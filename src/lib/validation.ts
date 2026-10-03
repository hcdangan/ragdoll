import { z } from "zod";

import {
  EMBEDDING_DIMENSIONS,
  PROVIDERS,
  isLoopbackUrl,
  resolveBaseUrl,
  resolveEmbeddingModel,
} from "./providers";
import { t } from "./i18n";
import { LIMITS, computeOverlapTokens, megabytes, snapToStep } from "./rules";
import {
  DISTANCE_METRICS,
  PROVIDER_IDS,
  RETRIEVAL_MODES,
  type PipelineConfig,
  type UploadedDocument,
} from "./types";

/**
 * Input validation shared by the creation form (client-side, for inline errors)
 * and the Server Action (server-side, as the authority).
 *
 * The overlap-token and embedding-dimension derivations live here rather than in
 * the component so what the user reads and what the engine receives cannot drift.
 * Everything in this module is runtime-neutral — no Node globals — so a client
 * component may import it as well as the action.
 */

export const providerIdSchema = z.enum(PROVIDER_IDS);

/** A PDF attached to the form, before it reaches the session. */
export interface PendingDocument {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  /** base64 payload; the Server Action decodes it back to bytes. */
  readonly base64: string;
}

export const pipelineFormSchema = z.object({
  provider: providerIdSchema,
  baseUrl: z.string().trim().max(300).optional().default(""),
  model: z.string().trim().min(1).max(200),
  embeddingModel: z.string().trim().min(1).max(200),
  chunkSize: z.number().int().min(LIMITS.chunkSize.min).max(LIMITS.chunkSize.max),
  chunkOverlapPercent: z
    .number()
    .int()
    .min(LIMITS.chunkOverlapPercent.min)
    .max(LIMITS.chunkOverlapPercent.max),
  maxInputTokens: z.number().int().min(LIMITS.maxInputTokens.min).max(LIMITS.maxInputTokens.max),
  distanceMetric: z.enum(DISTANCE_METRICS),
  topK: z.number().int().min(LIMITS.topK.min).max(LIMITS.topK.max),
  retrievalMode: z.enum(RETRIEVAL_MODES),
  apiKey: z.string().max(400).optional().default(""),
  documents: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(256),
        sizeBytes: z.number().int().positive().max(LIMITS.files.maxFileBytes),
        base64: z.string().min(1),
      }),
    )
    .max(LIMITS.files.maxCount),
});

export type PipelineFormInput = z.input<typeof pipelineFormSchema>;
export type PipelineFormValues = z.output<typeof pipelineFormSchema>;

export interface PipelineValidationResult {
  readonly config: PipelineConfig | null;
  readonly errors: Readonly<Record<string, string>>;
}

/** `%PDF-` encoded as base64, so the magic check needs no decoder. */
const PDF_MAGIC_BASE64 = "JVBERi";

const stripDataUrl = (value: string): string => value.replace(/^data:[^;]+;base64,/, "");

/** True when a base64 payload really starts with the PDF magic number. */
export const hasPdfMagic = (base64: string): boolean =>
  stripDataUrl(base64).startsWith(PDF_MAGIC_BASE64);

/** Decoded byte length of a base64 payload, without materialising the bytes. */
export const base64ByteLength = (value: string): number => {
  const body = stripDataUrl(value);
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
};

/**
 * Turns a Zod issue into a sentence a user can act on.
 *
 * The schema is the authority, but its default wording ("Number must be less
 * than or equal to 2097152") is not usable in a form, so the document-array
 * issues are rephrased with the offending file name.
 * @param issue Zod issue.
 * @param input Raw input, used to recover the file name.
 */
const describeIssue = (issue: z.ZodIssue, input: PipelineFormInput): string => {
  const [head, index, field] = issue.path;
  if (head === "documents" && typeof index === "number") {
    const name = input.documents?.[index]?.name ?? t("documents.generic", { index: index + 1 });
    if (field === "sizeBytes" || issue.code === "too_big") {
      return t("documents.tooLarge", { name, limit: megabytes(LIMITS.files.maxFileBytes) });
    }
    return t("documents.unacceptable", { name, reason: issue.message });
  }
  if (head === "documents") {
    return t("documents.tooMany", { count: LIMITS.files.maxCount });
  }
  return issue.message;
};

/**
 * Validates form values and resolves them into an immutable pipeline config.
 * @param input Raw form values.
 * @param options.hosted When true, loopback base URLs are refused up front.
 */
