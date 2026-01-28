import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { workflowStatus, stepStatus } from "./schema.js";

// How long before a claimed workflow is considered abandoned (30 seconds)
const CLAIM_TIMEOUT_MS = 30_000;
const ALL_WORKFLOWS = "*";

// ============================================================================
// Workflow Management
// ============================================================================

/**
 * Start a new workflow instance
 */
export const startWorkflow = mutation({
  args: {
    name: v.string(),
    input: v.any(),
  },
  returns: v.id("workflows"),
  handler: async (ctx, args) => {
    const workflowId = await ctx.db.insert("workflows", {
      name: args.name,
      status: "pending",
      input: args.input,
    });
    return workflowId;
  },
});

/**
 * Claim a pending workflow for execution
 * Returns null if no workflow available or claim failed
 */
export const claimWorkflow = mutation({
  args: {
    workflowNames: v.array(v.string()), // which workflow types this worker handles
    workerId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      workflowId: v.id("workflows"),
      name: v.string(),
      input: v.any(),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const leaseExpiresAt = now + CLAIM_TIMEOUT_MS;

    const claimAll = args.workflowNames.includes(ALL_WORKFLOWS);

    if (claimAll) {
      // Claim the oldest pending workflow globally (FIFO).
      const pending = await ctx.db
        .query("workflows")
        .withIndex("status", (q) => q.eq("status", "pending"))
        .order("asc")
        .first();

      if (pending) {
        await ctx.db.patch(pending._id, {
          status: "running",
          claimedBy: args.workerId,
          claimedAt: now,
          leaseExpiresAt,
        });
        return {
          workflowId: pending._id,
          name: pending.name,
          input: pending.input,
        };
      }

      // Check for sleeping workflows that should wake up (claimAll case)
      const sleepingGlobal = await ctx.db
        .query("workflows")
        .withIndex("status_sleepUntil", (q) =>
          q.eq("status", "sleeping").lte("sleepUntil", now),
        )
        .first();

      if (sleepingGlobal) {
        await ctx.db.patch(sleepingGlobal._id, {
          status: "running",
          claimedBy: args.workerId,
          claimedAt: now,
          leaseExpiresAt,
          sleepUntil: undefined,
        });
        return {
          workflowId: sleepingGlobal._id,
          name: sleepingGlobal.name,
          input: sleepingGlobal.input,
        };
      }

      // Reclaim the most-expired lease globally.
      const expired = await ctx.db
        .query("workflows")
        .withIndex("status_leaseExpiresAt", (q) =>
          q.eq("status", "running").lt("leaseExpiresAt", now),
        )
        .order("asc")
        .first();

      if (expired) {
        await ctx.db.patch(expired._id, {
          claimedBy: args.workerId,
          claimedAt: now,
          leaseExpiresAt,
        });
        return {
          workflowId: expired._id,
          name: expired.name,
          input: expired.input,
        };
      }

      // Back-compat: reclaim older running workflows missing leaseExpiresAt.
      const legacyRunning = await ctx.db
        .query("workflows")
        .withIndex("status", (q) => q.eq("status", "running"))
        .order("asc")
        .take(25);
      for (const workflow of legacyRunning) {
        if (
          workflow.leaseExpiresAt == null &&
          workflow.claimedAt != null &&
          now - workflow.claimedAt > CLAIM_TIMEOUT_MS
        ) {
          await ctx.db.patch(workflow._id, {
            claimedBy: args.workerId,
            claimedAt: now,
            leaseExpiresAt,
          });
          return {
            workflowId: workflow._id,
            name: workflow.name,
            input: workflow.input,
          };
        }
      }

      return null;
    }

    // First, try to find a pending workflow (oldest first - global FIFO across requested names)
    // Query each name and find the globally oldest pending workflow
    let oldestPending: Awaited<ReturnType<typeof ctx.db.get>> | null = null;

    for (const name of args.workflowNames) {
      const pending = await ctx.db
        .query("workflows")
        .withIndex("name_status", (q) =>
          q.eq("name", name).eq("status", "pending"),
        )
        .order("asc")
        .first();

      if (pending) {
        if (
          !oldestPending ||
          pending._creationTime < oldestPending._creationTime
        ) {
          oldestPending = pending;
        }
      }
    }

    if (oldestPending) {
      await ctx.db.patch(oldestPending._id, {
        status: "running",
        claimedBy: args.workerId,
        claimedAt: now,
        leaseExpiresAt,
      });
      return {
        workflowId: oldestPending._id,
        name: oldestPending.name,
        input: oldestPending.input,
      };
    }

    // Check for sleeping workflows that should wake up (per-name case)
    // Use an index on sleepUntil to avoid starvation (no `take(25)` scan).
    let bestSleeping: Awaited<ReturnType<typeof ctx.db.get>> | null = null;

    for (const name of args.workflowNames) {
      const sleeping = await ctx.db
        .query("workflows")
        .withIndex("name_status_sleepUntil", (q) =>
          q.eq("name", name).eq("status", "sleeping").lte("sleepUntil", now),
        )
        .first();

      if (!sleeping) continue;

      if (!bestSleeping) {
        bestSleeping = sleeping;
        continue;
      }

      const sleepingUntil = sleeping.sleepUntil ?? Number.POSITIVE_INFINITY;
      const bestUntil = bestSleeping.sleepUntil ?? Number.POSITIVE_INFINITY;

      if (
        sleepingUntil < bestUntil ||
        (sleepingUntil === bestUntil &&
          sleeping._creationTime < bestSleeping._creationTime)
      ) {
        bestSleeping = sleeping;
      }
    }

    if (bestSleeping) {
      await ctx.db.patch(bestSleeping._id, {
        status: "running",
        claimedBy: args.workerId,
        claimedAt: now,
        leaseExpiresAt,
        sleepUntil: undefined,
      });
      return {
        workflowId: bestSleeping._id,
        name: bestSleeping.name,
        input: bestSleeping.input,
      };
    }

    // Check for abandoned workflows (claimed but timed out) - oldest first globally
    let oldestExpired: Awaited<ReturnType<typeof ctx.db.get>> | null = null;

    for (const name of args.workflowNames) {
      const expired = await ctx.db
        .query("workflows")
        .withIndex("name_status_leaseExpiresAt", (q) =>
          q.eq("name", name).eq("status", "running").lt("leaseExpiresAt", now),
        )
        .order("asc")
        .first();

      if (expired) {
        if (
          !oldestExpired ||
          expired._creationTime < oldestExpired._creationTime
        ) {
          oldestExpired = expired;
        }
      }
    }

    if (oldestExpired) {
      await ctx.db.patch(oldestExpired._id, {
        claimedBy: args.workerId,
        claimedAt: now,
        leaseExpiresAt,
      });
      return {
        workflowId: oldestExpired._id,
        name: oldestExpired.name,
        input: oldestExpired.input,
      };
    }

    // Back-compat: reclaim older running workflows missing leaseExpiresAt
    let oldestLegacy: Awaited<ReturnType<typeof ctx.db.get>> | null = null;

    for (const name of args.workflowNames) {
      const legacyRunning = await ctx.db
        .query("workflows")
        .withIndex("name_status", (q) =>
          q.eq("name", name).eq("status", "running"),
        )
        .order("asc")
        .take(25);

      for (const workflow of legacyRunning) {
        if (
          workflow.leaseExpiresAt == null &&
          workflow.claimedAt != null &&
          now - workflow.claimedAt > CLAIM_TIMEOUT_MS
        ) {
          if (
            !oldestLegacy ||
            workflow._creationTime < oldestLegacy._creationTime
          ) {
            oldestLegacy = workflow;
          }
        }
      }
    }

    if (oldestLegacy) {
      await ctx.db.patch(oldestLegacy._id, {
        claimedBy: args.workerId,
        claimedAt: now,
        leaseExpiresAt,
      });
      return {
        workflowId: oldestLegacy._id,
        name: oldestLegacy.name,
        input: oldestLegacy.input,
      };
    }

    return null;
  },
});

