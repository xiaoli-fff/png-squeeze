// png-squeeze-01 v1: lossless PNG squeeze that beats the house fixed-paeth baseline.
//
// Strategy: reuse make.fun's own kit screen (program/generator/subject/scale.mjs,
// MIT, see NOTICE) — it picks the best colour form (palette / grey / RGB / RGBA,
// with tRNS key where legal) and the best filter choice per form (fixed filters,
// minimum-sum, fewest-pairs, per-row brute force), weighed by zlib — then
// re-deflate the winning filtered data at level 9 and keep whichever stream
// (the screen's level-6 stream or the level-9 one) is smaller. Fully
// deterministic: no clock, no randomness, fixed choice order, first on ties.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync } from 'node:zlib';
import { decodePng } from './png.mjs';
import { pngOfForm, screen } from './scale.mjs';

/** The smallest zlib stream of `data` among the screen's level-6 stream and two level-9 variants. */
function bestStream(data, screened) {
  const candidates = [screened];
  for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
    const stream = deflateSync(data, { level: 9, memLevel: 9, strategy });
    if (stream.length < candidates[0].length) candidates[0] = stream;
  }
  const winner = candidates[0];
  return new Uint8Array(winner.buffer, winner.byteOffset, winner.length);
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  const best = screen(image.rgba, image.width, image.height, { brute: true });
  const idat = bestStream(best.data, best.zlib);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), pngOfForm(image.width, image.height, best.form, idat));
}
