"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";

import { clearPipelineAction, createPipelineAction, testConnectionAction } from "@/app/actions/pipeline";
import { InlineNotice } from "@/components/ui/feedback";
import { Field, SegmentedControl, SliderField } from "@/components/ui/form-fields";
import { SecretField } from "@/components/ui/secret-field";
import {
  IconAlert,
  IconCheck,
  IconDatabase,
  IconFile,
  IconInfo,
  IconSpinner,
  IconTrash,
  IconUpload,
} from "@/components/ui/icons";
import { useSession } from "@/hooks/use-session";
import { t } from "@/lib/i18n";
import {
  DISTANCE_METRIC_LABEL_KEYS,
  EMBEDDING_DIMENSIONS,
  PROVIDERS,
  PROVIDER_ORDER,
  RETRIEVAL_MODE_LABEL_KEYS,
  SIMILARITY_HINTS,
} from "@/lib/providers";
import { LIMITS, computeOverlapTokens } from "@/lib/rules";
import {
  DISTANCE_METRICS,
  RETRIEVAL_MODES,
  type DistanceMetric,
  type PipelineConfig,
  type EmbeddingModel,
  type ProviderId,
  type RetrievalMode,
} from "@/lib/types";
import { checkClientDocuments, type PendingDocument } from "@/lib/validation";

/**
 * RAG creation form.
 *
 * Client-side validation exists to give instant feedback; the Server Action
 * re-validates with the same function, so the server is always the authority.
 * Files are read into base64 in the browser and travel with the action — the
 * server never receives a path, and nothing is written to disk on either side.
 */

interface FormState {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  embeddingModel: EmbeddingModel;
  chunkSize: number;
  chunkOverlapPercent: number;
  maxInputTokens: number;
  distanceMetric: DistanceMetric;
  topK: number;
  retrievalMode: RetrievalMode;
}

const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error(`Could not read ${file.name}.`));
    };
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });

const createId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `doc-${Math.random().toString(36).slice(2)}`;

/** The form's pristine state: also what "Clear RAG pipeline" restores. */
const defaultFormState = (): FormState => ({
  provider: "openai",
  baseUrl: "",
  model: PROVIDERS.openai.defaultModel,
  embeddingModel: PROVIDERS.openai.embeddingModels[0] ?? "text-embedding-3-small",
  chunkSize: LIMITS.chunkSize.default,
  chunkOverlapPercent: LIMITS.chunkOverlapPercent.default,
  maxInputTokens: LIMITS.maxInputTokens.default,
  distanceMetric: "cosine",
  topK: LIMITS.topK.default,
  retrievalMode: "context-injection",
});

/** Projects an existing pipeline back onto the form, so reloads agree with it. */
const formStateFromPipeline = (config: PipelineConfig): FormState => ({
  provider: config.provider,
  baseUrl: config.baseUrl,
  model: config.model,
  embeddingModel: config.embeddingModel,
  chunkSize: config.chunkSize,
  chunkOverlapPercent: config.chunkOverlapPercent,
  maxInputTokens: config.maxInputTokens,
  distanceMetric: config.distanceMetric,
  topK: config.topK,
  retrievalMode: config.retrievalMode,
});

