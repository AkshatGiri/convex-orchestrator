/**
 * Trigger Workflows
 *
 * This script demonstrates how to start workflows from any client.
 * Run with: bun example/trigger.ts [workflow-name]
 * Or send a signal: bun example/trigger.ts signal <workflowId> <signalName> <jsonPayload>
 *
 * Examples:
 *   bun example/trigger.ts greet
 *   bun example/trigger.ts order
 *   bun example/trigger.ts approval
 *
 *   bun example/trigger.ts signal <workflowId> approved '{"approved":true}'
 */

import { ConvexClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL as string;
if (!CONVEX_URL) {
  console.error("CONVEX_URL environment variable is required");
  process.exit(1);
}

async function main() {
  const command = process.argv[2] || "greet";

  console.log("🔌 Connecting to Convex...");
  const client = new ConvexClient(CONVEX_URL);
  await sleep(1000);

  if (command === "signal") {
    const workflowId = process.argv[3];
    const signalName = process.argv[4];
    const payloadRaw = process.argv[5] ?? "null";

    if (!workflowId || !signalName) {
      console.error(
        `Usage: bun example/trigger.ts signal <workflowId> <signalName> <jsonPayload>`,
      );
      process.exit(1);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadRaw);
    } catch (e) {
      console.error(`Invalid JSON payload: ${payloadRaw}`);
      throw e;
    }

    const ok = await client.mutation(api.example.signalWorkflow, {
      workflowId,
      signal: signalName,
      payload,
    });

    console.log(
      ok
        ? `✅ Sent signal "${signalName}" to ${workflowId}`
        : `❌ Failed to send signal "${signalName}" to ${workflowId}`,
    );
    client.close();
    return;
  }

  const workflowName = command;
  console.log(`\n🚀 Starting "${workflowName}" workflow...`);

  let input: unknown;
  switch (workflowName) {
    case "greet":
      input = { name: "World" };
      break;
    case "order":
      input = {
        userId: "user_123",
        email: "customer@example.com",
        items: [
          { name: "Widget", price: 29.99 },
          { name: "Gadget", price: 49.99 },
        ],
      };
      break;
    case "approval":
      input = {
        requestId: `req_${Date.now()}`,
        requester: "demo@example.com",
      };
      break;
    default:
      console.error(`Unknown workflow: ${workflowName}`);
      process.exit(1);
  }

  const workflowId = await client.mutation(api.example.startWorkflow, {
    name: workflowName,
    input,
  });

  console.log(`✅ Workflow started: ${workflowId}`);
  console.log(`   Input: ${JSON.stringify(input)}`);

  // Poll for result
  console.log("\n⏳ Waiting for result...");
  while (true) {
    const workflow = await client.query(api.example.getWorkflow, {
      workflowId: workflowId as string,
    });

    if (!workflow) {
      console.error("Workflow not found!");
      break;
    }

    if (workflow.status === "completed") {
      console.log(`\n🎉 Workflow completed!`);
      console.log(`   Output: ${JSON.stringify(workflow.output, null, 2)}`);
      break;
    }

    if (workflow.status === "failed") {
      console.log(`\n❌ Workflow failed!`);
      console.log(`   Error: ${workflow.error}`);
      break;
    }

    console.log(`   Status: ${workflow.status}...`);
    if (workflow.status === "waiting") {
      console.log(
        `   Waiting for signal. Send one with: bun example/trigger.ts signal ${workflowId} approved '{"approved":true}'`,
      );
    }
    await sleep(1000);
  }

  client.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
