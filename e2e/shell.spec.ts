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

  test("chat prompts cannot be sent before a pipeline exists", async ({ page }) => {
    await page.goto("/chat");

    // The empty-state suggestion chips are buttons, and they used to submit a
    // question through a pipeline that does not exist yet.
    const prompts = page.locator("main ul li button");
    const count = await prompts.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      await expect(prompts.nth(index)).toBeDisabled();
    }

    await expect(page.getByLabel(/Ask something about your documents/i)).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Send$/ })).toBeDisabled();
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

  test("a self-hosted base URL and model survive switching providers", async ({ page }) => {
    await page.goto("/create");

    await page.getByRole("radio", { name: /Ollama/i }).check({ force: true });
    const baseUrl = page.getByLabel(/Base URL/i);
    const model = page.locator('input[list$="-suggestions"]');
    await baseUrl.fill("http://hcdangan.duckdns.org:11434/v1");
    await model.fill("gpt-oss-20b-Q4_K_M");

    // Comparing providers is normal, and it used to silently reset the model to the
    // provider default — which is how "Pipeline ready" came to report llama3.2 for a
    // pipeline built with something else.
    await page.getByRole("radio", { name: /OpenAI/i }).check({ force: true });
    await expect(model).toHaveValue("gpt-4o-mini");
    await page.getByRole("radio", { name: /Ollama/i }).check({ force: true });

    await expect(model).toHaveValue("gpt-oss-20b-Q4_K_M");
    await expect(baseUrl).toHaveValue("http://hcdangan.duckdns.org:11434/v1");
  });

  test("the base URL keeps every character typed into it", async ({ page }) => {
    await page.goto("/create");
    await page.getByRole("radio", { name: /Ollama/i }).check({ force: true });

    const baseUrl = page.getByLabel(/Base URL/i);
    const typed = "http://192.168.1.10:11434/v1";
    await baseUrl.click();
    // Real key events, one at a time: a field that normalised or dropped slashes
    // would fail here.
    await baseUrl.pressSequentially(typed, { delay: 10 });

    await expect(baseUrl).toHaveValue(typed);
    // Autofill would fight a URL being typed; nothing here should be remembered.
    await expect(baseUrl).toHaveAttribute("autocomplete", "off");
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

    // Light is the default, so this starts light and flips to dark.
    await expect(html).not.toHaveClass(/dark/);
    await toggle.click();

    await expect(html).toHaveClass(/dark/);
  });

  /**
   * Light is the default *whatever the operating system prefers*; a dark OS used to
   * decide the first visit, which is the behaviour this pins down.
   */
  test.describe("with the operating system set to dark", () => {
    test.use({ colorScheme: "dark" });

    test("the first visit is still light, and an explicit choice persists", async ({ page }) => {
      await page.goto("/");

      const html = page.locator("html");
      const themeColor = page.locator('meta[name="theme-color"]');

      await expect(html).not.toHaveClass(/dark/);
      await expect(themeColor).toHaveAttribute("content", "#fdf0df");

      await page.getByRole("button", { name: /^(Dark|Light)$/ }).click();

      await expect(html).toHaveClass(/dark/);
      // The browser chrome follows the app theme, not the OS.
      await expect(themeColor).toHaveAttribute("content", "#094454");

      await page.reload();
      await expect(html).toHaveClass(/dark/);
    });
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
