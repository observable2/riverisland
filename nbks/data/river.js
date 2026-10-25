// The navigation model of riverIsland: the state machine of the 'ri' sprite track, without the display.
//
// Two loops of sixteen nodes cross at one node: horizontal node 5 is vertical node 1. The horizontal loop is the
// panorama (node n sits at pan (n-1) x 22.5 degrees), the vertical loop the object movie (node n at angle (n-1) x 22.5,
// where angle = (tilt + 90) x 2 and each node has twelve of its 192 frames). Moving to a node means a morph of the text
// (14 steps, one every STEP_MS), during which the panorama or the object movie glides to the new node.

import { Morph, bytesOf, trimRow } from "./morph.js";

export const STEP_MS = 750; // ms per morph step: the 'ri' track's idle frequency is 90; this value was chosen by the author
export const NODE_DEG = 22.5;
export const VIDEO_NODES = [4, 6, 11]; // vertical nodes that offer an interliteral movie
export const EAST = 1, WEST = -1, NORTH = 2, SOUTH = -2;

const wrap16 = (n) => ((n - 1 + 16) % 16) + 1;
export const wrap360 = (a) => ((a % 360) + 360) % 360;
export const home = (n) => (n - 1) * NODE_DEG;
// the node (1-16) whose sound is nearest to the angle (the original adds 11.25 degrees and divides by 22.5)
export const nodeAt = (angle) => Math.floor(((Math.round(angle * 100) + 1125 + 36000 * 2) % 36000) / 2250) + 1;
// frame (0-191) of the object movie for an angle: the film runs against the tilt, and loops
export const frameAt = (angle) => Math.floor(wrap360(360 - angle) * (192 / 360)) % 192;
const shortest = (from, to) => ((to - from + 540) % 360) - 180;
const latin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const DELTA = { [EAST]: -1, [WEST]: 1, [NORTH]: -1, [SOUTH]: 1 }; // east steps back through the list of texts

export class River {
  constructor(texts) {
    this.h = texts.h.map(bytesOf);
    this.v = texts.v.map(bytesOf);
    this.morph = new Morph(texts.alphabets);
    this.loading = { bytes: latin(texts.loading), keys: {}, chinese: false };
    this.axis = "h";
    this.hIdx = 5;
    this.vIdx = 1;
    this.pan = 90; // the angles of the two movies
    this.tilt = 0;
    this.rows = [this.loading.bytes];
    this.chinese = false;
    this.clean = this.loading; // the entry the rows are exactly, or null in the middle of a morph
    this.transit = null;
    this.holding = 0;
    this.armed = true;
    this.changed = false;
    this.arrived = false;
    this.acc = 0;
    this.video = 0; // vertical node of the interliteral movie being shown, or 0
    this.dirty = true;
  }

  get idx() { return this.axis === "h" ? this.hIdx : this.vIdx; }
  get angle() { return this.axis === "h" ? this.pan : this.tilt; }
  entry(axis, n) { return (axis === "h" ? this.h : this.v)[n - 1]; }
  home(axis, n) { return home(n); }

  // the text as it stands, as one entry to morph from
  current() {
    if (this.clean) return this.clean;
    const bytes = [];
    this.rows.forEach((r, i) => { if (i) bytes.push(13); bytes.push(...trimRow(r)); });
    return { bytes: Uint8Array.from(bytes), keys: {}, chinese: this.chinese };
  }

  text() { return this.rows.map(trimRow); }

  // ---- transitions ----