/**
 * Heartbeat to keep a workflow claim alive
 */
export const heartbeat = mutation({
  args: {
    workflowId: v.id("workflows"),
    workerId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow || workflow.claimedBy !== args.workerId) {
      return false;
    }
    await ctx.db.patch(args.workflowId, {
      claimedAt: Date.now(),
      leaseExpiresAt: Date.now() + CLAIM_TIMEOUT_MS,
    });
    return true;
  },
});

/**
 * Complete a workflow successfully
 */
export const completeWorkflow = mutation({
  args: {
    workflowId: v.id("workflows"),
    workerId: v.string(),
    output: v.any(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow || workflow.claimedBy !== args.workerId) {
      return false;
    }
    await ctx.db.patch(args.workflowId, {
      status: "completed",
      output: args.output,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
    });
    return true;
  },
});

/**
 * Fail a workflow
 */
export const failWorkflow = mutation({
  args: {
    workflowId: v.id("workflows"),
    workerId: v.string(),
    error: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow || workflow.claimedBy !== args.workerId) {
      return false;
    }
    await ctx.db.patch(args.workflowId, {
      status: "failed",
      error: args.error,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
    });
    return true;
  },
});

/**
 * Put workflow to sleep until a specific timestamp
 */
export const sleepWorkflow = mutation({
  args: {
    workflowId: v.id("workflows"),
    workerId: v.string(),
    sleepUntil: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (
      !workflow ||
      workflow.status !== "running" ||
      workflow.claimedBy !== args.workerId
    ) {
      return false;
    }
    await ctx.db.patch(args.workflowId, {
      status: "sleeping",
      sleepUntil: args.sleepUntil,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
    });
    return true;
  },
});

