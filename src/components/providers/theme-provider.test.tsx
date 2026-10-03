// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { themeBootstrapScript } from "@/components/providers/theme-provider";

/**
 * The bootstrap script is a string the root layout inlines into `<head>`, so the
 * only way to test what a visitor actually gets before React mounts is to run it.
 *
 * This is the file that decides the default theme: dark used to be chosen for
 * anyone whose operating system preferred it, and that decision has to stay out.
 */
const runBootstrap = (): void => {
  new Function(themeBootstrapScript)();
};

const isDark = (): boolean => document.documentElement.classList.contains("dark");

describe("theme bootstrap script", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.head.innerHTML = '<meta name="theme-color" content="#fdf0df">';
    window.localStorage.clear();
  });

  it("leaves a first visit light, whatever the operating system prefers", () => {
    runBootstrap();

    expect(isDark()).toBe(false);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#fdf0df",
    );
  });

  it("applies a stored dark choice before the first paint", () => {
    window.localStorage.setItem("ragdoll-theme-v2", "dark");

    runBootstrap();

    expect(isDark()).toBe(true);
    // The browser chrome follows the app theme.
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#094454",
    );
  });

  it("ignores a dark value left under the old key", () => {
    // Written while dark was the OS-driven default rather than a choice, so it must
    // not keep a device dark now that light is the default.
    window.localStorage.setItem("ragdoll-theme", "dark");

    runBootstrap();

    expect(isDark()).toBe(false);
  });

  it("treats an explicit light choice as light", () => {
    window.localStorage.setItem("ragdoll-theme-v2", "light");

    runBootstrap();

    expect(isDark()).toBe(false);
  });
});
