import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isLoopbackHost,
  LoopbackBlockedError,
  ProviderClient,
  ProviderError,
  stripVersionSuffix,
  type ChatMessage,
  type ProviderOptions,
} from "@/lib/rag/llm";

/**
 * Wire-protocol tests for the provider client.
 *
 * The request *body* is the contract here, not the parsing: OpenAI's schema rejects
 * unknown arguments outright, so a field that exists to help Ollama
 * (`num_predict`) breaks every OpenAI-compatible endpoint — Vocareum returned
 * "Unrecognized request argument supplied: num_predict" and refused to answer at
 * all. Nothing else in the suite can catch that, because it is only wrong on the
 * wire.
 */

const OPENAI: ProviderOptions = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
  embeddingModel: "text-embedding-3-small",
};

const VOCAREUM: ProviderOptions = { ...OPENAI, provider: "vocareum", baseUrl: "https://openai.vocareum.com/v1" };

const OLLAMA: ProviderOptions = {
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  apiKey: "",
  model: "llama3.2",
  embeddingModel: "nomic-embed-text",
};

const MESSAGES: readonly ChatMessage[] = [{ role: "user", content: "hello" }];

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const chatCompletion = (text: string): unknown => ({
  choices: [{ message: { role: "assistant", content: text } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
});

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** Records every request the client makes, and answers with `respond`. */
const stubFetch = (respond: (call: Call) => Response): Call[] => {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call = { url: String(input), body };
    calls.push(call);
    return Promise.resolve(respond(call));
  });
  return calls;
};

/** Fails if any request carried a field the protocol does not define. */
const expectNoField = (calls: readonly Call[], field: string): void => {
  for (const call of calls) {
    expect(Object.keys(call.body), `${field} in ${call.url}`).not.toContain(field);
    const nested = call.body.options;
    if (typeof nested === "object" && nested !== null) {
      expect(Object.keys(nested), `${field} in options`).not.toContain(field);
    }
  }
};

const earlier = { hosted: process.env.RAGDOLL_HOSTED, vercel: process.env.VERCEL };

beforeEach(() => {
  // The loopback guard is env-driven and would otherwise depend on the shell.
  delete process.env.RAGDOLL_HOSTED;
  delete process.env.VERCEL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (earlier.hosted !== undefined) {
    process.env.RAGDOLL_HOSTED = earlier.hosted;
  }
  if (earlier.vercel !== undefined) {
    process.env.VERCEL = earlier.vercel;
  }
});

describe("OpenAI-compatible protocol", () => {
  it("sends max_tokens and temperature at the top level, and never num_predict", async () => {
    const calls = stubFetch(() => jsonResponse(chatCompletion("ready")));
    const client = new ProviderClient(VOCAREUM);

    const completion = await client.complete(MESSAGES, { temperature: 0, maxTokens: 8 });

    expect(completion.text).toBe("ready");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openai.vocareum.com/v1/chat/completions");
    expect(calls[0]?.body).toMatchObject({
      model: "gpt-4o-mini",
      stream: false,
      max_tokens: 8,
      temperature: 0,
    });
    // The regression: an Ollama-only field broke every OpenAI-compatible endpoint.
    expectNoField(calls, "num_predict");
    expect(calls[0]?.body).not.toHaveProperty("options");
  });

  it("omits sampling controls entirely when the caller sets none", async () => {
    const calls = stubFetch(() => jsonResponse(chatCompletion("ready")));

    await new ProviderClient(OPENAI).complete(MESSAGES);

    expect(calls[0]?.body).not.toHaveProperty("max_tokens");
    expect(calls[0]?.body).not.toHaveProperty("temperature");
  });

  it("embeds through /embeddings with an input list", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2] }, { index: 1, embedding: [0.3, 0.4] }] }),
    );

    const vectors = await new ProviderClient(OPENAI).embed(["a", "b"]);

    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0]?.body).toMatchObject({ model: "text-embedding-3-small", input: ["a", "b"] });
    expect(calls[0]?.body).not.toHaveProperty("prompt");
  });

  it("surfaces a rejected argument as a non-retryable provider error", async () => {
    const calls = stubFetch(() =>
      jsonResponse(
        { error: { message: "Unrecognized request argument supplied: num_predict" } },
        400,
      ),
    );

    const failure = await new ProviderClient(VOCAREUM).complete(MESSAGES).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).code).toBe("provider_error");
    expect((failure as ProviderError).message).toContain("HTTP 400");
    // A malformed request will be malformed again, so it must not be retried.
    expect(calls).toHaveLength(1);
  });

  it("reports a rejected key as an authentication failure", async () => {
    stubFetch(() => jsonResponse({ error: { message: "Invalid API key" } }, 401));

    const failure = await new ProviderClient(OPENAI).complete(MESSAGES).catch((error: unknown) => error);

    expect((failure as ProviderError).code).toBe("invalid_api_key");
  });
});

