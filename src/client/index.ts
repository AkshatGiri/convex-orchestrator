import { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";

// Re-export types
export type { ComponentApi };

// ============================================================================
// Types
// ============================================================================

export type WorkflowStatus = "pending" | "running" | "completed" | "failed";
export type StepStatus = "pending" | "running" | "completed" | "failed";

export interface WorkflowContext<TInput> {
  input: TInput;
  workflowId: string;
  step: <T>(name: string, fn: () => T | Promise<T>) => Promise<T>;
}

export type WorkflowFunction<TInput, TOutput> = (
  ctx: WorkflowContext<TInput>,
  input: TInput
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

// API type that workers need to operate
export interface OrchestratorApi {
  startWorkflow: FunctionReference<"mutation", "public", { name: string; input: any }, string>;
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
    { workflowId: string; stepName: string },
    { stepId: string; status: StepStatus; output?: any; error?: string; isNew: boolean }
  >;
  completeStep: FunctionReference<
    "mutation",
    "public",
    { stepId: string; output: any },
    boolean
  >;
  failStep: FunctionReference<
    "mutation",
    "public",
    { stepId: string; error: string },
    boolean
  >;
  getWorkflow: FunctionReference<
    "query",
    "public",
    { workflowId: string },
    { _id: string; _creationTime: number; name: string; status: WorkflowStatus; input: any; output?: any; error?: string } | null
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
  fn: WorkflowFunction<TInput, TOutput>
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
  client: ConvexClient,
  orchestratorApi: OrchestratorApi,
  options: WorkerOptions
) {
  const workerId = generateWorkerId();
  const workflows = new Map<string, WorkflowDefinition>();
  const pollIntervalMs = options.pollIntervalMs ?? 1000;

  for (const wf of options.workflows) {
    workflows.set(wf.name, wf);
  }

  let running = false;
  let pollTimeout: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  const workflowNames = Array.from(workflows.keys());

  async function executeWorkflow(
    workflowId: string,
    workflowName: string,
    input: unknown
  ) {
    const workflowDef = workflows.get(workflowName);
    if (!workflowDef) {
      console.error(`Unknown workflow: ${workflowName}`);
      return;
    }

    // Create the context with step function
    const ctx: WorkflowContext<unknown> = {
      input,
      workflowId,
      step: async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
        // Check if step already completed
        const stepInfo = await client.mutation(orchestratorApi.getOrCreateStep, {
          workflowId,
          stepName: name,
        });

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
          const result = await fn();

          // Store the result
          await client.mutation(orchestratorApi.completeStep, {
            stepId: stepInfo.stepId,
            output: result,
          });

          return result;
        } catch (error) {
          // Store the error
          await client.mutation(orchestratorApi.failStep, {
            stepId: stepInfo.stepId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    };

    // Start heartbeat
    const heartbeatInterval = setInterval(async () => {
      try {
        await client.mutation(orchestratorApi.heartbeat, {
          workflowId,
          workerId,
        });
      } catch (e) {
        // Heartbeat failed, workflow may have been reassigned
        console.warn("Heartbeat failed:", e);
      }
    }, 10_000); // Every 10 seconds

    try {
      // Execute the workflow
      const result = await workflowDef.fn(ctx, input);

      // Mark workflow as completed
      await client.mutation(orchestratorApi.completeWorkflow, {
        workflowId,
        workerId,
        output: result,
      });

      console.log(`Workflow ${workflowId} completed successfully`);
    } catch (error) {
      // Mark workflow as failed
      await client.mutation(orchestratorApi.failWorkflow, {
        workflowId,
        workerId,
        error: error instanceof Error ? error.message : String(error),
      });

      console.error(`Workflow ${workflowId} failed:`, error);
    } finally {
      clearInterval(heartbeatInterval);
    }
  }

  async function poll() {
    if (!running) return;

    try {
      // Try to claim a workflow
      const claimed = await client.mutation(orchestratorApi.claimWorkflow, {
        workflowNames,
        workerId,
      });

      if (claimed) {
        console.log(`Claimed workflow: ${claimed.workflowId} (${claimed.name})`);
        await executeWorkflow(claimed.workflowId, claimed.name, claimed.input);
        // Immediately poll again after completing a workflow
        if (running) {
          poll();
          return;
        }
      }
    } catch (error) {
      console.error("Error polling for workflows:", error);
    }

    // Schedule next poll
    if (running) {
      pollTimeout = setTimeout(poll, pollIntervalMs);
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
        { workflowNames },
        (count) => {
          if (count > 0 && running) {
            // There are pending workflows, trigger a poll
            if (pollTimeout) {
              clearTimeout(pollTimeout);
            }
            poll();
          }
        }
      );

      // Start polling
      poll();
    },

    /**
     * Stop the worker
     */
    stop: () => {
      running = false;
      if (pollTimeout) {
        clearTimeout(pollTimeout);
        pollTimeout = null;
      }
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
      input: TInput
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
  client: ConvexClient,
  orchestratorApi: OrchestratorApi,
  workflowId: string
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

    claimWorkflow: mutationGeneric({
      args: {
        workflowNames: v.array(v.string()),
        workerId: v.string(),
      },
      handler: async (ctx, args) => {
        return await ctx.runMutation(component.lib.claimWorkflow, args);
      },
    }),

    heartbeat: mutationGeneric({
      args: {
        workflowId: v.string(),
        workerId: v.string(),
      },
      handler: async (ctx, args) => {
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
        return await ctx.runMutation(component.lib.failWorkflow, {
          workflowId: args.workflowId as any,
          workerId: args.workerId,
          error: args.error,
        });
      },
    }),

    getOrCreateStep: mutationGeneric({
      args: {
        workflowId: v.string(),
        stepName: v.string(),
      },
      handler: async (ctx, args) => {
        return await ctx.runMutation(component.lib.getOrCreateStep, {
          workflowId: args.workflowId as any,
          stepName: args.stepName,
        });
      },
    }),

    completeStep: mutationGeneric({
      args: {
        stepId: v.string(),
        output: v.any(),
      },
      handler: async (ctx, args) => {
        return await ctx.runMutation(component.lib.completeStep, {
          stepId: args.stepId as any,
          output: args.output,
        });
      },
    }),

    failStep: mutationGeneric({
      args: {
        stepId: v.string(),
        error: v.string(),
      },
      handler: async (ctx, args) => {
        return await ctx.runMutation(component.lib.failStep, {
          stepId: args.stepId as any,
          error: args.error,
        });
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

    listWorkflows: queryGeneric({
      args: {
        status: v.optional(
          v.union(
            v.literal("pending"),
            v.literal("running"),
            v.literal("completed"),
            v.literal("failed")
          )
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

    subscribePendingWorkflows: queryGeneric({
      args: {
        workflowNames: v.array(v.string()),
      },
      handler: async (ctx, args) => {
        return await ctx.runQuery(component.lib.subscribePendingWorkflows, args);
      },
    }),
  };
}
