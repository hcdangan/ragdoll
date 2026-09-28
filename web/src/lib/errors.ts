import type { TranslationKey } from "./i18n";
import { t } from "./i18n";

/**
 * Transport-neutral failure shape. `code` is a stable machine discriminator so
 * the UI can react without string matching, while `message` is always safe to
 * render — it is either a dictionary string or an upstream detail we vetted.
 */
export type AppErrorCode =
  | "validation"
  | "unauthorized"
  | "timeout"
  | "network"
  | "provider_auth"
  | "provider_unreachable"
  | "provider_error"
  | "guardrail_jailbreak"
  | "guardrail_injection"
  | "pdf_invalid"
  | "pdf_encrypted"
  | "pdf_active_content"
  | "pipeline_missing"
  | "rate_limited"
  | "engine_error"
  | "internal";

export interface AppErrorShape {
  readonly code: AppErrorCode;
  readonly message: string;
  /** Field-level messages for form rendering, keyed by input name. */
  readonly fields?: Readonly<Record<string, string>>;
  /** Retryable failures surface a retry affordance instead of a dead end. */
  readonly retryable: boolean;
}

export const ERROR_MESSAGES: Readonly<Record<AppErrorCode, TranslationKey>> = {
  validation: "error.invalidInput",
  unauthorized: "error.unauthorized",
  timeout: "error.timeout",
  network: "error.network",
  provider_auth: "error.apiKey",
  provider_unreachable: "error.providerUnreachable",
  provider_error: "error.generic",
  guardrail_jailbreak: "error.guardrail.jailbreak",
  guardrail_injection: "error.guardrail.injection",
  pdf_invalid: "error.pdfInvalid",
  pdf_encrypted: "error.pdfEncrypted",
  pdf_active_content: "error.pdfActiveContent",
  pipeline_missing: "error.pipelineMissing",
  rate_limited: "error.generic",
  engine_error: "error.generic",
  internal: "error.generic",
};

const RETRYABLE: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  "timeout",
  "network",
  "provider_unreachable",
  "provider_error",
  "rate_limited",
  "engine_error",
  "internal",
]);

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly fields: Readonly<Record<string, string>> | undefined;
  readonly retryable: boolean;

  constructor(
    code: AppErrorCode,
    message: string,
    options: {
      readonly fields?: Readonly<Record<string, string>>;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.fields = options.fields;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }

  toShape(): AppErrorShape {
    return this.fields === undefined
      ? { code: this.code, message: this.message, retryable: this.retryable }
      : { code: this.code, message: this.message, fields: this.fields, retryable: this.retryable };
  }
}

/**
 * Creates an AppError with a dictionary-derived message.
 * @param code Failure discriminator.
 * @param vars Interpolation values for the dictionary entry.
 */
export const appError = (
  code: AppErrorCode,
  vars?: Readonly<Record<string, string | number>>,
  options?: ConstructorParameters<typeof AppError>[2],
): AppError => new AppError(code, t(ERROR_MESSAGES[code], vars), options);

/**
 * Normalises any thrown value into an AppErrorShape.
 * @param error Unknown thrown value.
 * @param fallbackCode Code used when the value is not already an AppError.
 */
export const toErrorShape = (
  error: unknown,
  fallbackCode: AppErrorCode = "internal",
): AppErrorShape => {
  if (error instanceof AppError) {
    return error.toShape();
  }
  if (error instanceof Error && error.name === "AbortError") {
    return appError("timeout").toShape();
  }
  if (error instanceof Error) {
    return { code: fallbackCode, message: error.message, retryable: RETRYABLE.has(fallbackCode) };
  }
  return appError(fallbackCode).toShape();
};

/** Discriminated result returned by every Server Action. */
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: AppErrorShape };

export const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });

export const fail = <T = never>(error: unknown): ActionResult<T> => ({
  ok: false,
  error: toErrorShape(error),
});

/** Test helper: extracts the error shape, throwing when the result succeeded. */
export const expectError = <T>(result: ActionResult<T>): AppErrorShape => {
  if (result.ok) {
    throw new Error("Expected a failed ActionResult.");
  }
  return result.error;
};
