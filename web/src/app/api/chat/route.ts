import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { NextRequest } from "next/server";

import { toErrorShape } from "@/lib/errors";
import { requireApiKey } from "@/lib/secrets";
import { loadSession, readSessionToken, saveSession, stampSession } from "@/lib/session";
import { requireEngine } from "@/lib/pipeline/engine";
import { enginePayload } from "@/lib/pipeline/session-helpers";
import type { Citation } from "@/lib/types";

/**
 * SSE frame names the engine emits.
 *
 * Declared here rather than in a shared module because this route is the only
 * consumer: the engine's `routes.py` writes these literals, and a name that drifts
 * on one side shows up immediately as a missing citation panel or a stuck stream.
 */
const ENGINE_EVENTS = {
  citations: "citations",
  status: "status",
  token: "token",
  replacement: "replacement",
  error: "error",
  done: "done",
} as const;

/**
 * Streaming chat bridge.
 *
 * Server Actions cannot stream, so this Route Handler owns the one streaming
 * path: it calls the FastAPI `/v1/chat/stream` SSE endpoint and re-emits every
 * frame as a Vercel AI SDK v5 UI message chunk. Citations are written before the
 * first token, which is what lets the citation panel populate while the answer is
 * still being generated.
 *
 * The client abort signal is forwarded upstream, so stopping a response also
 * stops the provider call instead of leaving it running.
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface ChatRequestBody {
  readonly messages?: readonly {
    readonly role?: string;
    readonly parts?: readonly { readonly type?: string; readonly text?: string }[];
    readonly content?: string;
  }[];
}

const lastUserText = (body: ChatRequestBody): string => {
  const messages = body.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string" && message.content.trim().length > 0) {
      return message.content;
    }
    const text = (message.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("");
    if (text.trim().length > 0) {
      return text;
    }
  }
  return "";
};

interface EngineFrame {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/**
 * Parses an SSE byte stream into engine frames.
 * @param stream Upstream body (already validated as non-null by the caller).
 */
async function* parseEngineStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<EngineFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const frame = parseFrame(raw);
        if (frame !== null) {
          yield frame;
        }
        separator = buffer.indexOf("\n\n");
      }
    }

    const trailing = parseFrame(buffer);
    if (trailing !== null) {
      yield trailing;
    }
  } finally {
    reader.releaseLock();
  }
}

const parseFrame = (raw: string): EngineFrame | null => {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  try {
    const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    return { event, data };
  } catch {
    return null;
  }
};

const asCitations = (value: unknown): Citation[] =>
  Array.isArray(value) ? (value as Citation[]) : [];

export async function POST(request: NextRequest): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ChatRequestBody;
  const question = lastUserText(body).trim();

  const token = await readSessionToken();
  const resolved = await loadSession(token);

  if (resolved === null) {
    return Response.json(
      { error: { code: "pipeline_missing", message: "Your session expired. Create the pipeline again." } },
      { status: 409 },
    );
  }

  const { session } = resolved;

  const stream = createUIMessageStream({
    onError: (error) => toErrorShape(error).message,
    execute: async ({ writer }) => {
      const textId = "answer";
      let started = false;
      let answer = "";
      let fallback = false;
      let citations: Citation[] = [];
      let persisted = false;

      const write = (part: unknown): void => {
        (writer as unknown as { write: (chunk: unknown) => void }).write(part);
      };

      /**
       * Records the turn as soon as generation stops, for any reason.
       *
       * Aborting is a first-class outcome (AGENTS.md): the client aborts, which
       * aborts the upstream fetch, which throws out of the SSE loop. Saving in a
       * `finally` rather than after the loop is what keeps the partial answer and
       * the user's question in the session, so the next turn has the context and a
       * reload still shows what was said.
       */
      const persistTurn = async (): Promise<void> => {
        if (persisted || question.length === 0) {
          return;
        }
        persisted = true;
        try {
          const now = new Date().toISOString();
          await saveSession(
            stampSession({
              ...session,
              chat: [
                ...session.chat,
                { role: "user", content: question, citations: [], createdAt: now },
                {
                  role: "assistant",
                  content: answer,
                  citations,
                  createdAt: now,
                  ...(fallback ? { fallback: true } : {}),
                },
              ],
            }),
          );
        } catch (error) {
          console.error("[ragdoll] could not persist the chat turn", error);
        }
      };

      try {
        if (question.length === 0) {
          write({
            type: "data-error",
            data: { code: "validation", message: "Type a question before sending." },
          });
          write({ type: "finish" });
          return;
        }

        const sessionId = session.id;
        const apiKey = requireApiKey(session);
        const payload = enginePayload(session, apiKey);
        const engine = requireEngine();

        const upstream = await engine.streamChat(
          payload,
          { sessionId, question },
          request.signal,
        );

        write({
          type: "data-status",
          data: { phase: "retrieval", message: "Retrieving sources" },
          transient: true,
        });

        for await (const frame of parseEngineStream(upstream.body as ReadableStream<Uint8Array>)) {
          switch (frame.event) {
            case ENGINE_EVENTS.citations: {
              citations = asCitations(frame.data.citations);
              write({
                type: "data-citation",
                data: { citations, standaloneQuery: frame.data.standaloneQuery ?? "" },
              });
              break;
            }
            case ENGINE_EVENTS.status: {
              write({
                type: "data-status",
                data: {
                  phase: String(frame.data.phase ?? "generation"),
                  message: String(frame.data.message ?? ""),
                },
                transient: true,
              });
              break;
            }
            case ENGINE_EVENTS.token: {
              if (!started) {
                started = true;
                write({ type: "text-start", id: textId });
              }
              const delta = String(frame.data.text ?? "");
              if (delta.length > 0) {
                answer += delta;
                write({ type: "text-delta", id: textId, delta });
              }
              break;
            }
            case ENGINE_EVENTS.replacement: {
              if (!started) {
                started = true;
                write({ type: "text-start", id: textId });
              }
              // The groundedness gate rejected the draft. The UI message protocol
              // can only append text, so the browser is told to swap the rendered
              // draft for the fallback via a data part (see use-chat-stream).
              write({
                type: "data-status",
                data: { phase: "groundedness", message: "Answer withheld" },
                transient: true,
              });
              write({
                type: "data-fallback",
                data: { answer: String(frame.data.answer ?? "") },
              });
              answer = String(frame.data.answer ?? "");
              fallback = true;
              break;
            }
            case ENGINE_EVENTS.done: {
              fallback = fallback || frame.data.fallback === true;
              answer = String(frame.data.answer ?? answer);
              citations = asCitations(frame.data.citations ?? citations);
              write({
                type: "data-status",
                data: { phase: "done", message: "Complete" },
                transient: true,
              });
              break;
            }
            case ENGINE_EVENTS.error: {
              write({
                type: "data-error",
                data: {
                  code: String(frame.data.code ?? "engine_error"),
                  message: String(frame.data.message ?? "The answer failed."),
                },
              });
              break;
            }
            default:
              break;
          }
        }

        if (!started) {
          write({ type: "text-start", id: textId });
        }
        if (fallback) {
          write({ type: "data-fallback", data: { answer } });
        }
        write({ type: "text-end", id: textId });
        write({ type: "finish" });
      } catch (error) {
        const shape = toErrorShape(error);
        write({ type: "data-error", data: { code: shape.code, message: shape.message } });
        if (!started) {
          write({ type: "text-start", id: "answer" });
        }
        write({ type: "text-end", id: "answer" });
        write({ type: "finish" });
      } finally {
        await persistTurn();
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
