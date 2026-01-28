import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";

// Re-export types
export type { ComponentApi };

// ============================================================================
// Types
// ============================================================================

export type WorkflowStatus =
  | "pending"
  | "running"
  | "sleeping"
  | "waiting"
  | "completed"
  | "failed";
export type StepStatus = "pending" | "running" | "completed" | "failed";

/**
 * Error thrown when a workflow goes to sleep
 * This is caught by the worker to gracefully stop execution
 */
export class WorkflowSleepError extends Error {
  constructor(public readonly wakeTime: number) {
    super(`Workflow sleeping until ${wakeTime}`);
    this.name = "WorkflowSleepError";
  }
}

/**
 * Error thrown when a workflow is waiting for a signal.
 * This is caught by the worker to gracefully stop execution.
 */
export class WorkflowWaitError extends Error {
  constructor(
    public readonly signalName: string,
    public readonly marker: string,
  ) {
    super(`Workflow waiting for signal "${signalName}" (${marker})`);
    this.name = "WorkflowWaitError";
  }
}

export interface WorkflowContext<TInput> {
  input: TInput;
  workflowId: string;
  step: <T>(name: string, fn: () => T | Promise<T>) => Promise<T>;
  sleep: {
    (durationMs: number): Promise<void>;
    (marker: string, durationMs: number): Promise<void>;
  };
  sleepUntil: {
    (timestamp: number | Date): Promise<void>;
    (marker: string, timestamp: number | Date): Promise<void>;
  };
  waitForSignal: <T = any>(marker: string, signalName: string) => Promise<T>;
}

export type WorkflowFunction<TInput, TOutput> = (
  ctx: WorkflowContext<TInput>,
  input: TInput,
) => Promise<TOutput>;

export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  fn: WorkflowFunction<TInput, TOutput>;
}

export interface WorkflowHandle {
  workflowId: string;
  status: () => Promise<{
    status: WorkflowStatus;
    output?: unknown;
    error?: string;
  }>;
  result: () => Promise<unknown>;
}

export interface ConvexWorkerClient {
  mutation: ConvexClient["mutation"];
  query: ConvexClient["query"];
  onUpdate: ConvexClient["onUpdate"];
}

// API type that workers need to operate
export interface OrchestratorApi {
  startWorkflow: FunctionReference<
    "mutation",
    "public",
    { name: string; input: any },
    string
  >;
  claimWorkflow: FunctionReference<
    "mutation",
    "public",
    { workflowNames: string[]; workerId: string },
    { workflowId: string; name: string; input: any } | null
  >;
  heartbeat: FunctionReference<
    "mutation",
    "public",
    { workflowId: string; workerId: string },
    boolean
  >;
  completeWorkflow: FunctionReference<
    "mutation",
    "public",
    { workflowId: string; workerId: string; output: any },
    boolean
  >;
  failWorkflow: FunctionReference<
    "mutation",
    "public",
    { workflowId: string; workerId: string; error: string },
    boolean
  >;
  getOrCreateStep: FunctionReference<
    "mutation",
    "public",
    { workflowId: string; stepName: string; workerId: string },
    {
      stepId: string;
      status: StepStatus;
      output?: any;
      error?: string;
      sleepUntil?: number;
      isNew: boolean;
    }
  >;
  scheduleSleep: FunctionReference<
    "mutation",
    "public",
    { workflowId: string; stepId: string; workerId: string; sleepUntil: number },
    boolean
  >;
  waitForSignal: FunctionReference<
    "mutation",
    "public",
    { workflowId: string; stepId: string; workerId: string; signalName: string },
    { kind: "waiting" } | { kind: "signaled"; payload: any }
  >;
  completeStep: FunctionReference<
    "mutation",
    "public",
    { stepId: string; workerId: string; output: any },
    boolean
  >;
  failStep: FunctionReference<
    "mutation",
    "public",
    { stepId: string; workerId: string; error: string },
    boolean
  >;
  sleepWorkflow: FunctionReference<
    "mutation",
    "public",
    { workflowId: string; workerId: string; sleepUntil: number },
    boolean
  >;
  getWorkflow: FunctionReference<
    "query",
    "public",
    { workflowId: string },
    {
      _id: string;
      _creationTime: number;
      name: string;
      status: WorkflowStatus;
      input: any;
      output?: any;
      error?: string;
      claimedBy?: string | null;
      sleepUntil?: number;
    } | null
  >;
  subscribePendingWorkflows: FunctionReference<
    "query",
    "public",
    { workflowNames: string[] },
    number
  >;
}

