/**
 * Slices the RAGdoll master logo into derived brand assets.
 *
 * Run with: node tools/slice-assets.mjs
 *
 * The master logo (public/brand/ragdoll-logo.png) is the single source of
 * truth. Everything else is derived from it so the brand cannot drift.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BRAND_DIR = join(ROOT, "public", "brand");
const SOURCE = join(BRAND_DIR, "ragdoll-logo.png");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Reads a PNG buffer into raw RGBA pixels.
 * Only 8-bit, non-interlaced truecolour images are supported, which covers the
 * brand master and every asset this script emits.
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
const decodePng = (buffer) => {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Not a PNG file.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colourType = data.readUInt8(9);
      const interlace = data.readUInt8(12);
      if (bitDepth !== 8 || interlace !== 0) {
        throw new Error(`Unsupported PNG (bitDepth=${bitDepth}, interlace=${interlace}).`);
      }
      if (colourType !== 2 && colourType !== 6) {
        throw new Error(`Unsupported PNG colour type ${colourType}.`);
      }
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  const channels = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(y * (stride + 1));
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    unfilterInPlace(filter, line, previous, channels);

    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      rgba[target] = line[source];
      rgba[target + 1] = line[source + 1];
      rgba[target + 2] = line[source + 2];
      rgba[target + 3] = channels === 4 ? line[source + 3] : 255;
    }
    previous = line;
  }

  return { width, height, rgba };
};

/**
 * Reverses a PNG scanline filter in place.
 * @param {number} filter
 * @param {Buffer} line
 * @param {Buffer} previous
 * @param {number} channels
 * @returns {void}
 */
const unfilterInPlace = (filter, line, previous, channels) => {
  const bpp = channels;
  for (let i = 0; i < line.length; i += 1) {
    const left = i >= bpp ? line[i - bpp] : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;

    switch (filter) {
      case 0:
        break;
      case 1:
        line[i] = (line[i] + left) & 0xff;
        break;
      case 2:
        line[i] = (line[i] + up) & 0xff;
        break;
      case 3:
        line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
        break;
      case 4: {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        line[i] = (line[i] + predictor) & 0xff;
        break;
      }
      default:
        throw new Error(`Unsupported PNG filter ${filter}.`);
    }
  }
};

/**
 * Encodes RGBA pixels as an 8-bit RGBA PNG.
 * @param {{ width: number, height: number, rgba: Buffer }} image
 * @returns {Buffer}
 */
const encodePng = ({ width, height, rgba }) => {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/**
 * Builds a PNG chunk with its CRC.
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * Crops a region out of an image.
 * @param {{ width: number, height: number, rgba: Buffer }} image
 * @param {{ x: number, y: number, width: number, height: number }} box
 */
const crop = (image, box) => {
  const rgba = Buffer.alloc(box.width * box.height * 4);
  for (let y = 0; y < box.height; y += 1) {
    const sourceStart = ((box.y + y) * image.width + box.x) * 4;
    image.rgba.copy(rgba, y * box.width * 4, sourceStart, sourceStart + box.width * 4);
  }
  return { width: box.width, height: box.height, rgba };
};

/**
 * Nearest-neighbour resample — used only to upscale UI avatars, never to shrink.
 * @param {{ width: number, height: number, rgba: Buffer }} image
 * @param {number} width
 * @param {number} height
 */
const resize = (image, width, height) => {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const source = (sourceY * image.width + sourceX) * 4;
      const target = (y * width + x) * 4;
      rgba[target] = image.rgba[source];
      rgba[target + 1] = image.rgba[source + 1];
      rgba[target + 2] = image.rgba[source + 2];
      rgba[target + 3] = image.rgba[source + 3];
    }
  }
  return { width, height, rgba };
};

/**
 * Removes the flat brand background, keeping the illustration and softening edges.
 * @param {{ width: number, height: number, rgba: Buffer }} image
 */
const transparencyFromBackground = (image) => {
  const rgba = Buffer.from(image.rgba);
  const samples = [
    0,
    (image.width - 1) * 4,
    (image.height - 1) * image.width * 4,
    ((image.height - 1) * image.width + image.width - 1) * 4,
  ];
  const background = [0, 1, 2].map(
    (channel) => samples.reduce((total, index) => total + rgba[index + channel], 0) / samples.length,
  );

  for (let i = 0; i < rgba.length; i += 4) {
    const distance = Math.max(
      Math.abs(rgba[i] - background[0]),
      Math.abs(rgba[i + 1] - background[1]),
      Math.abs(rgba[i + 2] - background[2]),
    );
    if (distance <= 8) {
      rgba[i + 3] = 0;
    } else if (distance < 24) {
      rgba[i + 3] = Math.round((255 * (distance - 8)) / 16);
    }
  }
  return { width: image.width, height: image.height, rgba };
};

const main = async () => {
  await mkdir(BRAND_DIR, { recursive: true });
  const master = decodePng(await readFile(SOURCE));

  // Avatar: the RAGdoll cat illustration from the top-left of the master logo.
  const avatarBox = { x: 56, y: 30, width: 272, height: 286 };
  const avatar = transparencyFromBackground(crop(master, avatarBox));

  await writeFile(join(BRAND_DIR, "ragdoll-cat.png"), encodePng(avatar));
  await writeFile(join(BRAND_DIR, "ragdoll-cat@2x.png"), encodePng(resize(avatar, avatar.width * 2, avatar.height * 2)));

  // Icon: the cat on the brand background, square, for favicons and store cards.
  const icon = resize(crop(master, { x: 112, y: 44, width: 216, height: 216 }), 512, 512);
  await writeFile(join(BRAND_DIR, "icon-512.png"), encodePng(icon));
  await writeFile(join(BRAND_DIR, "icon-192.png"), encodePng(resize(icon, 192, 192)));

  process.stdout.write(
    `brand assets written: cat ${avatar.width}x${avatar.height}, icon 512, plus @2x variants\n`,
  );
};

await main();
