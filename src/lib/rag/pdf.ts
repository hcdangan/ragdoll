/**
 * PDF parsing and sandbox validation.
 *
 * Ported from the FastAPI engine's `pdf.py`. `unpdf` wraps PDF.js compiled to
 * WebAssembly, so this stays pure JavaScript — no native module, which is what keeps
 * the deployment small and portable.
 *
 * Three guards are retained from the original: reject files containing JavaScript,
 * embedded files or launch actions; reject encrypted files; and cap the work a single
 * upload can trigger.
 */

import { extractText, getDocumentProxy } from "unpdf";

import { chunkDocument, normaliseText, type TextChunk } from "./chunking";

export const MAX_DOCUMENTS = 3;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_PAGES = 400;
const MAX_TEXT_CHARS = 2_000_000;

/** A page carrying an image and less text than this is essentially the image. */
const IMAGE_ONLY_TEXT_CHARS = 120;

const PDF_MAGIC = "%PDF-";
const PDF_EOF = "%%EOF";

/** Names indicating active content; presence is disqualifying regardless of execution. */
const DANGEROUS_KEYS = ["/JavaScript", "/JS", "/Launch", "/EmbeddedFile", "/RichMedia"];

/** A PDF rejected by the sandbox. */
export class PdfRejectedError extends Error {
  readonly code: "pdf_invalid" | "pdf_encrypted" | "pdf_active_content";

  constructor(message: string, code: PdfRejectedError["code"] = "pdf_invalid") {
    super(message);
    this.name = "PdfRejectedError";
    this.code = code;
  }
}

/** Everything the index needs from one uploaded PDF. */
export interface ParsedDocument {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly pageCount: number;
  readonly imageCount: number;
  readonly hasImages: boolean;
  /** Pages whose content is effectively the image, so no text can stand in for it. */
  readonly imageOnlyPageNumbers: readonly number[];
  readonly chunks: readonly TextChunk[];
}

/**
 * Decodes a base64 payload, rejecting anything that is not really a PDF.
 * @param payload base64 document body.
 * @param documentName Name used in error messages.
 */
export function decodeBase64(payload: string, documentName: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(Buffer.from(payload, "base64"));
  } catch {
    throw new PdfRejectedError(`${documentName} is not valid base64 data.`, "pdf_invalid");
  }

  if (raw.byteLength > MAX_FILE_BYTES) {
    throw new PdfRejectedError(`${documentName} exceeds the 2 MB per-file limit.`, "pdf_invalid");
  }

  const head = Buffer.from(raw.subarray(0, 5)).toString("latin1");
  if (head !== PDF_MAGIC) {
    throw new PdfRejectedError(`${documentName} is not a PDF file.`, "pdf_invalid");
  }

  const tail = Buffer.from(raw.subarray(Math.max(0, raw.byteLength - 2048))).toString("latin1");
  if (!tail.includes(PDF_EOF)) {
    // A missing trailer almost always means a truncated upload.
    throw new PdfRejectedError(`${documentName} is truncated and could not be read.`, "pdf_invalid");
  }

  return raw;
}

/** Minimal shape of the PDF.js objects this module reads. */
interface PdfDict {
  readonly keys?: () => string[];
  get?: (key: string) => unknown;
}
interface PdfPage {
  readonly node?: PdfDict;
  get: (key: string) => unknown;
}
interface PdfProxy {
  readonly numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  getMetadata?: () => Promise<unknown>;
}

const asDict = (value: unknown): PdfDict | null =>
  typeof value === "object" && value !== null ? (value as PdfDict) : null;

/**
 * Rejects PDFs carrying JavaScript, embedded files or launch actions.
 *
 * Scans the decoded bytes for the catalogue keys rather than traversing the parsed
 * object graph: PDF dictionaries are plain ASCII in the file, so a byte scan catches
 * exactly these entries, and it cannot be defeated by a structure PDF.js is willing
 * to parse. The trade-off is deliberate — a compressed content stream that happens to
 * contain one of these strings is rejected too, which for a 2 MB, three-file upload
 * budget is the safer failure.
 */
function assertNoActiveContent(raw: Uint8Array, documentName: string): void {
  const text = Buffer.from(raw).toString("latin1");
  for (const key of DANGEROUS_KEYS) {
    if (text.includes(key)) {
      throw new PdfRejectedError(
        `${documentName} contains active content (${key}) and was rejected.`,
        "pdf_active_content",
      );
    }
  }

  // An /OpenAction in the catalogue means the document does something on open.
  if (text.includes("/OpenAction")) {
    throw new PdfRejectedError(
      `${documentName} declares an open action and was rejected.`,
      "pdf_active_content",
    );
  }
  // A /Names tree carrying either entry is how embedded files and scripts are attached.
  if (
    /\/Names\s*<<[^>]*\/(JavaScript|EmbeddedFiles)/s.test(text) ||
    text.includes("/EmbeddedFiles")
  ) {
    throw new PdfRejectedError(
      `${documentName} embeds scripts or files and was rejected.`,
      "pdf_active_content",
    );
  }
}

