"use server";

import { revalidatePath } from "next/cache";

import { appError, fail, ok, type ActionResult } from "@/lib/errors";
import { getServerEnv } from "@/lib/env";
import { toAppError } from "@/lib/pipeline/engine-errors";
import { enginePayload, toPipelineSummary } from "@/lib/pipeline/session-helpers";
import { enforceUploadBudget } from "@/lib/rag/pdf";
import { clearHistory, ensureIndex, reset, testConnection } from "@/lib/rag/service";
import { LIMITS } from "@/lib/rules";
import {
  adoptSession,
  destroySession,
  readSessionToken,
  saveSession,
  stampSession,
} from "@/lib/session";
import type { DocumentSummary, PipelineSummary, UploadedDocument } from "@/lib/types";
import {
  toUploadedDocuments,
  validatePipelineForm,
  type PipelineFormInput,
} from "@/lib/validation";

/**
 * Pipeline Server Actions.
 *
 * Mutations go through Server Actions (AGENTS.md), streaming does not. The one
 * rule every action follows: validate on the server, mutate the session, and
 * return a discriminated result — never throw across the boundary, because a
 * thrown action error becomes an opaque 500 in the browser.
 *
 * These actions call the RAG pipeline directly: it is a module inside this same
 * Next.js runtime, not a second service, so there is no URL to configure and no
 * HTTP boundary to translate errors across. `toAppError` is what keeps the error
 * vocabulary the UI already understands intact across that change.
 */

export interface CreatePipelineData {
  readonly summary: PipelineSummary;
  readonly documents: readonly DocumentSummary[];
  readonly chunkCount: number;
  readonly multimodal: boolean;
  readonly latencyMs: number;
}

/**
 * Loads the session for an action, adopting the identity middleware minted.
 *
 * The id comes from the request, never from a fresh `createEmptySession()`. An
 * action that invented its own id saved the pipeline under one name while the
 * browser's cookie named another, so the next page load saw an empty session.
 */
const requireSession = async () => {
  const token = await readSessionToken();
  return (await adoptSession(token)).session;
};

/**
 * Validates the provider, stores the key in the session vault, builds the index
 * and records the parsed citations.
 */
export async function createPipelineAction(
  input: PipelineFormInput,
): Promise<ActionResult<CreatePipelineData>> {
  const started = Date.now();
  try {
    const env = getServerEnv();
    const { config, errors } = validatePipelineForm(input, { hosted: env.hosted });
    if (config === null) {
      return fail(
        appError("validation", undefined, {
          fields: errors,
        }),
      );
    }

    const session = await requireSession();
    const documents: UploadedDocument[] = toUploadedDocuments(input.documents ?? []);
    enforceUploadBudget(documents.map((document) => document.bytes.byteLength));

    const engineSession = { ...session, pipeline: config, documents };
    const payload = enginePayload(engineSession, input.apiKey ?? "");

    // Test first: a bad key must fail before any embedding spend.
    await testConnection(payload);
    const upsert = await ensureIndex(payload);

    const summaries = upsert.documents;
    const withMetadata = documents.map((document) => {
      const summary = summaries.find((candidate) => candidate.id === document.id);
      return {
        ...document,
        pageCount: summary?.pageCount ?? document.pageCount,
        chunkCount: summary?.chunkCount ?? 0,
        imageCount: summary?.imageCount ?? 0,
      };
    });

    const updated = stampSession({
      ...session,
      pipeline: config,
      documents: withMetadata,
      chat: [],
      // Stored on the session so it is re-encrypted into the sealed cookie and
      // survives an instance recycling; `lib/secrets.ts` owns access to it.
      apiKey: input.apiKey ?? "",
    });
    await saveSession(updated);

    const summary = toPipelineSummary(updated);
    if (summary === null) {
      return fail(appError("internal"));
    }

    revalidatePath("/create");
    revalidatePath("/evaluate");
    revalidatePath("/chat");
    revalidatePath("/");

    return ok({
      summary: { ...summary, chunkCount: upsert.chunkCount },
      documents: summaries,
      chunkCount: upsert.chunkCount,
      multimodal: upsert.multimodal,
      latencyMs: Date.now() - started,
    });
  } catch (error) {
    return fail(toAppError(error));
  }
}

export interface TestConnectionData {
  readonly reachable: boolean;
  readonly latencyMs: number;
  readonly modelEcho: string;
  readonly embeddingDimension: number;
  readonly embeddingProbe: boolean;
}

/**
 * Tests the provider configuration without storing anything.
 * Used by the "Test connection" affordance so a user can validate a key before
 * committing to a full index build.
 */
export async function testConnectionAction(
  input: PipelineFormInput,
): Promise<ActionResult<TestConnectionData>> {
  try {
    const env = getServerEnv();
    const { config, errors } = validatePipelineForm(input, { hosted: env.hosted });
    if (config === null) {
      return fail(appError("validation", undefined, { fields: errors }));
    }

    const session = await requireSession();
    const probe = await testConnection(
      enginePayload({ ...session, pipeline: config, documents: [] }, input.apiKey ?? ""),
    );
    return ok({
      reachable: probe.reachable,
      latencyMs: probe.latencyMs,
      modelEcho: probe.modelEcho,
      embeddingDimension: probe.embeddingDimension,
      embeddingProbe: probe.embeddingProbe,
    });
  } catch (error) {
    return fail(toAppError(error));
  }
}

/** Clears the pipeline, the documents, the chat history and the stored key. */
export async function clearPipelineAction(): Promise<ActionResult<{ readonly cleared: true }>> {
  try {
    const session = await requireSession();
    reset(session.id);
    await destroySession(session.id);

    revalidatePath("/create");
    revalidatePath("/evaluate");
    revalidatePath("/chat");
    revalidatePath("/");
    return ok({ cleared: true } as const);
  } catch (error) {
    return fail(toAppError(error));
  }
}

/** Clears only the chat transcript; the pipeline and PDFs persist. */
export async function resetChatAction(): Promise<ActionResult<{ readonly turns: number }>> {
  try {
    const session = await requireSession();
    clearHistory(session.id);
    const cleared = stampSession({ ...session, chat: [] });
    await saveSession(cleared);
    revalidatePath("/chat");
    return ok({ turns: session.chat.length });
  } catch (error) {
    return fail(toAppError(error));
  }
}

/** Refreshes the sliding session window on explicit user action. */
export async function keepAliveAction(): Promise<ActionResult<{ readonly ttlMs: number }>> {
  try {
    const session = await requireSession();
    await saveSession(stampSession(session));
    return ok({ ttlMs: LIMITS.sessionTtlMs });
  } catch (error) {
    return fail(toAppError(error));
  }
}
