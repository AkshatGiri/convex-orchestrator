import { components } from "./_generated/api.js";
import { exposeApi } from "@akshatgiri/convex-orchestrator";

// Expose the full orchestrator API for use from the frontend and worker
export const {
  // For starting workflows and viewing status (frontend/dashboard)
  startWorkflow,
  getWorkflow,
  listWorkflows,
  getWorkflowSteps,
  // For worker operations
  claimWorkflow,
  heartbeat,
  completeWorkflow,
  failWorkflow,
  getOrCreateStep,
  completeStep,
  failStep,
  subscribePendingWorkflows,
} = exposeApi(components.convexOrchestrator);