export interface WorkerOptions {
  workflows: WorkflowDefinition<any, any>[];
  pollIntervalMs?: number;
  /**
   * Max number of workflows to execute concurrently within a single worker
   * process. Defaults to 1.
   */
  maxConcurrentWorkflows?: number;
  /**
   * If true, the worker will claim workflows globally (FIFO) by passing `["*"]`
   * to the backend. This avoids per-name queries but may claim workflows you
   * haven't registered.
   *
   * Reserve the workflow name "*" for this purpose.
   */
  claimAllWorkflows?: boolean;
}

// ============================================================================
// Workflow Definition
// ============================================================================

/**
 * Define a workflow
 *
 * @example
 * ```ts
 * const orderWorkflow = workflow("order", async (ctx, input: OrderInput) => {
 *   const payment = await ctx.step("charge", () =>
 *     processPayment(input.total)
 *   );
 *
 *   if (payment.success) {
 *     await ctx.step("notify", () =>
 *       sendEmail(input.email, "Thanks!")
 *     );
 *   }
 *
 *   return { orderId: payment.id };
 * });
 * ```
 */
export function workflow<TInput, TOutput>(
  name: string,
  fn: WorkflowFunction<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput> {
  return { name, fn };
}

// ============================================================================
// Worker
// ============================================================================

/**
 * Create a worker that executes workflows
 *
 * @example
 * ```ts
 * const worker = createWorker(convex, api.orchestrator, {
 *   workflows: [orderWorkflow, onboardingWorkflow],
 * });
 *
 * await worker.start();
 * ```
 */
export function createWorker(
  client: ConvexWorkerClient,
  orchestratorApi: OrchestratorApi,
  options: WorkerOptions,
) {
  const workerId = generateWorkerId();
  const workflows = new Map<string, WorkflowDefinition>();
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const claimAllWorkflows = options.claimAllWorkflows ?? false;
  const maxConcurrentWorkflows = options.maxConcurrentWorkflows ?? 1;

  for (const wf of options.workflows) {
    workflows.set(wf.name, wf);
  }

  let running = false;
  let unsubscribe: (() => void) | null = null;
  let pollLoopRunning = false;
  let wakePoll: (() => void) | null = null;
  const inFlight = new Set<Promise<void>>();

  const workflowNames = Array.from(workflows.keys());
  const workflowNamesForClaim = claimAllWorkflows ? ["*"] : workflowNames;

  async function executeWorkflow(
    workflowId: string,
    workflowName: string,
    input: unknown,
  ) {
    const workflowDef = workflows.get(workflowName);
    if (!workflowDef) {
      console.error(`Unknown workflow: ${workflowName}`);
      return;
    }

    const claimState = { lost: false };
    let executingStepName: string | null = null;
    const sleepPrefix = "__sleep:";
    const signalPrefix = "__signal:";

    // Create the context with step function and sleep functions
    const ctx: WorkflowContext<unknown> = {
      input,
      workflowId,
      step: async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
        if (claimState.lost) {
          throw new Error("Workflow claim lost");
        }
        // Check if step already completed
        const stepInfo = await client.mutation(
          orchestratorApi.getOrCreateStep,
          {
            workflowId,
            stepName: name,
            workerId,
          },
        );

        if (claimState.lost) {
          throw new Error("Workflow claim lost");
        }

        if (!stepInfo.isNew && stepInfo.status === "completed") {
          // Step already completed, return cached result
          return stepInfo.output as T;
        }

        if (!stepInfo.isNew && stepInfo.status === "failed") {
          // Step previously failed, throw the error
          throw new Error(stepInfo.error ?? "Step failed");
        }

        // Execute the step
        try {
          executingStepName = name;
          const result = await fn();

          if (claimState.lost) {
            throw new Error("Workflow claim lost");
          }

          // Store the result
          const ok = await client.mutation(orchestratorApi.completeStep, {
            stepId: stepInfo.stepId,
            workerId,
            output: result,
          });
          if (!ok) {
            throw new Error("Failed to record step result (claim lost?)");
          }

          return result;
        } catch (error) {
          // Best-effort store the error (may fail if claim was lost)
          try {
            await client.mutation(orchestratorApi.failStep, {
              stepId: stepInfo.stepId,
              workerId,
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // ignore
          }
          throw error;
        } finally {
          executingStepName = null;
        }
      },
      sleep: async (...args: [number] | [string, number]) => {
        if (executingStepName) {
          throw new Error(
            `ctx.sleep() cannot be called inside ctx.step("${executingStepName}"). ` +
              `Move the sleep outside of ctx.step and make it its own top-level await.`,
          );
        }

        if (args.length === 1) {
          throw new Error(
            `ctx.sleep(durationMs) is not replay-safe. Use ctx.sleep(marker, durationMs) instead.`,
          );
        }

        const [marker, durationMs] = args;
        if (durationMs <= 0) {
          console.warn(
            `[convex-orchestrator] sleep(${durationMs}) called with non-positive duration, continuing immediately`,
          );
          return;
        }

        await ctx.sleepUntil(marker, Date.now() + durationMs);
      },
      sleepUntil: async (
        ...args: [number | Date] | [string, number | Date]
      ) => {
        if (executingStepName) {
          throw new Error(
            `ctx.sleepUntil() cannot be called inside ctx.step("${executingStepName}"). ` +
              `Move the sleep outside of ctx.step and make it its own top-level await.`,
          );
        }

        if (args.length === 1) {
          throw new Error(
            `ctx.sleepUntil(timestamp) is not replay-safe. Use ctx.sleepUntil(marker, timestamp) instead.`,
          );
        }

        const [marker, timestamp] = args;
        const ts =
          typeof timestamp === "number" ? timestamp : timestamp.getTime();
        if (ts <= Date.now()) {
          console.warn(
            `[convex-orchestrator] sleepUntil(${ts}) called with time in the past, continuing immediately`,
          );
          return;
        }
        if (claimState.lost) {
          throw new Error("Workflow claim lost");
        }

        const stepName = `${sleepPrefix}${marker}`;
        const stepInfo = await client.mutation(orchestratorApi.getOrCreateStep, {
          workflowId,
          stepName,
          workerId,
        });

        if (!stepInfo.isNew && stepInfo.status === "completed") {
          return;
        }
        if (!stepInfo.isNew && stepInfo.status === "failed") {
          throw new Error(stepInfo.error ?? "Sleep marker step failed");
        }

        const sleepUntil = stepInfo.sleepUntil ?? ts;
        if (sleepUntil <= Date.now()) {
          // We're already past the wake time; complete the marker and continue.
          const ok = await client.mutation(orchestratorApi.completeStep, {
            stepId: stepInfo.stepId,
            workerId,
            output: { sleepUntil },
          });
          if (!ok) {
            throw new Error("Failed to complete sleep marker (claim lost?)");
          }
          return;
        }

        const ok = await client.mutation(orchestratorApi.scheduleSleep, {
          workflowId,
          stepId: stepInfo.stepId,
          workerId,
          sleepUntil,
        });
        if (!ok) {
          throw new Error("Failed to schedule workflow sleep (claim lost?)");
        }

        // Stop execution - workflow will be resumed later
        throw new WorkflowSleepError(sleepUntil);
      },
      waitForSignal: async <T,>(marker: string, signalName: string) => {
        if (executingStepName) {
          throw new Error(
            `ctx.waitForSignal() cannot be called inside ctx.step("${executingStepName}"). ` +
              `Move the wait outside of ctx.step and make it its own top-level await.`,
          );
        }
        if (!marker) {
          throw new Error("ctx.waitForSignal(marker, signalName) requires a marker");
        }
        if (!signalName) {
          throw new Error(
            "ctx.waitForSignal(marker, signalName) requires a signalName",
          );
        }
        if (claimState.lost) {
          throw new Error("Workflow claim lost");
        }

        const stepName = `${signalPrefix}${signalName}:${marker}`;
        const stepInfo = await client.mutation(orchestratorApi.getOrCreateStep, {
          workflowId,
          stepName,
          workerId,
        });

        if (!stepInfo.isNew && stepInfo.status === "completed") {
          return stepInfo.output as T;
        }
        if (!stepInfo.isNew && stepInfo.status === "failed") {
          throw new Error(stepInfo.error ?? "Signal marker step failed");
        }

        const res = await client.mutation(orchestratorApi.waitForSignal, {
          workflowId,
          stepId: stepInfo.stepId,
          workerId,
          signalName,
        });

        if (res.kind === "signaled") {
          const ok = await client.mutation(orchestratorApi.completeStep, {
            stepId: stepInfo.stepId,
            workerId,
            output: res.payload,
          });
          if (!ok) {
            throw new Error("Failed to record signal result (claim lost?)");
          }
          return res.payload as T;
        }

        throw new WorkflowWaitError(signalName, marker);
      },
    };

    // Start heartbeat
    const heartbeatInterval = setInterval(async () => {
      if (claimState.lost) return;
      try {
        const ok = await client.mutation(orchestratorApi.heartbeat, {
          workflowId,
          workerId,
        });
        if (!ok) {
          claimState.lost = true;
          console.warn(`Lost claim for workflow ${workflowId}`);
        }
      } catch (e) {
        // Heartbeat failed, workflow may have been reassigned
        console.warn("Heartbeat failed:", e);
      }
    }, 10_000); // Every 10 seconds

    try {
      // Execute the workflow
      const result = await workflowDef.fn(ctx, input);

      if (claimState.lost) {
        return;
      }

      // Mark workflow as completed
      const ok = await client.mutation(orchestratorApi.completeWorkflow, {
        workflowId,
        workerId,
        output: result,
      });
      if (!ok) {
        console.warn(`Failed to complete workflow ${workflowId} (claim lost?)`);
        return;
      }

      console.log(`Workflow ${workflowId} completed successfully`);
    } catch (error) {
      if (claimState.lost) {
        return;
      }
      // Check if this is a sleep error - if so, workflow is now sleeping
      if (error instanceof WorkflowSleepError) {
        console.log(
          `Workflow ${workflowId} is sleeping until ${error.wakeTime}`,
        );
        return;
      }
      if (error instanceof WorkflowWaitError) {
        console.log(
          `Workflow ${workflowId} is waiting for signal ${error.signalName} (${error.marker})`,
        );
        return;
      }
      // Mark workflow as failed
      const ok = await client.mutation(orchestratorApi.failWorkflow, {
        workflowId,
        workerId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!ok) {
        console.warn(`Failed to fail workflow ${workflowId} (claim lost?)`);
        return;
      }

      console.error(`Workflow ${workflowId} failed:`, error);
    } finally {
      clearInterval(heartbeatInterval);
    }
  }

  function triggerPoll() {
    if (!running) return;
    if (wakePoll) {
      wakePoll();
      return;
    }
    void pollLoop();
  }

  function startInFlight(
    workflowId: string,
    workflowName: string,
    input: unknown,
  ) {
    const p = (async () => {
      await executeWorkflow(workflowId, workflowName, input);
    })();
    inFlight.add(p);
    void p.finally(() => {
      inFlight.delete(p);
      // If we're still running and we freed capacity, try to claim more.
      triggerPoll();
    });
  }

  async function pollLoop() {
    if (pollLoopRunning) return;
    pollLoopRunning = true;
    try {
      while (running) {
        try {
          // Fill available capacity.
          while (running && inFlight.size < maxConcurrentWorkflows) {
            const claimed = await client.mutation(
              orchestratorApi.claimWorkflow,
              {
                workflowNames: workflowNamesForClaim,
                workerId,
              },
            );

            if (!claimed) break;

            console.log(
              `Claimed workflow: ${claimed.workflowId} (${claimed.name})`,
            );
            startInFlight(claimed.workflowId, claimed.name, claimed.input);
          }
        } catch (error) {
          console.error("Error polling for workflows:", error);
        }

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            wakePoll = null;
            resolve();
          }, pollIntervalMs);

          wakePoll = () => {
            clearTimeout(timeout);
            wakePoll = null;
            resolve();
          };
        });
      }
    } finally {
      pollLoopRunning = false;
      wakePoll = null;
    }
  }

  return {
    /**
     * Start the worker
     */
    start: async () => {
      if (running) return;
      running = true;

      console.log(`Worker ${workerId} starting...`);
      console.log(`Registered workflows: ${workflowNames.join(", ")}`);

      // Subscribe to pending workflow count for real-time updates
      unsubscribe = client.onUpdate(
        orchestratorApi.subscribePendingWorkflows,
        { workflowNames: workflowNamesForClaim },
        (count) => {
          if (count > 0 && running) {
            // There are pending workflows, wake the poll loop.
            triggerPoll();
          }
        },
      );

      // Start polling
      triggerPoll();
    },

    /**
     * Stop the worker
     */
    stop: () => {
      running = false;
      if (wakePoll) wakePoll();
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      console.log(`Worker ${workerId} stopped`);
    },

    /**
     * Start a new workflow
     */
    startWorkflow: async <TInput>(
      workflowName: string,
      input: TInput,
    ): Promise<WorkflowHandle> => {
      const workflowId = await client.mutation(orchestratorApi.startWorkflow, {
        name: workflowName,
        input,
      });

      return createWorkflowHandle(client, orchestratorApi, workflowId);
    },

    /**
     * Get a handle to an existing workflow
     */
    getWorkflow: (workflowId: string): WorkflowHandle => {
      return createWorkflowHandle(client, orchestratorApi, workflowId);
    },

    /**
     * Worker ID
     */
    workerId,
  };
}

