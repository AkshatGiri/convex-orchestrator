import { components } from "./_generated/api.js";
import { exposeApi, exposeApiWithWorker } from "@akshatgiri/convex-orchestrator";

// Expose the full orchestrator API for use from the frontend and worker
export const {
  // For starting workflows and viewing status (frontend/dashboard)
  startWorkflow,
  getWorkflow,
  listWorkflows,
  getWorkflowSteps,
  signalWorkflow,
} = exposeApi(components.convexOrchestrator);

export const {
  // For worker operations (intentionally opt-in; protect in production)
  claimWorkflow,
  heartbeat,
  completeWorkflow,
  failWorkflow,
  getOrCreateStep,
  scheduleSleep,
  waitForSignal,
  completeStep,
  failStep,
  sleepWorkflow,
  subscribePendingWorkflows,
} = exposeApiWithWorker(components.convexOrchestrator, {
  authorize: () => true,
});
