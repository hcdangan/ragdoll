/**
 * Runs pnpm with `stdio: "inherit"`.
 *
 * The DSH Windows sandbox denies `spawn` with piped stdio (EPERM), which breaks
 * pnpm's package lifecycle scripts. Inheriting stdio avoids the pipe entirely.
 *
 * Usage: node tools/pnpm.mjs install --frozen-lockfile
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PNPM = join(ROOT, ".tools", "node_modules", "pnpm", "bin", "pnpm.cjs");

const child = spawn(process.execPath, [PNPM, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    npm_config_cache: join(ROOT, ".npm-cache"),
  },
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.stderr.write(`pnpm terminated by ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
