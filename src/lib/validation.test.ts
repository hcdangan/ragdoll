import { describe, expect, it } from "vitest";

import { t } from "@/lib/i18n";
import { LIMITS, megabytes } from "@/lib/rules";
import {
  base64ByteLength,
  checkClientDocuments,
  hasPdfMagic,
  validatePipelineForm,
  type PendingDocument,
  type PipelineFormInput,
} from "@/lib/validation";

const PDF_BASE64 = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n").toString("base64");

const document = (overrides: Partial<PendingDocument> = {}): PendingDocument => ({
  id: "doc-1",
  name: "handbook.pdf",
  sizeBytes: 2048,
  base64: PDF_BASE64,
  ...overrides,
});

const form = (overrides: Partial<PipelineFormInput> = {}): PipelineFormInput => ({
  provider: "openai",
  baseUrl: "",
  model: "gpt-4o-mini",
  embeddingModel: "text-embedding-3-small",
  chunkSize: 512,
  chunkOverlapPercent: 10,
  maxInputTokens: 1024,
  distanceMetric: "cosine",
  topK: 5,
  retrievalMode: "context-injection",
  apiKey: "sk-test-key",
  documents: [],
  ...overrides,
});

describe("validatePipelineForm", () => {
  it("accepts a default OpenAI configuration", () => {
    const result = validatePipelineForm(form(), { hosted: false });
    expect(result.errors).toEqual({});
    expect(result.config?.embeddingDimension).toBe(1536);
    expect(result.config?.chunkOverlapTokens).toBe(64);
  });

  it("derives the vector size from the embedding model", () => {
    const result = validatePipelineForm(form({ embeddingModel: "text-embedding-3-large" }), {
      hosted: false,
    });
    expect(result.config?.embeddingDimension).toBe(3072);
  });

  it("falls back to a provider-supported embedding model instead of failing", () => {
    const result = validatePipelineForm(
      form({ provider: "ollama", baseUrl: "http://localhost:11434/v1", apiKey: "", embeddingModel: "text-embedding-3-small" }),
      { hosted: false },
    );
    expect(result.errors).toEqual({});
    expect(result.config?.embeddingModel).toBe("nomic-embed-text");
    expect(result.config?.embeddingDimension).toBe(768);
  });

  it("requires a base URL for a self-hosted provider", () => {
    const result = validatePipelineForm(form({ provider: "ollama", apiKey: "" }), { hosted: false });
    expect(result.errors.baseUrl).toBeDefined();
    expect(result.config).toBeNull();
  });

  it("refuses a loopback provider on a hosted deployment", () => {
    const result = validatePipelineForm(
      form({ provider: "ollama", baseUrl: "http://localhost:11434/v1", apiKey: "" }),
      { hosted: true },
    );
    expect(result.errors.baseUrl).toBe(
      "Cannot reach localhost from a hosted deployment. Self-host RAGdoll to use local providers.",
    );
  });

  it("requires an API key for hosted providers", () => {
    const result = validatePipelineForm(form({ apiKey: "" }), { hosted: false });
    expect(result.errors.apiKey).toBeDefined();
  });

  it("rejects a base URL without a scheme", () => {
    const result = validatePipelineForm(
      form({ provider: "ollama", baseUrl: "localhost:11434", apiKey: "" }),
      { hosted: false },
    );
    expect(result.errors.baseUrl).toContain("http://");
  });

  it("snaps a chunk size that is off the step grid instead of refusing it", () => {
    const result = validatePipelineForm(form({ chunkSize: 500 }), { hosted: false });
    expect(result.errors).toEqual({});
    expect(result.config?.chunkSize).toBe(512);
  });

  it("rejects more than three documents", () => {
    const result = validatePipelineForm(
      form({
        documents: [document({ id: "a" }), document({ id: "b" }), document({ id: "c" }), document({ id: "d" })],
      }),
      { hosted: false },
    );
    expect(result.config).toBeNull();
  });

  it("rejects a payload that is not really a PDF", () => {
    const result = validatePipelineForm(
      form({ documents: [document({ base64: Buffer.from("hello world").toString("base64") })] }),
      { hosted: false },
    );
    expect(result.errors.documents).toContain("not a readable PDF");
  });

  it("rejects a document over the per-file limit", () => {
    const result = validatePipelineForm(
      form({ documents: [document({ sizeBytes: LIMITS.files.maxFileBytes + 1 })] }),
      { hosted: false },
    );
    expect(result.config).toBeNull();
  });

  it("accepts exactly the session allowance: three files at the per-file ceiling", () => {
    const result = validatePipelineForm(
      form({
        documents: [
          document({ id: "a", sizeBytes: LIMITS.files.maxFileBytes }),
          document({ id: "b", sizeBytes: LIMITS.files.maxFileBytes }),
          document({ id: "c", sizeBytes: LIMITS.files.maxFileBytes }),
        ],
      }),
      { hosted: false },
    );
    expect(result.errors).toEqual({});
    expect(result.config).not.toBeNull();
  });

  it("refuses a document whose declared size exceeds the per-file limit", () => {
    const result = validatePipelineForm(
      form({
        documents: [
          document({ id: "a", name: "ok.pdf" }),
          document({ id: "b", name: "huge.pdf", sizeBytes: LIMITS.files.maxFileBytes + 1 }),
        ],
      }),
      { hosted: false },
    );
    // The schema rejects it before the policy pass; the creation form therefore
    // sets the human-readable message from the file picker's own check.
    expect(result.config).toBeNull();
    expect(Object.values(result.errors).join(" ")).toContain(megabytes(LIMITS.files.maxFileBytes));
  });

  it("normalises sliders to the step grid", () => {
    const result = validatePipelineForm(form({ chunkSize: 600, maxInputTokens: 1000 }), {
      hosted: false,
    });
    expect(result.config?.chunkSize).toBe(608);
    expect(result.config?.maxInputTokens).toBe(992);
  });
});

