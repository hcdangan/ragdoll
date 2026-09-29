/**
 * Runs pnpm with the current working directory preserved, for tools that need a
 * `pnpm` on PATH (Vercel's local builder, for instance). The DSH sandbox denies
 * piped stdio to child processes, so stdio is inherited.
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PNPM = join(ROOT, ".tools", "node_modules", "pnpm", "bin", "pnpm.cjs");

const child = spawn(process.execPath, [PNPM, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: { ...process.env, npm_config_cache: join(ROOT, ".npm-cache") },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
