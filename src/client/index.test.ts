import { describe, expect, test } from "vitest";
import { exposeApi } from "./index.js";
import { anyApi, type ApiFromModules } from "convex/server";
import { components, initConvexTest } from "./setup.test.js";

export const { startWorkflow, getWorkflow, listWorkflows, getWorkflowSteps } =
  exposeApi(components.convexOrchestrator);

const testApi = (
  anyApi as unknown as ApiFromModules<{
    "index.test": {
      startWorkflow: typeof startWorkflow;
      getWorkflow: typeof getWorkflow;
      listWorkflows: typeof listWorkflows;
      getWorkflowSteps: typeof getWorkflowSteps;
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
});
