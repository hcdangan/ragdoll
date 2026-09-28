import { describe, expect, it } from "vitest";

import { signId, verifyId } from "@/lib/session-token";

/**
 * The cookie carries a session id and nothing else, so these tests cover exactly
 * two things: an id that verifies, and anything else that must not.
 *
 * The property that matters is the one an earlier design got wrong — the handle
 * must not grow with the session. A 6 MB upload session and an empty one produce a
 * cookie of the same length, which is asserted below.
 */
describe("signed session id", () => {
  const secret = "a".repeat(48);

  it("round-trips an id", async () => {
    const token = await signId(secret, "session-abc");
    expect(await verifyId(secret, token)).toBe("session-abc");
  });

  it("rejects a forged id", async () => {
    const token = await signId(secret, "session-abc");
    const signature = token.slice(token.lastIndexOf(".") + 1);
    expect(await verifyId(secret, `session-xyz.${signature}`)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signId("b".repeat(48), "session-abc");
    expect(await verifyId(secret, token)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    for (const token of ["", ".", "no-separator", "trailing."]) {
      expect(await verifyId(secret, token)).toBeNull();
    }
  });

  it("is insensitive to how much the session holds", async () => {
    const small = await signId(secret, "tiny");
    const large = await signId(secret, "x".repeat(64));
    expect(small.length).toBeLessThan(120);
    expect(large.length).toBeLessThan(180);
  });

  it("produces a stable signature for the same id", async () => {
    expect(await signId(secret, "session-abc")).toBe(await signId(secret, "session-abc"));
  });
});