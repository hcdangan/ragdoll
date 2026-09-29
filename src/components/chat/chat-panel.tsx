"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { CatAvatar } from "@/components/brand/logo";
import { IconAlert, IconQuote, IconRefresh, IconSend, IconSpinner, IconStop } from "@/components/ui/icons";
import { useNotices, type NoticeInput } from "@/components/providers/notice-provider";
import { resetChatAction } from "@/app/actions/pipeline";
import {
  messageCitations,
  messageError,
  messageFallback,
  messageStatus,
  messageText,
  type CitationData,
  type ChatErrorData,
  type FallbackData,
  type RagdollUIMessage,
} from "@/lib/chat-message";
import { useSession } from "@/hooks/use-session";
import { t, type TranslationKey } from "@/lib/i18n";
import { exceedsContextWindow } from "@/lib/rules";
import type { Citation, FallbackReason } from "@/lib/types";

/**
 * Copy for each reason an answer came back as the fallback string.
 *
 * Reporting every one of them as a failed groundedness check is what made a
 * perfectly good "I don't know" look like a bug in the pipeline.
 */
const FALLBACK_NOTICE: Readonly<Record<FallbackReason, TranslationKey>> = {
  unsupported: "chat.fallbackNotice",
  declined: "chat.declinedNotice",
  no_context: "chat.noMatchNotice",
};

/**
 * Chat surface.
 *
 * `useChat` owns the transcript and the in-flight response; everything else in
 * this component is presentation. Three details are deliberate:
 *
 *  * **Interrupt** — `stop()` aborts the fetch, which aborts the server's request
 *    to the provider, and the partial assistant text stays in the transcript.
 *  * **Groundedness replacement** — when the engine's faithfulness gate rejects a
 *    drafted answer, a `data-fallback` part arrives and the draft is swapped for
 *    the canned refusal, so the user never reads an unsupported answer.
 *  * **Citation-first** — the citation panel is populated from a data part that
 *    is emitted *before* the first token, so sources appear while the answer
 *    streams.
 */

const MAX_HISTORY_SENT = 10;

const toEngineMessages = (messages: readonly RagdollUIMessage[]): readonly RagdollUIMessage[] =>
  messages.slice(-MAX_HISTORY_SENT);

/**
 * The failure notice, carrying the retry affordance the inline alert used to own.
 *
 * `retry` is a ref rather than the callback itself so the notice raised from
 * `onData` — which runs before `useChat` returns `regenerate` — still calls the
 * current one when the user presses the button.
 */
const chatErrorNotice = (message: string, retry: RefObject<() => void>): NoticeInput => ({
  tone: "danger",
  message,
  action: (
    <button
      type="button"
      className="btn-secondary text-xs"
      onClick={() => {
        retry.current();
      }}
    >
      <IconRefresh className="h-4 w-4" />
      {t("chat.retry")}
    </button>
  ),
});

