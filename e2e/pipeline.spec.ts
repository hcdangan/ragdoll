import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Full pipeline journey: configure → index → chat with citations → evaluate.
 *
 * This is the only test that exercises the Server Action bridge, the streaming
 * route and `useChat` together, and it runs against the whole app rather than a
 * mock. The RAG pipeline is a module in the Next.js server now, so there is no
 * service to start: the offline provider (`RAGDOLL_DEV_PROVIDER=1`, set by
 * `playwright.config.ts`) supplies deterministic answers and embeddings.
 *
 *   pnpm build && pnpm start
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 pnpm e2e
 */

const FIXTURE = resolve(__dirname, ".fixtures", "handbook.pdf");

test.describe("pipeline journey", () => {
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
