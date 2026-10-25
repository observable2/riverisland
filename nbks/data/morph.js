// The 'transliteral' morph of riverIsland, ported from the wired actions of the 'ri' and 'stepper' sprite tracks
// (events 0xcfa7 prepare, 0x3d3e one step, 0x2f43 one line, 0x128c one word). See workingnotes.md.
//
// Text is handled as bytes, as in the original: Mac Roman for most texts, Big5 for the Chinese nodes. A line is a
// Uint8Array; the display decodes a pair of high bytes as one (double width) Chinese character where it can.

const SPACE = 32;
const APOS = 0xd5; // Mac Roman right single quote; the morph never lingers on it

// slack added to the 'room to spare' of a letter, indexed by step (variables 10093..10105 of the original)
const SKEW = [0, 2, 2, 1, 0, -1, -5, -7, -6, -5, -3, -2, -2, -1];

const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const splitLines = (b) => {
  const out = [[]];
  for (const c of b) c === 13 ? out.push([]) : out[out.length - 1].push(c);
  return out;
};

export class Morph {
  // alphabets: the two circular letter orderings (bytes); the first is used for 14 steps, the second (which adds the
  // Big5 bytes of the Chinese text) for 15, when a Chinese node is involved
  constructor(alphabets) {
    this.alphabets = alphabets.map((a) => (typeof a === "string" ? fromHex(a) : a));
  }

  // from, to: { bytes: Uint8Array, keys: {name: [x1, y1, x2, y2]} } (rectangles: columns from 0, lines from 1)
  prepare(from, to, { chinese = false, steps = chinese ? 15 : 14 } = {}) {
    this.steps = steps;
    this.alpha = this.alphabets[chinese ? 1 : 0];
    this.n = this.alpha.length;
    this.index = new Map(Array.from(this.alpha, (c, i) => [c, i + 1]));
    this.step = 1;
    const src = splitLines(from.bytes);
    const tgt = splitLines(to.bytes);
    const lines = Math.max(src.length, tgt.length);
    while (src.length < lines) src.push([SPACE]);
    while (tgt.length < lines) tgt.push([SPACE]);
    const width = Math.max(...src.map((l) => l.length), ...tgt.map((l) => l.length));
    // lower-case, blank what is not in the alphabet, pad to the common width
    const norm = (line) => {
      const out = new Uint8Array(width).fill(SPACE);
      line.forEach((c, i) => {
        if (c > 64 && c < 91) c += 32;
        out[i] = this.index.has(c) ? c : SPACE;
      });
      return out;
    };
    this.src = src.map(norm);
    this.tgt = tgt.map(norm);
    // words with the same key travel from their place in the old text to their place in the new one
    this.words = [];
    for (const key of Object.keys(to.keys ?? {})) {
      const a = from.keys?.[key];
      if (!a) continue;
      const b = to.keys[key];
      const [ax1, ay1, ax2] = a;
      const [bx1, by1, bx2] = b;
      const sl = this.src[ay1 - 1], tl = this.tgt[by1 - 1];
      let sw = Array.from(sl.slice(ax1, ax2 + 1));
      let tw = Array.from(tl.slice(bx1, bx2 + 1));
      sl.fill(SPACE, ax1, ax2 + 1);
      tl.fill(SPACE, ax1, ax2 + 1); // sic: the original blanks the target line at the *source* columns
      const diff = tw.length - sw.length;
      if (diff > 0) sw = sw.concat(Array(diff).fill(SPACE));
      else if (diff < 0) tw = tw.concat(Array(-diff).fill(SPACE));
      this.words.push({ sw: Uint8Array.from(sw), tw: Uint8Array.from(tw), x0: ax1, y0: ay1, x1: bx1, y1: by1, left: ax1, line: ay1 });
    }
    return this;
  }

