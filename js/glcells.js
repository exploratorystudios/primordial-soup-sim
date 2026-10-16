// Cells drawn on the GPU (WebGL2) when they are small on screen: one instanced draw for every cell's disk,
// nucleus, wall ring and membrane outline, and one for the flagella, instead of thousands of 2D canvas calls.
// It draws exactly what Renderer.drawCell draws at these sizes, into its own canvas, which the renderer then
// copies onto the main one in the cells' place. Close up (cell interiors, membranes, walls in detail) the
// renderer draws as before.

const VS = `#version 300 es
in vec2 corner;
in vec4 a0; in vec4 a1; in vec4 a2; in vec3 a3;
uniform vec2 screen;
out vec2 local; flat out vec4 v0; flat out vec4 v1; flat out vec4 v2; flat out vec3 v3;
void main() {
  // a0: centre x, y (device px), radius, half-size of the quad; a1: fill rgb, alpha;
  // a2: nucleus (0/1), wall ring radius, wall width, outline width; a3: outline alpha, square (0/1), fade
  local = corner * a0.w;
  vec2 p = a0.xy + local;
  gl_Position = vec4(p.x / screen.x * 2.0 - 1.0, 1.0 - p.y / screen.y * 2.0, 0.0, 1.0);
  v0 = a0; v1 = a1; v2 = a2; v3 = a3;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 local; flat in vec4 v0; flat in vec4 v1; flat in vec4 v2; flat in vec3 v3;
out vec4 o;
vec4 over(vec4 s, vec4 d) { return s + d * (1.0 - s.a); }
void main() {
  float r = v0.z;
  if (v3.y > 0.5) { // tiny cell: a two-pixel square
    if (max(abs(local.x), abs(local.y)) > r) discard;
    o = vec4(v1.rgb * v1.a, v1.a) * v3.z;
    return;
  }
  float d = length(local);
  vec4 c = vec4(v1.rgb, 1.0) * v1.a * clamp(r - d + 0.5, 0.0, 1.0);
  if (v2.x > 0.5) { float m = 0.75 * clamp(0.34 * r - d + 0.5, 0.0, 1.0); c = over(vec4(30.0, 20.0, 60.0, 255.0) / 255.0 * m, c); }
  if (v2.z > 0.0) { float m = 0.85 * clamp(v2.z * 0.5 - abs(d - v2.y) + 0.5, 0.0, 1.0); c = over(vec4(205.0, 165.0, 105.0, 255.0) / 255.0 * m, c); }
  if (v2.w > 0.0) { float m = v3.x * clamp(v2.w * 0.5 - abs(d - r) + 0.5, 0.0, 1.0); c = over(vec4(m), c); }
  if (c.a <= 0.0) discard;
  o = c * v3.z; // (a newborn fades in)
}`;

const LVS = `#version 300 es
in vec2 pos; in float alpha;
uniform vec2 screen;
out float a;
void main() { gl_Position = vec4(pos.x / screen.x * 2.0 - 1.0, 1.0 - pos.y / screen.y * 2.0, 0.0, 1.0); a = alpha; }`;
const LFS = `#version 300 es
precision highp float;
in float a; out vec4 o;
void main() { o = vec4(220.0, 235.0, 255.0, 255.0) / 255.0 * a; }`;

const PER = 15; // floats per cell instance

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export class GLCells {
  // Returns null where WebGL2 isn't available (the renderer then draws cells as before).
  static create() {
    try { return new GLCells(); } catch { return null; }
  }

  constructor() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('no WebGL2');
    this.canvas = canvas; this.gl = gl;
    this.cellProg = compile(gl, VS, FS);
    this.lineProg = compile(gl, LVS, LFS);
    this.inst = new Float32Array(PER * 4096);
    this.lines = new Float32Array(3 * 8192);
    // Cells: a unit quad, instanced.
    this.cellVao = gl.createVertexArray();
    gl.bindVertexArray(this.cellVao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const lc = gl.getAttribLocation(this.cellProg, 'corner');
    gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const sizes = [['a0', 4, 0], ['a1', 4, 4], ['a2', 4, 8], ['a3', 3, 12]];
    for (const [name, n, off] of sizes) {
      const l = gl.getAttribLocation(this.cellProg, name);
      gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, n, gl.FLOAT, false, PER * 4, off * 4); gl.vertexAttribDivisor(l, 1);
    }
    // Flagella: line segments.
    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    this.lineBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    const lp = gl.getAttribLocation(this.lineProg, 'pos'), la = gl.getAttribLocation(this.lineProg, 'alpha');
    gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(la); gl.vertexAttribPointer(la, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);
    this.uScreen = gl.getUniformLocation(this.cellProg, 'screen');
    this.uLScreen = gl.getUniformLocation(this.lineProg, 'screen');
    this.n = 0; this.nl = 0;
  }

  begin(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.n = 0; this.nl = 0;
  }

  // One cell (device-pixel units).
  cell(x, y, r, ext, R, G, B, A, nucleus, wallR, wallW, lineW, lineA, square, fade) {
    if ((this.n + 1) * PER > this.inst.length) { const b = new Float32Array(this.inst.length * 2); b.set(this.inst); this.inst = b; }
    const a = this.inst, o = this.n++ * PER;
    a[o] = x; a[o + 1] = y; a[o + 2] = r; a[o + 3] = ext;
    a[o + 4] = R; a[o + 5] = G; a[o + 6] = B; a[o + 7] = A;
    a[o + 8] = nucleus; a[o + 9] = wallR; a[o + 10] = wallW; a[o + 11] = lineW;
    a[o + 12] = lineA; a[o + 13] = square; a[o + 14] = fade;
  }

  // One flagellum segment (device pixels).
  segment(x1, y1, x2, y2, alpha) {
    if ((this.nl + 2) * 3 > this.lines.length) { const b = new Float32Array(this.lines.length * 2); b.set(this.lines); this.lines = b; }
    const l = this.lines, o = this.nl * 3;
    l[o] = x1; l[o + 1] = y1; l[o + 2] = alpha; l[o + 3] = x2; l[o + 4] = y2; l[o + 5] = alpha;
    this.nl += 2;
  }

  // Draw what was added since begin(); the result is in this.canvas.
  end() {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (this.nl) { // flagella under the cells, as in the 2D drawing
      gl.useProgram(this.lineProg); gl.uniform2f(this.uLScreen, W, H);
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.lines.subarray(0, this.nl * 3), gl.STREAM_DRAW);
      gl.drawArrays(gl.LINES, 0, this.nl);
    }
    if (this.n) {
      gl.useProgram(this.cellProg); gl.uniform2f(this.uScreen, W, H);
      gl.bindVertexArray(this.cellVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.inst.subarray(0, this.n * PER), gl.STREAM_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    }
    gl.bindVertexArray(null);
  }
}
