import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const workflowStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed")
);

export const stepStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed")
);

export default defineSchema({
  // Workflow instances
  workflows: defineTable({
    name: v.string(), // workflow type name (e.g., "order", "onboarding")
    status: workflowStatus,
    input: v.any(), // JSON input to the workflow
    output: v.optional(v.any()), // JSON output when completed
    error: v.optional(v.string()), // error message if failed
    claimedBy: v.optional(v.string()), // worker ID that's running this
    claimedAt: v.optional(v.number()), // when it was claimed (for timeout)
  })
    .index("status", ["status"])
    .index("name_status", ["name", "status"]),

  // Individual step executions within a workflow
  steps: defineTable({
    workflowId: v.id("workflows"),
    name: v.string(), // step name (unique within workflow)
    status: stepStatus,
    output: v.optional(v.any()), // step result when completed
    error: v.optional(v.string()), // error if failed
    attempts: v.number(), // retry count
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("workflowId", ["workflowId"])
    .index("workflowId_name", ["workflowId", "name"]),
});