  // A transition has two ends: the node it started from (the origin) and the one it is going to (the destination). It is
  // `total` presses long (the steps of the morph and one more, which puts the exact text in), and `depth` counts how many
  // presses it is away from the origin, so that an opposite click takes one back (depth - 1) and the click that makes
  // depth 0 puts the origin text back exactly; `heading` says which end it is going to now.
  begin({ axis, to, toEntry, fromAngle, toAngle, auto, dir = 0, steps }) {
    const from = this.current();
    const chinese = from.chinese || toEntry.chinese;
    const t = { chinese, axis, to, from: this.arrived ? { axis: this.axis, idx: this.idx } : null, dir, auto, fromAngle, toAngle, toEntry, glide: !toEntry,
      heading: 1, depth: 0, angleO: fromAngle, angleD: toAngle, originEntry: this.clean, destTo: to, destEntry: toEntry };
    this.morph.prepare(from, toEntry, { chinese, steps });
    t.steps = this.morph.steps;
    t.total = t.steps + 1;
    this.transit = t;
    this.acc = 0;
    this.clean = null;
    this.video = 0;
    this.dirty = true;
  }

  // the opening sequence: 'Loading ...' morphs into the first poem
  open() {
    this.begin({ axis: "h", to: 5, toEntry: this.entry("h", 5), fromAngle: 90, toAngle: 90, auto: true });
  }

  arrow(dir) { return Math.abs(dir) === 1 ? this.axis === "h" || this.vIdx === 1 : this.axis === "v" || this.hIdx === 5; }

  // fresh: a new press of the button. Sliding onto an arrow with the button already down is not fresh, and after a node
  // has been reached it does nothing until the pointer has left an arrow (the original's reset of 'momentum')
  press(dir, fresh = false) {
    if (!this.arrived || !this.arrow(dir)) return false;
    this.holding = dir;
    if (!this.armed && !fresh) return false;
    this.armed = true;
    const t = this.transit;
    if (!t) this.start(dir);
    else if (t.auto || Math.abs(dir) !== Math.abs(t.dir)) return false;
    else if (dir !== t.dir) this.reverse(dir);
    // a press steps at once, so that a click without a hold is one step; holding goes on stepping every STEP_MS
    this.stepOnce();
    this.acc = 0;
    return true;
  }

  // lifting the button, or leaving the arrow, resets the momentum
  release() { this.holding = 0; this.armed = true; }

  start(dir) {
    const axis = Math.abs(dir) === 1 ? "h" : "v";
    const idx = axis === "h" ? (this.axis === "h" ? this.hIdx : 5) : this.axis === "v" ? this.vIdx : 1;
    const to = wrap16(idx + DELTA[dir]);
    const fromAngle = home(idx);
    this.axis = axis;
    if (axis === "h") this.hIdx = idx; else this.vIdx = idx;
    this.pos(axis, fromAngle);
    const toEntry = { ...this.entry(axis, to) };
    if (axis === "h") toEntry.keys = {};
    this.begin({ axis, to, toEntry, fromAngle, toAngle: fromAngle + (dir > 0 ? -NODE_DEG : NODE_DEG), auto: false, dir });
    return true;
  }

  // The opposite arrow in mid-transition heads for the other end, and it takes exactly as many presses as the distance to it:
  // one step out, one click back; three out, three back. (The morph itself is always a morph of the text as it is now.)
  reverse(dir) {
    const t = this.transit;
    const heading = -t.heading;
    const remaining = heading === 1 ? t.total - t.depth : t.depth;
    const to = heading === 1 ? t.destTo : t.from.idx;
    const toEntry = { ...(heading === 1 ? t.destEntry : t.originEntry) };
    const from = this.current();
    const chinese = from.chinese || toEntry.chinese;
    // remaining - 1 steps of morph, then the press that arrives (a morph of 0 steps arrives at once)
    this.morph.prepare(from, toEntry, { chinese, steps: remaining - 1 });
    Object.assign(t, { heading, dir, to, toEntry, chinese, steps: this.morph.steps });
    this.acc = 0;
    this.dirty = true;
  }

  pos(axis, a) { if (axis === "h") this.pan = a; else this.tilt = a; }

  // where the movie is: the origin's angle plus the destination's, by how far along the transition it is (a part of a step
  // is added while the arrow is held, so that the movie glides between steps)
  glideAngle(t = this.transit) {
    const p = Math.max(0, Math.min(1, (t.depth + t.heading * Math.min(1, this.acc / STEP_MS)) / t.total));
    return t.angleO + (t.angleD - t.angleO) * p;
  }

