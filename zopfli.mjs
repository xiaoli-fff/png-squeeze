// zopfli-lite: optimal-parsing DEFLATE encoder (raw deflate stream, no zlib
// wrapper). Used by main.ts as a drop-in replacement for zlib level 9 on the
// screen's winning filtered data, where it wins by finding the matches zlib
// misses (long chains, a second near match per position, and a dynamic-
// programming parse over length-symbol boundaries), then encoding each
// 256 KiB block with its own true Huffman tables.
//
// Deterministic: no clock, no randomness, fixed iteration order, first on
// ties. Node 22 compatible; only built-in modules (none, in fact — pure JS).

export { deflateOptimal };

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenSym(len) {
  if (len >= 258) return 285;
  let s = 0;
  while (s < 28 && LEN_BASE[s + 1] <= len) s++;
  return 257 + s;
}
function distSym(d) {
  let s = 0;
  while (s < 29 && DIST_BASE[s + 1] <= d) s++;
  return s;
}

/** True optimal Huffman code lengths (maxBits), Kraft sum exactly 1.
 * Heap-built tree, then zlib's overflow fix (over-long codes clamped to
 * maxBits and re-balanced), then lengths re-assigned to symbols in frequency
 * order, which is optimal for the resulting length multiset. */
function codeLengths(freq, maxBits) {
  const n = freq.length;
  const len = new Array(n).fill(0);
  const used = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) used.push(i);
  if (used.length === 0) return len;
  if (used.length === 1) {
    len[used[0]] = 1;
    // A single code alone is incomplete: add a dummy second code of length 1.
    for (let i = 0; i < n; i++) if (freq[i] === 0) { len[i] = 1; break; }
    return len;
  }
  // Heap Huffman (min-heap by frequency; ties by symbol for determinism).
  const cmp = (a, b) => (a.f - b.f) || (a.tie - b.tie);
  const heap = used.map((s) => ({ f: freq[s], tie: s, syms: [s] }));
  heap.sort(cmp);
  const pop = () => heap.shift();
  const push = (nd) => {
    let i = heap.findIndex((x) => cmp(x, nd) > 0);
    if (i < 0) heap.push(nd);
    else heap.splice(i, 0, nd);
  };
  let tie = n;
  const depth = new Array(n).fill(0);
  while (heap.length > 1) {
    const a = pop(), b = pop();
    for (const s of a.syms) depth[s]++;
    for (const s of b.syms) depth[s]++;
    push({ f: a.f + b.f, tie: tie++, syms: [...a.syms, ...b.syms] });
  }
  // Length histogram, over-long codes clamped to maxBits.
  const blCount = new Array(maxBits + 1).fill(0);
  let overflow = 0;
  for (const s of used) {
    if (depth[s] > maxBits) { blCount[maxBits]++; overflow++; }
    else blCount[depth[s]]++;
  }
  // zlib's overflow fix: split a leaf below maxBits into two, and shorten one
  // over-long code to be its brother; each round removes two overflows.
  while (overflow > 0) {
    let m = maxBits - 1;
    while (m > 0 && blCount[m] === 0) m--;
    if (m === 0 || blCount[maxBits] === 0) break; // cannot fix further; stays valid-ish
    blCount[m]--;
    blCount[m + 1] += 2;
    blCount[maxBits]--;
    overflow -= 2;
  }
  // Assign the (fixed) length multiset to symbols in frequency order.
  const byFreq = [...used].sort((a, b) => (freq[b] - freq[a]) || (a - b));
  let k = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    for (let c = 0; c < blCount[bits] && k < byFreq.length; c++) len[byFreq[k++]] = bits;
  }
  // Any symbol the multiset did not cover (defensive) gets the longest length.
  while (k < byFreq.length) len[byFreq[k++]] = maxBits;
  // Verify Kraft == 1 exactly; repair by single-bit steps if the fix-up left
  // it off (each step changes Kraft by a power of two dividing the gap).
  const kraft = () => {
    let s = 0;
    for (let i = 0; i < n; i++) if (len[i] > 0) s += 1 << (maxBits - len[i]);
    return s;
  };
  const target = 1 << maxBits;
  let kk = kraft();
  let guard = 0;
  while (kk > target && guard++ < 10000) {
    let bi = -1, bl = -1, bf = Infinity;
    for (let i = 0; i < n; i++) {
      if (len[i] > 0 && len[i] < maxBits && (len[i] > bl || (len[i] === bl && freq[i] < bf))) { bl = len[i]; bf = freq[i]; bi = i; }
    }
    if (bi < 0) break;
    len[bi]++;
    kk = kraft();
  }
  guard = 0;
  while (kk < target && guard++ < 10000) {
    let bi = -1, bl = -1, bf = Infinity;
    for (let i = 0; i < n; i++) {
      if (len[i] > 1 && (len[i] > bl || (len[i] === bl && freq[i] < bf))) { bl = len[i]; bf = freq[i]; bi = i; }
    }
    if (bi < 0) break;
    len[bi]--;
    kk = kraft();
  }
  return len;
}

