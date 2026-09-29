"use server";

import { revalidatePath } from "next/cache";

import { appError, fail, ok, type ActionResult } from "@/lib/errors";
import { toAppError } from "@/lib/pipeline/engine-errors";
import { enginePayload } from "@/lib/pipeline/session-helpers";
import { DEFAULT_SAMPLE_SIZE, MAX_SAMPLE_SIZE, runEvaluation } from "@/lib/rag/evaluation";
import { requireApiKey } from "@/lib/secrets";
import { adoptSession, readSessionToken } from "@/lib/session";
import type { EvaluationReport } from "@/lib/types";

/**
 * Evaluation Server Action.
 *
 * The metric suite runs in this process because it needs the index and the
 * provider client, both of which live in the session. This action only guards the
 * preconditions and returns a typed report. Multimodal metrics come back as
 * `"N/A"` with a `skippedReason` when every upload was text-only, so the UI never
 * has to guess why a score is missing.
 */

export interface EvaluationRequestData {
  readonly sampleCount: number;
}

export async function runEvaluationAction(
  request: EvaluationRequestData,
): Promise<ActionResult<EvaluationReport>> {
  try {
    const token = await readSessionToken();
    const { session } = await adoptSession(token);

    if (session.pipeline === null) {
      return fail(appError("pipeline_missing"));
    }

    const apiKey = requireApiKey(session);
    const sampleCount = Number.isFinite(request.sampleCount)
      ? Math.max(1, Math.min(MAX_SAMPLE_SIZE, Math.round(request.sampleCount)))
      : DEFAULT_SAMPLE_SIZE;

    const report = await runEvaluation(enginePayload(session, apiKey), { sampleCount });

    revalidatePath("/evaluate");
    return ok(report);
  } catch (error) {
    return fail(toAppError(error));
  }
}
