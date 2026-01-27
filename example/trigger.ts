/**
 * Trigger Workflows
 *
 * This script demonstrates how to start workflows from any client.
 * Run with: bun example/trigger.ts [workflow-name]
 *
 * Examples:
 *   bun example/trigger.ts greet
 *   bun example/trigger.ts order
 */

import { ConvexClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL as string;
if (!CONVEX_URL) {
  console.error("CONVEX_URL environment variable is required");
  process.exit(1);
}

async function main() {
  const workflowName = process.argv[2] || "greet";

  console.log("🔌 Connecting to Convex...");
  const client = new ConvexClient(CONVEX_URL);
  await sleep(1000);

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
    await sleep(1000);
  }

  client.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