  // the dot: morph to the node that matches where the movie was dragged to
  jump() {
    if (!this.changed || this.transit || !this.arrived) return false;
    const axis = this.axis;
    const n = nodeAt(this.angle);
    const cur = wrap360(this.angle);
    const toAngle = cur + shortest(cur, home(n));
    this.changed = false;
    this.armed = false;
    if (n === this.idx) {
      this.transit = { axis, to: n, from: { axis, idx: n }, dir: 0, auto: true, fromAngle: cur, toAngle, toEntry: null, glide: true, steps: 14, heading: 1, depth: 0, total: 15, angleO: cur, angleD: toAngle };
      this.morph.step = 1;
      this.morph.steps = 14;
      this.acc = 0;
    } else {
      const toEntry = { ...this.entry(axis, n) };
      if (axis === "h") toEntry.keys = {};
      this.begin({ axis, to: n, toEntry, fromAngle: cur, toAngle, auto: true });
      this.transit.from = { axis, idx: this.idx };
    }
    this.dirty = true;
    return true;
  }

  arrive() {
    const t = this.transit;
    const e = t.toEntry ?? this.current();
    this.axis = t.axis;
    if (t.axis === "h") this.hIdx = t.to; else this.vIdx = t.to;
    this.pos(t.axis, wrap360(home(t.to)));
    this.rows = (() => { const out = [[]]; for (const c of e.bytes) c === 13 ? out.push([]) : out[out.length - 1].push(c); return out.map((r) => Uint8Array.from(r)); })();
    this.chinese = !!e.chinese;
    this.clean = e;
    this.transit = null;
    this.arrived = true;
    this.armed = false; // momentum is reset by leaving the arrow
    this.changed = false;
    this.dirty = true;
  }

  // ---- time ----

  tick(dt) {
    const t = this.transit;
    if (!t) return;
    if (!t.auto && this.holding !== t.dir) return; // stepping continues only while the arrow is held
    this.acc += dt;
    while (this.acc >= STEP_MS && this.transit) {
      this.acc -= STEP_MS;
      this.stepOnce();
    }
    if (this.transit) this.pos(t.axis, this.glideAngle(t));
  }

  // one step of the morph (or, for a glide without text, one tick); the last one arrives at the node
  stepOnce() {
    const t = this.transit;
    if (!t) return;
    t.depth += t.heading;
    if (t.glide) {
      this.morph.step++;
      if (this.morph.step > t.steps) this.arrive();
    } else if (this.morph.done) this.arrive();
    else {
      this.rows = this.morph.advance();
      this.chinese = t.chinese;
    }
    if (this.transit) this.pos(t.axis, this.glideAngle(t));
    this.dirty = true;
  }

  // ---- dragging the movies ----

  activate(axis) {
    if (this.axis === axis) return;
    if (this.transit || !this.arrived) return;
    this.axis = axis;
    this.changed = false;
    this.dirty = true;
  }

  dragEnd(startAngle) {
    if (Math.abs(shortest(startAngle, this.angle)) > 0.01) this.changed = true;
    this.dirty = true;
  }

  canPlayVideo() { return this.axis === "v" && !this.transit && this.arrived && VIDEO_NODES.includes(this.vIdx); }

  // what the little icons in the lower right show
  icons() {
    const shown = this.arrived && !this.transit;
    const t = this.transit;
    const vis = (dir) => (shown ? this.arrow(dir) : !!t && !t.auto ? Math.abs(dir) === Math.abs(t.dir) : false);
    let centre = "none";
    if (this.video) centre = "button";
    else if (shown) centre = this.changed ? "dot" : this.canPlayVideo() ? "button" : "ellipse";
    return { e: vis(EAST), w: vis(WEST), n: vis(NORTH), s: vis(SOUTH), centre, pressed: t ? this.holding : 0 }; // the pressed look lasts only while a transition is under way
  }
}
