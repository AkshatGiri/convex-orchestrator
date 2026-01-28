import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { createWorker, exposeApi, exposeApiWithWorker, workflow } from "./index.js";
import { anyApi, type ApiFromModules } from "convex/server";
import { components, initConvexTest } from "./setup.test.js";

export const {
  startWorkflow,
  getWorkflow,
  listWorkflows,
  getWorkflowSteps,
  signalWorkflow,
} = exposeApi(components.convexOrchestrator);

const unauthorizedWorkerApi = exposeApiWithWorker(components.convexOrchestrator, {
  authorize: () => false,
});
export const { claimWorkflow: unauthorizedClaimWorkflow } = unauthorizedWorkerApi;

const testApi = (
  anyApi as unknown as ApiFromModules<{
    "index.test": {
      startWorkflow: typeof startWorkflow;
      getWorkflow: typeof getWorkflow;
      listWorkflows: typeof listWorkflows;
      getWorkflowSteps: typeof getWorkflowSteps;
      signalWorkflow: typeof signalWorkflow;
      unauthorizedClaimWorkflow: typeof unauthorizedClaimWorkflow;
    };
  }>
)["index.test"];

describe("client tests", () => {
  test("should be able to start a workflow via exposed API", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(testApi.startWorkflow, {
      name: "test-workflow",
      input: { foo: "bar" },
    });
    expect(workflowId).toBeDefined();

    const workflow = await t.query(testApi.getWorkflow, {
      workflowId: workflowId as string,
    });
    expect(workflow).toBeDefined();
    expect(workflow?.name).toBe("test-workflow");
    expect(workflow?.status).toBe("pending");
  });

  test("should be able to list workflows via exposed API", async () => {
    const t = initConvexTest();

    await t.mutation(testApi.startWorkflow, {
      name: "workflow-1",
      input: {},
    });
    await t.mutation(testApi.startWorkflow, {
      name: "workflow-2",
      input: {},
    });

    const workflows = await t.query(testApi.listWorkflows, {});
    expect(workflows).toHaveLength(2);
  });

  test("listWorkflows via exposed API accepts sleeping status filter", async () => {
    const t = initConvexTest();
    const workflows = await t.query(testApi.listWorkflows, {
      status: "sleeping",
    });
    expect(Array.isArray(workflows)).toBe(true);
  });

  test("exposeApi does not include worker control functions by default", () => {
    const apiObj = exposeApi(components.convexOrchestrator) as any;
    expect(apiObj.claimWorkflow).toBeUndefined();
    expect(apiObj.completeWorkflow).toBeUndefined();
    expect(apiObj.failWorkflow).toBeUndefined();
    expect(apiObj.getOrCreateStep).toBeUndefined();
    expect(apiObj.scheduleSleep).toBeUndefined();
    expect(apiObj.waitForSignal).toBeUndefined();
    expect(apiObj.completeStep).toBeUndefined();
    expect(apiObj.failStep).toBeUndefined();
    expect(apiObj.subscribePendingWorkflows).toBeUndefined();
  });

  test("exposeApiWithWorker enforces authorization", async () => {
    const t = initConvexTest();
    await t.mutation(testApi.startWorkflow, { name: "wf", input: {} });
    await expect(
      t.mutation(testApi.unauthorizedClaimWorkflow, {
        workflowNames: ["wf"],
        workerId: "worker-1",
      })
    ).rejects.toThrow(/unauthorized/i);
  });
});

