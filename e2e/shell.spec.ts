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

  test("home page credits the Asian Institute of Management with a real logo", async ({ page }) => {
    await page.goto("/");

    const credit = page.getByRole("region", { name: /Asian Institute of Management/i });
    await expect(credit).toContainText(/submitted as a mini project/i);

    // `naturalWidth` proves the vendored SVG was served and decoded, not just that
    // an <img> element exists with a broken src.
    const logo = credit.getByRole("img", { name: /Asian Institute of Management logo/i });
    await expect(logo).toBeVisible();
    expect(
      await logo.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
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
    const html = page.locator("html");

    // The stored preference wins, then the OS preference, so which scheme the page
    // starts in depends on the runner. Clicking until dark is reached asserts the
    // toggle really flips the class without assuming a starting point.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const isDark = await html.evaluate((element) => element.classList.contains("dark"));
      if (isDark) {
        break;
      }
      await toggle.click();
      await page.waitForTimeout(100);
    }

    await expect(html).toHaveClass(/dark/);
  });

  test("an unbuilt pipeline is explained rather than hidden", async ({ page }) => {
    await page.goto("/evaluate");
    await expect(page.getByText(/Create a RAG pipeline first/i)).toBeVisible();
  });

  test("a notification is visible from any scroll position and can be dismissed", async ({ page }) => {
    await page.goto("/create");

    // A rejected upload is the one notice this suite can raise without a provider:
    // the browser-side check refuses a non-PDF before any request is made.
    await page.locator('input[type="file"]').setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not a pdf"),
    });

    const notice = page.getByRole("alert").filter({ hasText: "notes.txt is not a PDF file." });
    await expect(notice).toBeVisible();

    // The creation form is taller than the viewport, so the notice has to be fixed
    // to the viewport rather than parked in the page flow near the upload control.
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await expect(notice).toBeInViewport();

    await notice.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(notice).toHaveCount(0);
  });

  test("notifications do not survive a page load", async ({ page }) => {
    await page.goto("/create");
    await page.locator('input[type="file"]').setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not a pdf"),
    });
    await expect(page.getByRole("alert").filter({ hasText: "notes.txt" })).toBeVisible();

    await page.reload();

    await expect(page.getByRole("region", { name: "Notifications" })).toHaveCount(0);
  });
});