/** Canonical codes from lengths. */
function canonicalCodes(len) {
  const n = len.length;
  const codes = new Array(n).fill(0);
  const blCount = new Array(16).fill(0);
  for (let i = 0; i < n; i++) if (len[i] > 0) blCount[len[i]]++;
  let code = 0;
  const next = new Array(16).fill(0);
  for (let b = 1; b <= 15; b++) {
    code = (code + blCount[b - 1]) << 1;
    next[b] = code;
  }
  for (let i = 0; i < n; i++) if (len[i] > 0) codes[i] = next[len[i]]++;
  return codes;
}

/** Bit writer, LSB-first. */
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.nbits = 0; }
  write(code, len) {
    this.acc |= code << this.nbits;
    this.nbits += len;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  /** Write bits reversed (for Huffman codes, which are emitted MSB-first). */
  writeRev(code, len) {
    let r = 0;
    for (let i = 0; i < len; i++) r = (r << 1) | ((code >> i) & 1);
    this.write(r, len);
  }
  finish() {
    if (this.nbits > 0) this.bytes.push(this.acc & 0xff);
    return new Uint8Array(this.bytes);
  }
}

/** Find the longest match at every position (hash chains), plus a second
 * match: the longest match at a near distance (<= 256), which the DP needs
 * because the longest match is often far away (expensive distance code)
 * while a 1-byte-shorter match one byte back is far cheaper. Returns
 * { lens, dists, lens2, dists2 } (Uint16Arrays, 0 where there is no match). */
