/**
 * Builds the PDF fixture used by the E2E pipeline spec.
 *
 * Plain JavaScript on purpose: this runs from `pnpm e2e` before Playwright
 * starts, so there is no TypeScript loader in the picture.
 *
 * Written by hand for the same reason the Python suite builds its own: the engine
 * rejects PDFs carrying active content, so a fixture with a real cross-reference
 * table and no /OpenAction is the honest input.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(HERE, "..", "e2e", ".fixtures", "handbook.pdf");

const PAGE_TEXTS = [
  "Retention is seven years for financial records. Archived records are stored offsite.",
  "The methodology used stratified sampling across four quarters of data.",
  "Recommendations include quarterly audits and a named records owner.",
];

/**
 * @param {readonly string[]} pageTexts
 * @returns {Buffer}
 */
const buildPdf = (pageTexts) => {
  const objects = [];
  const fontObject = 3 + pageTexts.length * 2;
  const kids = pageTexts.map((_, index) => `${3 + index * 2} 0 R`).join(" ");

  objects.push(Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(Buffer.from(`<< /Type /Pages /Count ${pageTexts.length} /Kids [${kids}] >>`));

  pageTexts.forEach((text, index) => {
    const contentsObject = 4 + index * 2;
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${fontObject} 0 R >> >> ` +
          `/Contents ${contentsObject} 0 R >>`,
      ),
    );
    const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const stream = Buffer.from(`BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`);
    objects.push(
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
        stream,
        Buffer.from("\nendstream"),
      ]),
    );
  });

  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));

  const chunks = [Buffer.from("%PDF-1.7\n")];
  const offsets = [];
  let cursor = chunks[0].length;

  objects.forEach((body, index) => {
    offsets.push(cursor);
    const head = Buffer.from(`${index + 1} 0 obj\n`);
    const tail = Buffer.from("\nendobj\n");
    chunks.push(head, body, tail);
    cursor += head.length + body.length + tail.length;
  });

  const xrefOffset = cursor;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");

  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
};

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, buildPdf(PAGE_TEXTS));
process.stdout.write(`wrote ${OUTPUT}\n`);
