// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import { NoticeProvider, useNotices } from "@/components/providers/notice-provider";

/**
 * The notification surface is a behaviour, not a style: a notice has to be
 * reachable from the fixed stack, dismissible, non-persistent, and de-duplicated.
 * jsdom cannot verify that `position: fixed` keeps something on screen — the
 * Playwright spec covers that — but it can pin everything else.
 */

const router = vi.hoisted(() => ({ pathname: "/create" }));
vi.mock("next/navigation", () => ({ usePathname: () => router.pathname }));

function Harness(): ReactElement {
  const { notify, clear } = useNotices();
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          notify({ tone: "success", message: "Pipeline created." });
        }}
      >
        raise-success
      </button>
      <button
        type="button"
        onClick={() => {
          notify({ tone: "danger", message: "The provider rejected the API key." });
        }}
      >
        raise-danger
      </button>
      <button
        type="button"
        onClick={() => {
          for (let index = 0; index < 6; index += 1) {
            notify({ tone: "info", message: `notice ${index}` });
          }
        }}
      >
        raise-many
      </button>
      <button type="button" onClick={clear}>
        clear-all
      </button>
    </div>
  );
}

const view = (): ReactElement => (
  <NoticeProvider>
    <Harness />
  </NoticeProvider>
);

afterEach(() => {
  cleanup();
  router.pathname = "/create";
});

describe("NoticeProvider", () => {
  it("raises a notice in a fixed viewport stack", () => {
    render(view());

    fireEvent.click(screen.getByText("raise-danger"));

    expect(screen.queryByText("The provider rejected the API key.")).not.toBeNull();
    const region = screen.getByRole("region", { name: "Notifications" });
    // The stack itself has to leave the document flow, or a notice raised at the
    // bottom of a long form scrolls out of sight again.
    expect(region.className).toContain("fixed");
    expect(region.className).toContain("bottom-0");
  });

  it("announces failures assertively and everything else politely", () => {
    render(view());

    fireEvent.click(screen.getByText("raise-danger"));
    fireEvent.click(screen.getByText("raise-success"));

    expect(screen.getByRole("alert").textContent).toContain("rejected the API key");
    expect(screen.getByRole("status").textContent).toContain("Pipeline created.");
  });

  it("closes a notice from its own close button", () => {
    render(view());
    fireEvent.click(screen.getByText("raise-success"));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    expect(screen.queryByText("Pipeline created.")).toBeNull();
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  it("collapses an identical repeat instead of stacking it", () => {
    render(view());

    fireEvent.click(screen.getByText("raise-danger"));
    fireEvent.click(screen.getByText("raise-danger"));

    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("keeps the stack bounded", () => {
    render(view());

    fireEvent.click(screen.getByText("raise-many"));

    expect(screen.getAllByRole("status")).toHaveLength(4);
    // The oldest is the one dropped, so the most recent feedback always survives.
    expect(screen.queryByText("notice 0")).toBeNull();
    expect(screen.queryByText("notice 5")).not.toBeNull();
  });

  it("empties itself on clear and on a route change", () => {
    const { rerender } = render(view());
    fireEvent.click(screen.getByText("raise-success"));
    fireEvent.click(screen.getByText("clear-all"));
    expect(screen.queryByText("Pipeline created.")).toBeNull();

    // A soft navigation is not a page load, but a notice only describes the page
    // that raised it, so it must not follow the user to the next route.
    fireEvent.click(screen.getByText("raise-success"));
    router.pathname = "/chat";
    rerender(view());

    expect(screen.queryByText("Pipeline created.")).toBeNull();
  });
});