// ============================================================================
// Workflow Handle
// ============================================================================

function createWorkflowHandle(
  client: ConvexWorkerClient,
  orchestratorApi: OrchestratorApi,
  workflowId: string,
): WorkflowHandle {
  return {
    workflowId,

    status: async () => {
      const workflow = await client.query(orchestratorApi.getWorkflow, {
        workflowId,
      });
      if (!workflow) {
        throw new Error(`Workflow ${workflowId} not found`);
      }
      return {
        status: workflow.status,
        output: workflow.output,
        error: workflow.error,
      };
    },

    result: async () => {
      // Poll until completed or failed
      while (true) {
        const workflow = await client.query(orchestratorApi.getWorkflow, {
          workflowId,
        });
        if (!workflow) {
          throw new Error(`Workflow ${workflowId} not found`);
        }
        if (workflow.status === "completed") {
          return workflow.output;
        }
        if (workflow.status === "failed") {
          throw new Error(workflow.error ?? "Workflow failed");
        }
        // Wait and poll again
        await sleep(500);
      }
    },
  };
}

// ============================================================================
// Utilities
// ============================================================================

function generateWorkerId(): string {
  return `worker_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Convex Integration Helpers (for use in Convex functions)
// ============================================================================

/**
 * Expose orchestrator API for use from Convex functions or frontend
 * This creates wrapper functions that the worker can call
 */
export type WorkerAuthorizeFn = (
  ctx: any,
  args: any,
) => boolean | Promise<boolean>;

export function exposeApi(component: ComponentApi) {
  return {
    startWorkflow: mutationGeneric({
      args: {
        name: v.string(),
        input: v.any(),
      },
      handler: async (ctx, args) => {
        return await ctx.runMutation(component.lib.startWorkflow, args);
      },
    }),

    getWorkflow: queryGeneric({
      args: {
        workflowId: v.string(),
      },
      handler: async (ctx, args) => {
        return await ctx.runQuery(component.lib.getWorkflow, {
          workflowId: args.workflowId as any,
        });
      },
    }),

    signalWorkflow: mutationGeneric({
      args: {
        workflowId: v.string(),
        signal: v.string(),
        payload: v.any(),
      },
      handler: async (ctx, args) => {
        return await ctx.runMutation(component.lib.signalWorkflow, {
          workflowId: args.workflowId as any,
          signal: args.signal,
          payload: args.payload,
        });
      },
    }),

    listWorkflows: queryGeneric({
      args: {
        status: v.optional(
          v.union(
            v.literal("pending"),
            v.literal("running"),
            v.literal("sleeping"),
            v.literal("waiting"),
            v.literal("completed"),
            v.literal("failed"),
          ),
        ),
        limit: v.optional(v.number()),
      },
      handler: async (ctx, args) => {
        return await ctx.runQuery(component.lib.listWorkflows, args);
      },
    }),

    getWorkflowSteps: queryGeneric({
      args: {
        workflowId: v.string(),
      },
      handler: async (ctx, args) => {
        return await ctx.runQuery(component.lib.getWorkflowSteps, {
          workflowId: args.workflowId as any,
        });
      },
    }),
  };
}

export function exposeApiWithWorker(
  component: ComponentApi,
  options: { authorize: WorkerAuthorizeFn },
) {
  const publicApi = exposeApi(component);

  const authorize = options.authorize;
  const ensureAuthorized = async (ctx: any, args: any) => {
    const ok = await authorize(ctx, args);
    if (!ok) throw new Error("Unauthorized worker call");
  };

  return {
    ...publicApi,

    claimWorkflow: mutationGeneric({
      args: {
        workflowNames: v.array(v.string()),
        workerId: v.string(),
      },
      handler: async (ctx, args) => {
        await ensureAuthorized(ctx, args);
        return await ctx.runMutation(component.lib.claimWorkflow, args);
      },
    }),

    heartbeat: mutationGeneric({
      args: {
        workflowId: v.string(),
        workerId: v.string(),
      },
      handler: async (ctx, args) => {
        await ensureAuthorized(ctx, args);
        return await ctx.runMutation(component.lib.heartbeat, {
          workflowId: args.workflowId as any,
          workerId: args.workerId,
        });
      },
    }),

    completeWorkflow: mutationGeneric({
      args: {
        workflowId: v.string(),
        workerId: v.string(),
        output: v.any(),
      },
      handler: async (ctx, args) => {
        await ensureAuthorized(ctx, args);
        return await ctx.runMutation(component.lib.completeWorkflow, {
          workflowId: args.workflowId as any,
          workerId: args.workerId,
          output: args.output,
        });
      },
    }),

    failWorkflow: mutationGeneric({
      args: {
        workflowId: v.string(),
        workerId: v.string(),
        error: v.string(),
      },
      handler: async (ctx, args) => {
        await ensureAuthorized(ctx, args);
        return await ctx.runMutation(component.lib.failWorkflow, {
          workflowId: args.workflowId as any,
          workerId: args.workerId,
          error: args.error,
        });
      },
    }),

    sleepWorkflow: mutationGeneric({
      args: {
        workflowId: v.string(),
        workerId: v.string(),
        sleepUntil: v.number(),
      },
      handler: async (ctx, args) => {
        await ensureAuthorized(ctx, args);
        return await ctx.runMutation(component.lib.sleepWorkflow, {
          workflowId: args.workflowId as any,
          workerId: args.workerId,
          sleepUntil: args.sleepUntil,
        });
      },
    }),

    getOrCreateStep: mutationGeneric({
      args: {
        workflowId: v.string(),
        stepName: v.string(),
        workerId: v.string(),
      },
      handler: async (ctx, args) => {
        await ensureAuthorized(ctx, args);
        return await ctx.runMutation(component.lib.getOrCreateStep, {
          workflowId: args.workflowId as any,
          stepName: args.stepName,
          workerId: args.workerId,
        });
      },
    }),

    scheduleSleep: mutationGeneric({
      args: {
        workflowId: v.string(),
        stepId: v.string(),
        workerId: v.string(),
        sleepUntil: v.number(),
      },
      handler: async (ctx, args) => {
        await ensureAuthorized(ctx, args);
        return await ctx.runMutation(component.lib.scheduleSleep, {
          workflowId: args.workflowId as any,
          stepId: args.stepId as any,
          workerId: args.workerId,
          sleepUntil: args.sleepUntil,
        });
      },
    }),

    waitForSignal: mutationGeneric({
      args: {
        workflowId: v.string(),
        stepId: v.string(),
        workerId: v.string(),
        signalName: v.string(),
      },
      handler: async (ctx, args) => {
        await ensureAuthorized(ctx, args);
        return await ctx.runMutation(component.lib.waitForSignal, {
          workflowId: args.workflowId as any,
          stepId: args.stepId as any,
          workerId: args.workerId,
          signalName: args.signalName,
        });
      },
    }),

    completeStep: mutationGeneric({
      args: {
        stepId: v.string(),
        workerId: v.string(),
        output: v.any(),
      },
      handler: async (ctx, args) => {
        await ensureAuthorized(ctx, args);
        return await ctx.runMutation(component.lib.completeStep, {
          stepId: args.stepId as any,
          workerId: args.workerId,
          output: args.output,
        });
      },
    }),

    failStep: mutationGeneric({
      args: {
        stepId: v.string(),
        workerId: v.string(),
        error: v.string(),
      },
      handler: async (ctx, args) => {
        await ensureAuthorized(ctx, args);
        return await ctx.runMutation(component.lib.failStep, {
          stepId: args.stepId as any,
          workerId: args.workerId,
          error: args.error,
        });
      },
    }),

    subscribePendingWorkflows: queryGeneric({
      args: {
        workflowNames: v.array(v.string()),
      },
      handler: async (ctx, args) => {
        await ensureAuthorized(ctx, args);
        return await ctx.runQuery(
          component.lib.subscribePendingWorkflows,
          args,
        );
      },
    }),
  };
}
