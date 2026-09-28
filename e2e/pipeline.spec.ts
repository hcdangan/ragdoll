import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Full pipeline journey: configure → index → chat with citations → evaluate.
 *
 * Requires a reachable engine, because this is the only test that exercises the
 * Server Action bridge, the SSE adapter and `useChat` together. Point it at the
 * offline engine with:
 *
 *   RAGDOLL_DEV_PROVIDER=1 python -m uvicorn main:app --port 8000 --app-dir api
 *   pnpm build && pnpm start                     # serves the app and proxies /engine
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 pnpm e2e
 *
 * The engine's default location is the same-origin `/engine` path, which
 * `vercel.json` rewrites in production and `src/middleware.ts` proxies locally, so
 * no engine URL has to be configured for the journey to run.
 *
 * `RAGDOLL_API_URL` is only used as the skip flag below: without it the suite skips
 * rather than failing, so `pnpm e2e` stays useful on a machine with no engine.
 */

const FIXTURE = resolve(__dirname, ".fixtures", "handbook.pdf");
const engineConfigured = Boolean(process.env.RAGDOLL_API_URL);

test.describe("pipeline journey", () => {
  test.skip(!engineConfigured, "RAGDOLL_API_URL is not configured for this run.");
  test.skip(!existsSync(FIXTURE), "Run `node scripts/make-fixture.mjs` first.");

  test("creates a pipeline, answers with citations and evaluates", async ({ page }) => {
    await page.goto("/create");

    await page.getByRole("textbox", { name: "API key" }).fill("dev-offline-key");
    await page.setInputFiles('input[type="file"]', FIXTURE);

    await expect(page.getByText("handbook.pdf")).toBeVisible();

    await page.getByRole("button", { name: /Create RAG pipeline/i }).click();

    // The session snapshot, not the action's own response, is what chat and
    // evaluation depend on — so the assertion waits for the creation page's own
    // confirmation, which is rendered only after the session write returns.
    const confirmation = page.locator('[role="status"]', { hasText: /chunks from/i });
    await expect(confirmation).toBeVisible({ timeout: 30_000 });

    await page.goto("/chat");
    const input = page.getByLabel(/Ask something about your documents/i);
    await input.fill("What is the retention period?");
    await page.getByRole("button", { name: /^Send$/ }).click();

    await expect(page.getByText(/Based on the retrieved sources/i).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("complementary", { name: /Citations/i })).toContainText(
      "handbook.pdf",
    );

    await page.goto("/evaluate");
    await page.getByRole("button", { name: /Run evaluation/i }).click();

    const faithfulness = page.getByRole("row", { name: /^Faithfulness/ });
    await expect(faithfulness).toBeVisible({ timeout: 60_000 });
    await expect(faithfulness).toContainText(/[01]\.\d{3}/);

    const multimodal = page.getByRole("row", { name: /^Multimodal Faithfulness/ });
    await expect(multimodal).toContainText("N/A");
    await expect(multimodal).toContainText("Skipped");
  });
});