/**
 * Rejects a password-protected PDF with a message that says so.
 *
 * Detected here rather than from the parser's failure because pdf.js reports a
 * missing password as an opaque "could not be parsed", which reads like corruption
 * and sends the user looking for a different problem.
 */
function assertNotEncrypted(raw: Uint8Array, documentName: string): void {
  if (/\/Encrypt\b/.test(Buffer.from(raw).toString("latin1"))) {
    throw new PdfRejectedError(
      `${documentName} is password protected and cannot be indexed.`,
      "pdf_encrypted",
    );
  }
}

/** Counts extractable raster images on a page. */
function countImages(page: PdfPage): number {
  try {
    const resources = asDict(page.get("Resources"));
    if (resources === null) {
      return 0;
    }
    const xobject = asDict(resources.get?.("XObject"));
    if (xobject === null) {
      return 0;
    }
    const keys = xobject.keys?.() ?? [];
    let count = 0;
    for (const name of keys) {
      const entry = asDict(xobject.get?.(name));
      if (entry?.get?.("Subtype") === "/Image") {
        count += 1;
      }
    }
    return count;
  } catch {
    // A malformed XObject must not fail the upload.
    return 0;
  }
}

/**
 * Validates and chunks a single PDF upload.
 * @param options Document identity plus the chunking configuration.
 */
export async function parseDocument(options: {
  readonly id: string;
  readonly name: string;
  readonly payloadBase64: string;
  readonly chunkSize: number;
  readonly chunkOverlapTokens: number;
  readonly declaredPageCount?: number;
}): Promise<ParsedDocument> {
  const { id, name, payloadBase64, chunkSize, chunkOverlapTokens, declaredPageCount = 0 } = options;
  const raw = decodeBase64(payloadBase64, name);
  // Measured before parsing: pdf.js *transfers* the buffer it is handed, so the
  // caller's view is detached afterwards and any later read sees zero bytes.
  const sizeBytes = raw.byteLength;

  // Scanned before parsing, for the same reason — a byte scan after the transfer
  // would find nothing and silently pass every document, including a malicious one.
  assertNoActiveContent(raw, name);
  assertNotEncrypted(raw, name);

  let pdf: PdfProxy;
  try {
    pdf = (await getDocumentProxy(raw)) as unknown as PdfProxy;
  } catch {
    throw new PdfRejectedError(`${name} could not be parsed as a PDF.`, "pdf_invalid");
  }

  const extracted = await extractText(pdf as never, { mergePages: false });
  const pageTexts = Array.isArray(extracted.text) ? extracted.text : [extracted.text];

  const pages: [number, string][] = [];
  const imageOnlyPageNumbers: number[] = [];
  let imageCount = 0;
  let textBudget = MAX_TEXT_CHARS;

  const pageTotal = Math.min(pdf.numPages, MAX_PAGES, pageTexts.length);
  for (let pageNumber = 1; pageNumber <= pageTotal; pageNumber += 1) {
    const pageImages = countImages(await pdf.getPage(pageNumber));
    imageCount += pageImages;

    const text = normaliseText(pageTexts[pageNumber - 1] ?? "");
    if (pageImages > 0 && text.length < IMAGE_ONLY_TEXT_CHARS) {
      // A page whose content is essentially the image itself. Those are the only pages
      // a vision model could add something to, so they decide whether the multimodal
      // metrics have anything to measure.
      imageOnlyPageNumbers.push(pageNumber);
    }

    if (textBudget <= 0) {
      continue;
    }
    const clipped = text.length > textBudget ? text.slice(0, textBudget) : text;
    textBudget -= clipped.length;
    pages.push([pageNumber, clipped]);
  }

  const chunks = chunkDocument(pages, { chunkSize, chunkOverlapTokens });

  return {
    id,
    name,
    sizeBytes,
    pageCount: declaredPageCount > 0 ? Math.max(declaredPageCount, pages.length) : pages.length,
    imageCount,
    hasImages: imageCount > 0,
    imageOnlyPageNumbers,
    chunks,
  };
}

/** Applies the count and size limits before any parsing happens. */
export function enforceUploadBudget(sizes: readonly number[]): void {
  if (sizes.length > MAX_DOCUMENTS) {
    throw new PdfRejectedError(
      `At most ${MAX_DOCUMENTS} PDFs can be indexed per session.`,
      "pdf_invalid",
    );
  }
  for (const size of sizes) {
    if (size > MAX_FILE_BYTES) {
      throw new PdfRejectedError("A file exceeds the 2 MB per-file limit.", "pdf_invalid");
    }
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new PdfRejectedError("Combined uploads exceed the 6 MB session limit.", "pdf_invalid");
  }
}
