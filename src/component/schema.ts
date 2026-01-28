import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const workflowStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("sleeping"),
  v.literal("completed"),
  v.literal("failed"),
);

export const stepStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);

export default defineSchema({
  // Workflow instances
  workflows: defineTable({
    name: v.string(), // workflow type name (e.g., "order", "onboarding")
    status: workflowStatus,
    input: v.any(), // JSON input to the workflow
    output: v.optional(v.any()), // JSON output when completed
    error: v.optional(v.string()), // error message if failed
    claimedBy: v.optional(v.union(v.string(), v.null())), // worker ID that's running this
    claimedAt: v.optional(v.union(v.number(), v.null())), // last heartbeat/claim time
    leaseExpiresAt: v.optional(v.union(v.number(), v.null())), // for efficient reclaiming
    // Used to prevent duplicate step rows under concurrency.
    stepIdsByName: v.optional(v.record(v.string(), v.id("steps"))),
    // When the workflow should wake up from sleeping state
    sleepUntil: v.optional(v.number()),
  })
    .index("status", ["status"])
    .index("status_leaseExpiresAt", ["status", "leaseExpiresAt"])
    .index("name_status", ["name", "status"])
    .index("name_status_leaseExpiresAt", ["name", "status", "leaseExpiresAt"])
    .index("name_status_sleepUntil", ["name", "status", "sleepUntil"])
    .index("status_sleepUntil", ["status", "sleepUntil"]),

  // Individual step executions within a workflow
  steps: defineTable({
    workflowId: v.id("workflows"),
    name: v.string(), // step name (unique within workflow)
    status: stepStatus,
    output: v.optional(v.any()), // step result when completed
    error: v.optional(v.string()), // error if failed
    // Only set for internal sleep markers (ctx.sleep / ctx.sleepUntil).
    sleepUntil: v.optional(v.number()),
    attempts: v.number(), // retry count
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("workflowId", ["workflowId"])
    .index("workflowId_name", ["workflowId", "name"]),
});