function findMatches(data, maxChain, opts = {}) {
  const n = data.length;
  const lens = new Uint16Array(n);
  const dists = new Uint16Array(n);
  const lens2 = new Uint16Array(n);
  const dists2 = new Uint16Array(n);
  const HASH_BITS = opts.hashBits ?? 15;
  const HASH_BYTES = opts.hashBytes ?? 3;
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  // 4-byte word view for fast compare (padded copy).
  const padded = new Uint8Array(((n + 3) >> 2) << 2);
  padded.set(data);
  const words = new Uint32Array(padded.buffer);
  const nw = words.length;
  const hashMask = (1 << HASH_BITS) - 1;
  const hashAt = (i) => {
    if (HASH_BYTES === 4) {
      const v = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
      return Math.imul(v, 2654435761) >>> (32 - HASH_BITS);
    }
    return ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & hashMask;
  };
  const need = HASH_BYTES;
  for (let i = 0; i < n; i++) {
    if (i + need <= n) {
      const h = hashAt(i);
      let cand = head[h];
      prev[i] = cand;
      head[h] = i;
      let bestLen = 0;
      let bestDist = 0;
      let nearLen = 0;
      let nearDist = 0;
      const maxLen = Math.min(258, n - i);
      let chain = 0;
      while (cand >= 0) {
        const dist = i - cand;
        if (dist > 32768) break;
        // zlib level-9 rule: once a good (>= 32) match is found, the chain
        // search is cut to a quarter of its length.
        if (chain >= (bestLen >= 32 ? maxChain >> 2 : maxChain)) break;
        chain++;
        // A candidate is worth a full compare if it can beat the longest
        // match or the near match.
        const canBeatLong = bestLen < maxLen && data[cand + bestLen] === data[i + bestLen];
        const canBeatNear = dist <= 256 && nearLen < maxLen && data[cand + nearLen] === data[i + nearLen];
        if (canBeatLong || canBeatNear) {
          // Compare bytes; switch to whole words only once both positions are
          // word-aligned (same offset mod 4), so a word never covers bytes
          // before the match start.
          let l = 0;
          while (l < maxLen && ((i + l) & 3) !== 0 && data[cand + l] === data[i + l]) l++;
          if (l < maxLen && data[cand + l] === data[i + l] && (cand & 3) === (i & 3)) {
            let wi = (i + l) >> 2, wc = (cand + l) >> 2;
            while (l + 4 <= maxLen && wi < nw && words[wc] === words[wi]) { l += 4; wi++; wc++; }
          }
          while (l < maxLen && data[cand + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = dist;
            if (l >= maxLen) break;
          }
          if (dist <= 256 && l > nearLen) {
            nearLen = l;
            nearDist = dist;
          }
        }
        cand = prev[cand];
      }
      if (bestLen >= 3) { lens[i] = bestLen; dists[i] = bestDist; }
      // The near match is useful only when it is strictly closer than the
      // longest match (otherwise the longest dominates it).
      if (nearLen >= 3 && nearDist < bestDist) { lens2[i] = nearLen; dists2[i] = nearDist; }
    }
  }
  return { lens, dists, lens2, dists2 };
}

/** DP optimal parse of data[lo,hi) with given per-symbol bit costs. Returns the symbol list. */
function dpParse(data, lo, hi, lens, dists, litCost, lenCost, distCost, lens2 = null, dists2 = null) {
  const m = hi - lo;
  // All symbol costs are whole bits, so the DP runs on integers (Int32Array
  // is far friendlier to the cache than Float64 here); INF marks unreachable.
  const INF = 1 << 30;
  const cost = new Int32Array(m + 1).fill(INF);
  const prevPos = new Int32Array(m + 1).fill(-1);
  const prevLen = new Int16Array(m + 1);
  const prevDist = new Int32Array(m + 1);
  cost[0] = 0;
  // length-symbol boundary lengths: for symbol s, max length in its range
  const symMaxLen = [];
  for (let s = 0; s < 29; s++) {
    symMaxLen.push(s === 28 ? 258 : LEN_BASE[s + 1] - 1);
  }
  // Per-symbol transition costs, precomputed (length code + extra bits, and
  // distance code + extra bits, by symbol).
  const lenSymCost = new Int32Array(29);
  for (let s = 0; s < 29; s++) lenSymCost[s] = lenCost[257 + s] + LEN_EXT[s];
  const distSymCost = new Int32Array(30);
  for (let s = 0; s < 30; s++) distSymCost[s] = distCost[s] + DIST_EXT[s];
  for (let i = 0; i < m; i++) {
    const c = cost[i];
    if (c >= INF) continue;
    const pos = lo + i;
    // literal
    const lc = c + litCost[data[pos]];
    if (lc < cost[i + 1]) { cost[i + 1] = lc; prevPos[i + 1] = i; prevLen[i + 1] = 1; prevDist[i + 1] = 0; }
    // matches: the longest match and the near match, each tried at every
    // length-symbol boundary up to its length.
    for (let p = 0; p < 2; p++) {
      const L = p === 0 ? lens[pos] : lens2 !== null ? lens2[pos] : 0;
      if (L < 3) continue;
      const d = p === 0 ? dists[pos] : dists2[pos];
      const dc = distSymCost[distSym(d)];
      const maxL = Math.min(L, m - i);
      for (let s = 0; s < 29; s++) {
        const symLen = Math.min(symMaxLen[s], maxL);
        if (symLen < LEN_BASE[s]) continue;
        if (s > 0 && symLen <= Math.min(symMaxLen[s - 1], maxL)) continue;
        const nc = c + lenSymCost[s] + dc;
        const j = i + symLen;
        if (nc < cost[j]) { cost[j] = nc; prevPos[j] = i; prevLen[j] = symLen; prevDist[j] = d; }
      }
    }
  }
  // backtrack
  const syms = [];
  let j = m;
  while (j > 0) {
    const i = prevPos[j];
    const l = prevLen[j];
    if (l === 1) syms.push({ lit: data[lo + i] });
    else syms.push({ len: l, dist: prevDist[j] });
    j = i;
  }
  syms.reverse();
  return syms;
}

function freqsOf(syms) {
  const litFreq = new Array(286).fill(0);
  const distFreq = new Array(30).fill(0);
  for (const s of syms) {
    if (s.lit !== undefined) litFreq[s.lit]++;
    else {
      litFreq[lenSym(s.len)]++;
      distFreq[distSym(s.dist)]++;
    }
  }
  litFreq[256]++; // end of block
  return { litFreq, distFreq };
}

function emitBlock(bw, syms, litLen, litCode, distLen, distCode, isLast) {
  bw.write(isLast ? 1 : 0, 1);
  bw.write(2, 2); // dynamic
  // count used lit/len codes (at least 257) and dist codes (at least 1)
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const all = new Array(hlit + hdist);
  for (let i = 0; i < hlit; i++) all[i] = litLen[i];
  for (let i = 0; i < hdist; i++) all[hlit + i] = distLen[i];
  // RLE of code lengths with 16/17/18
  const clSeq = [];
  {
    let i = 0;
    while (i < all.length) {
      const v = all[i];
      let run = 1;
      while (i + run < all.length && all[i + run] === v) run++;
      if (v === 0) {
        let r = run;
        while (r >= 11) { const take = Math.min(r, 138); clSeq.push([18, take]); r -= take; }
        if (r >= 3) { clSeq.push([17, r]); r = 0; }
        while (r > 0) { clSeq.push([0, 1]); r--; }
      } else {
        clSeq.push([v, 1]);
        let r = run - 1;
        while (r >= 3) { const take = Math.min(r, 6); clSeq.push([16, take]); r -= take; }
        while (r > 0) { clSeq.push([v, 1]); r--; }
      }
      i += run;
    }
  }
  const clFreq = new Array(19).fill(0);
  for (const [s] of clSeq) clFreq[s]++;
  const clLen = codeLengths(clFreq, 7);
  const clCode = canonicalCodes(clLen);
  const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let hclen = 19;
  while (hclen > 4 && clLen[ORDER[hclen - 1]] === 0) hclen--;
  bw.write(hlit - 257, 5);
  bw.write(hdist - 1, 5);
  bw.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.write(clLen[ORDER[k]], 3);
  for (const [s, rep] of clSeq) {
    bw.writeRev(clCode[s], clLen[s]);
    if (s === 16) bw.write(rep - 3, 2);
    else if (s === 17) bw.write(rep - 3, 3);
    else if (s === 18) bw.write(rep - 11, 7);
  }
  // symbols
  for (const s of syms) {
    if (s.lit !== undefined) {
      bw.writeRev(litCode[s.lit], litLen[s.lit]);
    } else {
      const ls = lenSym(s.len);
      bw.writeRev(litCode[ls], litLen[ls]);
      if (LEN_EXT[ls - 257] > 0) bw.write(s.len - LEN_BASE[ls - 257], LEN_EXT[ls - 257]);
      const ds = distSym(s.dist);
      bw.writeRev(distCode[ds], distLen[ds]);
      if (DIST_EXT[ds] > 0) bw.write(s.dist - DIST_BASE[ds], DIST_EXT[ds]);
    }
  }
  bw.writeRev(litCode[256], litLen[256]);
}

/** Optimal deflate of `data` in blocks of `blockSize`, hash chains of
 * `maxChain`. Returns the raw deflate stream (no zlib wrapper). */
function deflateOptimal(data, blockSize = 262144, maxChain = 128, matchOpts = {}) {
  const { lens, dists, lens2, dists2 } = findMatches(data, maxChain, matchOpts);
  const bw = new BitWriter();
  const nBlocks = Math.ceil(data.length / blockSize);
  for (let b = 0; b < nBlocks; b++) {
    const lo = b * blockSize;
    const hi = Math.min(data.length, lo + blockSize);
    // pass 1: flat costs
    const litCost1 = new Float64Array(256).fill(9);
    const lenCost1 = new Float64Array(286).fill(6);
    const distCost1 = new Float64Array(30).fill(6);
    let syms = dpParse(data, lo, hi, lens, dists, litCost1, lenCost1, distCost1, lens2, dists2);
    // pass 2: real costs. Pseudocount +1 on EVERY symbol: a symbol the pass-1
    // parse never used still needs a valid (long) code length, or the DP would
    // treat it as free (length 0) and abuse it (e.g. emitting thousands of
    // "free" literals of a byte value the first parse covered only by matches).
    const { litFreq, distFreq } = freqsOf(syms);
    for (let i = 0; i < 286; i++) litFreq[i]++;
    for (let i = 0; i < 30; i++) distFreq[i]++;
    let litLen = codeLengths(litFreq, 15);
    let distLen = codeLengths(distFreq, 15);
    const litCost = new Float64Array(286);
    const distCost = new Float64Array(30);
    for (let i = 0; i < 286; i++) litCost[i] = litLen[i];
    for (let i = 0; i < 30; i++) distCost[i] = distLen[i];
    syms = dpParse(data, lo, hi, lens, dists, litCost, litCost, distCost, lens2, dists2);
    const f2 = freqsOf(syms);
    litLen = codeLengths(f2.litFreq, 15);
    distLen = codeLengths(f2.distFreq, 15);
    // No match at all in this block: emit a complete two-code distance table.
    if (f2.distFreq.every((f) => f === 0)) { distLen = new Array(30).fill(0); distLen[0] = 1; distLen[1] = 1; }
    const litCode = canonicalCodes(litLen);
    const distCode = canonicalCodes(distLen);
    emitBlock(bw, syms, litLen, litCode, distLen, distCode, b === nBlocks - 1);
  }
  return bw.finish();
}
