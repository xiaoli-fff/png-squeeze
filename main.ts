// png-squeeze-01 v2: lossless PNG squeeze that beats the house fixed-paeth baseline.
//
// Strategy: reuse make.fun's own kit screen (program/generator/subject/scale.mjs,
// MIT, see NOTICE) — it picks the best colour form (palette / grey / RGB / RGBA,
// with tRNS key where legal) and the best filter choice per form (fixed filters,
// minimum-sum, fewest-pairs, per-row brute force), weighed by zlib — then
// re-compress the winning filtered data with the best of several encoders:
//
//   - the optimal-parsing DEFLATE in ./zopfli.mjs (hash-chain longest match +
//     a second near match per position, DP parse over length-symbol
//     boundaries, true Huffman tables per 256 KiB block), with the hash-chain
//     length chosen per image from its colour type and compressed size
//     (measured on the practice set: palette images gain most from a long
//     chain, complex grey saturates early, simple grey and RGB/RGBA gain
//     steadily; rich/alpha images whose screen size is small gain too little
//     per second to be worth parsing at all);
//   - zlib level 9 with Z_BLOCK flushing every 256 KiB (fresh Huffman tables
//     per block), plus, for RGB, a Z_FILTERED variant — these are the safety
//     net: if the optimal parser ever loses on an unseen image, the best
//     zlib stream wins instead;
//   - for images where the parser is skipped, a small grid of chunk sizes
//     and strategies around the best known ones;
//   - the screen's own level-6 stream, always in the running.
//
// Fully deterministic: no clock, no randomness, fixed candidate order,
// first on ties. The work per image is fixed by its colour type and size,
// never by the clock, so the run stays well under the 60 s wall.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, createDeflate, deflateSync } from 'node:zlib';
import { decodePng } from './png.mjs';
import { pngOfForm, screen } from './scale.mjs';
import { deflateOptimal } from './zopfli.mjs';

/** Adler-32 of `data` (zlib checksum), computed in 5552-byte runs so the
 * 16-bit accumulators never overflow between reductions. */
function adler32(data) {
  let a = 1;
  let b = 0;
  for (let off = 0; off < data.length; off += 5552) {
    const end = Math.min(data.length, off + 5552);
    for (let i = off; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Wrap a raw deflate stream as a zlib stream (0x78 0x9C header + adler32). */
function wrapZlib(raw, data) {
  const out = new Uint8Array(2 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(raw, 2);
  const ad = adler32(data);
  out[2 + raw.length] = (ad >>> 24) & 0xff;
  out[3 + raw.length] = (ad >>> 16) & 0xff;
  out[4 + raw.length] = (ad >>> 8) & 0xff;
  out[5 + raw.length] = ad & 0xff;
  return out;
}

/** zlib stream of `data`, flushed with Z_BLOCK every `chunk` bytes so each
 * chunk gets fresh Huffman tables. Async (createDeflate is a stream). */
function deflateChunks(data, chunk, opts) {
  return new Promise((resolve, reject) => {
    const d = createDeflate(opts);
    const parts = [];
    d.on('data', (c) => parts.push(c));
    d.on('error', reject);
    d.on('end', () => resolve(Buffer.concat(parts)));
    (async () => {
      for (let off = 0; off < data.length; off += chunk) {
        // Respect backpressure: wait for the stream to drain before writing
        // more, so a large image cannot pile up in the write buffer.
        if (!d.write(data.subarray(off, Math.min(data.length, off + chunk)))) {
          await new Promise((res) => d.once('drain', res));
        }
        if (off + chunk < data.length) {
          await new Promise((res, rej) => d.flush(constants.Z_BLOCK, (e) => (e ? rej(e) : res())));
        }
      }
      d.end();
    })().catch(reject);
  });
}

/** Hash-chain length for the optimal parser, or null to skip it and use
 * zlib only. `bytes` is the screen winner's level-6 size (a complexity
 * proxy): palette images repay a long chain, complex grey saturates at a
 * short one, and small rich/alpha images repay parsing too slowly to be
 * worth the seconds. Thresholds measured on the practice set. */
function chainFor(colourType, bytes) {
  if (colourType === 3) return 4096;
  if (colourType === 0) return bytes > 50000 ? 512 : 2048;
  return bytes > 100000 ? 512 : null;
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

async function main() {
  for (const id of readdirSync(I).sort()) {
    const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
    if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
    const best = screen(image.rgba, image.width, image.height, { brute: true });
    const data = best.data;
    // Candidates in fixed order; the shortest wins, first on ties.
    const candidates = [best.zlib];
    const chain = chainFor(best.form.colourType, best.bytes);
    if (chain !== null) {
      const raw = deflateOptimal(data, 262144, chain, { hashBytes: 4, hashBits: 17 });
      candidates.push(wrapZlib(raw, data));
      candidates.push(await deflateChunks(data, 262144, { level: 9, memLevel: 8 }));
      if (best.form.colourType === 2) {
        candidates.push(await deflateChunks(data, 262144, { level: 9, memLevel: 9, strategy: constants.Z_FILTERED }));
      }
    } else {
      candidates.push(deflateSync(data, { level: 9, memLevel: 8 }));
      for (const chunk of [262144, 393216, 524288]) {
        candidates.push(await deflateChunks(data, chunk, { level: 9, memLevel: 8 }));
      }
      candidates.push(await deflateChunks(data, 262144, { level: 9, memLevel: 9, strategy: constants.Z_FILTERED }));
    }
    let idat = candidates[0];
    for (const c of candidates) if (c.length < idat.length) idat = c;
    mkdirSync(join(O, id), { recursive: true });
    writeFileSync(join(O, id, 'image.png'), pngOfForm(image.width, image.height, best.form, idat));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