describe("Ollama protocol", () => {
  it("sends sampling controls nested under options, with no OpenAI fields", async () => {
    const calls = stubFetch(() => jsonResponse({ message: { content: "ready" } }));
    const client = new ProviderClient(OLLAMA);

    const completion = await client.complete(MESSAGES, { temperature: 0, maxTokens: 8 });

    expect(completion.text).toBe("ready");
    expect(calls[0]?.url).toBe("http://localhost:11434/api/chat");
    expect(calls[0]?.body).toMatchObject({
      model: "llama3.2",
      stream: false,
      options: { temperature: 0, num_predict: 8 },
    });
    expect(calls[0]?.body).not.toHaveProperty("max_tokens");
    expect(calls[0]?.body).not.toHaveProperty("temperature");
  });

  it("embeds through the native endpoint with a single prompt", async () => {
    const calls = stubFetch(() => jsonResponse({ embedding: [0.5, 0.6] }));

    const [vector] = await new ProviderClient(OLLAMA).embed(["a"]);

    expect(vector).toEqual([0.5, 0.6]);
    expect(calls[0]?.url).toBe("http://localhost:11434/api/embeddings");
    // The native endpoint takes one string, not a list: batching is done by looping.
    expect(calls[0]?.body).toMatchObject({ model: "nomic-embed-text", prompt: "a" });
    expect(calls[0]?.body).not.toHaveProperty("input");
  });

  it("streams with stream:true and no OpenAI usage hint", async () => {
    const calls = stubFetch(() => jsonResponse({ message: { content: "hi" }, done: true }));

    const deltas = [];
    for await (const delta of new ProviderClient(OLLAMA).stream(MESSAGES, { maxTokens: 8 })) {
      deltas.push(delta.text);
    }

    expect(deltas.join("")).toBe("hi");
    expect(calls[0]?.body).toMatchObject({ stream: true, options: { num_predict: 8 } });
    expect(calls[0]?.body).not.toHaveProperty("stream_options");
  });
});

describe("OpenAI streaming", () => {
  it("asks for usage and reassembles a frame split across chunk boundaries", async () => {
    const frame = { choices: [{ delta: { content: "grounded" } }] };
    const payload = `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`;
    const encoder = new TextEncoder();
    const calls: Call[] = [];

    vi.stubGlobal("fetch", (_input: unknown, init?: { body?: unknown }) => {
      calls.push({
        url: String(_input),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      });
      // Split mid-JSON and mid-frame: a naive reader truncates the token.
      const cut = Math.floor(payload.length / 2);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(payload.slice(0, cut)));
          controller.enqueue(encoder.encode(payload.slice(cut)));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });

    let text = "";
    for await (const delta of new ProviderClient(OPENAI).stream(MESSAGES)) {
      text += delta.text;
    }

    expect(text).toBe("grounded");
    expect(calls[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expectNoField(calls, "num_predict");
  });
});

describe("hosted loopback guard", () => {
  it("refuses a local provider on a hosted deployment with the documented message", () => {
    process.env.RAGDOLL_HOSTED = "1";

    expect(() => new ProviderClient(OLLAMA)).toThrow(LoopbackBlockedError);
    expect(() => new ProviderClient(OLLAMA)).toThrow(
      "Cannot reach localhost from a hosted deployment. Self-host RAGdoll to use local providers.",
    );
  });

  it("allows a local provider when the deployment is self-hosted", () => {
    expect(() => new ProviderClient(OLLAMA)).not.toThrow();
  });

  it("still refuses a public provider on a hosted deployment", () => {
    process.env.RAGDOLL_HOSTED = "1";

    expect(() => new ProviderClient(OPENAI)).not.toThrow();
  });
});

describe("url helpers", () => {
  it("strips a single trailing /v1", () => {
    expect(stripVersionSuffix("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(stripVersionSuffix("http://localhost:11434/v1/")).toBe("http://localhost:11434");
    expect(stripVersionSuffix("https://api.openai.com/v1")).toBe("https://api.openai.com");
    expect(stripVersionSuffix("http://localhost:11434")).toBe("http://localhost:11434");
  });

  it("flags loopback, LAN and link-local hosts", () => {
    expect(isLoopbackHost("http://localhost:11434")).toBe(true);
    expect(isLoopbackHost("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLoopbackHost("http://[::1]:11434")).toBe(true);
    expect(isLoopbackHost("http://192.168.1.10:8000")).toBe(true);
    expect(isLoopbackHost("http://10.0.0.5:8000")).toBe(true);
    expect(isLoopbackHost("http://172.16.4.9:8000")).toBe(true);
    expect(isLoopbackHost("http://169.254.1.1:8000")).toBe(true);
    expect(isLoopbackHost("http://ollama.local:11434")).toBe(true);
    expect(isLoopbackHost("https://api.openai.com/v1")).toBe(false);
    expect(isLoopbackHost("http://172.32.0.1:8000")).toBe(false);
    expect(isLoopbackHost("not a url")).toBe(false);
  });
});
