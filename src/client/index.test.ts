import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { createWorker, exposeApi, exposeApiWithWorker, workflow } from "./index.js";
import { anyApi, type ApiFromModules } from "convex/server";
import { components, initConvexTest } from "./setup.test.js";

export const { startWorkflow, getWorkflow, listWorkflows, getWorkflowSteps } =
  exposeApi(components.convexOrchestrator);

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

  test("exposeApi does not include worker control functions by default", () => {
    const apiObj = exposeApi(components.convexOrchestrator) as any;
    expect(apiObj.claimWorkflow).toBeUndefined();
    expect(apiObj.completeWorkflow).toBeUndefined();
    expect(apiObj.failWorkflow).toBeUndefined();
    expect(apiObj.getOrCreateStep).toBeUndefined();
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
});