/**
 * Get workflow status
 */
export const getWorkflow = query({
  args: {
    workflowId: v.id("workflows"),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("workflows"),
      _creationTime: v.number(),
      name: v.string(),
      status: workflowStatus,
      input: v.any(),
      output: v.optional(v.any()),
      error: v.optional(v.string()),
      claimedBy: v.optional(v.union(v.string(), v.null())),
      sleepUntil: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow) return null;
    return {
      _id: workflow._id,
      _creationTime: workflow._creationTime,
      name: workflow.name,
      status: workflow.status,
      input: workflow.input,
      output: workflow.output,
      error: workflow.error,
      claimedBy: workflow.claimedBy,
      sleepUntil: workflow.sleepUntil,
    };
  },
});

/**
 * List workflows (for dashboard)
 */
export const listWorkflows = query({
  args: {
    status: v.optional(workflowStatus),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("workflows"),
      _creationTime: v.number(),
      name: v.string(),
      status: workflowStatus,
      input: v.any(),
      output: v.optional(v.any()),
      error: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    const workflows = args.status
      ? await ctx.db
          .query("workflows")
          .withIndex("status", (q) => q.eq("status", args.status!))
          .order("desc")
          .take(limit)
      : await ctx.db.query("workflows").order("desc").take(limit);

    return workflows.map((w) => ({
      _id: w._id,
      _creationTime: w._creationTime,
      name: w.name,
      status: w.status,
      input: w.input,
      output: w.output,
      error: w.error,
    }));
  },
});

// ============================================================================
// Step Management
// ============================================================================

/**
 * Get or create a step for a workflow
 * Returns the step status and result if already completed
 */
