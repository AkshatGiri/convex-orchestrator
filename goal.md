# Convex Orchestrator

A durable orchestration/workflow engine built as a Convex component, similar to Temporal or Inngest, but with step execution happening on client machines rather than on Convex.

## Goals

- **Durable execution** - Workflows survive crashes, restarts, and failures
- **Client-side step execution** - Actual workflow step code runs on your machines, not on Convex servers
- **No exposed endpoints** - Unlike Restate, workers pull work from Convex (no need to expose HTTP endpoints)
- **Real-time + polling** - Leverage Convex's real-time subscriptions for responsiveness, with polling for correctness
- **Dashboard UI** - Eventually build a UI on top of the primitives for workflow visibility

## Why This Architecture

### Why not run steps on Convex?
- Access to local resources (files, databases, APIs behind firewalls)
- No cold start issues
- No function time limits for long-running tasks
- Don't need to deploy code to Convex for every workflow change

### Why Convex as the backend?
- Built-in durability and persistence
- Real-time subscriptions out of the box
- Transactional state updates
- Optimistic concurrency control

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Convex Backend                    │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │  Workflows  │  │    Steps     │  │   Results  │  │
│  │  (defined)  │  │  (pending)   │  │  (durable) │  │
│  └─────────────┘  └──────────────┘  └────────────┘  │
└────────────────────────┬────────────────────────────┘
                         │ real-time subscriptions
                         │ + polling for correctness
              ┌──────────┴──────────┐
              ▼                     ▼
        ┌──────────┐          ┌──────────┐
        │ Worker 1 │          │ Worker 2 │
        │ (your    │          │ (your    │
        │  machine)│          │  machine)│
        └──────────┘          └──────────┘
```

## Key Design Considerations

### Step Claiming
How do we prevent two workers from grabbing the same step?
- Optimistic locking with `claimedBy` field
- `claimedAt` timestamp for timeout-based release
- Convex transactions ensure atomic claiming

### Retries & Timeouts
- When does a step get released back to the queue if a worker dies mid-execution?
- Configurable timeout per step type
- Automatic retry with backoff

### Workflow Definition
- Code-first (like Temporal) vs config/DSL-first?
- How do we define the DAG of steps?

## Client SDK API (Temporal-style)

### Defining Activities (the actual work)
```ts
const activities = {
  async sendEmail(to: string, body: string) {
    await emailClient.send(to, body);
    return { sent: true };
  },

  async processPayment(amount: number) {
    const result = await stripe.charge(amount);
    return { success: true, id: result.id };
  },

  async fetchUserData(userId: string) {
    return await db.users.find(userId);
  },
};
```

### Defining Workflows (orchestration logic)
```ts
import { workflow } from "convex-orchestrator";

const orderWorkflow = workflow("order", async (ctx, input: OrderInput) => {
  // Each step is durable - if we crash after this, we won't re-run it
  const payment = await ctx.step("charge", () =>
    activities.processPayment(input.total)
  );

  // Conditional logic works naturally
  if (payment.success) {
    await ctx.step("notify", () =>
      activities.sendEmail(input.email, "Thanks for your order!")
    );
  }

  // Return value is stored as workflow result
  return { orderId: payment.id };
});
```

### Starting the Worker
```ts
import { createWorker } from "convex-orchestrator";
import { ConvexClient } from "convex/browser";

const convex = new ConvexClient(process.env.CONVEX_URL);

const worker = createWorker(convex, {
  workflows: [orderWorkflow],
});

await worker.start(); // Starts polling/subscribing for work
```

### Starting a Workflow (from anywhere)
```ts
// Option 1: From the worker client
const handle = await worker.start("order", {
  total: 100,
  email: "bob@test.com",
});

// Option 2: From any Convex client (another service, frontend, etc.)
await convex.mutation(api.orchestrator.start, {
  workflow: "order",
  input: { total: 100, email: "bob@test.com" },
});
```

### Querying Workflow Status
```ts
const handle = await worker.start("order", input);

// Get current status
const status = await handle.status();
// { state: "running", currentStep: "charge", startedAt: ... }

// Wait for completion and get result
const result = await handle.result();
// { orderId: "xyz123" }
```

### Advanced: Parallel Steps
```ts
const workflow = workflow("parallel-example", async (ctx, input) => {
  // Run multiple steps in parallel
  const [user, orders, notifications] = await ctx.parallel([
    ctx.step("fetch-user", () => activities.fetchUser(input.userId)),
    ctx.step("fetch-orders", () => activities.fetchOrders(input.userId)),
    ctx.step("fetch-notifications", () => activities.fetchNotifications(input.userId)),
  ]);

  return { user, orders, notifications };
});
```

### Advanced: Sleep/Timers
```ts
const workflow = workflow("reminder", async (ctx, input) => {
  await ctx.step("send-welcome", () => activities.sendEmail(input.email, "Welcome!"));

  // Durable sleep - survives crashes
  await ctx.sleep("followup-delay", 24 * 60 * 60 * 1000);

  await ctx.step("send-followup", () => activities.sendEmail(input.email, "How's it going?"));
});
```

### Advanced: Wait for External Signal
```ts
const workflow = workflow("approval", async (ctx, input) => {
  await ctx.step("request-approval", () =>
    activities.sendApprovalRequest(input.managerId)
  );

  // Wait for external signal (e.g., manager clicks approve)
  const approval = await ctx.waitForSignal("approved", { timeout: "48h" });

  if (approval.approved) {
    await ctx.step("provision", () => activities.provisionAccess(input.userId));
  }
});

// Send signal from anywhere
await convex.mutation(api.orchestrator.signal, {
  workflowId: "xxx",
  signal: "approved",
  payload: { approved: true, approvedBy: "manager@co.com" },
});
```

## Inspiration
- [Temporal](https://temporal.io) - Worker-based execution model
- [Inngest](https://inngest.com) - Event-driven workflows
- [Restate](https://restate.dev) - Durable execution engine (requires exposed endpoints)
- [Convex Workflow Component](https://github.com/get-convex/workflow) - Existing Convex workflow (runs on Convex)
