import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("example", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  test("startWorkflow and getWorkflow", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.example.startWorkflow, {
      name: "test-workflow",
      input: { foo: "bar" },
    });
    expect(workflowId).toBeDefined();

    const workflow = await t.query(api.example.getWorkflow, {
      workflowId: workflowId as string,
    });
    expect(workflow).toBeDefined();
    expect(workflow?.name).toBe("test-workflow");
    expect(workflow?.status).toBe("pending");
  });

  test("listWorkflows", async () => {
    const t = initConvexTest();

    await t.mutation(api.example.startWorkflow, {
      name: "workflow-1",
      input: {},
    });
    await t.mutation(api.example.startWorkflow, {
      name: "workflow-2",
      input: {},
    });

    const workflows = await t.query(api.example.listWorkflows, {});
    expect(workflows).toHaveLength(2);
  });
});