export const getOrCreateStep = mutation({
  args: {
    workflowId: v.id("workflows"),
    stepName: v.string(),
    workerId: v.string(),
  },
  returns: v.object({
    stepId: v.id("steps"),
    status: stepStatus,
    output: v.optional(v.any()),
    error: v.optional(v.string()),
    sleepUntil: v.optional(v.number()),
    isNew: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (
      !workflow ||
      workflow.status !== "running" ||
      workflow.claimedBy !== args.workerId
    ) {
      throw new Error("Workflow not claimed by worker");
    }

    const existingStepId = workflow.stepIdsByName?.[args.stepName];
    if (existingStepId) {
      const step = await ctx.db.get(existingStepId);
      if (step) {
        return {
          stepId: step._id,
          status: step.status,
          output: step.output,
          error: step.error,
          sleepUntil: step.sleepUntil,
          isNew: false,
        };
      }
    }

    // Create new step
    const stepId = await ctx.db.insert("steps", {
      workflowId: args.workflowId,
      name: args.stepName,
      status: "running",
      attempts: 1,
      startedAt: Date.now(),
    });

    await ctx.db.patch(args.workflowId, {
      stepIdsByName: {
        ...(workflow.stepIdsByName ?? {}),
        [args.stepName]: stepId,
      },
    });

    return {
      stepId,
      status: "running" as const,
      output: undefined,
      error: undefined,
      sleepUntil: undefined,
      isNew: true,
    };
  },
});

/**
 * Atomically schedule a workflow sleep and associate it with a running step.
 *
 * This is used by ctx.sleep()/ctx.sleepUntil() so replays can resume without
 * re-sleeping indefinitely: the step holds the durable sleepUntil marker.
 */
export const scheduleSleep = mutation({
  args: {
    workflowId: v.id("workflows"),
    stepId: v.id("steps"),
    workerId: v.string(),
    sleepUntil: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (
      !workflow ||
      workflow.status !== "running" ||
      workflow.claimedBy !== args.workerId
    ) {
      return false;
    }

    const step = await ctx.db.get(args.stepId);
    if (
      !step ||
      step.workflowId !== args.workflowId ||
      step.status !== "running"
    ) {
      return false;
    }

    const chosenSleepUntil = step.sleepUntil ?? args.sleepUntil;
    if (chosenSleepUntil <= Date.now()) {
      // No need to sleep; caller should complete the marker step instead.
      return false;
    }

    if (step.sleepUntil == null) {
      await ctx.db.patch(step._id, { sleepUntil: chosenSleepUntil });
    }

    await ctx.db.patch(args.workflowId, {
      status: "sleeping",
      sleepUntil: chosenSleepUntil,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
    });
    return true;
  },
});

/**
 * Complete a step successfully
 */
export const completeStep = mutation({
  args: {
    stepId: v.id("steps"),
    workerId: v.string(),
    output: v.any(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step || step.status !== "running") {
      return false;
    }
    const workflow = await ctx.db.get(step.workflowId);
    if (
      !workflow ||
      workflow.status !== "running" ||
      workflow.claimedBy !== args.workerId
    ) {
      return false;
    }
    await ctx.db.patch(args.stepId, {
      status: "completed",
      output: args.output,
      sleepUntil: undefined,
      completedAt: Date.now(),
    });
    return true;
  },
});

/**
 * Fail a step
 */
export const failStep = mutation({
  args: {
    stepId: v.id("steps"),
    workerId: v.string(),
    error: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step || step.status !== "running") {
      return false;
    }
    const workflow = await ctx.db.get(step.workflowId);
    if (
      !workflow ||
      workflow.status !== "running" ||
      workflow.claimedBy !== args.workerId
    ) {
      return false;
    }
    await ctx.db.patch(args.stepId, {
      status: "failed",
      error: args.error,
      sleepUntil: undefined,
      completedAt: Date.now(),
    });
    return true;
  },
});

/**
 * Get all steps for a workflow
 */
export const getWorkflowSteps = query({
  args: {
    workflowId: v.id("workflows"),
  },
  returns: v.array(
    v.object({
      _id: v.id("steps"),
      _creationTime: v.number(),
      name: v.string(),
      status: stepStatus,
      output: v.optional(v.any()),
      error: v.optional(v.string()),
      attempts: v.number(),
      startedAt: v.optional(v.number()),
      completedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const steps = await ctx.db
      .query("steps")
      .withIndex("workflowId", (q) => q.eq("workflowId", args.workflowId))
      .collect();

    return steps.map((s) => ({
      _id: s._id,
      _creationTime: s._creationTime,
      name: s.name,
      status: s.status,
      output: s.output,
      error: s.error,
      attempts: s.attempts,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
    }));
  },
});

// ============================================================================
// Subscriptions for real-time updates
// ============================================================================

/**
 * Subscribe to pending workflows (for workers)
 * Also triggers when sleeping workflows are ready to wake
 */
export const subscribePendingWorkflows = query({
  args: {
    workflowNames: v.array(v.string()),
  },
  returns: v.number(), // just return count, triggers re-subscription
  handler: async (ctx, args) => {
    const now = Date.now();

    if (args.workflowNames.includes(ALL_WORKFLOWS)) {
      const pending = await ctx.db
        .query("workflows")
        .withIndex("status", (q) => q.eq("status", "pending"))
        .first();
      if (pending) return 1;

      // Check for sleeping workflows ready to wake
      const sleeping = await ctx.db
        .query("workflows")
        .withIndex("status_sleepUntil", (q) =>
          q.eq("status", "sleeping").lte("sleepUntil", now),
        )
        .first();
      if (sleeping) return 1;

      return 0;
    }

    for (const name of args.workflowNames) {
      const pending = await ctx.db
        .query("workflows")
        .withIndex("name_status", (q) =>
          q.eq("name", name).eq("status", "pending"),
        )
        .first();
      if (pending) return 1;
    }

    // Check for sleeping workflows ready to wake (per-name)
    for (const name of args.workflowNames) {
      const sleeping = await ctx.db
        .query("workflows")
        .withIndex("name_status_sleepUntil", (q) =>
          q.eq("name", name).eq("status", "sleeping").lte("sleepUntil", now),
        )
        .first();
      if (sleeping) {
        return 1;
      }
    }

    return 0;
  },
});
