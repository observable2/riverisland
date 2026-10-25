// Cylindrical panorama viewer (WebGL2), standing in for the QuickTime VR panorama tracks.
//
// Conventions recovered from the QTVR movies (see tools/extract.py):
//  - a panorama image is a full 360 degree cylinder; its columns run in the direction of *decreasing* pan,
//    so a view centred on pan p shows image column (360 - p) / 360 of the width
//  - rows are linear in tan(tilt) (a true cylinder), the top row being the maximum tilt
//  - the field of view is the vertical field of view of the window

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D tex;
uniform vec2 size;      // drawing buffer, px
uniform float f;        // focal length, px
uniform float pan;      // radians
uniform float tilt;     // radians
uniform vec2 tanRange;  // tan(minTilt), tan(maxTilt)
uniform float lodBias;  // added to the mip level; negative keeps more detail
uniform float sharpen;  // unsharp-mask strength, measured over one display pixel
const float TAU = 6.283185307179586;

// Catmull-Rom bicubic from four bilinear fetches (level 0): sharper than bilinear when the image is magnified or near 1:1
vec4 bicubic(vec2 st, vec2 sz) {
  vec2 pos = st * sz - 0.5;
  vec2 fr = fract(pos);
  vec2 c = floor(pos) + 0.5;
  vec2 w0 = fr * (-0.5 + fr * (1.0 - 0.5 * fr));
  vec2 w1 = 1.0 + fr * fr * (-2.5 + 1.5 * fr);
  vec2 w2 = fr * (0.5 + fr * (2.0 - 1.5 * fr));
  vec2 w3 = fr * fr * (-0.5 + 0.5 * fr);
  vec2 s0 = w0 + w1, s1 = w2 + w3;
  vec2 t0 = (c - 1.0 + w1 / s0) / sz, t1 = (c + 1.0 + w3 / s1) / sz;
  return s0.y * (s0.x * textureLod(tex, vec2(t0.x, t0.y), 0.0) + s1.x * textureLod(tex, vec2(t1.x, t0.y), 0.0))
       + s1.y * (s0.x * textureLod(tex, vec2(t0.x, t1.y), 0.0) + s1.x * textureLod(tex, vec2(t1.x, t1.y), 0.0));
}

void main() {
  vec2 q = (uv - 0.5) * size;
  float y = q.y * cos(tilt) + f * sin(tilt);
  float z = f * cos(tilt) - q.y * sin(tilt);
  float theta = atan(q.x, z);
  float elev = y / length(vec2(q.x, z));
  vec2 st = vec2((theta - pan) / TAU + 1.0, (tanRange.y - elev) / (tanRange.y - tanRange.x));
  if (st.y < 0.0 || st.y > 1.0) { color = vec4(0.0); return; }
  vec2 sz = vec2(textureSize(tex, 0));
  // mip level from the unwrapped coordinate, so there is no seam at the wrap-around
  float rho = max(length(dFdx(st * sz)), length(dFdy(st * sz)));
  float lod = log2(max(rho, 1e-6)) + lodBias;
  vec2 w = vec2(fract(st.x), st.y);
  vec4 c = lod <= 0.0 ? bicubic(w, sz) : textureLod(tex, w, lod);
  if (sharpen > 0.0) {
    // unsharp mask against the four neighbours one display pixel away (derivatives are seam-free)
    vec2 dx = dFdx(st), dy = dFdy(st);
    float l = max(lod, 0.0);
    vec4 blur = 0.25 * (textureLod(tex, w + dx, l) + textureLod(tex, w - dx, l) + textureLod(tex, w + dy, l) + textureLod(tex, w - dy, l));
    c = clamp(c + sharpen * (c - blur), 0.0, 1.0);
  }
  color = c;
}`;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const wrap = (d) => ((d % 360) + 360) % 360;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class Panorama {
  constructor(canvas, { cssWidth, cssHeight, lodBias = 0, sharpen = 0, dpr = Math.min(2, window.devicePixelRatio || 1) }) {
    this.lodBias = lodBias;
    this.sharpen = sharpen;
    this.canvas = canvas;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const gl = (this.gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false }));
    if (!gl) throw new Error("WebGL2 is not available");
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.u = Object.fromEntries(["tex", "size", "f", "pan", "tilt", "tanRange", "lodBias", "sharpen"].map((n) => [n, gl.getUniformLocation(prog, n)]));
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, canvas.width, canvas.height);
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.textures = new Map(); // url -> texture
    this.meta = null;
    this.tex = null;
    this.pan = 0;
    this.tilt = 0;
    this.fov = 30;
    this.dirty = true;
  }

  // Load `url` into a texture (cached) without showing it yet.
  async load(url) {
    const gl = this.gl;
    let tex = this.textures.get(url);
    if (tex) return tex;
    const img = new Image();
    img.src = url;
    await img.decode();
    let source = img;
    if (img.width > this.maxTexture) {
      const c = document.createElement("canvas");
      c.width = this.maxTexture;
      c.height = Math.round((img.height * this.maxTexture) / img.width);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      source = c;
    }
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(url, tex);
    while (this.textures.size > 4) {
      const [oldUrl, oldTex] = this.textures.entries().next().value;
      if (oldTex !== this.tex) gl.deleteTexture(oldTex);
      this.textures.delete(oldUrl);
    }
    return tex;
  }

  // Show a panorama described by its meta (see nbks/data/panos.json), loading `url` if needed.
  async show(meta, url) {
    this.tex = await this.load(url);
    this.meta = meta;
    this.pan = meta.def.pan;
    this.tilt = meta.def.tilt;
    this.fov = meta.def.fov;
    this.dirty = true;
  }

  // Backing-store pixels per logical pixel (the stage is scaled to fit the window).
  resize(k) {
    this.canvas.width = Math.round(this.cssWidth * k);
    this.canvas.height = Math.round(this.cssHeight * k);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.dirty = true;
  }

  setPan(pan) {
    this.pan = wrap(pan);
    this.dirty = true;
  }

  // tilt limits that keep the image filling the window, as QuickTime VR constrains them
  tiltLimits() {
    const { tilt, def } = this.meta;
    const lo = tilt[0] + this.fov / 2;
    const hi = tilt[1] - this.fov / 2;
    return lo <= hi ? [Math.min(lo, def.tilt), Math.max(hi, def.tilt)] : [def.tilt, def.tilt];
  }

  // Drag the scene: the content follows the pointer.
  drag(dx, dy) {
    if (!this.meta) return;
    const f = this.cssHeight / 2 / Math.tan(rad(this.fov) / 2);
    this.pan = wrap(this.pan + deg(dx / f));
    const [lo, hi] = this.tiltLimits();
    this.tilt = Math.min(hi, Math.max(lo, this.tilt + deg(dy / f)));
    this.dirty = true;
  }

  render() {
    if (!this.dirty || !this.tex) return;
    const { gl, canvas, u, meta } = this;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(u.tex, 0);
    gl.uniform2f(u.size, canvas.width, canvas.height);
    gl.uniform1f(u.f, (canvas.height / 2) / Math.tan(rad(this.fov) / 2));
    gl.uniform1f(u.pan, rad(this.pan));
    gl.uniform1f(u.tilt, rad(this.tilt));
    gl.uniform2f(u.tanRange, Math.tan(rad(meta.tilt[0])), Math.tan(rad(meta.tilt[1])));
    gl.uniform1f(u.lodBias, this.lodBias);
    gl.uniform1f(u.sharpen, this.sharpen);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.dirty = false;
  }
}
