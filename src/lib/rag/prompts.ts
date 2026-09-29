/**
 * Prompt construction and answer post-processing.
 *
 * Ported from the FastAPI engine's `prompts.py`. Keeping prompt text in one module
 * makes the grounding contract ("answer only from the context block") reviewable in
 * isolation, and makes it impossible for a caller to emit retrieved text without the
 * citation envelope.
 */

import { truncateToTokens } from "./chunking";
import type { ChatMessage } from "./llm";

/** Returned when retrieval finds nothing, or the groundedness gate rejects an answer. */
export const FALLBACK_ANSWER = "Sorry, I don't know the answer to that.";

/** A retrieved chunk paired with the document it came from. */
export interface OwnedChunk {
  readonly documentId: string;
  readonly documentName: string;
  readonly chunk: {
    readonly index: number;
    readonly text: string;
    readonly tokenCount: number;
    readonly page: number;
  };
}

export const SYSTEM_PROMPT =
  "You are RAGdoll, a retrieval-augmented assistant. Answer strictly from the " +
  "CONTEXT block. Cite sources inline as [document name, p.page]. If the context " +
  `does not contain the answer, reply exactly with: "${FALLBACK_ANSWER}" ` +
  "Never invent facts, page numbers or document names.";

export const AGENTIC_SYSTEM_PROMPT =
  "You are RAGdoll, a retrieval-augmented assistant. You may request more evidence " +
  "before answering. Answer strictly from what was retrieved, citing sources inline " +
  `as [document name, p.page]. If the evidence is insufficient, reply exactly with: "${FALLBACK_ANSWER}"`;

export const COMPRESS_SYSTEM_PROMPT =
  "Rewrite the user's latest message as a standalone search query. Resolve pronouns " +
  "and references using the conversation. Reply with the query only.";

export const GROUNDEDNESS_SYSTEM_PROMPT =
  "You are a strict fact-checker. Given CONTEXT and ANSWER, list every atomic claim " +
  "in ANSWER. For each claim state whether the CONTEXT supports it. Reply with JSON " +
  'only: {"claims":[{"claim":"...","supported":true|false}]}';

export const REVERSE_QUESTION_SYSTEM_PROMPT =
  "Generate the single question that the ANSWER most likely responds to, using only " +
  "the CONTEXT. Reply with the question only.";

export const QUESTION_SYSTEM_PROMPT =
  "Write one specific question that the PASSAGE answers completely. Reply with the " +
  "question only, no preamble.";

/**
 * The agentic retrieval protocol, as a prompt.
 *
 * A JSON ask rather than native tool calling: DeepSeek and Ollama both ship models
 * that silently ignore a `tools` field, so one uniform instruction is the portable
 * choice. Shared as a constant because the offline provider dispatches on it.
 */
export const AGENTIC_TOOL_INSTRUCTION =
  "You may request evidence before answering. To do so reply with JSON only: " +
  '{"tool":"retrieve","query":"<search query>","topK":5}. Otherwise reply with JSON ' +
  'only: {"tool":"answer"}.';

/**
 * Renders retrieved chunks as a tagged context block.
 *
 * The tag carries document name and page so the model can cite without being handed
 * a separate mapping it might misread.
 */
export function formatContextBlock(owned: readonly OwnedChunk[]): string {
  return owned
    .map(
      (item) =>
        `<source document="${item.documentName}" page="${item.chunk.page}">\n` +
        `${item.chunk.text}\n</source>`,
    )
    .join("\n\n");
}

/**
 * Assembles the chat completion request for a grounded answer.
 * @param options Question, context block, prior turns and the retrieval mode.
 */
export function buildAnswerMessages(options: {
  readonly question: string;
  readonly contextBlock: string;
  readonly history: readonly ChatMessage[];
  readonly agentic: boolean;
}): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: options.agentic ? AGENTIC_SYSTEM_PROMPT : SYSTEM_PROMPT },
    ...options.history,
  ];

  messages.push(
    options.agentic
      ? {
          role: "user",
          content: `Question: ${options.question}\n\nUse the retrieve tool to gather evidence before answering.`,
        }
      : {
          role: "user",
          content:
            `CONTEXT:\n${options.contextBlock}\n\n` +
            `QUESTION: ${options.question}\n\n` +
            "Answer from the CONTEXT and cite every source you use.",
        },
  );

  return messages;
}

/** Builds the multi-turn query-compression request. */
export function buildCompressionMessages(history: readonly ChatMessage[]): ChatMessage[] {
  return [{ role: "system", content: COMPRESS_SYSTEM_PROMPT }, ...history];
}

/** Builds the Ragas-style faithfulness judge request. */
export function buildGroundednessMessages(contextBlock: string, answer: string): ChatMessage[] {
  return [
    { role: "system", content: GROUNDEDNESS_SYSTEM_PROMPT },
    {
      role: "user",
      content: `CONTEXT:\n${contextBlock}\n\nANSWER:\n${answer}\n\nReply with JSON only.`,
    },
  ];
}

/** Builds the reverse-question generator used by response relevancy. */
export function buildReverseQuestionMessages(contextBlock: string, answer: string): ChatMessage[] {
  return [
    { role: "system", content: REVERSE_QUESTION_SYSTEM_PROMPT },
    { role: "user", content: `CONTEXT:\n${contextBlock}\n\nANSWER:\n${answer}` },
  ];
}

/** Builds the synthetic question generator used by evaluation. */
export function buildQuestionMessages(passage: string): ChatMessage[] {
  return [
    { role: "system", content: QUESTION_SYSTEM_PROMPT },
    { role: "user", content: `PASSAGE:\n${passage}` },
  ];
}

/** Trims retrieved chunks to a token budget, best-ranked chunk first. */
export function truncateContext(
  owned: readonly OwnedChunk[],
  budgetTokens: number,
): OwnedChunk[] {
  const kept: OwnedChunk[] = [];
  let remaining = Math.max(0, budgetTokens);
  for (const item of owned) {
    if (remaining <= 0) {
      break;
    }
    kept.push(item);
    remaining -= item.chunk.tokenCount;
  }
  return kept;
}

/** Keeps the most recent history turns that fit the budget. */
export function clampHistory(history: readonly ChatMessage[], budgetTokens: number): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let remaining = Math.max(0, budgetTokens);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message === undefined) {
      continue;
    }
    const cost = Math.max(1, Math.floor(message.content.length / 4));
    if (cost > remaining) {
      break;
    }
    kept.push(message);
    remaining -= cost;
  }
  kept.reverse();
  return kept;
}

/** Single-line excerpt for the citation panel. */
export function snippet(text: string, limit = 240): string {
  const flat = text.split(/\s+/).join(" ");
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** Guards the question against absurdly long input. */
export function truncateQuestion(question: string, maxTokens: number): string {
  return truncateToTokens(question, maxTokens);
}
