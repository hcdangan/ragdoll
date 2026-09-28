import { describe, expect, it } from "vitest";

import { createEmptySession, loadSession, saveSession, stampSession } from "@/lib/session";
import { sessionSecret, signId } from "@/lib/session-token";

/**
 * Regression guard for the store-visibility bug that made a freshly built pipeline
 * vanish one navigation later.
 *
 * Next.js compiles Server Actions and Route Handlers as separate bundles, so a
 * module-level `Map` exists once per bundle *within the same process*. The store is
 * therefore hung off `globalThis`; this asserts the two properties that depend on
 * it: a write is immediately visible to a read, and the registry is a single
 * process-wide object rather than a per-import one.
 */
describe("session store visibility", () => {
  it("round-trips a saved session through a signed token", async () => {
    const session = stampSession({ ...createEmptySession("store-round-trip"), apiKey: "sk-test" });
    await saveSession(session);

    const token = await signId(sessionSecret(), session.id);
    const resolved = await loadSession(token);

    expect(resolved).not.toBeNull();
    expect(resolved?.session.id).toBe(session.id);
    expect(resolved?.session.apiKey).toBe("sk-test");
  });

  it("adopts the id carried by the token instead of inventing one", async () => {
    const token = await signId(sessionSecret(), "token-named-session");
    const { adoptSession } = await import("@/lib/session");
    const { session } = await adoptSession(token);
    expect(session.id).toBe("token-named-session");
  });

  it("keeps the registry on globalThis so sibling bundles share it", () => {
    const key = Symbol.for("ragdoll.session.store");
    const registry = (globalThis as Record<symbol, unknown>)[key];
    expect(registry).toBeDefined();
    expect(registry).toHaveProperty("sessions");
  });

  it("ignores a token signed with the wrong secret", async () => {
    const token = await signId("z".repeat(40), "forged");
    expect(await loadSession(token)).toBeNull();
  });
});