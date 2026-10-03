/**
 * Central i18n dictionary. Every user-facing string in the application is
 * registered here — no literals in components — so a second locale is a data
 * change rather than a refactor. `TranslationKey` is derived from the object,
 * which turns a typo or a deleted key into a compile error.
 */

export const LOCALES = ["en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const en = {
  "app.name": "RAGdoll",
  "app.tagline": "AI RAG Dashboard & Chatbot",
  "app.description":
    "RAGdoll is a retrieval-augmented generation workbench: assemble a pipeline, evaluate it against Ragas metrics, then chat with your own PDFs. No code required.",

  "nav.primary": "Primary",
  "nav.home": "Home",
  "nav.create": "RAG Creation",
  "nav.evaluate": "Evaluate",
  "nav.chat": "Chat",
  "nav.lockedHint": "Create a RAG pipeline to unlock this page",
  "nav.skipToContent": "Skip to main content",
  "nav.themeToggle": "Toggle colour theme",
  "nav.themeLight": "Light",
  "nav.themeDark": "Dark",
  "nav.menu": "Open navigation menu",
  "nav.closeMenu": "Close navigation menu",

  "session.title": "Session",
  "session.storageNotice":
    "Everything you enter lives in your server session only. Nothing is written to disk.",
  "session.apiKeyNotice": "Your API key is held in your session and purged when it expires.",
  "session.pipelineReady": "Pipeline ready",
  "session.pipelineMissing": "No pipeline yet",
  "session.expiresIn": "Session expires in {time}",
  "session.refresh": "Keep alive",
  "session.refreshed": "Session refreshed",
  "session.documents": "{count} documents",
  "session.chunks": "{count} chunks",
  "session.reset": "Clear pipeline",
  "session.resetConfirm": "Clear the pipeline and reset every field to its default?",
  "session.resetDone": "Pipeline cleared. Fields restored to defaults.",
  "session.expired": "Your session expired. Create the pipeline again to continue.",
  "session.noSharedStore":
    "This deployment has no shared session store, so a request handled by another instance will not see your pipeline. Configure Upstash/Vercel KV.",

  "home.hero.eyebrow": "Retrieval Augmented Generation",
  "home.hero.title": "Build, evaluate and chat with a RAG pipeline",
  "home.hero.subtitle":
    "Pick a provider, drop in up to three PDFs, tune the retrieval knobs, and RAGdoll assembles the index, scores it with Ragas metrics, and answers questions with citations.",
  "home.cta.create": "Create a pipeline",
  "home.cta.chat": "Open chat",
  "home.cta.evaluate": "Run evaluation",
  "home.cta.home": "Learn more",
  "home.features.title": "What you get",
  "home.feature.pipeline.title": "Pipeline workbench",
  "home.feature.pipeline.body":
    "Four providers, selectable embedding models, chunking controls, distance metric and top-K — validated end to end before anything is indexed.",
  "home.feature.evaluate.title": "Ragas evaluation",
  "home.feature.evaluate.body":
    "Context precision and recall, entity recall, noise sensitivity, relevancy, faithfulness and the multimodal pair, reported in one dashboard.",
  "home.feature.chat.title": "Grounded chat",
  "home.feature.chat.body":
    "Citation-first streaming with a Ragas faithfulness gate: unsupported answers are replaced instead of hallucinated.",
  "home.how.title": "How it works",
  "home.how.step1.title": "Configure",
  "home.how.step1.body":
    "Choose OpenAI, Vocareum, DeepSeek or a self-hosted Ollama endpoint, then set the model and retrieval parameters.",
  "home.how.step2.title": "Ingest",
  "home.how.step2.body":
    "PDFs are parsed in a sandboxed worker, chunked with your overlap settings, and embedded into a per-session index.",
  "home.how.step3.title": "Ask",
  "home.how.step3.body":
    "Chat retrieves the top-K chunks, injects them as a tagged context block, and answers with page-level citations.",
  "home.stack.title": "Built with",
  "home.stack.body":
    "Next.js 15 App Router and React 19 on the front end, TanStack Query for server state, a TypeScript retrieval and evaluation engine running inside the Next.js server, and the Vercel AI SDK for streaming.",
  "home.license.title": "License",
  "home.license.body":
    "RAGdoll is released under the MIT License. Copyright (c) 2026 Harley Dangan.",
  "home.license.link": "Read the license",
  "home.aim.title": "Asian Institute of Management",
  "home.aim.body": "RAGdoll is submitted as a mini project to the Asian Institute of Management.",
  "home.aim.logoAlt": "Asian Institute of Management logo",

  "create.title": "RAG Creation",
  "create.subtitle": "Configure the pipeline. Every field is validated before the index is built.",
  "create.section.provider": "Provider",
  "create.section.model": "Model",
  "create.section.embedding": "Embedding",
  "create.section.credentials": "Credentials",
  "create.section.documents": "Documents",
  "create.section.retrieval": "Retrieval",

  "provider.label": "Provider",
  "provider.hint": "Requests are resolved from the function's network, not your browser.",
  "provider.baseUrl": "Base URL",
  "provider.baseUrlHint":
    "Point this at an Ollama or llama.cpp server reachable from the deployment.",
  "provider.baseUrlPlaceholder": "http://localhost:11434/v1",
  "provider.localBlocked":
    "Cannot reach localhost from a hosted deployment. Self-host RAGdoll to use local providers.",
  "provider.openai": "OpenAI",
  "provider.vocareum": "Vocareum",
  "provider.deepseek": "DeepSeek",
  "provider.ollama": "Ollama / Llama.cpp",

  "model.label": "LLM",
  "model.hint": "Model identifier sent to the provider.",
  "model.placeholder": "Model name",

  "embedding.model": "Embedding model",
  "embedding.hint": "Available models follow the selected provider.",
  "embedding.dimension": "Vector size",
  "embedding.dimensionHint": "Derived from the embedding model and read-only by design.",

  "credentials.apiKey": "API key",
  "credentials.apiKeyPlaceholder": "sk-…",
  "credentials.show": "Show API key",
  "credentials.hide": "Hide API key",
  "credentials.notRequired": "This provider does not require a key.",
  "credentials.stored": "Stored in session memory only — never persisted, never logged.",

  "documents.dropzone": "Add PDF files",
  "documents.dropzoneHint": "Drag and drop, or browse. PDF only.",
  "documents.limits": "Up to {count} files · {perFile} each · {total} per session.",
  "documents.limitsHosted":
    "On this deployment the platform caps the request body at 4.5 MB, so uploads are held below the app's own 5 MB limit.",
  "documents.browse": "Browse files",
  "documents.remove": "Remove {name}",
  "documents.pages": "{count} pages",
  "documents.tooMany": "You can upload at most {count} PDFs.",
  "documents.notPdf": "{name} is not a PDF file.",
  "documents.tooLarge": "{name} exceeds the {limit} per-file limit.",
  "documents.duplicate": "{name} is already attached.",
  "documents.totalTooLarge": "Combined uploads exceed the {limit} session limit.",
  "documents.empty": "No documents attached. The pipeline will answer from the model only.",
  "documents.rejected": "{name} was rejected: {reason}",
  "documents.unacceptable": "{name} could not be accepted: {reason}",
  "documents.generic": "Document {index}",

  "chunking.size": "Chunk size",
  "chunking.overlap": "Chunk overlap",
  "chunking.overlapValue": "{percent}% · {tokens} tokens",
  "chunking.overlapHint": "Rounded to the nearest multiple of 32, clamped to 10–20%.",
  "chunking.maxInput": "Max input tokens",
  "chunking.maxInputHint": "Context window reserved for retrieved chunks plus history.",

  "metric.label": "Distance metric",
  "metric.cosine": "Cosine similarity",
  "metric.dot": "Dot product",
  "metric.euclidean": "Euclidean distance",

  "retrieval.topK": "Top-K",
  "retrieval.topKHint": "Chunks retrieved per question. 0 disables retrieval.",
  "retrieval.mode": "Retrieval strategy",
  "retrieval.modeHint":
    "Context injection retrieves once; agentic exposes retrieval as a tool the model can call repeatedly.",
  "retrieval.contextInjection": "Context injection",
  "retrieval.agentic": "Agentic (tool call)",

  "create.submit": "Create RAG pipeline",
  "create.submitting": "Testing provider and building the index…",
  "create.test": "Test connection",
  "create.testing": "Testing connection…",
  "create.testOk": "Connected to {model} — embeddings {dimensions}d, first reply in {latency} ms.",
  "create.success": "Pipeline ready — {chunks} chunks from {documents} documents · {model}.",
  "create.successNoDocs": "Pipeline ready. No documents indexed yet · {model}.",
  "create.noTextNotice":
    "The pipeline was created, but no text could be extracted from your PDFs, so nothing was indexed — chat will only ever reply that it does not know. Upload a PDF whose text can be selected (not a scan) and create the pipeline again.",
  "create.clear": "Clear RAG pipeline",
  "create.pipelineExists": "A pipeline already exists. Creating again replaces it.",
  "create.validationFix": "Fix the highlighted fields and try again.",

  "evaluate.title": "Evaluate",
  "evaluate.subtitle":
    "Run the Ragas retrieval-augmented generation suite against your pipeline.",
  "evaluate.columnMetric": "Metric",
  "evaluate.columnScore": "Score",
  "evaluate.columnDefinition": "Definition",
  "evaluate.sampleCountLabel": "Questions",
  "evaluate.requiresPipeline": "Create a RAG pipeline first — evaluation needs an index to query.",
  "evaluate.run": "Run evaluation",
  "evaluate.rerun": "Run again",
  "evaluate.running": "Evaluating…",
  "evaluate.progress": "Scoring {completed} of {total} metrics",
  "evaluate.category": "Retrieval Augmented Generation",
  "evaluate.samples": "{count} synthetic questions",
  "evaluate.duration": "Completed in {seconds}s",
  "evaluate.multimodalSkipped":
    "Multimodal metrics are N/A: the uploaded PDFs contain no extractable images.",
  "evaluate.multimodalAvailable": "Image extraction detected — multimodal metrics included.",
  "evaluate.metric.context_precision": "Context Precision",
  "evaluate.metric.context_recall": "Context Recall",
  "evaluate.metric.context_entity_recall": "Context Entity Recall",
  "evaluate.metric.noise_sensitivity": "Noise Sensitivity",
  "evaluate.metric.response_relevancy": "Response Relevancy",
  "evaluate.metric.faithfulness": "Faithfulness",
  "evaluate.metric.multimodal_faithfulness": "Multimodal Faithfulness",
  "evaluate.metric.multimodal_relevance": "Multimodal Relevance",
  "evaluate.na": "N/A",
  "evaluate.samplesHeading": "Sampled questions",
  "evaluate.sampleHeading": "Sample question {index}",
  "evaluate.answerHeading": "Answer",
  "evaluate.contextsHeading": "Retrieved contexts",
  "evaluate.groundTruthHeading": "Ground truth",
  "evaluate.download": "Download JSON",
  "evaluate.failed": "Evaluation failed: {message}",
  "evaluate.timedOut":
    "The evaluation did not finish within the deployment's 5-minute limit, so it was stopped. Fewer questions, a faster model, or a self-hosted deployment will fit the budget.",

  "chat.title": "Chat",
  "chat.subtitle": "Ask questions and get answers grounded in your documents.",
  "chat.requiresPipeline": "Create a RAG pipeline first — chat needs an index to retrieve from.",
  "chat.placeholder": "Ask something about your documents…",
  "chat.send": "Send",
  "chat.stop": "Stop response",
  "chat.stopped": "Response stopped. Partial answer kept.",
  "chat.thinking": "RAGdoll is reading your documents",
  "chat.avatarAlt": "RAGdoll cat assistant",
  "chat.you": "You",
  "chat.assistant": "RAGdoll",
  "chat.empty.title": "Ask your first question",
  "chat.empty.body":
    "Try a question whose answer is inside the uploaded PDFs. Answers cite page numbers you can verify.",
  "chat.empty.suggestion1": "Summarise the key findings.",
  "chat.empty.suggestion2": "What methodology was used?",
  "chat.empty.suggestion3": "List the recommendations.",
  "chat.error": "The response failed: {message}",
  "chat.retry": "Try again",
  "chat.noTextWarning":
    "No text could be extracted from your PDFs, so nothing was indexed and every answer will be the fallback. Upload a PDF whose text can be selected (not a scan) and create the pipeline again.",
  "chat.fallbackNotice": "The answer failed the groundedness check and was withheld.",
  "chat.declinedNotice": "Your documents don't appear to contain the answer to that.",
  "chat.noMatchNotice": "No matching passage was found in your documents for that question.",
  "chat.contextWarning.title": "Context window reached",
  "chat.contextWarning.body":
    "This conversation has filled the {tokens} token context window. Start a new chat session to continue — your pipeline, PDFs and settings are kept.",
  "chat.contextWarning.confirm": "Start new chat session",
  "chat.contextWarning.proceed": "Send anyway",
  "chat.contextWarning.cancel": "Keep chatting",
  "chat.newSession": "New chat session",
  "chat.clearView": "Clear the view",
  "chat.sessionReset": "New chat session started. Pipeline and documents kept.",
  "chat.turnCount": "{count} turns",

  "citations.title": "Citations",
  "citations.empty": "Citations appear here once the assistant retrieves sources.",
  "citations.source": "{document} · p.{page}",
  "citations.score": "score {score}",
  "citations.count": "{count} sources",
  "citations.open": "Show citation for {document} page {page}",
  "citations.excerpt": "Excerpt",

  "status.testing": "Testing connection…",
  "status.ok": "Connected",
  "status.ready": "Ready",
  "status.running": "Running",
  "status.queued": "Queued",
  "status.skipped": "Skipped",
  "status.failed": "Failed",
  "status.noSharedStore": "No shared store",

  "error.generic": "Something went wrong. Try again.",
  "error.retry": "Retry",
  "error.unauthorized": "That request was not authorised. Refresh the page and try again.",
  "error.boundary.title": "This section failed to load",
  "error.boundary.body": "The error was contained so the rest of the app keeps working.",
  "error.network": "Cannot reach the server. Check your connection and retry.",
  "error.timeout": "The request timed out. Try again.",
  "error.invalidInput": "That input is not valid.",
  "error.guardrail.jailbreak":
    "This request looks like a jailbreak attempt and was blocked. Please rephrase your question.",
  "error.guardrail.injection":
    "This request looks like a prompt injection attempt and was blocked. Please rephrase your question.",
  "error.apiKey": "The provider rejected the API key. Check the key and provider selection.",
  "error.providerUnreachable": "The provider could not be reached at {baseUrl}.",
  "error.noApiKey": "Enter an API key for this provider.",
  "error.noBaseUrl": "Enter a base URL for this provider.",
  "error.baseUrlScheme": "The base URL must start with http:// or https://.",
  "error.noDocuments": "Upload at least one PDF before building the index.",
  "error.pdfInvalid": "{name} is not a readable PDF.",
  "error.pdfEncrypted": "{name} is password protected and cannot be indexed.",
  "error.pdfActiveContent": "{name} contains JavaScript or embedded files and was rejected.",
  "error.pipelineMissing": "No pipeline in this session.",
  "error.notFound": "Not found.",

  "a11y.slider": "{label} slider, {value} of {max}",
  "a11y.progress": "{label} progress",
  "a11y.loading": "Loading",
  "a11y.errorSummary": "Form errors",

  "notice.region": "Notifications",
  "notice.dismiss": "Dismiss notification",
} as const;

export type TranslationKey = keyof typeof en;

export const dictionaries: Readonly<Record<Locale, Readonly<Record<TranslationKey, string>>>> = {
  en,
};

export type TranslationVars = Readonly<Record<string, string | number>>;

/**
 * Interpolates `{name}` placeholders.
 * @param template Dictionary entry.
 * @param vars Replacement values.
 */
const interpolate = (template: string, vars?: TranslationVars): string => {
  if (vars === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = vars[token];
    return value === undefined ? match : String(value);
  });
};

export interface Translator {
  (key: TranslationKey, vars?: TranslationVars): string;
  readonly locale: Locale;
}

/**
 * Creates a translator bound to a locale.
 * @param locale Target locale.
 */
export const createTranslator = (locale: Locale = DEFAULT_LOCALE): Translator => {
  const table = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE];

  const translate = (key: TranslationKey, vars?: TranslationVars): string => {
    const entry = table[key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
    return interpolate(entry, vars);
  };

  return Object.assign(translate, { locale }) as Translator;
};

/** Locale-aware plural helper for dictionary entries such as `session.chunks`. */
export const pluralize = (count: number, singular: string, plural: string): string =>
  count === 1 ? singular : plural;

export const t = createTranslator();
