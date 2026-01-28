import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

async function assertFileExists(relPath) {
  const absPath = path.resolve(projectRoot, relPath);
  try {
    await fs.access(absPath);
  } catch {
    throw new Error(`Missing file: ${relPath}`);
  }
}

const pkg = JSON.parse(
  await fs.readFile(path.join(projectRoot, "package.json"), "utf8"),
);

const convexConfigExport = pkg?.exports?.["./convex.config.js"]?.default;
if (typeof convexConfigExport !== "string") {
  throw new Error('Missing export: exports["./convex.config.js"].default');
}

await assertFileExists(convexConfigExport);

// Ensure the export actually imports (catches missing deps like `convex/server`).
await import(`${pkg.name}/convex.config.js`);

console.log("verify-exports: ok");

