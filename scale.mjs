// png-squeeze-01's screen, make.fun's own (MIT): the forms and filters an image can be written in, each weighed by
// zlib, and the scale compressor the generator states each key from (generate.mjs scalePng). The reference compressor
// (reference/squeeze.mjs) screens the same way and writes its winner with its own deflate. Lossless: every pixel's four
// channels decode back exactly (png.mjs decodePng).
//
// The choices that hold the image exactly:
//   - the colour type: a palette (type 3, its transparent entries first so tRNS is short) when the image has at most
//     256 colours, its other entries by count or by luminance; grey (type 0) or grey and alpha (type 4) when every
//     pixel is grey; RGB (type 2) or RGBA (type 6) otherwise; with one fully transparent value that no opaque pixel
//     uses and every other pixel opaque, type 0 or 2 with a tRNS key instead of an alpha channel. A palette of an image
//     that is not grey holds it in a third of the bytes of RGB or less, so its RGB or RGBA form is not tried;
//   - the filters (FILTERS): every row unfiltered, or every row one fixed filter, or each row its own: the minimum-sum
//     heuristic (the PNG specification's section 12.8), the fewest distinct byte pairs, or brute force (each of the
//     five filters compressed by zlib after the 32 KiB written before it, the smallest kept). A palette by count is
//     tried unfiltered only, a palette by luminance unfiltered, by the minimum sum and by brute force.
// The screen (screen): each choice's filtered data compressed by zlib at SCREEN (level 6), the smallest the winner,
// the first on a tie, each weighed with its PLTE and tRNS chunks: one zlib run a choice, at a level whose match search
// visits at most 128 candidates a position, so its cost is bounded by the image's size.
//
// The scale (scalePng): the screen without brute force (the one choice that costs five zlib runs a row), its winner
// written with that zlib stream as it is. Its bytes are each key's scale_bytes: about 2 s a set of 8 at one CPU, so a
// draw stays well inside its wall. The reference screens brute force too and keeps its own deflate's stream only when
// it is smaller, so it never writes more bytes than the scale.

import { constants, deflateSync } from 'node:zlib';
import { filterRow, ihdrOf, pngOf, signedSum } from './png.mjs';

/** The image's pixels as 32-bit words (a copy when its bytes do not start on a word boundary). */
function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

/** What the image holds: whether every pixel is opaque, whether every pixel is grey, and its colours when at most 256. */
export function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  // A colour as [r, g, b, a] whatever the platform's byte order: read back from the bytes, never from the word.
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value (grey or RGB) the image may key by tRNS instead of an alpha channel: every pixel
 * opaque or that exact value at alpha 0, and no opaque pixel of the same value. Null when there is none.
 */
export function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The image's samples in colour type `ct` (0, 2, 4 or 6) from its RGBA. */
export function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/** A palette's entries in the order a trial writes them: the transparent ones first (by alpha), then by `order`. */
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

/** The palette form: {plte, trns, indices}. */
function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

/** The zlib setting every choice is screened by, and the stream the scale's PNG holds. */
export const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });

/** How many bytes written before a row brute force compresses its trials after. */
const BRUTE_CONTEXT = 32768;
/** The zlib level brute force weighs a row's trials at. */
const BRUTE_LEVEL = 4;

/** The fewest-distinct-pairs heuristic's cost: how many distinct pairs of neighbouring bytes a filtered row holds. */
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

/**
 * The raw data of an image of `samples` (height rows of width x bpp samples), each row behind its filter byte, by
 * `choice`: a filter type (0 to 4) for every row, or 'minsum', 'pairs' or 'brute' (the header), the lower type on a tie;
 * written into `raw` when it is given.
 */
export function filtered(samples, width, height, bpp, choice, raw = new Uint8Array(height * (width * bpp + 1))) {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

/** The filter choices each form is screened with. */
export const FILTERS = Object.freeze({
  palette: Object.freeze([0]),
  paletteByLuminance: Object.freeze([0, 'minsum', 'brute']),
  channels: Object.freeze([0, 1, 2, 4, 'minsum', 'pairs', 'brute']),
});

/** The forms the reference screens for an image: each {colourType, bpp, samples, plte, trns, filters}. */
export function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', FILTERS.palette],
      ['luminance', FILTERS.paletteByLuminance],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}


/** The bytes a form's PLTE and tRNS chunks take in its file (each 12 bytes of length, type and CRC around its data). */
const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

/**
 * The screen's winner for an image (the header's `screen`): its form, filter choice and filtered data, zlib's stream of
 * it at SCREEN and its weight (that stream's bytes and its form's PLTE and tRNS chunks); the first on a tie. Brute force
 * is screened unless `brute` is false.
 */
export function screen(rgba, width, height, { brute = true } = {}) {
  let best = null;
  // The buffer the next choice is filtered into: a loser's, written again by a later choice of its size.
  let spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      if (!brute && choice === 'brute') continue;
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, zlib: new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length), bytes };
      } else spare = data;
    }
  }
  return best;
}

/** The PNG of an image of `form` whose IDAT holds the zlib stream `idat`. */
export function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/** The scale's PNG of the image (the header): the screen's winner without brute force, in zlib's stream at SCREEN. */
export function scalePng(rgba, width, height) {
  const { form, zlib } = screen(rgba, width, height, { brute: false });
  return pngOfForm(width, height, form, zlib);
}