describe("worker unit tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('claimAllWorkflows uses workflowNames ["*"]', async () => {
    const claimWorkflowRef = Symbol("claimWorkflow") as any;
    const subscribePendingRef = Symbol("subscribePendingWorkflows") as any;

    const client = {
      mutation: vi.fn(async (ref: any, _args: any) => {
        if (ref === claimWorkflowRef) {
          // Keep returning null to avoid executing anything.
          return null;
        }
        throw new Error(`Unexpected mutation: ${String(ref)}`);
      }),
      query: vi.fn(async () => {
        throw new Error("Unexpected query");
      }),
      onUpdate: vi.fn((_ref: any, args: any, _cb: any) => {
        expect(args).toEqual({ workflowNames: ["*"] });
        return () => {};
      }),
    };

    const orchestratorApi: any = {
      startWorkflow: Symbol("startWorkflow") as any,
      claimWorkflow: claimWorkflowRef,
      heartbeat: Symbol("heartbeat") as any,
      completeWorkflow: Symbol("completeWorkflow") as any,
      failWorkflow: Symbol("failWorkflow") as any,
      getOrCreateStep: Symbol("getOrCreateStep") as any,
      completeStep: Symbol("completeStep") as any,
      failStep: Symbol("failStep") as any,
      getWorkflow: Symbol("getWorkflow") as any,
      subscribePendingWorkflows: subscribePendingRef,
    };

    const wf = workflow("test", async () => "ok");
    const worker = createWorker(client as any, orchestratorApi, {
      workflows: [wf],
      claimAllWorkflows: true,
      pollIntervalMs: 1000,
    });

    await worker.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(client.mutation).toHaveBeenCalledWith(claimWorkflowRef, {
      workflowNames: ["*"],
      workerId: worker.workerId,
    });

    worker.stop();
  });

  test("maxConcurrentWorkflows claims and executes workflows concurrently", async () => {
    const claimWorkflowRef = Symbol("claimWorkflow") as any;
    const heartbeatRef = Symbol("heartbeat") as any;
    const completeWorkflowRef = Symbol("completeWorkflow") as any;
    const subscribePendingRef = Symbol("subscribePendingWorkflows") as any;

    const deferred: Record<string, { promise: Promise<void>; resolve: () => void }> =
      {};
    for (const id of ["wf1", "wf2"]) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      deferred[id] = { promise, resolve };
    }

    const started: string[] = [];
    const finished: string[] = [];

    const claimedQueue = [
      { workflowId: "wf1", name: "test", input: { id: "wf1" } },
      { workflowId: "wf2", name: "test", input: { id: "wf2" } },
    ];

    const client = {
      mutation: vi.fn(async (ref: any, args: any) => {
        if (ref === claimWorkflowRef) {
          return claimedQueue.shift() ?? null;
        }
        if (ref === heartbeatRef) return true;
        if (ref === completeWorkflowRef) return true;
        throw new Error(
          `Unexpected mutation: ${String(ref)} ${JSON.stringify(args)}`,
        );
      }),
      query: vi.fn(async () => {
        throw new Error("Unexpected query");
      }),
      onUpdate: vi.fn((_ref: any, _args: any, _cb: any) => {
        return () => {};
      }),
    };

    const orchestratorApi: any = {
      startWorkflow: Symbol("startWorkflow") as any,
      claimWorkflow: claimWorkflowRef,
      heartbeat: heartbeatRef,
      completeWorkflow: completeWorkflowRef,
      failWorkflow: Symbol("failWorkflow") as any,
      getOrCreateStep: Symbol("getOrCreateStep") as any,
      scheduleSleep: Symbol("scheduleSleep") as any,
      completeStep: Symbol("completeStep") as any,
      failStep: Symbol("failStep") as any,
      sleepWorkflow: Symbol("sleepWorkflow") as any,
      getWorkflow: Symbol("getWorkflow") as any,
      subscribePendingWorkflows: subscribePendingRef,
    };

    const wf = workflow("test", async (_ctx, input: any) => {
      const id = input.id as string;
      started.push(id);
      await deferred[id].promise;
      finished.push(id);
      return "ok";
    });

    const worker = createWorker(client as any, orchestratorApi, {
      workflows: [wf],
      pollIntervalMs: 1000,
      maxConcurrentWorkflows: 2,
    });

    await worker.start();
    await Promise.resolve();
    await Promise.resolve();

    // Both should have started without waiting for the first to finish.
    expect(started.sort()).toEqual(["wf1", "wf2"]);
    expect(finished).toEqual([]);

    // Now release both.
    deferred.wf1.resolve();
    deferred.wf2.resolve();

    await Promise.resolve();
    await Promise.resolve();

    worker.stop();

    expect(finished.sort()).toEqual(["wf1", "wf2"]);
  });

  test("worker stops writing results after claim is lost", async () => {
    const claimWorkflowRef = Symbol("claimWorkflow") as any;
    const heartbeatRef = Symbol("heartbeat") as any;
    const getOrCreateStepRef = Symbol("getOrCreateStep") as any;
    const completeStepRef = Symbol("completeStep") as any;
    const failStepRef = Symbol("failStep") as any;
    const completeWorkflowRef = Symbol("completeWorkflow") as any;
    const failWorkflowRef = Symbol("failWorkflow") as any;
    const subscribePendingRef = Symbol("subscribePendingWorkflows") as any;

    const calls: Array<{ ref: any; args: any }> = [];
    let claimedOnce = false;
    let heartbeatCalls = 0;

    const client = {
      mutation: vi.fn(async (ref: any, args: any) => {
        calls.push({ ref, args });

        if (ref === claimWorkflowRef) {
          if (claimedOnce) return null;
          claimedOnce = true;
          return { workflowId: "wf1", name: "test", input: {} };
        }

        if (ref === getOrCreateStepRef) {
          return { stepId: "step1", status: "running", isNew: true };
        }

        if (ref === heartbeatRef) {
          heartbeatCalls += 1;
          return heartbeatCalls >= 1 ? false : true;
        }

        if (ref === completeStepRef) return true;
        if (ref === failStepRef) return true;
        if (ref === completeWorkflowRef) return true;
        if (ref === failWorkflowRef) return true;
        throw new Error("Unexpected mutation");
      }),
      query: vi.fn(async () => {
        throw new Error("Unexpected query");
      }),
      onUpdate: vi.fn((_ref: any, _args: any, _cb: any) => {
        return () => {};
      }),
    };

    const orchestratorApi: any = {
      startWorkflow: Symbol("startWorkflow") as any,
      claimWorkflow: claimWorkflowRef,
      heartbeat: heartbeatRef,
      completeWorkflow: completeWorkflowRef,
      failWorkflow: failWorkflowRef,
      getOrCreateStep: getOrCreateStepRef,
      completeStep: completeStepRef,
      failStep: failStepRef,
      getWorkflow: Symbol("getWorkflow") as any,
      subscribePendingWorkflows: subscribePendingRef,
    };

    const wf = workflow("test", async (ctx) => {
      await ctx.step(
        "long",
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve("ok"), 20_000);
          })
      );
      return "done";
    });

    const worker = createWorker(client as any, orchestratorApi, {
      workflows: [wf],
      pollIntervalMs: 1000,
    });

    await worker.start();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    worker.stop();
    await vi.runOnlyPendingTimersAsync();

    expect(calls.some((c) => c.ref === heartbeatRef)).toBe(true);
    expect(calls.some((c) => c.ref === getOrCreateStepRef)).toBe(true);

    expect(calls.some((c) => c.ref === completeStepRef)).toBe(false);
    expect(calls.some((c) => c.ref === completeWorkflowRef)).toBe(false);
    expect(calls.some((c) => c.ref === failWorkflowRef)).toBe(false);
  });

  test("worker rejects ctx.sleep inside ctx.step (fails step and workflow)", async () => {
    const claimWorkflowRef = Symbol("claimWorkflow") as any;
    const getOrCreateStepRef = Symbol("getOrCreateStep") as any;
    const failStepRef = Symbol("failStep") as any;
    const failWorkflowRef = Symbol("failWorkflow") as any;
    const scheduleSleepRef = Symbol("scheduleSleep") as any;
    const subscribePendingRef = Symbol("subscribePendingWorkflows") as any;

    const calls: Array<{ ref: any; args: any }> = [];
    let claimedOnce = false;

    const client = {
      mutation: vi.fn(async (ref: any, args: any) => {
        calls.push({ ref, args });

        if (ref === claimWorkflowRef) {
          if (claimedOnce) return null;
          claimedOnce = true;
          return { workflowId: "wf1", name: "test", input: {} };
        }
        if (ref === getOrCreateStepRef) {
          return { stepId: "step1", status: "running", isNew: true };
        }
        if (ref === scheduleSleepRef) {
          throw new Error(
            "scheduleSleep should not be called from inside ctx.step",
          );
        }
        if (ref === failStepRef) return true;
        if (ref === failWorkflowRef) return true;
        return true;
      }),
      query: vi.fn(async () => {
        throw new Error("Unexpected query");
      }),
      onUpdate: vi.fn((_ref: any, _args: any, _cb: any) => {
        return () => {};
      }),
    };

    const orchestratorApi: any = {
      startWorkflow: Symbol("startWorkflow") as any,
      claimWorkflow: claimWorkflowRef,
      heartbeat: Symbol("heartbeat") as any,
      completeWorkflow: Symbol("completeWorkflow") as any,
      failWorkflow: failWorkflowRef,
      getOrCreateStep: getOrCreateStepRef,
      scheduleSleep: scheduleSleepRef,
      completeStep: Symbol("completeStep") as any,
      failStep: failStepRef,
      sleepWorkflow: Symbol("sleepWorkflow") as any,
      getWorkflow: Symbol("getWorkflow") as any,
      subscribePendingWorkflows: subscribePendingRef,
    };

    const wf = workflow("test", async (ctx) => {
      await ctx.step("bad", async () => {
        await ctx.sleep("delay", 1000);
      });
      return "done";
    });

    const worker = createWorker(client as any, orchestratorApi, {
      workflows: [wf],
      pollIntervalMs: 1000,
    });

    await worker.start();
    await Promise.resolve();
    await Promise.resolve();

    worker.stop();
    await vi.runOnlyPendingTimersAsync();

    const failStepCall = calls.find((c) => c.ref === failStepRef);
    const failWorkflowCall = calls.find((c) => c.ref === failWorkflowRef);

    expect(failStepCall).toBeDefined();
    expect(failWorkflowCall).toBeDefined();
    expect(failStepCall?.args.error).toMatch(/cannot be called inside ctx\.step/i);
    expect(failWorkflowCall?.args.error).toMatch(/cannot be called inside ctx\.step/i);
  });

  test("named ctx.sleep resumes after wake without re-sleeping", async () => {
    const claimWorkflowRef = Symbol("claimWorkflow") as any;
    const heartbeatRef = Symbol("heartbeat") as any;
    const getOrCreateStepRef = Symbol("getOrCreateStep") as any;
    const scheduleSleepRef = Symbol("scheduleSleep") as any;
    const completeStepRef = Symbol("completeStep") as any;
    const completeWorkflowRef = Symbol("completeWorkflow") as any;
    const subscribePendingRef = Symbol("subscribePendingWorkflows") as any;

    vi.setSystemTime(0);

    const steps = new Map<
      string,
      {
        stepId: string;
        status: "running" | "completed" | "failed";
        output?: any;
        error?: string;
        sleepUntil?: number;
      }
    >();
    let workflowSleepUntil: number | null = null;
    let firstClaimed = false;
    let resumedClaimed = false;
    let completed = false;

    const client = {
      mutation: vi.fn(async (ref: any, args: any) => {
        if (ref === claimWorkflowRef) {
          if (completed) return null;
          if (!firstClaimed) {
            firstClaimed = true;
            return { workflowId: "wf1", name: "test", input: {} };
          }
          if (
            workflowSleepUntil != null &&
            Date.now() >= workflowSleepUntil &&
            !resumedClaimed
          ) {
            resumedClaimed = true;
            return { workflowId: "wf1", name: "test", input: {} };
          }
          return null;
        }

        if (ref === heartbeatRef) return true;

        if (ref === getOrCreateStepRef) {
          const stepName = args.stepName as string;
          const existing = steps.get(stepName);
          if (existing) {
            return {
              stepId: existing.stepId,
              status: existing.status,
              output: existing.output,
              error: existing.error,
              sleepUntil: existing.sleepUntil,
              isNew: false,
            };
          }
          const created = {
            stepId: stepName,
            status: "running" as const,
            output: undefined,
            error: undefined,
            sleepUntil: undefined,
          };
          steps.set(stepName, created);
          return { ...created, isNew: true };
        }

        if (ref === scheduleSleepRef) {
          workflowSleepUntil = args.sleepUntil as number;
          const marker = steps.get("__sleep:delay");
          if (marker) marker.sleepUntil = workflowSleepUntil;
          return true;
        }

        if (ref === completeStepRef) {
          for (const [name, step] of steps.entries()) {
            if (step.stepId === args.stepId) {
              steps.set(name, {
                ...step,
                status: "completed",
                output: args.output,
                sleepUntil: undefined,
              });
            }
          }
          return true;
        }

        if (ref === completeWorkflowRef) {
          completed = true;
          return true;
        }

        throw new Error(`Unexpected mutation: ${String(ref)}`);
      }),
      query: vi.fn(async () => {
        throw new Error("Unexpected query");
      }),
      onUpdate: vi.fn((_ref: any, _args: any, _cb: any) => {
        return () => {};
      }),
    };

    const orchestratorApi: any = {
      startWorkflow: Symbol("startWorkflow") as any,
      claimWorkflow: claimWorkflowRef,
      heartbeat: heartbeatRef,
      completeWorkflow: completeWorkflowRef,
      failWorkflow: Symbol("failWorkflow") as any,
      getOrCreateStep: getOrCreateStepRef,
      scheduleSleep: scheduleSleepRef,
      completeStep: completeStepRef,
      failStep: Symbol("failStep") as any,
      sleepWorkflow: Symbol("sleepWorkflow") as any,
      getWorkflow: Symbol("getWorkflow") as any,
      subscribePendingWorkflows: subscribePendingRef,
    };

    const wf = workflow("test", async (ctx) => {
      await ctx.step("pre", () => "ok");
      await ctx.sleep("delay", 1000);
      await ctx.step("post", () => "done");
      return "finished";
    });

    const worker = createWorker(client as any, orchestratorApi, {
      workflows: [wf],
      pollIntervalMs: 1000,
    });

    await worker.start();
    await Promise.resolve();
    await Promise.resolve();

    // Let the worker reach the sleep and park itself.
    await vi.runOnlyPendingTimersAsync();

    // Advance time past the wake time so claimWorkflow can return it again.
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();

    worker.stop();

    expect(
      client.mutation.mock.calls.filter((c: any[]) => c[0] === scheduleSleepRef),
    ).toHaveLength(1);
    expect(completed).toBe(true);
  });

  test("named ctx.waitForSignal resumes after signal without re-waiting", async () => {
    const claimWorkflowRef = Symbol("claimWorkflow") as any;
    const heartbeatRef = Symbol("heartbeat") as any;
    const getOrCreateStepRef = Symbol("getOrCreateStep") as any;
    const waitForSignalRef = Symbol("waitForSignal") as any;
    const completeStepRef = Symbol("completeStep") as any;
    const completeWorkflowRef = Symbol("completeWorkflow") as any;
    const subscribePendingRef = Symbol("subscribePendingWorkflows") as any;

    const steps = new Map<
      string,
      { stepId: string; status: "running" | "completed"; output?: any; isNew: boolean }
    >();
    let signalAvailable = false;
    let firstClaimed = false;
    let resumedClaimed = false;
    let completed = false;

    const client = {
      mutation: vi.fn(async (ref: any, args: any) => {
        if (ref === claimWorkflowRef) {
          if (completed) return null;
          if (!firstClaimed) {
            firstClaimed = true;
            return { workflowId: "wf1", name: "test", input: {} };
          }
          if (signalAvailable && !resumedClaimed) {
            resumedClaimed = true;
            return { workflowId: "wf1", name: "test", input: {} };
          }
          return null;
        }

        if (ref === heartbeatRef) return true;

        if (ref === getOrCreateStepRef) {
          const stepName = args.stepName as string;
          const existing = steps.get(stepName);
          if (existing) {
            return {
              stepId: existing.stepId,
              status: existing.status,
              output: existing.output,
              error: undefined,
              isNew: false,
            };
          }
          const created = {
            stepId: stepName,
            status: "running" as const,
            output: undefined,
            isNew: true,
          };
          steps.set(stepName, created);
          return { ...created, error: undefined };
        }

        if (ref === waitForSignalRef) {
          if (!signalAvailable) return { kind: "waiting" as const };
          return { kind: "signaled" as const, payload: { approved: true } };
        }

        if (ref === completeStepRef) {
          for (const [name, step] of steps.entries()) {
            if (step.stepId === args.stepId) {
              steps.set(name, {
                ...step,
                status: "completed",
                output: args.output,
                isNew: false,
              });
            }
          }
          return true;
        }

        if (ref === completeWorkflowRef) {
          completed = true;
          return true;
        }

        throw new Error(`Unexpected mutation: ${String(ref)}`);
      }),
      query: vi.fn(async () => {
        throw new Error("Unexpected query");
      }),
      onUpdate: vi.fn((_ref: any, _args: any, _cb: any) => {
        return () => {};
      }),
    };

    const orchestratorApi: any = {
      startWorkflow: Symbol("startWorkflow") as any,
      claimWorkflow: claimWorkflowRef,
      heartbeat: heartbeatRef,
      completeWorkflow: completeWorkflowRef,
      failWorkflow: Symbol("failWorkflow") as any,
      getOrCreateStep: getOrCreateStepRef,
      scheduleSleep: Symbol("scheduleSleep") as any,
      waitForSignal: waitForSignalRef,
      completeStep: completeStepRef,
      failStep: Symbol("failStep") as any,
      sleepWorkflow: Symbol("sleepWorkflow") as any,
      getWorkflow: Symbol("getWorkflow") as any,
      subscribePendingWorkflows: subscribePendingRef,
    };

    const wf = workflow("test", async (ctx) => {
      const decision = await ctx.waitForSignal<{ approved: boolean }>(
        "decision",
        "approved",
      );
      await ctx.step("after", () => (decision.approved ? "ok" : "no"));
      return "done";
    });

    const worker = createWorker(client as any, orchestratorApi, {
      workflows: [wf],
      pollIntervalMs: 1000,
    });

    await worker.start();
    await Promise.resolve();
    await Promise.resolve();

    // First run should park waiting.
    expect(signalAvailable).toBe(false);
    expect(completed).toBe(false);

    // Now "send" the signal and advance time to trigger another claim.
    signalAvailable = true;
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();

    worker.stop();

    expect(completed).toBe(true);
    expect(
      client.mutation.mock.calls.filter((c: any[]) => c[0] === waitForSignalRef),
    ).toHaveLength(2);
  });
});
