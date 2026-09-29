/**
 * Offline provider, for development, tests and the E2E journey.
 *
 * Ported from the FastAPI engine's `RAGDOLL_DEV_PROVIDER=1` mode, and it exists for
 * the same reason: the Playwright journey has to exercise the *whole* app —
 * session cookie, Server Action, streaming route, citation panel, evaluation
 * table — without a paid API key or a network. Mocking the pipeline instead would
 * skip exactly the seams the journey is meant to cover.
 *
 * Everything here is deterministic: the same input produces the same vectors, the
 * same text and the same scores, so a failing test is a real regression rather
 * than a coin flip.
 *
 * Two design notes worth keeping:
 *
 *  * Embeddings are hashed bag-of-words, not noise. Random vectors would make
 *    retrieval rank arbitrarily, and a citation panel that lists the wrong page
 *    would make the journey pass for the wrong reason.
 *  * Answers name the source they came from, because the chat assertions look for
 *    a citation string the model actually produced.
 */

import {
  AGENTIC_SYSTEM_PROMPT,
  AGENTIC_TOOL_INSTRUCTION,
  COMPRESS_SYSTEM_PROMPT,
  FALLBACK_ANSWER,
  GROUNDEDNESS_SYSTEM_PROMPT,
  QUESTION_SYSTEM_PROMPT,
  REVERSE_QUESTION_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from "./prompts";
import type {
  ChatCompletion,
  ChatMessage,
  CompletionOptions,
  LlmProvider,
  ProbeResult,
  StreamDelta,
} from "./llm";

/** Sentences, for the answer text and for claim extraction. */
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/** Words that carry no retrieval signal. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "has",
  "have", "not", "you", "your", "its", "into", "than", "then", "them", "they", "what",
  "which", "when", "where", "how", "why", "does", "did", "can", "could", "should",
  "about", "there", "their", "will", "would", "been", "but", "all", "any", "our",
]);

/** Characters per streamed delta; small enough that the UI visibly streams. */
const STREAM_CHUNK = 18;

const tokenise = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));

/** The context block the pipeline sends when retrieval found nothing. */
const NO_CONTEXT_PLACEHOLDER = "(no context retrieved)";

/** FNV-1a, so a token always lands in the same bucket across processes. */
const hashToken = (token: string, buckets: number): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % buckets;
};