  // the next letter on the way from c1 to c2 (event 0x2f43 / 0x128c)
  letter(c1, c2, s) {
    const { n, alpha, index, steps } = this;
    let i1 = index.get(c1) ?? 0;
    const i2 = index.get(c2) ?? 0;
    let dir = 1;
    let d = Math.abs(i2 - i1);
    if (d <= n / 2) {
      if (i2 < i1) dir = -1;
    } else {
      d = n - d;
      if (i1 < i2) dir = -1;
    }
    let slack = n / 2 - s + 1 - d + 1;
    if (slack > 1) slack += SKEW[s] ?? 0;
    const adv = () => {
      i1 += dir;
      if (i1 < 1) i1 = n;
      else if (i1 > n) i1 = 1;
      return alpha[i1 - 1];
    };
    let c = adv();
    if (c === APOS) c = adv();
    if (slack > 1 && s > steps - 6 && (c2 === SPACE || c === SPACE)) c = SPACE;
    return c;
  }

  morphRow(a, b, s) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) a[i] = this.letter(a[i], b[i], s);
  }

  // one step of the morph (event 0x3d3e); returns the lines as they are now
  advance() {
    const s = this.step;
    this.src.forEach((row, i) => this.morphRow(row, this.tgt[i], s));
    for (const w of this.words) {
      this.morphRow(w.sw, w.tw, s);
      const len = w.sw.length;
      const oldLeft = w.left, oldLine = w.line, oldRight = oldLeft + len - 1;
      const round = (v) => Math.trunc(v * (1 + 0.5 / Math.abs(v || 1e-9))); // round half away from zero
      const left = round(w.x0 + (s * (w.x1 - w.x0)) / this.steps);
      const line = round(w.y0 + (s * (w.y1 - w.y0)) / this.steps);
      w.left = left;
      w.line = line;
      const row = this.src[line - 1];
      if (row) for (let x = 0; x < len; x++) if (w.sw[x] !== SPACE && left + x >= 0 && left + x < row.length) row[left + x] = w.sw[x];
      const old = this.src[oldLine - 1];
      if (!old) continue;
      if (oldLine !== line) old.fill(SPACE, oldLeft, oldRight + 1);
      else if (oldLeft < left) old[oldLeft] = SPACE;
      else if (oldLeft !== left) {
        let flag = true;
        const newRight = left + len - 1;
        for (let x = oldLeft; x <= oldRight; x++) {
          const c = w.sw[x - oldLeft];
          if (c === SPACE && flag && x > 0) {
            flag = false;
            old[x - 1] = SPACE;
          }
          if (x > newRight && c !== SPACE) old[x] = SPACE;
        }
      }
    }
    this.step++;
    return this.src;
  }

  get done() {
    return this.step > this.steps;
  }
}

// ---------- bytes to display ----------

// Mac Roman 0x80-0xFF (checked against a reference table). 0xCA is a no-break space; 0xF0 is the Apple logo, which only Macs have, so it is shown as a space
const MAC = "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»…\u00a0ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uf8ffÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";
const big5 = typeof TextDecoder === "function" ? new TextDecoder("big5") : null;
const b5cache = new Map();
const hi = (c) => (c < 128 ? String.fromCharCode(c) : c === 0xf0 ? " " : MAC[c - 128]);

// A pair of bytes that is a Big5 character comes out as one character (shown two cells wide); the rest as Mac Roman.
export function decodeRow(row, chinese) {
  let out = "";
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (chinese && big5 && c >= 0xa1 && c <= 0xf9 && i + 1 < row.length) {
      const d = row[i + 1];
      if ((d >= 0x40 && d <= 0x7e) || (d >= 0xa1 && d <= 0xfe)) {
        const k = c * 256 + d;
        let ch = b5cache.get(k);
        if (ch === undefined) {
          ch = big5.decode(Uint8Array.of(c, d));
          if (ch.length !== 1 || ch === "�") ch = "";
          b5cache.set(k, ch);
        }
        if (ch) {
          out += `\u0001${ch}\u0002`;
          i++;
          continue;
        }
      }
    }
    out += hi(c);
  }
  return out;
}

export const bytesOf = (e) => ({ bytes: fromHex(e.hex), keys: e.keys ?? {}, chinese: e.enc === "big5" });
export const trimRow = (row) => {
  let e = row.length;
  while (e > 0 && row[e - 1] === SPACE) e--;
  return row.subarray(0, e);
};
