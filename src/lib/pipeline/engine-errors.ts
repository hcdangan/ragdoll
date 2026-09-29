import "server-only";

import { AppError, appError, type AppErrorCode } from "../errors";
import { ChunkingError } from "../rag/chunking";
import { VectorError } from "../rag/distance";
import { GuardrailError } from "../rag/guardrails";
import { LoopbackBlockedError, ProviderError } from "../rag/llm";
import { PdfRejectedError } from "../rag/pdf";
import { PipelineError } from "../rag/service";

/**
 * Translation from engine failures to the app's error vocabulary.
 *
 * The engine used to be a separate service, and its HTTP status carried this
 * mapping. Now that it is a module, the throw type carries it instead — but the
 * *user-facing* codes must not change, because the dictionary, the retry
 * affordance and the form's field errors are all keyed on them.
 */

const PROVIDER_CODES: Readonly<Record<ProviderError["code"], AppErrorCode>> = {
  invalid_api_key: "provider_auth",
  provider_unreachable: "provider_unreachable",
  provider_error: "provider_error",
};

const PDF_CODES: Readonly<Record<PdfRejectedError["code"], AppErrorCode>> = {
  pdf_invalid: "pdf_invalid",
  pdf_encrypted: "pdf_encrypted",
  pdf_active_content: "pdf_active_content",
};

const PIPELINE_CODES: Readonly<Record<PipelineError["code"], AppErrorCode>> = {
  pipeline_missing: "pipeline_missing",
  validation: "validation",
  provider_auth: "provider_auth",
  provider_error: "provider_error",
};

/**
 * Re-wraps anything the engine throws as an AppError, preserving the codes the UI
 * already understands.
 * @param error Unknown thrown value from the service layer.
 * @param fallbackCode Code used for failures with no specific mapping.
 */
export const toAppError = (error: unknown, fallbackCode: AppErrorCode = "internal"): AppError => {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof GuardrailError) {
    return new AppError(error.code, error.message, { cause: error });
  }
  if (error instanceof PdfRejectedError) {
    return new AppError(PDF_CODES[error.code], error.message, { cause: error });
  }
  if (error instanceof ProviderError) {
    return new AppError(PROVIDER_CODES[error.code], error.message, { cause: error });
  }
  if (error instanceof LoopbackBlockedError) {
    return new AppError("provider_unreachable", error.message, { cause: error });
  }
  if (error instanceof PipelineError) {
    return new AppError(PIPELINE_CODES[error.code], error.message, { cause: error });
  }
  if (error instanceof ChunkingError || error instanceof VectorError) {
    return new AppError("internal", error.message, { cause: error });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return appError("timeout", undefined, { cause: error });
  }
  if (error instanceof Error) {
    return new AppError(fallbackCode, error.message, { cause: error });
  }
  return appError(fallbackCode, undefined, { cause: error });
};
