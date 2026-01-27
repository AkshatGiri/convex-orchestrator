import { defineApp } from "convex/server";
import convexOrchestrator from "@akshatgiri/convex-orchestrator/convex.config.js";

const app = defineApp();
app.use(convexOrchestrator);

export default app;
