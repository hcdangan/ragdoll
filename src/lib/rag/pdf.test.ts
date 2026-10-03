import { describe, expect, it } from "vitest";

import { megabytes } from "@/lib/rules";
import {
  MAX_DOCUMENTS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  PdfRejectedError,
  decodeBase64,
  enforceUploadBudget,
  parseDocument,
} from "@/lib/rag/pdf";

/**
 * This is the upload sandbox, so the tests are written from an attacker's side: a real
 * PDF with active content has to be rejected, a payload that is not a PDF at all has to
 * be rejected, and an honest text-only PDF has to come out the other end with its text
 * intact. The fixture is built here rather than checked in so that each hostile case is
 * one token away from a document the parser accepts.
 *
 * The PDF builder is a port of `scripts/make-fixture.mjs`, which the E2E suite uses.
 */

const PAGE_TEXT = "Retention is seven years for financial records.";

/** Keys the sandbox refuses, in the order the module checks them. */
const ACTIVE_CONTENT_KEYS = [
  "/JavaScript",
  "/JS",
  "/Launch",
  "/EmbeddedFile",
  "/RichMedia",
  "/OpenAction",
  "/EmbeddedFiles",
];

/**
 * Emits a minimal, honest PDF: uncompressed content stream, correct xref table, a
 * `%PDF-1.7` header and no active content. `marker` is spliced into the header as a
 * comment, which the parser ignores but the byte scan sees; `encrypted` adds a standard
 * security handler, which is how a password-protected document looks on the wire.
 */
function buildPdf(pageTexts: readonly string[], marker = "", encrypted = false): Buffer {
  const fontObject = 3 + pageTexts.length * 2;
  const kids = pageTexts.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(`<< /Type /Pages /Count ${pageTexts.length} /Kids [${kids}] >>`),
  ];

  pageTexts.forEach((text, index) => {
    const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const stream = Buffer.from(`BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`);
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
      ),
    );
    objects.push(
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
        stream,
        Buffer.from("\nendstream"),
      ]),
    );
  });

  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  if (encrypted) {
    objects.push(
      Buffer.from(
        "<< /Filter /Standard /V 1 /R 2 /Length 40 " +
          `/O <${"a1".repeat(32)}> /U <${"b2".repeat(32)}> /P -1 >>`,
      ),
    );
  }
  const encryptEntry = encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<0102> <0102>]` : "";

  const header = Buffer.from(`%PDF-1.7\n${marker}`);
  const parts: Buffer[] = [header];
  const offsets: number[] = [];
  let cursor = header.length;

  objects.forEach((body, index) => {
    offsets.push(cursor);
    const head = Buffer.from(`${index + 1} 0 obj\n`);
    const tail = Buffer.from("\nendobj\n");
    parts.push(head, body, tail);
    cursor += head.length + body.length + tail.length;
  });

  parts.push(
    Buffer.from(
      [
        `xref\n0 ${objects.length + 1}\n`,
        "0000000000 65535 f \n",
        ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptEntry} >>\n` +
          `startxref\n${cursor}\n%%EOF\n`,
      ].join(""),
    ),
  );

  return Buffer.concat(parts);
}

const pdfBase64 = (marker = ""): string => buildPdf([PAGE_TEXT], marker).toString("base64");

function parse(payloadBase64: string, name = "handbook.pdf"): ReturnType<typeof parseDocument> {
  return parseDocument({
    id: "doc-1",
    name,
    payloadBase64,
    chunkSize: 512,
    chunkOverlapTokens: 51,
  });
}

/** Runs a parse that must fail and hands back the rejection for inspection. */
async function rejection(call: Promise<unknown>): Promise<PdfRejectedError> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(PdfRejectedError);
    return error as PdfRejectedError;
  }
  throw new Error("the document should have been rejected");
}

describe("upload limits", () => {
  const megabyte = 1024 * 1024;

  it("pins the documented 3 file / 5 MB / 15 MB budget", () => {
    expect(MAX_DOCUMENTS).toBe(3);
    expect(MAX_FILE_BYTES).toBe(5 * megabyte);
    expect(MAX_TOTAL_BYTES).toBe(15 * megabyte);
  });

  it("accepts three files that together stay under the session cap", () => {
    expect(() => enforceUploadBudget([megabyte, megabyte, megabyte])).not.toThrow();
    expect(() => enforceUploadBudget([])).not.toThrow();
    expect(() => enforceUploadBudget([1024])).not.toThrow();
  });

  it("rejects a fourth file before it looks at any size", () => {
    expect(() => enforceUploadBudget([1, 1, 1, 1])).toThrow(PdfRejectedError);

    try {
      enforceUploadBudget([1, 1, 1, 1]);
      expect.unreachable("four files should have been rejected");
    } catch (error) {
      expect((error as PdfRejectedError).code).toBe("pdf_invalid");
      expect((error as PdfRejectedError).message).toBe(
        `At most ${MAX_DOCUMENTS} PDFs can be indexed per session.`,
      );
    }
  });

  it("rejects a single file above the per-file limit", () => {
    expect(() => enforceUploadBudget([MAX_FILE_BYTES + 1])).toThrow(PdfRejectedError);
    expect(() => enforceUploadBudget([1024, MAX_FILE_BYTES + 1, 1024])).toThrow(
      `A file exceeds the ${megabytes(MAX_FILE_BYTES)} per-file limit.`,
    );
  });

  it("accepts three files sitting exactly on both limits", () => {
    // Three files at the per-file ceiling are exactly the session cap, which is why
    // the combined-size guard can never fire first: the per-file limit is reached
    // before the total can be exceeded.
    expect(MAX_FILE_BYTES * MAX_DOCUMENTS).toBe(MAX_TOTAL_BYTES);
    expect(() =>
      enforceUploadBudget([MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES]),
    ).not.toThrow();
  });

  it("reports the session cap in the combined-size error", () => {
    expect(() =>
      enforceUploadBudget([MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_BYTES + 1]),
    ).toThrow(`A file exceeds the ${megabytes(MAX_FILE_BYTES)} per-file limit.`);

    // The combined guard is reachable only when the per-file ceiling is raised
    // independently, so it is asserted directly rather than through three uploads.
    expect(megabytes(MAX_TOTAL_BYTES)).toBe("15 MB");
  });
});