/** Pulls the first `<source ...>` tag out of a context block, if there is one. */
const firstSourceTag = (context: string): { name: string; page: string } | null => {
  const match = /<source document="([^"]*)" page="([^"]*)">/.exec(context);
  return match === null ? null : { name: match[1] ?? "document", page: match[2] ?? "1" };
};

/** The text between `CONTEXT:` and the next section marker, unescaped. */
const contextSection = (content: string): string => {
  const start = content.indexOf("CONTEXT:");
  if (start === -1) {
    return content;
  }
  const rest = content.slice(start + "CONTEXT:".length);
  const end = rest.search(/\n\n(?:QUESTION|ANSWER):/);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
};

const answerSection = (content: string): string => {
  const start = content.indexOf("ANSWER:");
  if (start === -1) {
    return content;
  }
  const rest = content.slice(start + "ANSWER:".length);
  const end = rest.indexOf("\n\nReply with JSON only.");
  return (end === -1 ? rest : rest.slice(0, end)).trim();
};

const lastUserMessage = (messages: readonly ChatMessage[]): string =>
  [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

/**
 * Deterministic provider that answers from the retrieved context.
 *
 * `dimensions` comes from the pipeline configuration so the offline vectors have
 * exactly the width the index was built for — a mismatch here would surface as a
 * dimension error rather than as the behaviour under test.
 */
export class DevProvider implements LlmProvider {
  private readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = Math.max(8, dimensions);
  }

  /** Hashed bag-of-words, L2-normalised so cosine and dot agree. */
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      for (const token of tokenise(text)) {
        const bucket = hashToken(token, this.dimensions);
        vector[bucket] = (vector[bucket] ?? 0) + 1;
      }
      const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
      return norm === 0 ? vector : vector.map((value) => value / norm);
    });
  }

  async embedOne(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    return vector ?? new Array<number>(this.dimensions).fill(0);
  }

  /** Dispatch on the system prompt: each pipeline step has exactly one. */
  async complete(
    messages: readonly ChatMessage[],
    _options?: CompletionOptions,
  ): Promise<ChatCompletion> {
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const text = this.respond(system, messages);
    return {
      text,
      usage: {
        promptTokens: messages.reduce((total, message) => total + message.content.length / 4, 0),
        completionTokens: text.length / 4,
      },
    };
  }

  async *stream(
    messages: readonly ChatMessage[],
    options?: CompletionOptions,
  ): AsyncGenerator<StreamDelta, void, undefined> {
    const completion = await this.complete(messages, options);
    for (let start = 0; start < completion.text.length; start += STREAM_CHUNK) {
      yield { text: completion.text.slice(start, start + STREAM_CHUNK) };
    }
    yield { text: "", usage: completion.usage };
  }

  async probe(): Promise<ProbeResult> {
    const [vector] = await this.embed(["ragdoll connection probe"]);
    return {
      latencyMs: 1,
      echo: "ready",
      embeddingDimension: vector?.length ?? 0,
      embeddingOk: true,
    };
  }

  /** One branch per pipeline step, keyed on the system prompt it was given. */
  private respond(system: string, messages: readonly ChatMessage[]): string {
    if (system === GROUNDEDNESS_SYSTEM_PROMPT) {
      const context = contextSection(lastUserMessage(messages));
      const claims = context
        .split(SENTENCE_SPLIT)
        .map((claim) => claim.trim())
        .filter((claim) => claim.length > 0)
        .slice(0, 3)
        .map((claim) => ({ claim, supported: true }));
      return JSON.stringify({ claims: claims.length > 0 ? claims : [{ claim: "none", supported: true }] });
    }

    if (system === COMPRESS_SYSTEM_PROMPT) {
      return lastUserMessage(messages).trim();
    }

    if (system === REVERSE_QUESTION_SYSTEM_PROMPT) {
      const answer = answerSection(lastUserMessage(messages));
      const keyword = tokenise(answer)[0] ?? "the answer";
      return `What does the document say about ${keyword}?`;
    }

    if (system === QUESTION_SYSTEM_PROMPT) {
      const passage = lastUserMessage(messages).replace(/^PASSAGE:\s*/, "");
      const keyword = tokenise(passage)[0] ?? "this passage";
      return `What does the passage say about ${keyword}?`;
    }

    if (system === AGENTIC_TOOL_INSTRUCTION) {
      // The agentic hop loop stops on anything that is not a retrieve call, so the
      // offline provider never spends a hop.
      return '{"tool":"answer"}';
    }

    if (system === SYSTEM_PROMPT || system === AGENTIC_SYSTEM_PROMPT) {
      return this.answerFrom(lastUserMessage(messages));
    }

    return FALLBACK_ANSWER;
  }

  /** Echoes the strongest sentence of the context with a real citation marker. */
  private answerFrom(userContent: string): string {
    const context = contextSection(userContent);
    if (context.length === 0 || context === NO_CONTEXT_PLACEHOLDER) {
      return FALLBACK_ANSWER;
    }
    const sentences = context
      .replace(/<[^>]*>/g, " ")
      .split(SENTENCE_SPLIT)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 20);
    const body = sentences[0] ?? context.slice(0, 200);
    const source = firstSourceTag(context);
    const citation = source === null ? "" : ` [${source.name}, p.${source.page}]`;
    return `Based on the retrieved sources: ${body}${citation}`;
  }
}

/**
 * True when the offline provider should be used.
 *
 * Deliberately allowed under `NODE_ENV=production`, because the E2E suite runs a
 * production build. It is opt-in through an environment variable that no
 * deployment sets, so the deployed app can never reach it by accident.
 */
export const isDevProviderEnabled = (): boolean =>
  (process.env.RAGDOLL_DEV_PROVIDER ?? "") === "1";

/**
 * Builds the offline provider for a pipeline configuration.
 * @param dimensions Embedding width from the pipeline config.
 */
export const createDevProvider = (dimensions: number): LlmProvider => new DevProvider(dimensions);
