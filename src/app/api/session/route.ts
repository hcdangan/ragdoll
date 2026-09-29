import { NextResponse } from "next/server";

import { getServerEnv } from "@/lib/env";
import type { TranslationKey } from "@/lib/i18n";
import { toPipelineSummary } from "@/lib/pipeline/session-helpers";
import { reset } from "@/lib/rag/service";
import { describeApiKey } from "@/lib/secrets";
import {
  adoptSession,
  destroySession,
  loadSession,
  readSessionToken,
  remainingTtlMs,
  sharedStoreMissing,
} from "@/lib/session";
import type { PipelineSummary, ProviderKeyStatus } from "@/lib/types";

/**
 * Session snapshot for the browser.
 *
 * The client needs three things it cannot derive locally: the pipeline summary
 * (nav gating), whether the provider key is still in the server-side vault, and
 * the remaining sliding-window lifetime. None of it exposes the key itself — only
 * a masked label.
 */

export const dynamic = "force-dynamic";

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly ttlMs: number;
  readonly pipeline: PipelineSummary | null;
  readonly provider: ProviderKeyStatus | null;
  readonly capabilities: {
    readonly chat: boolean;
    readonly evaluate: boolean;
    readonly sharedStore: boolean;
  };
  readonly notices: readonly TranslationKey[];
}

export async function GET(): Promise<NextResponse> {
  const env = getServerEnv();
  const token = await readSessionToken();

  // Adopts the id middleware minted rather than inventing one: the browser's
  // cookie already names this session, so the two must agree or every later
  // lookup misses. Middleware provisions the cookie, so nothing is written here.
  const { session } = await adoptSession(token);

  const status = describeApiKey(session);
  const pipeline = toPipelineSummary(session);
  const notices: TranslationKey[] = [];

  if (pipeline !== null && pipeline.documents.length === 0) {
    notices.push("documents.empty");
  }
  if (sharedStoreMissing()) {
    // Surfaced to the user because the failure it causes is otherwise baffling:
    // the pipeline exists on one instance and "disappears" on another.
    notices.push("session.noSharedStore");
  }

  const snapshot: SessionSnapshot = {
    sessionId: session.id,
    ttlMs: remainingTtlMs(session),
    pipeline,
    provider: status,
    capabilities: {
      chat: session.pipeline !== null && status?.hasKey === true,
      evaluate: session.pipeline !== null,
      sharedStore: env.kv !== null,
    },
    notices,
  };

  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}

/** Sliding-window refresh for callers that only need to keep the session alive. */
export async function HEAD(): Promise<NextResponse> {
  const token = await readSessionToken();
  const resolved = await loadSession(token);
  const ttlMs = resolved === null ? 0 : Math.max(0, remainingTtlMs(resolved.session) - 1_000);
  return new NextResponse(null, {
    status: resolved === null ? 404 : 204,
    headers: { "X-Ragdoll-Ttl": String(ttlMs), "Cache-Control": "no-store" },
  });
}

/** Clears the pipeline, the stored key and the chat history. */
export async function DELETE(): Promise<NextResponse> {
  const token = await readSessionToken();
  const resolved = await loadSession(token);

  if (resolved === null) {
    return NextResponse.json({ cleared: true });
  }

  reset(resolved.session.id);
  await destroySession(resolved.session.id);

  return NextResponse.json({ cleared: true }, { headers: { "Cache-Control": "no-store" } });
}