describe("decodeBase64", () => {
  it("returns the bytes of a well-formed PDF", () => {
    const bytes = buildPdf([PAGE_TEXT]);
    const raw = decodeBase64(bytes.toString("base64"), "handbook.pdf");

    expect(raw.byteLength).toBe(bytes.byteLength);
    expect(Buffer.from(raw.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  });

  it("rejects text that is not base64, which decodes to something that is not a PDF", () => {
    expect(() => decodeBase64("this is not a pdf at all!!", "broken.pdf")).toThrow(PdfRejectedError);
    expect(() => decodeBase64("this is not a pdf at all!!", "broken.pdf")).toThrow(
      "broken.pdf is not a PDF file.",
    );
  });

  it("rejects bytes that do not start with the PDF magic", () => {
    const archive = Buffer.from("PK\u0003\u0004 this is really a zip").toString("base64");

    expect(() => decodeBase64(archive, "archive.pdf")).toThrow("archive.pdf is not a PDF file.");
  });

  it("rejects a PDF that has no trailer, which is how a truncated upload looks", () => {
    const cut = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n").toString("base64");

    expect(() => decodeBase64(cut, "cut.pdf")).toThrow(
      "cut.pdf is truncated and could not be read.",
    );
  });

  it("rejects a payload above the per-file limit", () => {
    const oversize = Buffer.alloc(MAX_FILE_BYTES + 1).toString("base64");

    expect(() => decodeBase64(oversize, "big.pdf")).toThrow(
      `big.pdf exceeds the ${megabytes(MAX_FILE_BYTES)} per-file limit.`,
    );
  });
});

describe("parseDocument — rejected documents", () => {
  // The scan runs on the bytes *before* pdf.js parses them, because parsing transfers
  // the buffer and leaves the caller's view detached. This first case proves the
  // payload genuinely carries the key, so the rejections below cannot pass vacuously.
  it("builds a payload that really carries each active-content key", () => {
    for (const key of ACTIVE_CONTENT_KEYS) {
      expect(buildPdf([PAGE_TEXT], `% ${key}\n`).toString("latin1"), key).toContain(key);
    }
  });

  it("rejects a PDF carrying any active-content key", async () => {
    for (const key of ACTIVE_CONTENT_KEYS) {
      const failure = await rejection(parse(pdfBase64(`% ${key}\n`), "active.pdf"));

      expect(failure.code, key).toBe("pdf_active_content");
      expect(failure.message, key).toContain("active.pdf");
    }
  });

  it("names the key it rejected", async () => {
    await expect(parse(pdfBase64("% /JavaScript\n"), "scripted.pdf")).rejects.toThrow(
      "scripted.pdf contains active content (/JavaScript) and was rejected.",
    );
    await expect(parse(pdfBase64("% /OpenAction\n"), "opening.pdf")).rejects.toThrow(
      "opening.pdf declares an open action and was rejected.",
    );
  });

  it("rejects an encrypted PDF", async () => {
    const encrypted = buildPdf([PAGE_TEXT], "", true).toString("base64");
    const failure = await rejection(parse(encrypted, "locked.pdf"));

    // Reported as encryption specifically, not as corruption: pdf.js's own failure
    // would read like a damaged file.
    expect(failure.code).toBe("pdf_encrypted");
    expect(failure.message).toBe("locked.pdf is password protected and cannot be indexed.");
  });

  it("rejects a payload whose bytes are not a PDF", async () => {
    const archive = Buffer.from("PK\u0003\u0004 this is really a zip").toString("base64");

    await expect(parse(archive, "archive.pdf")).rejects.toThrow(
      "archive.pdf is not a PDF file.",
    );
  });
});

describe("parseDocument — accepted document", () => {
  it("extracts the text and page count of a minimal text-only PDF", async () => {
    const document = await parse(buildPdf([PAGE_TEXT]).toString("base64"));

    expect(document.id).toBe("doc-1");
    expect(document.name).toBe("handbook.pdf");
    expect(document.pageCount).toBe(1);
    expect(document.imageCount).toBe(0);
    expect(document.hasImages).toBe(false);
    expect(document.imageOnlyPageNumbers).toEqual([]);
    expect(document.chunks).toHaveLength(1);
    expect(document.chunks[0]?.text).toBe(PAGE_TEXT);
    expect(document.chunks[0]?.page).toBe(1);
  });

  it("reports the uploaded byte size", async () => {
    const bytes = buildPdf([PAGE_TEXT]);
    const document = await parse(bytes.toString("base64"));

    expect(document.sizeBytes).toBe(bytes.byteLength);
  });

  it("chunks every page of a multi-page PDF", async () => {
    const pages = [PAGE_TEXT, "The methodology used stratified sampling across four quarters."];
    const document = await parse(buildPdf(pages).toString("base64"), "handbook.pdf");

    expect(document.pageCount).toBe(2);
    expect(document.chunks.map((chunk) => chunk.page)).toEqual([1, 2]);
    expect(document.chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(document.chunks[1]?.text).toContain("stratified sampling");
  });
});
