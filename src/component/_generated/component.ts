/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      claimWorkflow: FunctionReference<
        "mutation",
        "internal",
        { workerId: string; workflowNames: Array<string> },
        null | { input: any; name: string; workflowId: string },
        Name
      >;
      completeStep: FunctionReference<
        "mutation",
        "internal",
        { output: any; stepId: string; workerId: string },
        boolean,
        Name
      >;
      completeWorkflow: FunctionReference<
        "mutation",
        "internal",
        { output: any; workerId: string; workflowId: string },
        boolean,
        Name
      >;
      failStep: FunctionReference<
        "mutation",
        "internal",
        { error: string; stepId: string; workerId: string },
        boolean,
        Name
      >;
      failWorkflow: FunctionReference<
        "mutation",
        "internal",
        { error: string; workerId: string; workflowId: string },
        boolean,
        Name
      >;
      getOrCreateStep: FunctionReference<
        "mutation",
        "internal",
        { stepName: string; workerId: string; workflowId: string },
        {
          error?: string;
          isNew: boolean;
          output?: any;
          status: "pending" | "running" | "completed" | "failed";
          stepId: string;
        },
        Name
      >;
      getWorkflow: FunctionReference<
        "query",
        "internal",
        { workflowId: string },
        null | {
          _creationTime: number;
          _id: string;
          error?: string;
          input: any;
          name: string;
          output?: any;
          status: "pending" | "running" | "completed" | "failed";
        },
        Name
      >;
      getWorkflowSteps: FunctionReference<
        "query",
        "internal",
        { workflowId: string },
        Array<{
          _creationTime: number;
          _id: string;
          attempts: number;
          completedAt?: number;
          error?: string;
          name: string;
          output?: any;
          startedAt?: number;
          status: "pending" | "running" | "completed" | "failed";
        }>,
        Name
      >;
      heartbeat: FunctionReference<
        "mutation",
        "internal",
        { workerId: string; workflowId: string },
        boolean,
        Name
      >;
      listWorkflows: FunctionReference<
        "query",
        "internal",
        {
          limit?: number;
          status?: "pending" | "running" | "completed" | "failed";
        },
        Array<{
          _creationTime: number;
          _id: string;
          error?: string;
          input: any;
          name: string;
          output?: any;
          status: "pending" | "running" | "completed" | "failed";
        }>,
        Name
      >;
      startWorkflow: FunctionReference<
        "mutation",
        "internal",
        { input: any; name: string },
        string,
        Name
      >;
      subscribePendingWorkflows: FunctionReference<
        "query",
        "internal",
        { workflowNames: Array<string> },
        number,
        Name
      >;
    };
  };
