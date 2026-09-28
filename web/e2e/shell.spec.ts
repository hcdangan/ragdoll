import { expect, test, type Page } from "@playwright/test";

/**
 * Smoke coverage for the shell: navigation gating, the licence notice, the
 * session notice and the accessible form primitives.
 *
 * The gating assertions are the important ones — "Evaluate" and "Chat" must be
 * visible but disabled until a pipeline exists — because that is a product
 * requirement, not a styling detail.
 */

test.describe("shell", () => {
  /**
   * Mobile hides the primary nav behind a disclosure button, so any test that
   * touches a nav item has to open it first. Doing that here keeps the
   * assertions identical across viewports.
   */
  const openNav = async (page: Page): Promise<void> => {
    const toggle = page.getByRole("button", { name: /Open navigation menu/i });
    if (await toggle.isVisible()) {
      await toggle.click();
    }
  };

  test("home page renders the licence and the session promise", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toContainText(/RAG pipeline/i);
    const footer = page.getByRole("contentinfo");
    await expect(footer).toContainText("MIT");
    await expect(footer).toContainText("Harley Dangan");
    await expect(footer.getByRole("link", { name: /Read the license/i })).toBeVisible();
  });

  test("evaluate and chat are announced as disabled without a pipeline", async ({ page }) => {
    await page.goto("/");
    await openNav(page);

    const nav = page.getByRole("navigation", { name: /Primary/i }).first();
    const evaluate = nav.getByText("Evaluate", { exact: true });
    const chat = nav.getByText("Chat", { exact: true });

    await expect(evaluate).toBeVisible();
    await expect(chat).toBeVisible();
    await expect(evaluate).toHaveAttribute("aria-disabled", "true");
    await expect(chat).toHaveAttribute("aria-disabled", "true");
  });

  test("can navigate to the creation workspace", async ({ page }) => {
    await page.goto("/");
    await openNav(page);
    await page
      .getByRole("navigation", { name: /Primary/i })
      .first()
      .getByRole("link", { name: "RAG Creation" })
      .click();

    await expect(page).toHaveURL(/\/create$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("RAG Creation");
    await expect(page.getByText(/nothing is written to disk/i)).toBeVisible();
  });

  test("the creation form exposes accessible sliders", async ({ page }) => {
    await page.goto("/create");

    const chunkSize = page.getByRole("slider", { name: /Chunk size/i });
    await expect(chunkSize).toBeVisible();
    await expect(chunkSize).toHaveAttribute("aria-valuenow", "512");
    await expect(chunkSize).toHaveAttribute("aria-valuemin", "128");
    await expect(chunkSize).toHaveAttribute("aria-valuemax", "2048");

    // 512 tok at 10% is 51.2 tokens, which the engine rounds up to the 32 grid.
    const overlap = page.getByRole("slider", { name: /Chunk overlap/i });
    await expect(overlap).toHaveAttribute("aria-valuenow", "10");
    await expect(overlap).toHaveAttribute("aria-valuetext", "10% · 64 tokens");

    const topK = page.getByRole("slider", { name: /Top-K/i });
    await expect(topK).toHaveAttribute("aria-valuenow", "5");
  });

  test("the API key field is masked and toggleable", async ({ page }) => {
    await page.goto("/create");

    const key = page.getByRole("textbox", { name: "API key" });
    await expect(key).toHaveAttribute("type", "password");

    await page.getByRole("button", { name: "Show API key" }).click();
    await expect(key).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: "Hide API key" })).toBeVisible();
  });

  test("the theme toggle switches colour schemes", async ({ page }) => {
    await page.goto("/");

    const toggle = page.getByRole("button", { name: /^(Dark|Light)$/ });
    await toggle.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("an unbuilt pipeline is explained rather than hidden", async ({ page }) => {
    await page.goto("/evaluate");
    await expect(page.getByText(/Create a RAG pipeline first/i)).toBeVisible();
  });
});
