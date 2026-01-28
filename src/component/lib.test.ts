/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

describe("orchestrator component", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("can start a workflow", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: { foo: "bar" },
    });
    expect(workflowId).toBeDefined();

    const workflow = await t.query(api.lib.getWorkflow, { workflowId });
    expect(workflow).toBeDefined();
    expect(workflow?.name).toEqual("test-workflow");
    expect(workflow?.status).toEqual("pending");
    expect(workflow?.input).toEqual({ foo: "bar" });
  });

  test("can claim a workflow", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: { foo: "bar" },
    });

    const claimed = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });

    expect(claimed).toBeDefined();
    expect(claimed?.workflowId).toEqual(workflowId);
    expect(claimed?.name).toEqual("test-workflow");

    const workflow = await t.query(api.lib.getWorkflow, { workflowId });
    expect(workflow?.status).toEqual("running");
  });

  test("prioritizes due sleeping workflows over pending (per-name)", async () => {
    const t = initConvexTest();
    const pendingId = await t.mutation(api.lib.startWorkflow, {
      name: "pending-workflow",
      input: { kind: "pending" },
    });

    vi.advanceTimersByTime(1000);

    const sleepId = await t.mutation(api.lib.startWorkflow, {
      name: "sleep-workflow",
      input: { kind: "sleep" },
    });

    // Claim + sleep the sleep-workflow so it's due immediately.
    await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["sleep-workflow"],
      workerId: "worker-1",
    });
    await t.mutation(api.lib.sleepWorkflow, {
      workflowId: sleepId,
      workerId: "worker-1",
      sleepUntil: Date.now(),
    });

    const claimed = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["pending-workflow", "sleep-workflow"],
      workerId: "worker-2",
    });

    expect(claimed?.workflowId).toEqual(sleepId);

    // Pending should still be pending.
    const pending = await t.query(api.lib.getWorkflow, { workflowId: pendingId });
    expect(pending?.status).toEqual("pending");
  });

  test("prioritizes due sleeping workflows over pending (claimAll)", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.startWorkflow, {
      name: "pending-workflow",
      input: { kind: "pending" },
    });

    vi.advanceTimersByTime(1000);

    const sleepId = await t.mutation(api.lib.startWorkflow, {
      name: "sleep-workflow",
      input: { kind: "sleep" },
    });

    await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["sleep-workflow"],
      workerId: "worker-1",
    });
    await t.mutation(api.lib.sleepWorkflow, {
      workflowId: sleepId,
      workerId: "worker-1",
      sleepUntil: Date.now(),
    });

    const claimed = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["*"],
      workerId: "worker-2",
    });

    expect(claimed?.workflowId).toEqual(sleepId);
  });

  test("can create and complete steps", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: {},
    });

    await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });

    // Create a step
    const step1 = await t.mutation(api.lib.getOrCreateStep, {
      workflowId,
      stepName: "step-1",
      workerId: "worker-1",
    });
    expect(step1.isNew).toBe(true);
    expect(step1.status).toEqual("running");

    // Complete the step
    await t.mutation(api.lib.completeStep, {
      stepId: step1.stepId,
      workerId: "worker-1",
      output: { result: "success" },
    });

    // Getting the same step should return cached result
    const step1Again = await t.mutation(api.lib.getOrCreateStep, {
      workflowId,
      stepName: "step-1",
      workerId: "worker-1",
    });
    expect(step1Again.isNew).toBe(false);
    expect(step1Again.status).toEqual("completed");
    expect(step1Again.output).toEqual({ result: "success" });
  });

  test("rejects step operations from non-owner worker", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: {},
    });

    await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });

    const step = await t.mutation(api.lib.getOrCreateStep, {
      workflowId,
      stepName: "step-1",
      workerId: "worker-1",
    });

    const ok = await t.mutation(api.lib.completeStep, {
      stepId: step.stepId,
      workerId: "worker-2",
      output: { result: "nope" },
    });
    expect(ok).toBe(false);

    const steps = await t.query(api.lib.getWorkflowSteps, { workflowId });
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe("running");
  });

  test("rejects step creation when workflow not claimed by worker", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: {},
    });

    await expect(
      t.mutation(api.lib.getOrCreateStep, {
        workflowId,
        stepName: "step-1",
        workerId: "worker-1",
      }),
    ).rejects.toThrow(/not claimed/i);
  });

  test("can complete a workflow", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: {},
    });

    // Claim the workflow
    await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });

    // Complete the workflow
    await t.mutation(api.lib.completeWorkflow, {
      workflowId,
      workerId: "worker-1",
      output: { final: "result" },
    });

    const workflow = await t.query(api.lib.getWorkflow, { workflowId });
    expect(workflow?.status).toEqual("completed");
    expect(workflow?.output).toEqual({ final: "result" });
  });

  test("can fail a workflow", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: {},
    });

    // Claim the workflow
    await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });

    // Fail the workflow
    await t.mutation(api.lib.failWorkflow, {
      workflowId,
      workerId: "worker-1",
      error: "Something went wrong",
    });

    const workflow = await t.query(api.lib.getWorkflow, { workflowId });
    expect(workflow?.status).toEqual("failed");
    expect(workflow?.error).toEqual("Something went wrong");
  });

  test("can list workflows", async () => {
    const t = initConvexTest();

    await t.mutation(api.lib.startWorkflow, {
      name: "workflow-1",
      input: {},
    });
    await t.mutation(api.lib.startWorkflow, {
      name: "workflow-2",
      input: {},
    });

    const workflows = await t.query(api.lib.listWorkflows, {});
    expect(workflows).toHaveLength(2);
  });

  test("only claims workflows for registered names", async () => {
    const t = initConvexTest();

    await t.mutation(api.lib.startWorkflow, {
      name: "workflow-a",
      input: {},
    });
    await t.mutation(api.lib.startWorkflow, {
      name: "workflow-b",
      input: {},
    });

    // Only looking for workflow-a
    const claimed = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["workflow-a"],
      workerId: "worker-1",
    });

    expect(claimed?.name).toEqual("workflow-a");
  });

  test("claims workflows in FIFO order (oldest first)", async () => {
    const t = initConvexTest();

    // Create workflows in order with different inputs to identify them
    const wf1 = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: { order: 1 },
    });
    const wf2 = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: { order: 2 },
    });
    const wf3 = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: { order: 3 },
    });

    // Claim first - should get oldest (wf1)
    const claimed1 = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });
    expect(claimed1?.workflowId).toEqual(wf1);
    expect(claimed1?.input).toEqual({ order: 1 });

    // Complete wf1 so we can claim next
    await t.mutation(api.lib.completeWorkflow, {
      workflowId: wf1,
      workerId: "worker-1",
      output: {},
    });

    // Claim second - should get wf2
    const claimed2 = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });
    expect(claimed2?.workflowId).toEqual(wf2);
    expect(claimed2?.input).toEqual({ order: 2 });

    // Complete wf2
    await t.mutation(api.lib.completeWorkflow, {
      workflowId: wf2,
      workerId: "worker-1",
      output: {},
    });

    // Claim third - should get wf3 (newest)
    const claimed3 = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });
    expect(claimed3?.workflowId).toEqual(wf3);
    expect(claimed3?.input).toEqual({ order: 3 });
  });

  test("claims workflows in global FIFO order across different workflow types", async () => {
    const t = initConvexTest();

    // Create workflows of different types, interleaved
    // Order: greet1, order1, greet2, order2
    const greet1 = await t.mutation(api.lib.startWorkflow, {
      name: "greet",
      input: { order: 1 },
    });
    const order1 = await t.mutation(api.lib.startWorkflow, {
      name: "order",
      input: { order: 2 },
    });
    const greet2 = await t.mutation(api.lib.startWorkflow, {
      name: "greet",
      input: { order: 3 },
    });
    const order2 = await t.mutation(api.lib.startWorkflow, {
      name: "order",
      input: { order: 4 },
    });

    // Claim should return workflows in global creation order, not grouped by name
    const claimed1 = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["greet", "order"],
      workerId: "worker-1",
    });
    expect(claimed1?.workflowId).toEqual(greet1);
    expect(claimed1?.name).toEqual("greet");

    await t.mutation(api.lib.completeWorkflow, {
      workflowId: greet1,
      workerId: "worker-1",
      output: {},
    });

    // Second should be order1 (created second globally)
    const claimed2 = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["greet", "order"],
      workerId: "worker-1",
    });
    expect(claimed2?.workflowId).toEqual(order1);
    expect(claimed2?.name).toEqual("order");

    await t.mutation(api.lib.completeWorkflow, {
      workflowId: order1,
      workerId: "worker-1",
      output: {},
    });

    // Third should be greet2
    const claimed3 = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["greet", "order"],
      workerId: "worker-1",
    });
    expect(claimed3?.workflowId).toEqual(greet2);
    expect(claimed3?.name).toEqual("greet");

    await t.mutation(api.lib.completeWorkflow, {
      workflowId: greet2,
      workerId: "worker-1",
      output: {},
    });

    // Fourth should be order2
    const claimed4 = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["greet", "order"],
      workerId: "worker-1",
    });
    expect(claimed4?.workflowId).toEqual(order2);
    expect(claimed4?.name).toEqual("order");
  });

  test('claimAll ("*") claims workflows globally in FIFO order', async () => {
    const t = initConvexTest();

    // Create workflows of different types, interleaved.
    // Order: greet1, order1, greet2
    const greet1 = await t.mutation(api.lib.startWorkflow, {
      name: "greet",
      input: { order: 1 },
    });
    const order1 = await t.mutation(api.lib.startWorkflow, {
      name: "order",
      input: { order: 2 },
    });
    const greet2 = await t.mutation(api.lib.startWorkflow, {
      name: "greet",
      input: { order: 3 },
    });

    const claimed1 = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["*"],
      workerId: "worker-1",
    });
    expect(claimed1?.workflowId).toEqual(greet1);
    expect(claimed1?.name).toEqual("greet");

    await t.mutation(api.lib.completeWorkflow, {
      workflowId: greet1,
      workerId: "worker-1",
      output: {},
    });

    const claimed2 = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["*"],
      workerId: "worker-1",
    });
    expect(claimed2?.workflowId).toEqual(order1);
    expect(claimed2?.name).toEqual("order");

    await t.mutation(api.lib.completeWorkflow, {
      workflowId: order1,
      workerId: "worker-1",
      output: {},
    });

    const claimed3 = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["*"],
      workerId: "worker-1",
    });
    expect(claimed3?.workflowId).toEqual(greet2);
    expect(claimed3?.name).toEqual("greet");
  });

  test("can put workflow to sleep", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: {},
    });

    // Claim the workflow
    await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });

    // Put workflow to sleep
    const sleepUntil = Date.now() + 60_000;
    const ok = await t.mutation(api.lib.sleepWorkflow, {
      workflowId,
      workerId: "worker-1",
      sleepUntil,
    });
    expect(ok).toBe(true);

    const workflow = await t.query(api.lib.getWorkflow, { workflowId });
    expect(workflow?.status).toEqual("sleeping");
    expect(workflow?.sleepUntil).toEqual(sleepUntil);
    expect(workflow?.claimedBy).toBeNull();
  });

  test("rejects sleep from non-owner worker", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: {},
    });

    // Claim the workflow
    await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });

    // Try to sleep from different worker
    const ok = await t.mutation(api.lib.sleepWorkflow, {
      workflowId,
      workerId: "worker-2",
      sleepUntil: Date.now() + 60_000,
    });
    expect(ok).toBe(false);

    const workflow = await t.query(api.lib.getWorkflow, { workflowId });
    expect(workflow?.status).toEqual("running");
  });

  test("can claim sleeping workflow after sleepUntil time", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: { data: "test" },
    });

    // Claim and sleep the workflow
    await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });

    const sleepUntil = Date.now() + 60_000;
    await t.mutation(api.lib.sleepWorkflow, {
      workflowId,
      workerId: "worker-1",
      sleepUntil,
    });

    // Advance time past sleepUntil
    vi.advanceTimersByTime(61_000);

    // Should be able to claim the sleeping workflow
    const claimed = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-2",
    });

    expect(claimed).toBeDefined();
    expect(claimed?.workflowId).toEqual(workflowId);
    expect(claimed?.input).toEqual({ data: "test" });

    const workflow = await t.query(api.lib.getWorkflow, { workflowId });
    expect(workflow?.status).toEqual("running");
    expect(workflow?.claimedBy).toEqual("worker-2");
    expect(workflow?.sleepUntil).toBeUndefined();
  });

  test("cannot claim sleeping workflow before sleepUntil time", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: {},
    });

    // Claim and sleep the workflow
    await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });

    await t.mutation(api.lib.sleepWorkflow, {
      workflowId: (await t.query(api.lib.listWorkflows, {}))[0]._id,
      workerId: "worker-1",
      sleepUntil: Date.now() + 60_000,
    });

    // Advance time but not past sleepUntil
    vi.advanceTimersByTime(30_000);

    // Should not be able to claim yet
    const claimed = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-2",
    });

    expect(claimed).toBeNull();
  });

  test("claimAll can claim expired sleeping workflows globally", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.lib.startWorkflow, {
      name: "test-workflow",
      input: { data: "global" },
    });

    // Claim and sleep
    await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["test-workflow"],
      workerId: "worker-1",
    });

    await t.mutation(api.lib.sleepWorkflow, {
      workflowId,
      workerId: "worker-1",
      sleepUntil: Date.now() + 60_000,
    });

    // Advance past sleepUntil
    vi.advanceTimersByTime(61_000);

    // Claim with wildcard
    const claimed = await t.mutation(api.lib.claimWorkflow, {
      workflowNames: ["*"],
      workerId: "worker-2",
    });

    expect(claimed).toBeDefined();
    expect(claimed?.workflowId).toEqual(workflowId);
  });
});
