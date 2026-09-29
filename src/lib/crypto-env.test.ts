import { describe, expect, it } from "vitest";

import { createSessionId, maskSecret } from "@/lib/crypto";
import { readServerEnv } from "@/lib/env";
import { AppError, appError, fail, ok, toErrorShape } from "@/lib/errors";
import {
  EMBEDDING_DIMENSIONS,
  PROVIDERS,
  isLoopbackUrl,
  resolveBaseUrl,
  resolveEmbeddingModel,
} from "@/lib/providers";

describe("maskSecret", () => {
  it("never reveals more than the last four characters", () => {
    const masked = maskSecret("sk-abcdefghijklmnop");
    expect(masked.endsWith("mnop")).toBe(true);
    expect(masked.slice(0, -4)).not.toContain("abcdefghijkl");
  });

  it("fully masks short keys", () => {
    expect(maskSecret("abc")).toBe("•••");
  });

  it("returns an empty string for an empty key", () => {
    expect(maskSecret("   ")).toBe("");
  });

  it("handles a key of exactly the masking threshold", () => {
    expect(maskSecret("12345678")).toBe("••••••••");
    expect(maskSecret("123456789")).toBe("•••••6789");
  });
});

describe("createSessionId", () => {
  it("produces distinct, url-safe identifiers", () => {
    const first = createSessionId();
    const second = createSessionId();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.length).toBeGreaterThanOrEqual(30);
  });
});

describe("readServerEnv", () => {
  it("falls back to development defaults outside production", () => {
    const env = readServerEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    // No engine configuration exists any more: the RAG pipeline is a module in
    // this process, so a deployment has nothing to point at.
    expect(env.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(env.kv).toBeNull();
    expect(env.hosted).toBe(false);
  });

  it("detects a hosted deployment from VERCEL", () => {
    // VERCEL_URL is deliberately not consulted: it is not exposed to the running
    // function, so nothing depends on it.
    const env = readServerEnv({
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_URL: "ragdoll-abc123.vercel.app",
      RAGDOLL_SESSION_SECRET: "b".repeat(40),
    } as NodeJS.ProcessEnv);
    expect(env.hosted).toBe(true);
  });

  it("refuses to start in production without a strong session secret", () => {
    expect(() =>
      readServerEnv({
        NODE_ENV: "production",
        RAGDOLL_SESSION_SECRET: "short",
      } as NodeJS.ProcessEnv),
    ).toThrow(/SESSION_SECRET/);
  });

  it("detects a hosted deployment", () => {
    const env = readServerEnv({ NODE_ENV: "development", VERCEL: "1" } as NodeJS.ProcessEnv);
    expect(env.hosted).toBe(true);
  });

  it("enables KV only when both credentials are present", () => {
    const env = readServerEnv({
      NODE_ENV: "development",
      KV_REST_API_URL: "https://kv.example.com",
      KV_REST_API_TOKEN: "token",
    } as NodeJS.ProcessEnv);
    expect(env.kv).toEqual({ url: "https://kv.example.com", token: "token" });
  });

  it("treats a half-configured KV pair as absent", () => {
    const env = readServerEnv({
      NODE_ENV: "development",
      KV_REST_API_URL: "https://kv.example.com",
    } as NodeJS.ProcessEnv);
    expect(env.kv).toBeNull();
  });
});

describe("providers", () => {
  it("resolves vendor base URLs", () => {
    expect(resolveBaseUrl("openai", "")).toBe("https://api.openai.com/v1");
    expect(resolveBaseUrl("vocareum", "")).toBe("https://openai.vocareum.com/v1");
    expect(resolveBaseUrl("deepseek", "")).toBe("https://api.deepseek.com/v1");
  });

  it("requires a user URL for self-hosted providers", () => {
    expect(resolveBaseUrl("ollama", "")).toBeNull();
    expect(resolveBaseUrl("ollama", "http://localhost:11434/v1/")).toBe(
      "http://localhost:11434/v1",
    );
  });

  it("keeps the embedding selection valid when the provider changes", () => {
    expect(resolveEmbeddingModel("ollama", "text-embedding-3-large")).toBe("nomic-embed-text");
    expect(resolveEmbeddingModel("openai", "bge-m3")).toBe("text-embedding-3-small");
    expect(resolveEmbeddingModel("openai", "text-embedding-3-large")).toBe(
      "text-embedding-3-large",
    );
  });

  it("only exposes the documented dimension table", () => {
    expect(EMBEDDING_DIMENSIONS["text-embedding-3-small"]).toBe(1536);
    expect(EMBEDDING_DIMENSIONS["text-embedding-3-large"]).toBe(3072);
    expect(EMBEDDING_DIMENSIONS["nomic-embed-text"]).toBe(768);
    expect(EMBEDDING_DIMENSIONS["bge-m3"]).toBe(1024);
    expect(EMBEDDING_DIMENSIONS.embeddinggemma).toBe(768);
    expect(EMBEDDING_DIMENSIONS["mxbai-embed-large"]).toBe(1024);
  });

  it("flags loopback, LAN and link-local URLs", () => {
    expect(isLoopbackUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:11434")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.10:8000")).toBe(true);
    expect(isLoopbackUrl("http://10.0.0.5:8000")).toBe(true);
    expect(isLoopbackUrl("http://172.16.4.9:8000")).toBe(true);
    expect(isLoopbackUrl("http://172.31.255.254:8000")).toBe(true);
    expect(isLoopbackUrl("http://169.254.1.1:8000")).toBe(true);
    expect(isLoopbackUrl("http://ollama.local:11434")).toBe(true);
    expect(isLoopbackUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLoopbackUrl("http://172.32.0.1:8000")).toBe(false);
    expect(isLoopbackUrl("https://localhost.example.com/v1")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });

  it("declares a default model for every provider", () => {
    for (const provider of Object.values(PROVIDERS)) {
      expect(provider.defaultModel.length).toBeGreaterThan(0);
      expect(provider.embeddingModels.length).toBeGreaterThan(0);
    }
  });
});

describe("error shapes", () => {
  it("wraps unknown failures as retryable internal errors", () => {
    const shape = toErrorShape(new Error("boom"));
    expect(shape.code).toBe("internal");
    expect(shape.retryable).toBe(true);
  });

  it("marks validation failures as non-retryable", () => {
    expect(toErrorShape(new AppError("validation", "bad")).retryable).toBe(false);
  });

  it("preserves field errors for form rendering", () => {
    const error = appError("validation", undefined, { fields: { apiKey: "Missing" } });
    expect(error.fields).toEqual({ apiKey: "Missing" });
  });

  it("normalises abort errors to timeouts", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(toErrorShape(abort).code).toBe("timeout");
  });

  it("builds discriminated results", () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 });
    const failure = fail(appError("network"));
    expect(failure.ok).toBe(false);
  });
});
