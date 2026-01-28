/**
 * Example Worker
 *
 * This demonstrates how to run a worker that executes workflows locally.
 * The actual step code runs on YOUR machine, not on Convex.
 *
 * Run with: bun example/worker.ts
 */

import { ConvexClient } from "convex/browser";
import { workflow, createWorker } from "../src/client/index.js";
import { api } from "./convex/_generated/api.js";

// Get CONVEX_URL from environment
const CONVEX_URL = process.env.CONVEX_URL as string;
if (!CONVEX_URL) {
  console.error("CONVEX_URL environment variable is required");
  console.error("Run: export CONVEX_URL=<your-convex-url>");
  process.exit(1);
}

const WORKER_CONCURRENCY_RAW = process.env.WORKER_CONCURRENCY;
const WORKER_CONCURRENCY = (() => {
  if (!WORKER_CONCURRENCY_RAW) return 4;
  const n = Number.parseInt(WORKER_CONCURRENCY_RAW, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
})();

// ============================================================================
// Define Activities (the actual work that runs on your machine)
// ============================================================================

const activities = {
  async sendEmail(to: string, subject: string, body: string) {
    // Simulate sending an email
    console.log(`📧 Sending email to ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Body: ${body}`);
    await sleep(500); // Simulate network delay
    return { sent: true, messageId: `msg_${Date.now()}` };
  },

  async processPayment(amount: number, currency: string) {
    // Simulate payment processing
    console.log(`💳 Processing payment: ${amount} ${currency}`);
    await sleep(1000); // Simulate payment processing time
    const success = Math.random() > 0.1; // 90% success rate
    if (!success) {
      throw new Error("Payment declined");
    }
    return {
      success: true,
      transactionId: `txn_${Date.now()}`,
      amount,
      currency,
    };
  },

  async fetchUserData(userId: string) {
    // Simulate fetching user data
    console.log(`👤 Fetching user data for ${userId}`);
    await sleep(300);
    return {
      id: userId,
      name: "John Doe",
      email: "john@example.com",
    };
  },

  async generateReport(data: unknown) {
    // Simulate report generation
    console.log(`📊 Generating report...`);
    await sleep(800);
    return {
      reportId: `report_${Date.now()}`,
      generatedAt: new Date().toISOString(),
      summary: `Report for ${JSON.stringify(data)}`,
    };
  },
};

// ============================================================================
// Define Workflows
// ============================================================================

interface OrderInput {
  userId: string;
  items: Array<{ name: string; price: number }>;
  email: string;
}

const orderWorkflow = workflow("order", async (ctx, input: OrderInput) => {
  console.log(`\n🚀 Starting order workflow for user ${input.userId}`);

  // Step 1: Fetch user data
  const user = await ctx.step("fetch-user", () =>
    activities.fetchUserData(input.userId)
  );
  console.log(`   User: ${user.name}`);

  // Step 2: Calculate total and process payment
  const total = input.items.reduce((sum, item) => sum + item.price, 0);
  const payment = await ctx.step("process-payment", () =>
    activities.processPayment(total, "USD")
  );
  console.log(`   Payment: ${payment.transactionId}`);

  // Step 3: Send confirmation email
  const email = await ctx.step("send-confirmation", () =>
    activities.sendEmail(
      input.email,
      "Order Confirmed!",
      `Your order of $${total} has been confirmed. Transaction: ${payment.transactionId}`
    )
  );
  console.log(`   Email sent: ${email.messageId}`);

  // Step 4: Generate receipt
  const receipt = await ctx.step("generate-receipt", () =>
    activities.generateReport({
      orderId: `order_${Date.now()}`,
      user: user.name,
      items: input.items,
      total,
      payment: payment.transactionId,
    })
  );

  console.log(`✅ Order workflow completed!`);

  return {
    orderId: receipt.reportId,
    total,
    transactionId: payment.transactionId,
  };
});

// Simple workflow for testing
const greetWorkflow = workflow("greet", async (ctx, input: { name: string }) => {
  console.log(`\n👋 Starting greet workflow for ${input.name}`);

  const greeting = await ctx.step("create-greeting", async () => {
    await sleep(500);
    return `Hello, ${input.name}!`;
  });

  const timestamp = await ctx.step("add-timestamp", async () => {
    await sleep(300);
    return new Date().toISOString();
  });

  console.log(`✅ Greet workflow completed!`);

  return { greeting, timestamp };
});

// Stress test workflow with 100 steps
const stressWorkflow = workflow("stress", async (ctx, input: { count: number }) => {
  const stepCount = input.count || 100;
  console.log(`\n🔥 Starting stress workflow with ${stepCount} steps`);

  const results: Array<{ step: number; value: number; timestamp: string }> = [];

  for (let i = 1; i <= stepCount; i++) {
    const result = await ctx.step(`step-${i.toString().padStart(3, "0")}`, async () => {
      // Simulate some work (fast, ~50ms each)
      await sleep(50);
      return {
        step: i,
        value: Math.floor(Math.random() * 1000),
        timestamp: new Date().toISOString(),
      };
    });
    results.push(result);

    if (i % 10 === 0) {
      console.log(`   Completed ${i}/${stepCount} steps`);
    }
  }

  console.log(`✅ Stress workflow completed! Processed ${results.length} steps`);

  return {
    totalSteps: results.length,
    firstStep: results[0],
    lastStep: results[results.length - 1],
    sum: results.reduce((acc, r) => acc + r.value, 0),
  };
});

// Reminder workflow demonstrating ctx.sleep()
interface ReminderInput {
  message: string;
  delaySeconds: number;
}

const reminderWorkflow = workflow("reminder", async (ctx, input: ReminderInput) => {
  console.log(`\n⏰ Starting reminder workflow`);
  console.log(`   Message: "${input.message}"`);
  console.log(`   Delay: ${input.delaySeconds} seconds`);

  // Step 1: Acknowledge the reminder was scheduled
  const scheduledAt = await ctx.step("schedule", async () => {
    const now = new Date().toISOString();
    console.log(`   Reminder scheduled at ${now}`);
    return now;
  });

  // Sleep for the specified duration (workflow pauses here)
  console.log(`   💤 Sleeping for ${input.delaySeconds} seconds...`);
  await ctx.sleep("delay", input.delaySeconds * 1000);
  console.log(`   ⏰ Woke up!`);

  // Step 2: Send the reminder
  const reminder = await ctx.step("send-reminder", async () => {
    const sentAt = new Date().toISOString();
    console.log(`   🔔 REMINDER: ${input.message}`);
    return {
      message: input.message,
      scheduledAt,
      sentAt,
    };
  });

  console.log(`✅ Reminder workflow completed!`);

  return reminder;
});

// ============================================================================
// Start the Worker
// ============================================================================

async function main() {
  console.log("🔌 Connecting to Convex...");
  const client = new ConvexClient(CONVEX_URL);

  // Wait for connection
  await sleep(1000);

  // Use the app's API (api.example) which wraps the component
  const worker = createWorker(client, api.example, {
    workflows: [orderWorkflow, greetWorkflow, stressWorkflow, reminderWorkflow],
    pollIntervalMs: 2000,
    maxConcurrentWorkflows: WORKER_CONCURRENCY,
  });

  console.log("\n📋 Starting worker...");
  await worker.start();

  console.log("\n✨ Worker is running! Waiting for workflows...");
  console.log("   Press Ctrl+C to stop\n");

  // Keep the process running
  process.on("SIGINT", () => {
    console.log("\n\n🛑 Shutting down worker...");
    worker.stop();
    client.close();
    process.exit(0);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
