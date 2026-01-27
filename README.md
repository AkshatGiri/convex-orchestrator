# @akshatgiri/convex-orchestrator

Durable workflow orchestration on Convex where *step execution happens on your machines* (workers pull work from Convex), inspired by Temporal’s worker model.

This project is early-stage. The API may change.

## What you get

- Durable workflow runs stored in Convex (`workflows` + `steps` tables)
- A worker SDK (`createWorker`, `workflow`, `ctx.step`) that executes activities locally and records step results durably
- Leasing + heartbeats so workflows can be reclaimed if a worker dies
- Simple dashboard primitives: list workflows, view workflow + steps

## Install

```sh
npm i @akshatgiri/convex-orchestrator
```

## Add the component to your Convex app

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import convexOrchestrator from "@akshatgiri/convex-orchestrator/convex.config.js";

const app = defineApp();
app.use(convexOrchestrator);

export default app;
```

## Expose API from your app

Create a module in your Convex app (for example `convex/orchestrator.ts`) and export:

```ts
// convex/orchestrator.ts
import { components } from "./_generated/api.js";
import { exposeApi, exposeApiWithWorker } from "@akshatgiri/convex-orchestrator";

// Safe to expose to clients (dashboard + starters)
export const { startWorkflow, getWorkflow, listWorkflows, getWorkflowSteps } =
  exposeApi(components.convexOrchestrator);

// Worker operations (DO NOT expose without auth in production)
export const {
  claimWorkflow,
  heartbeat,
  completeWorkflow,
  failWorkflow,
  getOrCreateStep,
  completeStep,
  failStep,
  subscribePendingWorkflows,
} = exposeApiWithWorker(components.convexOrchestrator, {
  authorize: async (ctx) => {
    // TODO: implement real auth (service token / identity / secret)
    // Returning true is fine for local dev, unsafe for production.
    void ctx;
    return true;
  },
});
```

## Define workflows

```ts
import { workflow } from "@akshatgiri/convex-orchestrator";

const greet = workflow("greet", async (ctx, input: { name: string }) => {
  const greeting = await ctx.step("greeting", async () => `Hello, ${input.name}!`);
  return { greeting };
});
```

## Run a worker (on your machine)

```ts
import { ConvexClient } from "convex/browser";
import { createWorker } from "@akshatgiri/convex-orchestrator";
import { api } from "./convex/_generated/api.js";

const client = new ConvexClient(process.env.CONVEX_URL!);

const worker = createWorker(client, api.orchestrator, { workflows: [greet] });
await worker.start();
```

## Start a workflow

From any Convex client:

```ts
await client.mutation(api.orchestrator.startWorkflow, {
  name: "greet",
  input: { name: "World" },
});
```

## Execution model (important)

- `ctx.step("name", fn)` is durable: the first successful result is stored and returned on replay.
- Steps are **at-least-once** from the perspective of your side effects. Make your step code idempotent.
- Workers hold a **lease** and heartbeat while executing. If the lease expires, another worker may reclaim the workflow; the original worker should stop writing results.

## Demo (this repo)

```sh
npm i
npm run dev
```

In another terminal:

```sh
bun example/worker.ts
bun example/trigger.ts greet
```

## Limitations / TODOs

- No durable timers/sleep, signals, parallel DAG execution, or retries/backoff yet
- No built-in worker authentication/authorization (you must enforce this in your app)

## Contributing

Issues/PRs welcome: https://github.com/akshatgiri/convex-orchestrator/issues
