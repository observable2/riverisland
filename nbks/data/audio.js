// The 'spatialized aural environment': a port of the PanoSound-style sprites in periplus.mov and paths.mov, with one change.
//
// Sixteen readings sit around each movie, one every 22.5 degrees (one for each node). In the original a reading is audible
// within 33.75 degrees of the view, which is wider than the distance between nodes, so that at a node one also hears the two
// next to it. Here a reading is audible only within 22.5 degrees, the distance to the next node: at a node you hear that
// node's reading alone, and between two nodes only those two, one fading as the other rises, in proportion to the distance
// (their volumes add up to the same all the way). The volume at a node is the original's 230/256 and the reading swings from
// side to side as the view passes it, by the original's amount scaled to the new range.
// A reading is started when the view is within 30 degrees of it (just before it becomes audible), and when it ends it starts
// again after a random pause of up to 1.5 s (the original's pause). Only the movie that is active is heard.
// Underneath there is the ambient loop of riAtmos.mov.

export const NODE_DEG = 22.5;
export const AUDIBLE = NODE_DEG; // was 67.5 / 2 in the original
export const AWAKE = 30; // was 80 in the original
export const MAX_VOLUME = 230 / 256;
export const MAX_BALANCE = 128 / 256;

// How reading k (of 16) sounds when the view is at `angle`: { volume 0..MAX_VOLUME, balance -MAX_BALANCE..MAX_BALANCE
// (positive = right), awake }
export function level(angle, k) {
  const x = (((angle - k * NODE_DEG) % 360) + 360) % 360; // 0..360, 0 = straight ahead
  const dist = x < 180 ? x : 360 - x;
  const side = x < 180 ? 1 : -1;
  return {
    volume: MAX_VOLUME * Math.max(0, 1 - dist / AUDIBLE),
    balance: side * MAX_BALANCE * Math.min(1, dist / AUDIBLE),
    awake: dist <= AWAKE,
  };
}

export class Spatial {
  constructor({ h, v, atmos }) {
    this.urls = { h, v };
    this.atmosUrl = atmos;
    this.ctx = null;
    this.sounds = { h: [], v: [] };
    this.active = "h";
  }

  // browsers allow sound only after a gesture; this is called from the first click
  start() {
    if (this.ctx) return this.ctx.resume();
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const a = new Audio(this.atmosUrl);
    a.loop = true;
    ctx.createMediaElementSource(a).connect(this.master);
    a.play().catch(() => {});
    this.atmos = a;
    return ctx.resume();
  }

  get started() { return !!this.ctx; }

  setMuted(m) { if (this.master) this.master.gain.value = m ? 0 : 1; }

  sound(axis, k) {
    let s = this.sounds[axis][k];
    if (s) return s;
    const el = new Audio(this.urls[axis][k]);
    el.preload = "auto";
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    const pan = this.ctx.createStereoPanner();
    this.ctx.createMediaElementSource(el).connect(gain).connect(pan).connect(this.master);
    s = this.sounds[axis][k] = { el, gain, pan, playing: false, wait: 0 };
    el.addEventListener("ended", () => { s.playing = false; s.wait = performance.now() + Math.random() * 1500; });
    return s;
  }

  // called every frame with the active movie and the angle it is looking at (pan, or (tilt + 90) x 2)
  update(axis, angle, now = performance.now()) {
    if (!this.ctx) return;
    this.active = axis;
    for (const ax of ["h", "v"]) {
      for (let k = 0; k < 16; k++) {
        const s = ax === axis ? this.sound(ax, k) : this.sounds[ax][k];
        if (!s) continue;
        const { volume, balance, awake } = level(angle, k);
        if (ax !== axis || !awake) {
          if (s.playing) { s.el.pause(); s.el.currentTime = 0; s.playing = false; }
          s.gain.gain.value = 0;
          continue;
        }
        if (!s.playing && now >= s.wait) {
          s.playing = true;
          s.el.currentTime = 0;
          s.el.play().catch(() => { s.playing = false; });
        }
        s.gain.gain.value = volume;
        s.pan.pan.value = balance;
      }
    }
  }
}