export function RagCreationForm(): ReactElement {
  const ids = {
    provider: useId(),
    baseUrl: useId(),
    model: useId(),
    embedding: useId(),
    apiKey: useId(),
    chunkSize: useId(),
    overlap: useId(),
    maxInput: useId(),
    topK: useId(),
    upload: useId(),
  };

  const { hasPipeline, pipeline, maskedKey, refetch } = useSession();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const hydratedFor = useRef<string | null>(null);

  const [form, setForm] = useState<FormState>(defaultFormState);
  const [apiKey, setApiKey] = useState("");
  const [documents, setDocuments] = useState<readonly PendingDocument[]>([]);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<"idle" | "testing" | "creating">("idle");
  const [notice, setNotice] = useState<
    { readonly tone: "success" | "danger" | "info"; readonly message: string } | null
  >(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const definition = PROVIDERS[form.provider];
  const overlapTokens = useMemo(
    () => computeOverlapTokens(form.chunkSize, form.chunkOverlapPercent),
    [form.chunkSize, form.chunkOverlapPercent],
  );
  const totalBytes = documents.reduce((total, document) => total + document.sizeBytes, 0);

  // An existing pipeline is the session's truth, so the fields adopt it on first
  // read. Without this, a reload showed default sliders next to a banner reporting
  // the configured values, and the two disagreed.
  useEffect(() => {
    if (pipeline === null || hydratedFor.current === pipeline.createdAt) {
      return;
    }
    hydratedFor.current = pipeline.createdAt;
    setForm(formStateFromPipeline(pipeline.config));
  }, [pipeline]);

  const updateForm = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  }, []);

  const selectProvider = useCallback((provider: ProviderId) => {
    setForm((current) => ({
      ...current,
      provider,
      model: PROVIDERS[provider].defaultModel,
      embeddingModel: PROVIDERS[provider].embeddingModels[0] ?? current.embeddingModel,
      baseUrl: provider === "ollama" ? current.baseUrl : "",
    }));
    setTestResult(null);
  }, []);

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (files === null || files.length === 0) {
        return;
      }
      const pending: PendingDocument[] = [];
      for (const file of Array.from(files)) {
        const base64 = await readFileAsBase64(file);
        pending.push({
          id: createId(),
          name: file.name,
          sizeBytes: file.size,
          base64,
        });
      }

      setDocuments((current) => {
        const { accepted, errors: rejected } = checkClientDocuments(current, pending);
        if (rejected.length > 0) {
          setNotice({ tone: "danger", message: rejected.join(" ") });
        } else {
          setNotice(null);
        }
        return [...current, ...accepted];
      });
      if (fileInput.current !== null) {
        fileInput.current.value = "";
      }
    },
    [],
  );

  const payload = useMemo(
    () => ({
      ...form,
      apiKey,
      documents: documents.map((document) => ({
        id: document.id,
        name: document.name,
        sizeBytes: document.sizeBytes,
        base64: document.base64,
      })),
    }),
    [apiKey, documents, form],
  );

  const runTest = useCallback(async () => {
    setBusy("testing");
    setErrors({});
    setNotice(null);
    try {
      const result = await testConnectionAction(payload);
      if (!result.ok) {
        setErrors(result.error.fields ?? {});
        setNotice({ tone: "danger", message: result.error.message });
        return;
      }
      setTestResult(
        t("create.testOk", {
          model: result.data.modelEcho || form.model,
          dimensions: result.data.embeddingDimension,
          latency: result.data.latencyMs,
        }),
      );
    } finally {
      setBusy("idle");
    }
  }, [form.model, payload]);

  const submit = useCallback(async () => {
    setBusy("creating");
    setErrors({});
    setNotice(null);
    try {
      const result = await createPipelineAction(payload);
      if (!result.ok) {
        setErrors(result.error.fields ?? {});
        setNotice({ tone: "danger", message: result.error.message });
        return;
      }
      setNotice({
        tone: "success",
        message:
          documents.length === 0
            ? t("create.successNoDocs")
            : t("create.success", {
                chunks: result.data.chunkCount,
                documents: result.data.documents.length,
              }),
      });
      refetch();
    } finally {
      setBusy("idle");
    }
  }, [documents.length, payload, refetch]);

  const clear = useCallback(async () => {
    if (!window.confirm(t("session.resetConfirm"))) {
      return;
    }
    setBusy("creating");
    try {
      const result = await clearPipelineAction();
      if (!result.ok) {
        setNotice({ tone: "danger", message: result.error.message });
        return;
      }
      setForm({
        provider: "openai",
        baseUrl: "",
        model: PROVIDERS.openai.defaultModel,
        embeddingModel: PROVIDERS.openai.embeddingModels[0] ?? "text-embedding-3-small",
        chunkSize: LIMITS.chunkSize.default,
        chunkOverlapPercent: LIMITS.chunkOverlapPercent.default,
        maxInputTokens: LIMITS.maxInputTokens.default,
        distanceMetric: "cosine",
        topK: LIMITS.topK.default,
        retrievalMode: "context-injection",
      });
      setDocuments([]);
      setApiKey("");
      setTestResult(null);
      setNotice({ tone: "info", message: t("session.resetDone") });
      refetch();
    } finally {
      setBusy("idle");
    }
  }, [refetch]);

  const disabled = busy !== "idle";

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <InlineNotice tone="info" title={t("session.title")}>
        {t("session.storageNotice")}
      </InlineNotice>

      {hasPipeline ? (
        <InlineNotice tone="warning" title={t("session.pipelineReady")}>
          {t("create.pipelineExists")}
          {maskedKey === null ? null : <span className="ml-1 font-mono text-xs">({maskedKey})</span>}
        </InlineNotice>
      ) : null}

      {notice === null ? null : (
        <InlineNotice tone={notice.tone}>
          {notice.message}
        </InlineNotice>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="section-title">{t("create.section.provider")}</h2>
          <div className="mt-4 space-y-5">
            <SegmentedControl<ProviderId>
              name="provider"
              legend={t("provider.label")}
              value={form.provider}
              onChange={selectProvider}
              disabled={disabled}
              options={PROVIDER_ORDER.map((provider) => ({
                value: provider,
                label: t(PROVIDERS[provider].labelKey as `provider.${ProviderId}`),
              }))}
            />
            <p className="field-hint">{t("provider.hint")}</p>

            <Field
              label={t("provider.baseUrl")}
              hint={definition.requiresBaseUrl ? t("provider.baseUrlHint") : undefined}
              error={errors.baseUrl}
              htmlFor={ids.baseUrl}
            >
              <input
                id={ids.baseUrl}
                className="input-mono"
                value={definition.requiresBaseUrl ? form.baseUrl : definition.baseUrl ?? ""}
                placeholder={t("provider.baseUrlPlaceholder")}
                readOnly={!definition.requiresBaseUrl}
                disabled={disabled}
                onChange={(event) => {
                  updateForm("baseUrl", event.target.value);
                }}
              />
            </Field>

            <Field label={t("model.label")} hint={t("model.hint")} error={errors.model} htmlFor={ids.model}>
              <>
                <input
                  id={ids.model}
                  className="input-mono"
                  list={`${ids.model}-suggestions`}
                  value={form.model}
                  placeholder={t("model.placeholder")}
                  disabled={disabled}
                  onChange={(event) => {
                    updateForm("model", event.target.value);
                  }}
                />
                <datalist id={`${ids.model}-suggestions`}>
                  {definition.modelSuggestions.map((suggestion) => (
                    <option key={suggestion} value={suggestion} />
                  ))}
                </datalist>
              </>
            </Field>

            <Field
              label={t("embedding.model")}
              hint={t("embedding.hint")}
              htmlFor={ids.embedding}
              trailing={
                <span className="badge font-mono">
                  {t("embedding.dimension")} {EMBEDDING_DIMENSIONS[form.embeddingModel]}
                </span>
              }
            >
              <select
                id={ids.embedding}
                className="input-mono"
                value={form.embeddingModel}
                disabled={disabled}
                onChange={(event) => {
                  updateForm("embeddingModel", event.target.value as EmbeddingModel);
                }}
              >
                {definition.embeddingModels.map((model) => (
                  <option key={model} value={model}>
                    {model} · {EMBEDDING_DIMENSIONS[model]}d
                  </option>
                ))}
              </select>
            </Field>
            <p className="field-hint">{t("embedding.dimensionHint")}</p>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="section-title">{t("create.section.credentials")}</h2>
          <div className="mt-4 space-y-5">
            <SecretField
              id={ids.apiKey}
              label={t("credentials.apiKey")}
              value={apiKey}
              placeholder={t("credentials.apiKeyPlaceholder")}
              hint={t("session.apiKeyNotice")}
              error={errors.apiKey}
              disabled={disabled}
              onChange={setApiKey}
            />
            {definition.selfHosted ? (
              <p className="field-hint">{t("credentials.notRequired")}</p>
            ) : null}
          </div>
        </section>

        <section className="card p-5">
          <h2 className="section-title">{t("create.section.documents")}</h2>
          <div className="mt-4 space-y-4">
            <div
              className="rounded-2xl border-2 border-dashed border-line-strong bg-surface-muted px-4 py-6 text-center transition-colors hover:border-cyan-400"
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                void onFiles(event.dataTransfer.files);
              }}
            >
              <IconUpload className="mx-auto h-6 w-6 text-cyan-500" />
              <p className="mt-2 text-sm font-medium">{t("documents.dropzone")}</p>
              <p className="field-hint mt-0.5">{t("documents.dropzoneHint")}</p>
              <input
                ref={fileInput}
                id={ids.upload}
                type="file"
                accept="application/pdf,.pdf"
                multiple
                className="sr-only"
                disabled={disabled}
                onChange={(event) => {
                  void onFiles(event.target.files);
                }}
              />
              <button
                type="button"
                className="btn-secondary mt-3"
                disabled={disabled || documents.length >= LIMITS.files.maxCount}
                onClick={() => {
                  fileInput.current?.click();
                }}
              >
                <IconFile className="h-4 w-4" />
                {t("documents.browse")}
              </button>
              <p className="field-hint mt-2">{t("documents.limits")}</p>
            </div>

            {errors.documents === undefined ? null : (
              <p className="field-error" role="alert">
                <IconAlert className="h-3.5 w-3.5" />
                {errors.documents}
              </p>
            )}

            {documents.length === 0 ? (
              <p className="field-hint">{t("documents.empty")}</p>
            ) : (
              <ul className="space-y-2">
                {documents.map((document) => (
                  <li
                    key={document.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <IconFile className="h-4 w-4 shrink-0 text-cyan-600" />
                      <span className="truncate text-sm">{document.name}</span>
                      <span className="badge font-mono text-[10px]">
                        {(document.sizeBytes / 1024).toFixed(0)} KB
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn-ghost h-8 w-8 !px-0"
                      aria-label={t("documents.remove", { name: document.name })}
                      onClick={() => {
                        setDocuments((current) =>
                          current.filter((candidate) => candidate.id !== document.id),
                        );
                      }}
                    >
                      <IconTrash className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="field-hint">
              {t("session.documents", { count: documents.length })} ·{" "}
              {(totalBytes / 1024 / 1024).toFixed(2)} MB / 6 MB
            </p>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="section-title">{t("create.section.retrieval")}</h2>
          <div className="mt-4 space-y-6">
            <SliderField
              id={ids.chunkSize}
              labelKey="chunking.size"
              value={form.chunkSize}
              min={LIMITS.chunkSize.min}
              max={LIMITS.chunkSize.max}
              step={LIMITS.chunkSize.step}
              valueLabel={`${form.chunkSize} tok`}
              disabled={disabled}
              onChange={(next) => {
                updateForm("chunkSize", next);
              }}
            />

            <SliderField
              id={ids.overlap}
              labelKey="chunking.overlap"
              value={form.chunkOverlapPercent}
              min={LIMITS.chunkOverlapPercent.min}
              max={LIMITS.chunkOverlapPercent.max}
              step={LIMITS.chunkOverlapPercent.step}
              valueLabel={t("chunking.overlapValue", {
                percent: form.chunkOverlapPercent,
                tokens: overlapTokens,
              })}
              hint={t("chunking.overlapHint")}
              disabled={disabled}
              onChange={(next) => {
                updateForm("chunkOverlapPercent", next);
              }}
            />

            <SliderField
              id={ids.maxInput}
              labelKey="chunking.maxInput"
              value={form.maxInputTokens}
              min={LIMITS.maxInputTokens.min}
              max={LIMITS.maxInputTokens.max}
              step={LIMITS.maxInputTokens.step}
              valueLabel={`${form.maxInputTokens} tok`}
              hint={t("chunking.maxInputHint")}
              disabled={disabled}
              onChange={(next) => {
                updateForm("maxInputTokens", next);
              }}
            />

            <SegmentedControl<DistanceMetric>
              name="distance-metric"
              legend={t("metric.label")}
              value={form.distanceMetric}
              onChange={(next) => {
                updateForm("distanceMetric", next);
              }}
              disabled={disabled}
              options={DISTANCE_METRICS.map((metric) => ({
                value: metric,
                label: t(DISTANCE_METRIC_LABEL_KEYS[metric]),
                hint: SIMILARITY_HINTS[metric],
              }))}
            />

            <SliderField
              id={ids.topK}
              labelKey="retrieval.topK"
              value={form.topK}
              min={LIMITS.topK.min}
              max={LIMITS.topK.max}
              step={LIMITS.topK.step}
              valueLabel={`${form.topK}`}
              hint={t("retrieval.topKHint")}
              disabled={disabled}
              onChange={(next) => {
                updateForm("topK", next);
              }}
            />

            <SegmentedControl<RetrievalMode>
              name="retrieval-mode"
              legend={t("retrieval.mode")}
              value={form.retrievalMode}
              onChange={(next) => {
                updateForm("retrievalMode", next);
              }}
              disabled={disabled}
              options={RETRIEVAL_MODES.map((mode) => ({
                value: mode,
                label: t(RETRIEVAL_MODE_LABEL_KEYS[mode]),
              }))}
            />
            <p className="field-hint">{t("retrieval.modeHint")}</p>
          </div>
        </section>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="button"
          className="btn-secondary"
          disabled={disabled}
          onClick={() => {
            void runTest();
          }}
        >
          {busy === "testing" ? <IconSpinner className="h-4 w-4" /> : <IconDatabase className="h-4 w-4" />}
          {busy === "testing" ? t("create.testing") : t("create.test")}
        </button>

        <button type="submit" className="btn-primary" disabled={disabled}>
          {busy === "creating" ? <IconSpinner className="h-4 w-4" /> : <IconCheck className="h-4 w-4" />}
          {busy === "creating" ? t("create.submitting") : t("create.submit")}
        </button>

        <button
          type="button"
          className="btn-danger sm:ml-auto"
          disabled={disabled || !hasPipeline}
          onClick={() => {
            void clear();
          }}
        >
          <IconTrash className="h-4 w-4" />
          {t("create.clear")}
        </button>
      </div>

      {testResult === null ? null : (
        <InlineNotice tone="success">
          <span className="flex items-center gap-2">
            <IconCheck className="h-4 w-4" />
            {testResult}
          </span>
        </InlineNotice>
      )}

      {hasPipeline && pipeline !== null ? (
        <InlineNotice tone="info" title={t("session.pipelineReady")}>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="flex items-center gap-1.5">
              <IconInfo className="h-3.5 w-3.5" />
              {pipeline.config.model} · {pipeline.config.embeddingModel} (
              {pipeline.config.embeddingDimension}d)
            </span>
            <span>
              {t("session.documents", { count: pipeline.documents.length })} ·{" "}
              {t("session.chunks", { count: pipeline.chunkCount })}
            </span>
            <span>
              chunk {pipeline.config.chunkSize} · overlap {pipeline.config.chunkOverlapTokens} · top-K{" "}
              {pipeline.config.topK}
            </span>
          </span>
        </InlineNotice>
      ) : null}
    </form>
  );
}
