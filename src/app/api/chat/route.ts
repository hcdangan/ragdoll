import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { NextRequest } from "next/server";

import { toErrorShape } from "@/lib/errors";
import { toAppError } from "@/lib/pipeline/engine-errors";
import { enginePayload } from "@/lib/pipeline/session-helpers";
import { answerStream, recordTurn } from "@/lib/rag/service";
import { requireApiKey } from "@/lib/secrets";
import { loadSession, readSessionToken, saveSession, stampSession } from "@/lib/session";
import type { Citation, FallbackReason } from "@/lib/types";

/**
 * Streaming chat handler.
 *
 * Server Actions cannot stream, so this Route Handler owns the one streaming path.
 * The RAG pipeline runs in this same process, so there is no upstream SSE body to
 * parse and re-frame any more: `answerStream` yields typed events, and this module
 * maps them onto Vercel AI SDK v5 UI message parts. Citations are written before
 * the first token, which is what lets the citation panel populate while the answer
 * is still being generated.
 *
 * The client abort signal is threaded into generation, so stopping a response also
 * stops the provider call instead of leaving it running.
 */

/**
 * Duration granted to one streamed answer on a hosted platform.
 *
 * A self-hosted model can spend a minute loading before the first token, and a
 * long answer on modest hardware can take minutes more; the 60-second default
 * ended those mid-sentence. Five minutes matches the evaluation budget and is the
 * Vercel Pro ceiling. Must stay a literal: Next reads it statically.
 * (`LIMITS.streamingTimeoutMs` mirrors this value and bounds the provider call.)
 */
export const maxDuration = 300;
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
      let fallbackReason: FallbackReason | null = null;
      let citations: Citation[] = [];
      let persisted = false;

      const write = (part: unknown): void => {
        (writer as unknown as { write: (chunk: unknown) => void }).write(part);
      };

      const startText = (): void => {
        if (!started) {
          started = true;
          write({ type: "text-start", id: textId });
        }
      };

      /**
       * Records the turn as soon as generation stops, for any reason.
       *
       * Aborting is a first-class outcome (AGENTS.md): the client aborts, which
       * aborts generation, which ends the event loop. Saving in a `finally` rather
       * than after the loop is what keeps the partial answer and the user's
       * question in the session, so the next turn has the context and a reload
       * still shows what was said.
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

        const payload = enginePayload(session, requireApiKey(session));

        for await (const event of answerStream(payload, question, session.chat, request.signal)) {
          switch (event.event) {
            case "citations": {
              citations = [...event.data.citations];
              write({
                type: "data-citation",
                data: { citations, standaloneQuery: event.data.standaloneQuery },
              });
              break;
            }
            case "status": {
              write({
                type: "data-status",
                data: { phase: event.data.phase, message: event.data.message },
                transient: true,
              });
              break;
            }
            case "token": {
              startText();
              if (event.data.text.length > 0) {
                answer += event.data.text;
                write({ type: "text-delta", id: textId, delta: event.data.text });
              }
              break;
            }
            case "replacement": {
              startText();
              // The answer was replaced by the fallback string. Only a failed
              // groundedness check is "withheld": when the model declined, or
              // retrieval found nothing, nothing was withheld, and the data part
              // lets the browser explain the real reason instead.
              if (event.data.reason === "unsupported") {
                write({
                  type: "data-status",
                  data: { phase: "groundedness", message: "Answer withheld" },
                  transient: true,
                });
              }
              write({
                type: "data-fallback",
                data: { answer: event.data.answer, reason: event.data.reason },
              });
              answer = event.data.answer;
              fallback = true;
              fallbackReason = event.data.reason;
              break;
            }
            case "done": {
              fallback = fallback || event.data.fallback;
              answer = event.data.answer;
              if (event.data.fallbackReason !== null) {
                fallbackReason = event.data.fallbackReason;
              }
              if (!fallback) {
                citations = [...event.data.citations];
              }
              recordTurn(session.id, question, answer, citations, fallback);
              write({
                type: "data-status",
                data: { phase: "done", message: "Complete" },
                transient: true,
              });
              break;
            }
          }
        }

        startText();
        if (fallback) {
          write({
            type: "data-fallback",
            data:
              fallbackReason === null
                ? { answer }
                : { answer, reason: fallbackReason },
          });
        }
        write({ type: "text-end", id: textId });
        write({ type: "finish" });
      } catch (error) {
        const shape = toErrorShape(toAppError(error));
        write({ type: "data-error", data: { code: shape.code, message: shape.message } });
        startText();
        write({ type: "text-end", id: textId });
        write({ type: "finish" });
      } finally {
        await persistTurn();
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