export const validatePipelineForm = (
  input: PipelineFormInput,
  options: { readonly hosted: boolean },
): PipelineValidationResult => {
  const parsed = pipelineFormSchema.safeParse(input);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".") || "form";
      errors[path] ??= describeIssue(issue, input);
    }
    return { config: null, errors };
  }

  const values = parsed.data;
  const errors: Record<string, string> = {};

  const definition = PROVIDERS[values.provider];
  const baseUrl = resolveBaseUrl(values.provider, values.baseUrl);
  if (baseUrl === null) {
    errors.baseUrl = t("error.noBaseUrl");
  } else if (options.hosted && isLoopbackUrl(baseUrl)) {
    errors.baseUrl = t("provider.localBlocked");
  } else if (!/^https?:\/\//.test(baseUrl)) {
    errors.baseUrl = t("error.baseUrlScheme");
  }

  if (values.apiKey.trim().length === 0 && !definition.selfHosted) {
    errors.apiKey = t("error.noApiKey");
  }

  const allowedEmbeddings = definition.embeddingModels as readonly string[];
  const embeddingModel = resolveEmbeddingModel(
    values.provider,
    allowedEmbeddings.includes(values.embeddingModel) ? values.embeddingModel : null,
  );

  // Sliders are snapped before the step check: a value off the grid is a UI
  // artefact (a keyboard nudge, a restored field), not a reason to refuse the
  // whole configuration.
  const chunkSize = snapToStep(values.chunkSize, LIMITS.chunkSize);
  const maxInputTokens = snapToStep(values.maxInputTokens, LIMITS.maxInputTokens);

  const totalBytes = values.documents.reduce((total, document) => total + document.sizeBytes, 0);
  if (totalBytes > LIMITS.files.maxTotalBytes) {
    errors.documents = t("documents.totalTooLarge", { limit: megabytes(LIMITS.files.maxTotalBytes) });
  }
  if (values.documents.length > LIMITS.files.maxCount) {
    errors.documents = t("documents.tooMany", { count: LIMITS.files.maxCount });
  }
  for (const document of values.documents) {
    if (!hasPdfMagic(document.base64)) {
      errors.documents = t("error.pdfInvalid", { name: document.name });
      break;
    }
    // Both the declared size and the decoded payload are checked: the declared
    // size is what the client measured and what the session stores, and the
    // decoded length catches a truncated or mismatched payload.
    if (
      document.sizeBytes > LIMITS.files.maxFileBytes ||
      base64ByteLength(document.base64) > LIMITS.files.maxFileBytes
    ) {
      errors.documents = t("documents.tooLarge", {
        name: document.name,
        limit: megabytes(LIMITS.files.maxFileBytes),
      });
      break;
    }
  }

  if (Object.keys(errors).length > 0 || baseUrl === null) {
    return { config: null, errors };
  }

  const config: PipelineConfig = {
    provider: values.provider,
    baseUrl,
    model: values.model,
    embeddingModel,
    embeddingDimension: EMBEDDING_DIMENSIONS[embeddingModel],
    chunkSize,
    chunkOverlapPercent: values.chunkOverlapPercent,
    chunkOverlapTokens: computeOverlapTokens(chunkSize, values.chunkOverlapPercent),
    maxInputTokens,
    distanceMetric: values.distanceMetric,
    topK: values.topK,
    retrievalMode: values.retrievalMode,
  };

  return { config, errors: {} };
};

/** Converts validated form documents into session documents. */
export const toUploadedDocuments = (documents: readonly PendingDocument[]): UploadedDocument[] =>
  documents.map((document) => ({
    id: document.id,
    name: document.name,
    sizeBytes: document.sizeBytes,
    bytes: Uint8Array.from(atob(stripDataUrl(document.base64)), (character) =>
      character.charCodeAt(0),
    ),
    pageCount: 0,
    chunkCount: 0,
    imageCount: 0,
  }));

export interface ClientDocumentCheck {
  readonly accepted: readonly PendingDocument[];
  readonly errors: readonly string[];
}

/**
 * Applies the upload limits in the browser so the user gets instant feedback.
 * The Server Action re-checks everything: this is convenience, not enforcement.
 * @param existing Documents already attached.
 * @param incoming Newly selected files.
 */
export const checkClientDocuments = (
  existing: readonly PendingDocument[],
  incoming: readonly PendingDocument[],
): ClientDocumentCheck => {
  const accepted: PendingDocument[] = [];
  const errors: string[] = [];
  const names = new Set(existing.map((document) => document.name));
  let totalBytes = existing.reduce((total, document) => total + document.sizeBytes, 0);

  for (const document of incoming) {
    if (existing.length + accepted.length >= LIMITS.files.maxCount) {
      errors.push(t("documents.tooMany", { count: LIMITS.files.maxCount }));
      break;
    }
    if (names.has(document.name)) {
      errors.push(t("documents.duplicate", { name: document.name }));
      continue;
    }
    if (!document.name.toLowerCase().endsWith(".pdf")) {
      errors.push(t("documents.notPdf", { name: document.name }));
      continue;
    }
    if (document.sizeBytes > LIMITS.files.maxFileBytes) {
      errors.push(
        t("documents.tooLarge", { name: document.name, limit: megabytes(LIMITS.files.maxFileBytes) }),
      );
      continue;
    }
    if (totalBytes + document.sizeBytes > LIMITS.files.maxTotalBytes) {
      errors.push(t("documents.totalTooLarge", { limit: megabytes(LIMITS.files.maxTotalBytes) }));
      break;
    }
    totalBytes += document.sizeBytes;
    names.add(document.name);
    accepted.push(document);
  }

  return { accepted, errors };
};