describe("hasPdfMagic", () => {
  it("accepts a PDF payload", () => {
    expect(hasPdfMagic(PDF_BASE64)).toBe(true);
  });

  it("accepts a data URL payload", () => {
    expect(hasPdfMagic(`data:application/pdf;base64,${PDF_BASE64}`)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(hasPdfMagic(Buffer.from("PK\u0003\u0004").toString("base64"))).toBe(false);
  });
});

describe("base64ByteLength", () => {
  it("matches the real decoded length", () => {
    for (const size of [1, 2, 3, 4, 100, 1023, 1024]) {
      const bytes = Buffer.alloc(size, 7);
      expect(base64ByteLength(bytes.toString("base64"))).toBe(size);
    }
  });
});

describe("checkClientDocuments", () => {
  it("accepts PDFs within the limits", () => {
    const result = checkClientDocuments([], [document()]);
    expect(result.accepted).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it("rejects non-PDF files by name", () => {
    const result = checkClientDocuments([], [document({ name: "notes.txt" })]);
    expect(result.accepted).toHaveLength(0);
    expect(result.errors[0]).toContain("not a PDF");
  });

  it("rejects duplicate names", () => {
    const first = document({ id: "a" });
    const result = checkClientDocuments([first], [document({ id: "b" })]);
    expect(result.errors[0]).toContain("already attached");
  });

  it("enforces the three-file ceiling", () => {
    const existing = [document({ id: "a", name: "a.pdf" }), document({ id: "b", name: "b.pdf" })];
    const result = checkClientDocuments(existing, [
      document({ id: "c", name: "c.pdf" }),
      document({ id: "d", name: "d.pdf" }),
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(result.errors).toContain(
      t("documents.tooMany", { count: LIMITS.files.maxCount }),
    );
  });

  it("enforces the per-file ceiling", () => {
    const result = checkClientDocuments([], [
      document({ sizeBytes: LIMITS.files.maxFileBytes + 1 }),
    ]);
    expect(result.errors[0]).toContain(megabytes(LIMITS.files.maxFileBytes));
  });
});