export function ChatPanel(): ReactElement {
  const { canChat, hasPipeline, pipeline } = useSession();
  // Stream failures are reported through the fixed notification stack rather than
  // a banner above the composer: the transcript scrolls independently, and a long
  // answer can push an inline alert out of view while the user is still reading.
  const { notify, clear } = useNotices();
  const [input, setInput] = useState("");
  const [citations, setCitations] = useState<readonly Citation[]>([]);
  const [fallbackReason, setFallbackReason] = useState<FallbackReason | null>(null);
  const [contextWarning, setContextWarning] = useState(false);
  const [resetting, setResetting] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The retry offered by an error notice has to survive being raised from a
  // callback that runs before `useChat` hands back `regenerate`.
  const retryRef = useRef<() => void>(() => undefined);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<RagdollUIMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { messages: toEngineMessages(messages) },
        }),
      }),
    [],
  );

  const { messages, sendMessage, status, stop, error, regenerate, setMessages } =
    useChat<RagdollUIMessage>({
      transport,
      onData: (part) => {
        if (part.type === "data-citation") {
          setCitations((part.data as CitationData).citations);
          setFallbackReason(null);
        } else if (part.type === "data-fallback") {
          setFallbackReason((part.data as FallbackData).reason ?? "unsupported");
        } else if (part.type === "data-error") {
          notify(chatErrorNotice((part.data as ChatErrorData).message, retryRef));
        }
      },
    });

  useEffect(() => {
    retryRef.current = () => {
      void regenerate();
    };
  }, [regenerate]);

  useEffect(() => {
    if (error === undefined) {
      return;
    }
    notify(chatErrorNotice(t("chat.error", { message: error.message }), retryRef));
  }, [error, notify]);

  const busy = status === "streaming" || status === "submitted";
  const maxInputTokens = pipeline?.config.maxInputTokens ?? 1024;
  const noTextIndexed =
    hasPipeline && (pipeline?.documents.length ?? 0) > 0 && (pipeline?.chunkCount ?? 0) === 0;

  // The context window is a client-side budget: the browser knows the transcript
  // length, and the engine only ever sees the trimmed history. Warning before the
  // send — rather than letting retrieval degrade silently — is the point.
  const transcriptTokens = useMemo(
    () =>
      messages.reduce(
        (total, message) => total + Math.ceil(messageText(message).length / 4),
        0,
      ),
    [messages],
  );
  const contextFull = exceedsContextWindow(transcriptTokens, maxInputTokens);

  const resetContext = useCallback(async () => {
    setResetting(true);
    try {
      const result = await resetChatAction();
      if (!result.ok) {
        notify({ tone: "danger", message: result.error.message });
        return;
      }
      setMessages([]);
      setCitations([]);
      setFallbackReason(null);
      setContextWarning(false);
    } finally {
      setResetting(false);
    }
  }, [notify, setMessages]);

  const submit = useCallback(
    (text: string, options: { readonly bypassWarning?: boolean } = {}) => {
      const question = text.trim();
      if (question.length === 0 || busy) {
        return;
      }
      const overBudget = exceedsContextWindow(
        transcriptTokens + Math.ceil(question.length / 4),
        maxInputTokens,
      );
      if (overBudget && options.bypassWarning !== true) {
        // Warn once, then let the user proceed: the engine trims history to the
        // same budget, so a long conversation degrades rather than breaking, and
        // trapping the user in a dead end would be worse than the degradation.
        setContextWarning(true);
        return;
      }
      setInput("");
      setCitations([]);
      setFallbackReason(null);
      // A new question retires the previous failure, exactly as the inline alert
      // used to be cleared on send.
      clear();
      setContextWarning(overBudget);
      void sendMessage({ text: question });
    },
    [busy, clear, maxInputTokens, sendMessage, transcriptTokens],
  );

  /** Clears the view only; the session transcript is left untouched. */
  const clearConversation = useCallback(() => {
    setMessages([]);
    setCitations([]);
    setFallbackReason(null);
    clear();
    setContextWarning(false);
  }, [clear, setMessages]);

  const suggestions = [
    t("chat.empty.suggestion1"),
    t("chat.empty.suggestion2"),
    t("chat.empty.suggestion3"),
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-h-[65vh] flex-col">
        <div
          ref={scrollRef}
          className="scrollbar-thin flex-1 space-y-5 overflow-y-auto rounded-2xl border border-line bg-surface p-4 sm:p-6"
          aria-live="polite"
          aria-busy={busy}
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 py-10 text-center">
              <CatAvatar size={96} />
              <div>
                <h2 className="text-lg font-semibold">{t("chat.empty.title")}</h2>
                <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{t("chat.empty.body")}</p>
              </div>
              <ul className="flex flex-wrap justify-center gap-2">
                {suggestions.map((suggestion) => (
                  <li key={suggestion}>
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      onClick={() => {
                        submit(suggestion);
                      }}
                    >
                      {suggestion}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {messages.map((message, index) => (
            <ChatBubble
              key={message.id}
              message={message}
              thinking={busy && index === messages.length - 1 && message.role === "assistant"}
              onCitation={(citation) => {
                setCitations((current) =>
                  current.some((item) => item.chunkId === citation.chunkId)
                    ? current
                    : [...current, citation],
                );
              }}
            />
          ))}
        </div>

        {contextWarning || contextFull ? (
          <div className="mt-3" role="alert">
            <div className="rounded-xl border border-warning bg-warning/25 px-4 py-3 text-sm text-ink">
              <p className="font-semibold">{t("chat.contextWarning.title")}</p>
              <p className="mt-1">
                {t("chat.contextWarning.body", { tokens: maxInputTokens })}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={resetting}
                  onClick={() => {
                    void resetContext();
                  }}
                >
                  {resetting ? <IconSpinner className="h-4 w-4" /> : <IconRefresh className="h-4 w-4" />}
                  {t("chat.contextWarning.confirm")}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={resetting || input.trim().length === 0}
                  onClick={() => {
                    // Explicit, second-press consent: the warning stays visible so
                    // the user can see the budget is still exceeded.
                    submit(input, { bypassWarning: true });
                  }}
                >
                  {t("chat.contextWarning.proceed")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit(input);
          }}
        >
          <label className="sr-only" htmlFor="chat-input">
            {t("chat.placeholder")}
          </label>
          <textarea
            id="chat-input"
            className="input min-h-[52px] flex-1 resize-y"
            rows={2}
            placeholder={canChat ? t("chat.placeholder") : t("chat.requiresPipeline")}
            value={input}
            disabled={busy || !canChat}
            aria-describedby="chat-input-hint"
            onChange={(event) => {
              setInput(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(input);
              }
            }}
          />
          {busy ? (
            <button
              type="button"
              className="btn-secondary h-[52px]"
              onClick={() => {
                stop();
              }}
              aria-label={t("chat.stop")}
            >
              <IconStop className="h-4 w-4" />
              <span className="hidden sm:inline">{t("chat.stop")}</span>
            </button>
          ) : (
            <button
              type="submit"
              className="btn-primary h-[52px]"
              disabled={!canChat || input.trim().length === 0}
              aria-label={t("chat.send")}
            >
              <IconSend className="h-4 w-4" />
              <span className="hidden sm:inline">{t("chat.send")}</span>
            </button>
          )}
        </form>
        {/* A pipeline built over PDFs with no extractable text answers "I don't
            know" to everything. Without this line that is indistinguishable from
            a broken chatbot. */}
        {noTextIndexed ? (
          <p className="tone-warning mt-2 px-3 py-2 text-xs font-medium">
            {t("chat.noTextWarning")}
          </p>
        ) : null}
        <p id="chat-input-hint" className="field-hint mt-2">
          {hasPipeline
            ? t("session.chunks", { count: pipeline?.chunkCount ?? 0 })
            : t("chat.requiresPipeline")}
          {" · "}
          {t("chat.subtitle")}
          <button
            type="button"
            className="ml-2 underline decoration-dotted underline-offset-2 hover:text-ink"
            onClick={clearConversation}
          >
            {t("chat.clearView")}
          </button>
        </p>
      </div>

      <CitationPanel citations={citations} fallbackReason={fallbackReason} />
    </div>
  );
}

/** One transcript entry, styled by role. */
function ChatBubble({
  message,
  thinking,
  onCitation,
}: {
  readonly message: RagdollUIMessage;
  readonly thinking: boolean;
  readonly onCitation: (citation: Citation) => void;
}): ReactElement {
  const isUser = message.role === "user";
  const fallback = messageFallback(message);
  const text = fallback?.answer ?? messageText(message);
  const localError = messageError(message);
  const status = messageStatus(message);
  const citations = messageCitations(message);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-navy-900 px-4 py-2.5 text-sm text-cream-50">
          <span className="sr-only">{t("chat.you")}: </span>
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <CatAvatar size={40} thinking={thinking} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
          {t("chat.assistant")}
        </p>
        <div className="rounded-2xl rounded-tl-sm border border-line bg-surface-muted px-4 py-3 text-sm leading-relaxed text-ink">
          {text.length === 0 && thinking ? (
            <span className="flex items-center gap-2 text-ink-muted">
              <span className="flex gap-1" aria-hidden>
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-dots-pulse"
                    style={{ animationDelay: `${dot * 0.15}s` }}
                  />
                ))}
              </span>
              {status?.message ?? t("chat.thinking")}
            </span>
          ) : (
            <p className="whitespace-pre-wrap">{text}</p>
          )}
        </div>

        {fallback !== null ? (
          <p className="tone-warning mt-1 inline-block px-2 py-0.5 text-xs font-medium">
            {t(FALLBACK_NOTICE[fallback.reason ?? "unsupported"])}
          </p>
        ) : null}

        {localError !== null ? (
          <p className="field-error mt-1">
            <IconAlert className="h-3.5 w-3.5" />
            {localError.message}
          </p>
        ) : null}

        {citations.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {citations.map((citation) => (
              <li key={`${citation.chunkId}-${citation.page}`}>
                <button
                  type="button"
                  className="citation-chip"
                  title={citation.snippet}
                  aria-label={t("citations.open", {
                    document: citation.documentName,
                    page: citation.page,
                  })}
                  onClick={() => {
                    onCitation(citation);
                  }}
                >
                  <IconQuote className="h-3 w-3" />
                  {t("citations.source", {
                    document: citation.documentName,
                    page: citation.page,
                  })}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** Citation rail, populated before the first token arrives. */
function CitationPanel({
  citations,
  fallbackReason,
}: {
  readonly citations: readonly Citation[];
  readonly fallbackReason: FallbackReason | null;
}): ReactElement {
  return (
    <aside className="card h-fit p-4 lg:sticky lg:top-20" aria-label={t("citations.title")}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-ink-subtle">
          {t("citations.title")}
        </h2>
        {citations.length > 0 ? (
          <span className="badge-brand">{t("citations.count", { count: citations.length })}</span>
        ) : null}
      </div>

      {fallbackReason !== null ? (
        <p className="tone-warning mt-3 px-3 py-2 text-xs font-medium">
          {t(FALLBACK_NOTICE[fallbackReason])}
        </p>
      ) : null}

      {citations.length === 0 ? (
        <p className="field-hint mt-3">{t("citations.empty")}</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {citations.map((citation, index) => (
            <li key={`${citation.chunkId}-${index}`} className="rounded-xl border border-line p-3">
              <p className="flex items-center justify-between gap-2 text-xs font-semibold text-cyan-700">
                <span className="truncate">
                  {t("citations.source", {
                    document: citation.documentName,
                    page: citation.page,
                  })}
                </span>
                <span className="font-mono text-[10px] text-ink-subtle">
                  {t("citations.score", { score: citation.score.toFixed(3) })}
                </span>
              </p>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">{citation.snippet}</p>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
