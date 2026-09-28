"use server";

import { revalidatePath } from "next/cache";

import { appError, fail, ok, type ActionResult } from "@/lib/errors";
import { requireEngine } from "@/lib/pipeline/engine";
import { enginePayload } from "@/lib/pipeline/session-helpers";
import { requireApiKey } from "@/lib/secrets";
import { adoptSession, readSessionToken } from "@/lib/session";
import type { EvaluationReport } from "@/lib/types";

/**
 * Evaluation Server Action.
 *
 * The metric suite lives in the engine because it owns the index; this action
 * only guards the preconditions and returns a typed report. Multimodal metrics
 * come back as `"N/A"` with a `skippedReason` when every upload was text-only,
 * so the UI never has to guess why a score is missing.
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
    const engine = requireEngine();
    const sampleCount = Math.max(1, Math.min(12, Math.round(request.sampleCount)));

    const report = await engine.evaluate(enginePayload(session, apiKey), {
      sessionId: session.id,
      sampleCount,
    });

    revalidatePath("/evaluate");
    return ok(report);
  } catch (error) {
    return fail(error);
  }
}
