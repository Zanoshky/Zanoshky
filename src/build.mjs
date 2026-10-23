// Draws every picture on the profile as an SVG on one character grid, the way
// Phosphor draws a home screen. Run: node src/build.mjs (needs python3 with
// fonttools and brotli, or FONTTOOLS_PYTHON pointing at one).
//
// GitHub strips scripts and styles from the README, but an SVG shown through
// <img> keeps its own CSS animations. So all motion here is CSS keyframes,
// every font glyph is embedded as a subset, and every final state is also the
// resting state, so reduced motion simply shows the finished screen.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const OUT = join(SRC, "..", "assets");

/* ------------------------------------------------------------ palette */

// The phosphor theme from Phosphor's Theme.kt: one hue at a few intensities.
const C = {
  bg: "#000000",
  faint: "#0a1a3a",
  shade: "#14306a",
  dim: "#3a5f9e",
  fg: "#9dbeff",
  acc: "#0068ff",
  acct: "#4d94ff",
  br: "#e8f1ff",
  white: "#ffffff",
};

const RAIN = "01<>/\\|=+*:.{}[]#$%&";
const NOISE = "░▒▓<>/\\|=+*#%&$@01{}[]";

function hash(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, -2048144777)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) & 0x7fffffff;
}

const f1 = (n) => +n.toFixed(1);
const f2 = (n) => +n.toFixed(2);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ------------------------------------------------------------ svg builder */

class Svg {
  constructor(w, h, { fs = 14, title = "" } = {}) {
    this.w = w;
    this.h = h;
    this.fs = fs;
    this.cw = fs * 0.6;
    this.ch = f2(fs * 1.21);
    this.title = title;
    this.defs = [];
    this.css = [];
    this.body = [];
    this.chars = new Set();
    this.uid = 0;
  }
  id(p) {
    return `${p}${this.uid++}`;
  }
  add(s) {
    this.body.push(s);
    return this;
  }
  // Text at a pixel position. y is the top of the cell, not the baseline.
  text(x, y, str, fill, o = {}) {
    for (const c of str) this.chars.add(c);
    const fs = o.fs || this.fs;
    const by = y + fs * 1.21 * 0.74;
    const a = [`x="${f1(x)}"`, `y="${f1(by)}"`];
    if (fill) a.push(`fill="${fill}"`);
    if (o.bold) a.push(`font-weight="700"`);
    if (o.fs) a.push(`font-size="${o.fs}"`);
    if (o.anchor) a.push(`text-anchor="${o.anchor}"`);
    if (o.cls) a.push(`class="${o.cls}"`);
    if (o.style) a.push(`style="${o.style}"`);
    if (o.op != null) a.push(`opacity="${o.op}"`);
    return `<text ${a.join(" ")}>${esc(str)}</text>`;
  }
  font() {
    return subsetFont([...this.chars].join(""));
  }
  toString() {
    const font = this.font();
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}" xml:space="preserve" role="img"${
      this.title ? ` aria-label="${esc(this.title)}"` : ""
    }>${this.title ? `<title>${esc(this.title)}</title>` : ""}<style>@font-face{font-family:J;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:400 800}text{font-family:J,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:${this.fs}px;white-space:pre}${BASE_CSS}${this.css.join("")}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style><defs>${this.defs.join("")}</defs>${this.body.join("")}</svg>`;
  }
}

// Shared motion. Every element's static style is its finished look, so a
// viewer that turns motion off sees the screen as it ends.
const BASE_CSS = [
  // the tube flickers a little, never enough to read as broken
  "@keyframes flk{0%,100%{opacity:1}7%{opacity:.965}8%{opacity:1}41%{opacity:.975}42%{opacity:1}43%{opacity:.955}44%{opacity:1}77%{opacity:.97}78%{opacity:1}}",
  ".flk{animation:flk 6.5s steps(1,end) infinite}",
  // a soft band of light rolls down the glass
  "@keyframes band{0%{transform:translateY(-120px)}100%{transform:translateY(var(--bh,600px))}}",
  ".band{animation:band 7s linear infinite}",
  "@keyframes blink{0%,49.9%{opacity:1}50%,100%{opacity:0}}",
  ".cur{animation:blink 1.06s steps(1,end) infinite}",
  "@keyframes fall{0%{transform:translateY(var(--a))}100%{transform:translateY(var(--b))}}",
  ".rn{animation:fall var(--d) linear infinite}",
  "@keyframes tw{0%,100%{opacity:.15}50%{opacity:1}}",
  ".tw{animation:tw var(--d,3s) ease-in-out infinite}",
  "@keyframes sheen{0%{transform:translateX(var(--a))}22%,100%{transform:translateX(var(--b))}}",
  ".sheen{animation:sheen var(--d,8s) cubic-bezier(.4,0,.2,1) infinite}",
  "@keyframes drift{0%{transform:translateX(var(--a))}100%{transform:translateX(var(--b))}}",
  ".drift{animation:drift var(--d) linear infinite}",
  "@keyframes shoot{0%{transform:translate(0,0);opacity:0}2%{opacity:1}9%{transform:translate(var(--x),var(--y));opacity:0}100%{transform:translate(var(--x),var(--y));opacity:0}}",
  ".shoot{animation:shoot var(--d,11s) linear infinite}",
].join("");

/* ------------------------------------------------------------ font subset */

const FONT = join(SRC, "font", "jetbrains-mono-sub.woff2");
const PY = process.env.FONTTOOLS_PYTHON || "python3";
const fontCache = new Map();

function subsetFont(chars) {
  const key = [...new Set(chars + " ")].sort().join("");
  if (fontCache.has(key)) return fontCache.get(key);
  const dir = mkdtempSync(join(tmpdir(), "font-"));
  const out = join(dir, "s.woff2");
  execFileSync(PY, [
    "-m", "fontTools.subset", FONT, `--text=${key}`, `--output-file=${out}`,
    "--flavor=woff2", "--layout-features=", "--no-hinting", "--desubroutinize",
  ]);
  const b64 = readFileSync(out).toString("base64");
  rmSync(dir, { recursive: true, force: true });
  fontCache.set(key, b64);
  return b64;
}

/* ------------------------------------------------------------ png icons */

// A small PNG reader, enough for the 8 bit RGB and RGBA store icons.
function readPng(file) {
  const b = readFileSync(file);
  let p = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), t = b.toString("ascii", p + 4, p + 8);
    const d = b.subarray(p + 8, p + 8 + len);
    if (t === "IHDR") {
      w = d.readUInt32BE(0); h = d.readUInt32BE(4); type = d[9];
      if (d[8] !== 8 || d[12] !== 0 || (type !== 2 && type !== 6)) throw new Error(`${file}: unsupported png`);
    } else if (t === "IDAT") idat.push(d);
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let r;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + up;
      else if (f === 3) r = v + ((a + up) >> 1);
      else {
        const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      }
      px[y * stride + x] = r & 255;
    }
  }
  const rgba = (x, y) => {
    const i = y * stride + x * bpp;
    return [px[i], px[i + 1], px[i + 2], bpp === 4 ? px[i + 3] : 255];
  };
  return { w, h, rgba };
}

// The real app icon, shrunk to n by n and redrawn in phosphor intensities.
// Brightness picks the ink, so the shape survives and the colour does not.
const RAMP = [null, C.faint, C.shade, C.dim, C.acc, C.acct, C.fg, C.br, C.white];
function iconMosaic(file, n) {
  const img = readPng(file);
  const s = img.w / n, cells = [];
  for (let gy = 0; gy < n; gy++) {
    const row = [];
    for (let gx = 0; gx < n; gx++) {
      let r = 0, g = 0, bl = 0, a = 0, k = 0;
      for (let y = Math.floor(gy * s); y < Math.floor((gy + 1) * s); y++)
        for (let x = Math.floor(gx * s); x < Math.floor((gx + 1) * s); x++) {
          const [pr, pg, pb, pa] = img.rgba(x, y);
          r += pr * pa; g += pg * pa; bl += pb * pa; a += pa; k++;
        }
      const al = a / k / 255;
      if (al < 0.45) { row.push(0); continue; }
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * bl) / a / 255;
      const L = 0.45 * lum + 0.55 * Math.max(r, g, bl) / a / 255;
      const lv = L < 0.035 ? 0 : L < 0.1 ? 1 : L < 0.2 ? 2 : L < 0.3 ? 3 : L < 0.42 ? 4 : L < 0.55 ? 5 : L < 0.7 ? 6 : L < 0.86 ? 7 : 8;
      row.push(lv);
    }
    cells.push(row);
  }
  return cells;
}

// Hand drawn marks for the two things with no app icon.
function patMosaic(rows) {
  const map = { ".": 0, f: 1, s: 2, d: 3, a: 4, t: 5, g: 6, b: 7, w: 8 };
  return rows.map((r) => [...r].map((c) => map[c]));
}

const ZELL_ICON = patMosaic([
  "....................",
  ".ssssssssssssssssss.",
  ".sffffffffffffffffs.",
  ".sffffffffffffffffs.",
  ".sffffffffffffffffs.",
  ".sffwwffffffffffffs.",
  ".sfffbbfffffffffffs.",
  ".sffffttffffffffffs.",
  ".sfffffaafffffffffs.",
  ".sffffttffffffffffs.",
  ".sfffbbfffffffffffs.",
  ".sffwwffffffffffffs.",
  ".sffffffffffffffffs.",
  ".sffffffffggggggffs.",
  ".sffffffffggggggffs.",
  ".sffffffffffffffffs.",
  ".sffffffffffffffffs.",
  ".ssssssssssssssssss.",
  "....................",
  "....................",
]);

function diamond(n) {
  const rows = [], c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    const row = [];
    for (let x = 0; x < n; x++) {
      const d = Math.abs(x - c) + Math.abs(y - c);
      if (d > c + 0.01) { row.push(0); continue; }
      const t = y / (n - 1);
      row.push(t < 0.12 ? 8 : t < 0.3 ? 7 : t < 0.46 ? 6 : t < 0.6 ? 5 : t < 0.75 ? 4 : 3);
    }
    rows.push(row);
  }
  return rows;
}

function mosaicSvg(cells, x, y, px) {
  const byCol = new Map();
  cells.forEach((row, gy) => {
    // merge runs of the same ink into one rect
    let gx = 0;
    while (gx < row.length) {
      const v = row[gx];
      let e = gx;
      while (e + 1 < row.length && row[e + 1] === v) e++;
      if (v) {
        const k = RAMP[v];
        if (!byCol.has(k)) byCol.set(k, []);
        byCol.get(k).push(`M${f1(x + gx * px)} ${f1(y + gy * px)}h${f1((e - gx + 1) * px)}v${f1(px)}h${f1(-(e - gx + 1) * px)}z`);
      }
      gx = e + 1;
    }
  });
  return [...byCol].map(([col, d]) => `<path fill="${col}" d="${d.join("")}"/>`).join("");
}

/* ------------------------------------------------------------ shared pieces */

// The glass: true black, one blue light above it, scanlines and a vignette.
function screen(s, { r = 14, frame = true } = {}) {
  const { w, h } = s;
  s.defs.push(
    `<linearGradient id="lit" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.acc}" stop-opacity=".16"/><stop offset=".45" stop-color="${C.acc}" stop-opacity=".03"/><stop offset="1" stop-color="${C.acc}" stop-opacity="0"/></linearGradient>`,
    `<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.acct}"/><stop offset=".12" stop-color="${C.acc}" stop-opacity=".7"/><stop offset=".5" stop-color="${C.shade}"/><stop offset="1" stop-color="${C.faint}"/></linearGradient>`,
    `<radialGradient id="vig" cx=".5" cy=".42" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></radialGradient>`,
    `<pattern id="scan" width="4" height="3" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" opacity=".42"/></pattern>`,
    `<linearGradient id="bandg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.br}" stop-opacity="0"/><stop offset=".5" stop-color="${C.br}" stop-opacity=".045"/><stop offset="1" stop-color="${C.br}" stop-opacity="0"/></linearGradient>`,
    `<clipPath id="glass"><rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${r - 1}"/></clipPath>`,
  );
  s.add(`<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="${r}" fill="#000"/>`);
  s.add(`<rect x="1" y="1" width="${w - 2}" height="${Math.min(h - 2, 260)}" rx="${r - 1}" fill="url(#lit)"/>`);
  s.add(`<g clip-path="url(#glass)"><g class="flk">`);
  return () => {
    s.add(`</g>`);
    s.add(`<rect class="band" style="--bh:${h + 40}px" x="0" y="0" width="${w}" height="120" fill="url(#bandg)"/>`);
    s.add(`<rect width="${w}" height="${h}" fill="url(#scan)"/>`);
    s.add(`<rect width="${w}" height="${h}" fill="url(#vig)"/>`);
    s.add(`</g>`);
    if (frame) {
      s.add(`<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="${r}" fill="none" stroke="url(#rim)"/>`);
      s.add(`<path d="M${r + 6} .7H${w - r - 6}" stroke="${C.br}" stroke-opacity=".5" stroke-width=".8"/>`);
    }
  };
}

// A Phosphor panel: a rounded box with its label set into the top border.
function panel(s, x, y, w, h, label, tag, { bottom } = {}) {
  const g = s.id("pg");
  s.defs.push(
    `<linearGradient id="${g}" gradientUnits="userSpaceOnUse" x1="0" y1="${y}" x2="0" y2="${y + h}"><stop offset="0" stop-color="${C.acc}"/><stop offset=".25" stop-color="${C.shade}"/><stop offset="1" stop-color="#0d214a"/></linearGradient>`,
  );
  const out = [];
  out.push(`<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}" rx="7" fill="#000" stroke="url(#${g})" stroke-width="1.2"/>`);
  out.push(`<rect x="${f1(x + 1)}" y="${f1(y + 1)}" width="${f1(w - 2)}" height="${f1(Math.min(60, h - 2))}" rx="6" fill="url(#lit)" opacity=".8"/>`);
  const cw = s.cw;
  if (label) {
    const lw = label.length * cw + 12;
    out.push(`<rect x="${f1(x + 12)}" y="${f1(y - 3)}" width="${f1(lw)}" height="6" fill="#000"/>`);
    out.push(s.text(x + 18, y - s.ch / 2, label, C.acct, { bold: true }));
  }
  if (tag) {
    const tw = tag.length * cw + 12;
    out.push(`<rect x="${f1(x + w - 12 - tw)}" y="${f1(y - 3)}" width="${f1(tw)}" height="6" fill="#000"/>`);
    out.push(s.text(x + w - 18 - tag.length * cw, y - s.ch / 2, tag, C.fg));
  }
  if (bottom) {
    const tw = bottom.length * cw + 12;
    out.push(`<rect x="${f1(x + w - 12 - tw)}" y="${f1(y + h - 3)}" width="${f1(tw)}" height="6" fill="#000"/>`);
    out.push(s.text(x + w - 18 - bottom.length * cw, y + h - s.ch / 2, bottom, C.dim));
  }
  return out.join("");
}

// Dim character rain, falling through the whole screen behind everything.
function rain(s, { density = 0.45, seed = 1, x0 = 0, cols, mask } = {}) {
  const { cw, ch, h } = s;
  const n = cols ?? Math.floor(s.w / cw);
  const out = [];
  for (let c = 0; c < n; c++) {
    if (hash(c, 7, seed) % 100 > density * 100) continue;
    const len = 6 + (hash(c, 0, 3 + seed) % 14);
    const x = x0 + c * cw;
    const d = f1(3.2 + (hash(c, 1, seed) % 60) / 10);
    const delay = f1(-(hash(c, 2, seed) % 100) / 100 * d);
    const tsp = [];
    for (let k = 0; k <= len; k++) {
      const ch2 = RAIN[hash(c, k, seed + 9) % RAIN.length];
      const a = k === 0 ? 0.62 : (1 - k / len) * 0.3;
      const col = k === 0 ? C.br : C.acc;
      tsp.push(`<tspan x="${f1(x)}" y="${f1(-k * ch)}" fill="${col}" fill-opacity="${f2(a)}">${esc(ch2)}</tspan>`);
      s.chars.add(ch2);
    }
    out.push(`<text class="rn" style="--a:-20px;--b:${f1(h + len * ch + 20)}px;--d:${d}s;animation-delay:${delay}s">${tsp.join("")}</text>`);
  }
  return `<g${mask ? ` mask="url(#${mask})"` : ""}>${out.join("")}</g>`;
}

// Braille dots, drawn as round capped zero length strokes: two across and four
// down per cell, the way Phosphor's Dots paints them.
class Dots {
  constructor(s, x0, y0, cols, rows) {
    Object.assign(this, { s, x0, y0, cols, rows });
    this.w = cols * 2;
    this.h = rows * 4;
    this.map = new Map();
  }
  set(x, y, col, layer = "base") {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const key = `${layer}|${col}`;
    if (!this.map.has(key)) this.map.set(key, new Map());
    this.map.get(key).set(`${x},${y}`, [x, y]);
  }
  pos(x, y) {
    const { cw, ch } = this.s;
    const cx = Math.floor(x / 2), side = x % 2, cy = Math.floor(y / 4), row = y % 4;
    return [this.x0 + cw * (cx + 0.3 + 0.4 * side), this.y0 + ch * (cy + 0.17 + 0.22 * row)];
  }
  path(layer, col, attrs = "") {
    const m = this.map.get(`${layer}|${col}`);
    if (!m) return "";
    const r = Math.min(this.s.cw * 0.15, this.s.ch * 0.075);
    const d = [...m.values()].map(([x, y]) => { const [px, py] = this.pos(x, y); return `M${f1(px)} ${f1(py)}h0`; }).join("");
    return `<path d="${d}" stroke="${col}" stroke-width="${f2(r * 2)}" stroke-linecap="round" fill="none"${attrs}/>`;
  }
  layer(name, attrs = "") {
    return [...this.map.keys()].filter((k) => k.startsWith(name + "|")).map((k) => this.path(name, k.split("|")[1], attrs)).join("");
  }
}

// The night sky from Phosphor's weather panel: stars, a moon, drifting clouds,
// two ranges of hills with pines, and now and then a shooting star.
function sky(s, x0, y0, cols, rows, { seed = 3, moonAt = 0.8 } = {}) {
  const d = new Dots(s, x0, y0, cols, rows);
  const W = d.w, H = d.h;
  const far = [], near = [];
  for (let x = 0; x < W; x++) {
    far.push(Math.floor(H * 0.62 - 3.2 * (Math.sin(0.075 * x + 1.3 + seed) + 0.6 * Math.sin(0.19 * x + 0.4))));
    near.push(Math.floor(H * 0.82 - 2.4 * (Math.sin(0.11 * x + 4 + seed) + 0.5 * Math.sin(0.27 * x + 1))));
  }
  // stars, some of them twinkling
  const nStars = Math.floor((W * H) / 30);
  for (let i = 0; i < nStars; i++) {
    const x = hash(i, 11, seed) % W, y = hash(i, 12, seed) % Math.max(1, far[x] - 3);
    const tw = hash(i, 13, seed) % 5;
    d.set(x, y, hash(i, 14, seed) % 6 === 0 ? C.br : C.dim, `star${tw}`);
  }
  // moon, a crescent lit from the right
  const mx = Math.floor(W * moonAt), my = Math.floor(H * 0.26);
  for (let y = -5; y <= 5; y++)
    for (let x = -5; x <= 5; x++) {
      const u = x / 4.8, v = y / 4.8;
      if (u * u + v * v > 1) continue;
      const lit = (u - 0.42) ** 2 + (v + 0.12) ** 2 > 0.78 ** 2;
      const crater = lit && hash(x + 9, y + 9, 77) % 9 === 0;
      if (lit && !crater) d.set(mx + x, my + y, C.br, "moon");
      else if (!lit && (x + y) % 2 === 0) d.set(mx + x, my + y, C.shade, "moon");
    }
  // hills, far ridge then near ridge with pines
  for (let x = 0; x < W; x++) {
    d.set(x, far[x], C.dim, "hill");
    for (let y = far[x] + 2; y < H; y++) if ((x + y) % 2 === 0 && (y % 2 === 0 || y - far[x] < 4)) d.set(x, y, C.faint, "hill");
  }
  for (const t of [0.07, 0.12, 0.44, 0.49, 0.56, 0.93]) {
    const x = Math.floor(W * t), base = near[x], hh = Math.min(Math.floor(H * 0.4), 8 + (hash(x, 4, 4) % 6));
    for (let k = 0; k < hh; k++) {
      const half = Math.floor(((k % 4) + Math.floor(k / 2)) / 2);
      for (let dx = -half; dx <= half; dx++) d.set(x + dx, base - hh + k, dx === -half || dx === half ? C.fg : C.dim, "near");
    }
    d.set(x, base, C.fg, "near"); d.set(x, base + 1, C.fg, "near");
  }
  for (let x = 0; x < W; x++) {
    d.set(x, near[x], C.fg, "near");
    for (let y = near[x] + 1; y < H; y++) {
      const on = y - near[x] < 3 ? (x + y) % 2 === 0 : (x + y) % 3 === 0 && x % 2 === 0;
      if (on) d.set(x, y, C.dim, "near");
    }
  }
  const out = [];
  // a black cut under the near hills so the far dither ends at the ridge
  const ridge = (arr) => {
    const pts = arr.map((y, x) => d.pos(x, y));
    return `M${f1(d.x0)} ${f1(d.y0 + rows * s.ch)}` + pts.map(([px, py]) => `L${f1(px)} ${f1(py - 1.5)}`).join("") + `L${f1(d.x0 + cols * s.cw)} ${f1(d.y0 + rows * s.ch)}Z`;
  };
  for (let k = 0; k < 5; k++) out.push(d.layer(`star${k}`, ` class="tw" style="--d:${2.2 + k * 0.9}s;animation-delay:-${k * 0.7}s"`));
  out.push(d.layer("moon"));
  // clouds drift with the wind, in front of the stars and behind the hills
  for (let i = 0; i < 2; i++) {
    const sc = 0.7 + (hash(i, 21, seed) % 40) / 100;
    const cd = new Dots(s, x0, y0, cols, rows);
    const cwid = Math.floor(21 * sc), chh = Math.floor(9 * sc);
    const cy = 2 + (hash(i, 23, seed) % Math.max(1, Math.floor(H * 0.25))) + chh;
    const blobs = [[3, 2, 3], [8, 0, 4.2], [13.5, 1.5, 3.4], [17, 3, 2.4]];
    const inC = (u, v) => v <= 5 && blobs.some(([bx, by, br]) => (u - bx) ** 2 + (v - by) ** 2 <= br * br);
    for (let v = -chh; v <= chh; v++)
      for (let u = -2; u <= cwid; u++) {
        const uu = u / sc, vv = v / sc, c = 1 / sc;
        if (!inC(uu, vv)) continue;
        const edge = !(inC(uu - c, vv) && inC(uu + c, vv) && inC(uu, vv - c) && inC(uu, vv + c));
        const col = edge && !inC(uu, vv - c) ? C.fg : edge ? C.dim : vv > 2.5 ? ((u + v) % 2 === 0 ? C.dim : null) : (u + v) % 2 === 0 ? C.dim : C.shade;
        if (col) cd.set(u + 2, cy + v, col, "cloud");
      }
    const span = cols * s.cw, cwPx = (cwid + 4) * s.cw / 2;
    const dur = f1(60 + i * 35);
    const back = `<rect x="${f1(x0)}" y="${f1(y0)}" width="${f1(cwPx)}" height="${f1(rows * s.ch)}" fill="none"/>`;
    out.push(`<g class="drift" style="--a:${f1(-cwPx)}px;--b:${f1(span)}px;--d:${dur}s;animation-delay:-${f1(dur * (0.3 + i * 0.45))}s">${back}${cd.layer("cloud")}</g>`);
  }
  out.push(`<path d="${ridge(far)}" fill="#000"/>`);
  out.push(d.layer("hill"));
  out.push(`<path d="${ridge(near)}" fill="#000"/>`);
  out.push(d.layer("near"));
  // the shooting star
  const sd = new Dots(s, x0, y0, cols, rows);
  for (let k = 0; k < 7; k++) sd.set(Math.floor(W * 0.18) - k * 3, 2 - k, k === 0 ? C.white : C.acct, "s");
  out.push(`<g class="shoot" style="--x:${f1(cols * s.cw * 0.35)}px;--y:${f1(rows * s.ch * 0.3)}px;--d:9s;animation-delay:2.5s">${sd.layer("s")}</g>`);
  const clip = s.id("sk");
  s.defs.push(`<clipPath id="${clip}"><rect x="${f1(x0)}" y="${f1(y0)}" width="${f1(cols * s.cw)}" height="${f1(rows * s.ch)}"/></clipPath>`);
  return `<g clip-path="url(#${clip})">${out.join("")}</g>`;
}

/* ------------------------------------------------------------ the name plate */

// The MARKO ZANOŠKI block letters from zanoski.com: one pixel is two cells wide
// and one tall, the top row white, the next two bright, the rest blue.
const LETTERS = {
  M: ["10001", "11011", "10101", "10001", "10001"],
  A: ["111", "101", "111", "101", "101"],
  R: ["111", "101", "111", "110", "101"],
  K: ["101", "101", "110", "101", "101"],
  O: ["111", "101", "101", "101", "111"],
  Z: ["111", "001", "010", "100", "111"],
  N: ["1001", "1101", "1011", "1001", "1001"],
  S: ["111", "100", "111", "001", "111"],
  I: ["111", "010", "010", "010", "111"],
};

function platePixels(lines) {
  const px = [];
  lines.forEach(([word, row]) => {
    let x = 0;
    for (const chr of word) {
      const g = LETTERS[chr === "Š" ? "S" : chr];
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < g[r].length; c++) if (g[r][c] === "1") px.push({ x: x + c * 2, y: row + r, r, w: 2 });
      if (chr === "Š") {
        // the caron, in half blocks above the S
        px.push({ x: x + 1, y: row - 1, r: -1, w: 1, half: "top" });
        px.push({ x: x + 2, y: row - 1, r: -1, w: 2, half: "bot" });
        px.push({ x: x + 4, y: row - 1, r: -1, w: 1, half: "top" });
      }
      x += g[0].length * 2 + 2;
    }
  });
  return px;
}

function plate(s, ox, oy, cw, ch, t0, lines) {
  const pixels = platePixels(lines);
  const rowCol = (r) => (r <= 0 ? C.white : r < 3 ? C.br : C.fg);
  const rect = (p, dx = 0, dy = 0) => {
    const x = ox + (p.x + dx) * cw, y = oy + (p.y + dy) * ch;
    if (p.half === "top") return `M${f1(x)} ${f1(y)}h${f1(p.w * cw)}v${f1(ch / 2)}h${f1(-p.w * cw)}z`;
    if (p.half === "bot") return `M${f1(x)} ${f1(y + ch / 2)}h${f1(p.w * cw)}v${f1(ch / 2)}h${f1(-p.w * cw)}z`;
    return `M${f1(x)} ${f1(y)}h${f1(p.w * cw)}v${f1(ch)}h${f1(-p.w * cw)}z`;
  };
  const rows = [...new Set(pixels.map((p) => p.y))].sort((a, b) => a - b);
  const maxX = Math.max(...pixels.map((p) => p.x + p.w));
  const maxY = Math.max(...rows) + 1;
  const clipId = s.id("pl");
  s.defs.push(`<clipPath id="${clipId}"><path d="${pixels.map((p) => rect(p)).join("")}"/></clipPath>`);
  s.defs.push(`<filter id="bl1" x="-10%" y="-20%" width="120%" height="140%"><feGaussianBlur stdDeviation="${f1(cw * 0.5)}"/></filter>`);
  s.defs.push(`<filter id="bl2" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="${f1(cw * 1.9)}"/></filter>`);
  const delay = (p) => t0 + (16 * p.x + (hash(p.x, p.y, 7) % 260) + 10 * p.y) / 1000;
  const out = [];
  // bloom: the whole word, blurred twice, glowing in once the letters are in
  const all = pixels.map((p) => rect(p)).join("");
  out.push(`<g class="fadein" style="animation-delay:${f2(t0 + 0.5)}s;animation-duration:1.2s"><path d="${all}" fill="${C.acc}" filter="url(#bl2)" opacity=".55"/><path d="${all}" fill="${C.fg}" filter="url(#bl1)" opacity=".45"/></g>`);
  // per row groups so a row can tear sideways for a moment
  const tears = { 1: "t1", 2: "t1", 8: "t2", 9: "t2", 10: "t2" };
  for (const y of rows) {
    const rp = pixels.filter((p) => p.y === y);
    const parts = [];
    for (const p of rp) {
      const d = f2(delay(p));
      parts.push(`<path class="on" style="animation-delay:${d}s" d="${rect(p, 0.5, 0.5)}" fill="${C.shade}"/>`);
    }
    for (const p of rp) {
      const d = f2(delay(p));
      parts.push(`<path class="on" style="animation-delay:${d}s" d="${rect(p)}" fill="${rowCol(p.r)}"/>`);
      // a burst of noise in the cell just before the pixel lands
      const g = NOISE[hash(p.x, p.y, 5) % NOISE.length] + NOISE[hash(p.x + 1, p.y, 5) % NOISE.length];
      parts.push(s.text(ox + p.x * cw, oy + p.y * ch, p.w === 2 ? g : g[0], C.acc, { cls: "nz", style: `animation-delay:${f2(d - 0.18)}s`, fs: f1(ch / 1.21) }));
    }
    out.push(`<g${tears[y - rows[0]] ? ` class="${tears[y - rows[0]]}"` : ""}>${parts.join("")}</g>`);
  }
  // a band of white light sweeps across the letters every few seconds
  const span = maxX * cw;
  out.push(`<g clip-path="url(#${clipId})"><path class="sheen" style="--a:${f1(ox - 120)}px;--b:${f1(span + 160)}px;--d:7.5s;animation-delay:${f1(t0 + 2.2)}s;transform:translateX(${f1(ox - 120)}px)" d="M0 ${f1(oy - ch)}h${f1(cw * 4)}l${f1(-cw * 6)} ${f1((maxY + 2) * ch)}h${f1(-cw * 4)}z" fill="${C.white}" opacity=".9"/></g>`);
  s.css.push(
    "@keyframes on{0%{opacity:0}100%{opacity:1}}.on{animation:on .01s both}",
    "@keyframes nz{0%,100%{opacity:1}}.nz{opacity:0;animation:nz .18s}",
    "@keyframes fadein{0%{opacity:0}100%{opacity:1}}.fadein{animation:fadein .6s both}",
    `@keyframes t1{0%,100%{transform:translateX(0)}61%{transform:translateX(${f1(cw * 2)}px)}63%{transform:translateX(0)}}.t1{animation:t1 9s steps(1,end) ${f1(t0 + 3)}s infinite}`,
    `@keyframes t2{0%,100%{transform:translateX(0)}37%{transform:translateX(${f1(-cw * 2)}px)}39%{transform:translateX(0)}}.t2{animation:t2 13s steps(1,end) ${f1(t0 + 4)}s infinite}`,
  );
  return { svg: out.join(""), w: (maxX + 1) * cw, h: (maxY + 1) * ch };
}

/* ------------------------------------------------------------ hero */

const BOOT = [
  ["home", "/home/marko"],
  ["phosphor", "phosphor.zanoski.com"],
  ["hyprtile", "hyprtile.zanoski.com"],
  ["firewall", "firewall.zanoski.com"],
  ["skellybon", "run-skellybon-run.zanoski.com"],
  ["boomshell", "survive.zanoski.com"],
  ["manual", "survival-guide.zanoski.com"],
  ["zell", "gitlab.com/Zanoshky"],
  ["apps", "11 found"],
];

const right0 = (narrow) => (narrow ? "github" : "github.com/Zanoshky");

function hero({ narrow, H = 900 }) {
  const W = narrow ? 400 : 830;
  const s = new Svg(W, H, { fs: narrow ? 12.5 : 14, title: "Marko Zanoški, software architect and digital craftsman in Zagreb, Croatia. A terminal boots, then his name lights up in block letters." });
  const { cw, ch } = s;
  const close = screen(s);
  const pad = narrow ? 18 : 22;

  // rain behind everything
  // text areas are solid: the rain passes behind them, never across them
  const solids = [];
  const solid = (x, y, w, h) => solids.push(`<rect x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(h)}"/>`);
  s.add(rain(s, { density: narrow ? 0.4 : 0.42, seed: 2, mask: "solid" }));

  /* ---- boot: power on, lines type in, a gauge fills, then a wipe ---- */
  const step = 0.17, t0 = 0.45;
  const bootEnd = t0 + BOOT.length * step + 0.55;
  const wipe = bootEnd + 0.15, wipeDur = 0.6;
  const boot = [];
  let y = 26;
  boot.push(s.text(pad, y, "ZANOSHKY", C.white, { bold: true }));
  boot.push(s.text(pad + 9 * cw, y, "github", C.dim));
  y += ch;
  boot.push(s.text(pad, y, "a terminal home for marko zanoški", C.dim));
  y += ch * 2;
  const nameW = 11;
  BOOT.forEach(([k, v], i) => {
    const at = t0 + i * step;
    const line = (k + " ".repeat(nameW)).slice(0, nameW) + v;
    // [ .. ] turns into [ ok ]
    boot.push(`<g class="hide" style="animation-delay:${f2(at + step * 0.8)}s">${s.text(pad, y, "[ .. ]", C.dim)}</g>`);
    boot.push(`<g class="show" style="animation-delay:${f2(at + step * 0.8)}s">${s.text(pad, y, "[ ok ]", C.acc, { bold: true })}</g>`);
    boot.push(s.text(pad + 7 * cw, y, line.slice(0, nameW), C.dim));
    boot.push(s.text(pad + (7 + nameW) * cw, y, v, C.fg));
    // a black cover slides off the line one character at a time
    const n = line.length, lw = n * cw;
    boot.push(`<rect class="type" style="--w:${f1(lw)}px;animation-delay:${f2(at)}s;animation-duration:${f2(n * 0.012)}s;animation-timing-function:steps(${n},end)" x="${f1(pad + 7 * cw)}" y="${f1(y)}" width="${f1(lw + cw)}" height="${f1(ch)}" fill="#000"/>`);
    // the whole row waits for its turn
    boot.push(`<rect class="wait" style="animation-delay:${f2(at)}s" x="${f1(pad - 2)}" y="${f1(y)}" width="${f1(W)}" height="${f1(ch)}" fill="#000"/>`);
    y += ch;
  });
  y += ch;
  const shellAt = t0 + BOOT.length * step;
  boot.push(`<g class="show" style="animation-delay:${f2(shellAt)}s">${s.text(pad, y, "starting shell", C.fg)}${[0, 1, 2, 3, 4].map((k) => s.text(pad + (15 + k) * cw, y, ".", C.acc, { cls: `d${k}` })).join("")}</g>`);
  const gy = H - 3 * ch - 6, gw = W - 2 * pad;
  boot.push(`<rect x="${pad}" y="${f1(gy + ch * 0.34)}" width="${f1(gw)}" height="${f1(ch * 0.32)}" fill="${C.faint}"/>`);
  boot.push(`<rect class="gauge" style="--d:${f2(bootEnd - t0)}s;animation-delay:${t0}s" x="${pad}" y="${f1(gy + ch * 0.34)}" width="${f1(gw)}" height="${f1(ch * 0.32)}" fill="${C.acc}"/>`);
  boot.push(s.text(pad, gy + ch, "booting", C.dim));
  s.css.push(
    "@keyframes hide{0%{opacity:1}100%{opacity:0}}.hide{animation:hide .01s both}",
    "@keyframes show{0%{opacity:0}100%{opacity:1}}.show{animation:show .01s both}",
    "@keyframes type{0%{transform:translateX(0);opacity:1}99%{transform:translateX(var(--w));opacity:1}100%{opacity:0}}.type{opacity:0;animation-name:type;animation-fill-mode:both}",
    "@keyframes wait{0%{opacity:1}100%{opacity:0}}.wait{opacity:0;animation:wait .01s both}",
    "@keyframes gauge{0%{transform:scaleX(0)}100%{transform:scaleX(1)}}.gauge{transform-box:fill-box;transform-origin:left;animation:gauge var(--d) cubic-bezier(.3,.1,.6,1) both}",
    ...[0, 1, 2, 3, 4].map((k) => `@keyframes d${k}{0%,${k * 16}%{opacity:0}${k * 16 + 0.1}%,100%{opacity:1}}.d${k}{animation:d${k} .7s steps(1,end) infinite}`),
    // the boot screen is gone at rest; the home screen is there at rest
    `@keyframes bootg{0%,100%{opacity:1}}.bootg{opacity:0;animation:bootg ${f2(wipe + wipeDur)}s}`,
    `@keyframes wipe{0%{transform:translateY(0)}100%{transform:translateY(${H}px)}}`,
    `.wipe{transform:translateY(${H}px);animation:wipe ${wipeDur}s cubic-bezier(.5,0,.6,1) ${f2(wipe)}s both}`,
    `@keyframes uncover{0%{transform:translateY(0)}100%{transform:translateY(${H}px)}}.uncover{transform:translateY(${H}px);animation:uncover ${wipeDur}s cubic-bezier(.5,0,.6,1) ${f2(wipe)}s both}`,
    `@keyframes power{0%{transform:scale(0,1);opacity:1}45%{transform:scale(1,1);opacity:1}100%{transform:scale(1,60);opacity:0}}.power{opacity:0;transform-box:fill-box;transform-origin:center;animation:power .42s ease-in both}`,
    `@keyframes dark{0%,90%{opacity:1}100%{opacity:0}}.dark{opacity:0;animation:dark .42s both}`,
  );

  /* ---- home ---- */
  const home = [];
  const top = 14;
  // the bar along the top, like the launcher's status line
  solid(0, 0, W, top + ch + 9);
  home.push(s.text(pad, top, "◆", C.acc));
  home.push(s.text(pad + 2 * cw, top, "zanoski", C.br, { bold: true }));
  home.push(s.text(pad + 10 * cw, top, "~", C.dim));
  const right = right0(narrow);
  home.push(s.text(W - pad - right.length * cw, top, right, C.fg));
  home.push(`<circle class="led" cx="${f1(W - pad - right.length * cw - cw)}" cy="${f1(top + ch / 2)}" r="3" fill="${C.acc}"/>`);
  home.push(`<path d="M0 ${f1(top + ch + 9)}H${W}" stroke="${C.shade}" stroke-width="1"/>`);
  s.css.push("@keyframes led{0%,100%{opacity:1}50%{opacity:.35}}.led{animation:led 2.4s ease-in-out infinite}");

  const ey = top + ch + 30;
  const eyebrow = narrow ? ["Zagreb, Croatia", "software architect"] : ["Zagreb, Croatia", "· software architect"];
  solid(pad - 6, ey - 4, (eyebrow[0].length + eyebrow[1].length + 4) * cw, ch + 8);
  home.push(`<circle cx="${f1(pad + 4)}" cy="${f1(ey + ch / 2)}" r="4" fill="${C.acc}"/><circle cx="${f1(pad + 4)}" cy="${f1(ey + ch / 2)}" r="8" fill="${C.acc}" opacity=".25" filter="url(#bl1)"/>`);
  home.push(s.text(pad + 2 * cw, ey, eyebrow[0], C.br));
  home.push(s.text(pad + (3 + eyebrow[0].length) * cw, ey, eyebrow[1], C.acct));

  // the name
  const plateT = wipe + wipeDur * 0.6;
  const pcw = narrow ? 6 : 7.6, pch = narrow ? 12.4 : 15.2;
  const py = ey + ch + (narrow ? 22 : 24);
  const pl = plate(s, pad, py + pch, pcw, pch, plateT, [["MARKO", 0], ["ZANOŠKI", 7]]);
  home.push(pl.svg);

  // the line under the name
  const ly = py + pl.h + (narrow ? 18 : 16);
  const lede = narrow
    ? ["Software architect and digital", "craftsman. I design, build and run", "small, fast products from start", "to finish."]
    : ["Software architect and digital craftsman.", "I design, build and run small, fast products", "from start to finish."];
  lede.forEach((l, i) => {
    solid(pad - 6, ly + i * ch * 1.35 - 4, (l.length + 1.5) * cw, ch + 8);
    home.push(`<g class="show" style="animation-delay:${f2(plateT + 1 + i * 0.12)}s">${s.text(pad, ly + i * ch * 1.35, l, i === 0 ? C.br : C.fg)}</g>`);
  });

  // a shell panel and the sky, on the right on desktop and below on a phone
  const shellCmd = "ls ~/apps";
  const apps = [["phosphor", "hyprtile", "firewall"], ["skellybon", "boomshell", "manual"], ["zell", "games", "piggy"], ["devtoolbox", "skipper", "weky"]];
  let sx, sy, sw, skyRows;
  if (narrow) {
    sx = pad; sw = W - 2 * pad;
    sy = ly + lede.length * ch * 1.35 + 26;
    skyRows = 0;
  } else {
    sx = 478; sw = W - sx - pad;
    sy = 64; skyRows = 7;
  }
  if (!narrow) {
    const skyH = skyRows * ch + 22;
    home.push(panel(s, sx, sy, sw, skyH, "zagreb", "night sky"));
    const skyCols = Math.floor((sw - 20) / cw);
    home.push(sky(s, sx + (sw - skyCols * cw) / 2, sy + 12, skyCols, skyRows, { seed: 3, moonAt: 0.78 }));
    sy += skyH + 26;
  }
  const shH = (apps.length + 3) * ch + 14;
  home.push(panel(s, sx, sy, sw, shH, "shell", narrow ? "" : "~/apps"));
  const px0 = sx + 14, pY = sy + 14;
  const prompt = "marko@zanoski ~";
  home.push(s.text(px0, pY, prompt, C.dim));
  home.push(s.text(px0 + (prompt.length + 1) * cw, pY, "❯", C.acc, { bold: true }));
  const cmdX = px0 + (prompt.length + 3) * cw;
  const typeAt = plateT + 1.5;
  [...shellCmd].forEach((c, k) => {
    if (c !== " ") home.push(s.text(cmdX + k * cw, pY, c, C.br, { cls: "show", style: `animation-delay:${f2(typeAt + k * 0.09)}s` }));
  });
  const listAt = typeAt + shellCmd.length * 0.09 + 0.35;
  const colW = Math.floor((sw - 28) / 3 / cw);
  apps.forEach((row, i) => {
    const parts = row.map((a, j) => s.text(px0 + j * colW * cw, pY + (i + 1.4) * ch, a, j === 0 && i === 0 ? C.br : C.fg)).join("");
    home.push(`<g class="show" style="animation-delay:${f2(listAt + i * 0.06)}s">${parts}</g>`);
  });
  const ly2 = pY + (apps.length + 1.6) * ch;
  s.defs.push(`<mask id="solid" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/><g fill="#000">${solids.join("")}</g></mask>`);
  s.bottom = Math.max(sy + shH, ly + (lede.length - 1) * ch * 1.35 + ch);
  home.push(`<g class="show" style="animation-delay:${f2(listAt + 0.3)}s">${s.text(px0, ly2, prompt, C.dim)}${s.text(px0 + (prompt.length + 1) * cw, ly2, "❯", C.acc, { bold: true })}<rect class="cur" x="${f1(cmdX)}" y="${f1(ly2 + 1)}" width="${f1(cw)}" height="${f1(ch - 2)}" fill="${C.acc}"/></g>`);

  // home sits under the wipe line: a black sheet slides down to uncover it
  s.add(`<g>${home.join("")}</g>`);
  // the boot screen rides on top until the wipe passes over it
  const bootClip = s.id("bc");
  s.defs.push(`<clipPath id="${bootClip}"><rect class="wipe" x="0" y="0" width="${W}" height="${H}"/></clipPath>`);
  s.add(`<g class="bootg" clip-path="url(#${bootClip})"><rect width="${W}" height="${H}" fill="#000"/>${rain(s, { density: 0.16, seed: 5 })}<g>${boot.join("")}</g></g>`);
  // the wipe line itself
  s.add(`<g class="wipe" style="animation-name:wipe"><rect x="0" y="-2" width="${W}" height="2.4" fill="${C.br}" opacity=".9"/><rect x="0" y="-30" width="${W}" height="28" fill="${C.acc}" opacity=".14"/></g>`);
  // power on: a line opens into the screen
  s.add(`<rect class="dark" width="${W}" height="${H}" fill="#000"/><rect class="power" x="0" y="${f1(H / 2 - 1)}" width="${W}" height="2" fill="${C.br}"/>`);
  close();
  return s;
}

/* ------------------------------------------------------------ whoami */

function whoami({ narrow, H: HH }) {
  const facts = [
    ["name", "Marko Zanoški"],
    ["role", "Software architect and digital craftsman"],
    ["base", "Zagreb, Croatia"],
    ["work", "I design, build and run small, fast", "products from start to finish."],
    ["stack", "Kotlin · Go · TypeScript · React", "Next.js · NestJS · Unity"],
    ["apps", "11 live, 2 on Google Play"],
    ["site", "zanoski.com"],
    ["code", "most of it lives on gitlab.com/Zanoshky"],
  ];
  const fs = narrow ? 12.5 : 14;
  const probe = new Svg(10, 10, { fs });
  const lines = facts.reduce((n, f) => n + f.length - 1, 0) + (narrow ? 4 : 0);
  const W = narrow ? 400 : 830;
  const logoN = narrow ? 13 : 15;
  const H = narrow ? 120 + logoN * 10 + (lines + 5) * probe.ch * 1.3 : 64 + Math.max(logoN * 2 * probe.ch * 0.5, (lines + 4) * probe.ch * 1.3) + 26;
  const s = new Svg(W, Math.round(HH || H), { fs, title: "whoami: Marko Zanoški, software architect and digital craftsman in Zagreb, Croatia. Stack: Kotlin, Go, TypeScript, React, Next.js, NestJS, Unity. 11 live apps, 2 on Google Play. Site zanoski.com, most code on gitlab.com/Zanoshky." });
  const { cw, ch } = s;
  const close = screen(s);
  s.add(rain(s, { density: 0.3, seed: 8 }));
  const m = 16;
  s.add(panel(s, m, 22, W - 2 * m, s.h - 22 - m, "whoami", "~/about"));

  // the logo: a diamond of blocks, lit from above, with a printed shadow
  const lp = narrow ? 10 : 12;
  const lx = narrow ? (W - logoN * lp) / 2 : 46, ly = narrow ? 50 : 58;
  const dm = diamond(logoN);
  const shadow = dm.map((r) => r.map((v) => (v ? 2 : 0)));
  s.defs.push(`<filter id="lg" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>`);
  s.add(`<g filter="url(#lg)" opacity=".6">${mosaicSvg(dm, lx, ly, lp)}</g>`);
  s.add(mosaicSvg(shadow, lx + lp * 0.5, ly + lp * 0.5, lp));
  s.add(mosaicSvg(dm, lx, ly, lp));
  // a sheen across the logo, in step with the name above
  s.defs.push(`<clipPath id="lc"><path d="M${f1(lx + (logoN * lp) / 2)} ${ly}l${f1((logoN * lp) / 2)} ${f1((logoN * lp) / 2)}l${f1(-(logoN * lp) / 2)} ${f1((logoN * lp) / 2)}l${f1(-(logoN * lp) / 2)} ${f1(-(logoN * lp) / 2)}z"/></clipPath>`);
  s.add(`<g clip-path="url(#lc)"><path class="sheen" style="--a:${f1(lx - 60)}px;--b:${f1(lx + logoN * lp + 40)}px;--d:7.5s;animation-delay:3s;transform:translateX(${f1(lx - 60)}px)" d="M0 ${ly - 10}h22l-40 ${logoN * lp + 20}h-22z" fill="#fff" opacity=".55"/></g>`);

  // the fetch output
  const tx = narrow ? 34 : lx + logoN * lp + 56;
  let y = narrow ? ly + logoN * lp + 30 : 52;
  const lh = ch * 1.3;
  const out = [];
  out.push(s.text(tx, y, "marko", C.acct, { bold: true }) + s.text(tx + 5 * cw, y, "@", C.fg) + s.text(tx + 6 * cw, y, "zanoski", C.acct, { bold: true }));
  y += lh;
  out.push(`<path d="M${f1(tx)} ${f1(y - lh * 0.2)}h${f1(13 * cw)}" stroke="${C.dim}" stroke-width="1.2"/>`);
  y += lh * 0.3;
  const kw = 7;
  let i = 0;
  const maxC = Math.floor((W - tx - 40) / cw) - kw;
  for (const [k, ...raw] of facts) {
    const vals = raw.flatMap((v) => wrap(v, maxC));
    vals.forEach((v, j) => {
      const row = (j === 0 ? s.text(tx, y, k, C.acc, { bold: true }) : "") + s.text(tx + kw * cw, y, v, k === "name" ? C.white : C.fg);
      out.push(`<g class="show" style="animation-delay:${f2(0.5 + i * 0.09)}s">${row}</g>`);
      y += lh;
      i++;
    });
  }
  // the colour blocks every fetch ends with, here only one hue
  y += lh * 0.4;
  const inks = [C.faint, C.shade, C.dim, C.acc, C.acct, C.fg, C.br, C.white];
  inks.forEach((c, k) => {
    out.push(`<rect class="show" style="animation-delay:${f2(0.5 + i * 0.09 + k * 0.05)}s" x="${f1(tx + k * 3 * cw)}" y="${f1(y)}" width="${f1(3 * cw)}" height="${f1(ch)}" fill="${c}"/>`);
  });
  s.bottom = Math.max(y + ch + 18, ly + logoN * lp + 26);
  out.push(`<rect class="cur" x="${f1(tx + 25 * cw)}" y="${f1(y + 1)}" width="${f1(cw)}" height="${f1(ch - 2)}" fill="${C.acc}"/>`);
  s.css.push("@keyframes show{0%{opacity:0}100%{opacity:1}}.show{animation:show .01s both}");
  s.add(out.join(""));
  close();
  return s;
}

/* ------------------------------------------------------------ app cards */

const CARDS = [
  {
    id: "phosphor", name: "Phosphor", tag: "android", domain: "phosphor.zanoski.com",
    tagline: "A terminal launcher for Android",
    facts: ["5 layouts, 14 themes", "A lock screen to match", "Coming soon to Google Play"],
    stack: "kotlin · one character grid", icon: "phosphor.png",
  },
  {
    id: "hyprtile", name: "Hyprtile", tag: "android", domain: "hyprtile.zanoski.com",
    tagline: "A tiling desktop for your Android home screen",
    facts: ["12 themes", "Rice it in hyprtile.conf", "No ads, no analytics"],
    stack: "kotlin", icon: "hyprtile.png",
  },
  {
    id: "firewall", name: "Firewall", tag: "android", domain: "firewall.zanoski.com",
    tagline: "Block a domain in every app",
    facts: ["Android, no root needed", "Free and open source", "No ads, no tracking"],
    stack: "local vpn · dns over https", icon: "firewall.png",
  },
  {
    id: "skellybon", name: "Run Skellybon Run", tag: "game", domain: "run-skellybon-run.zanoski.com",
    tagline: "A free Android dungeon runner",
    facts: ["On Google Play", "Free to play", "No account needed"],
    stack: "android", icon: "skellybon.png",
  },
  {
    id: "boomshell", name: "Boom Shell", tag: "game", domain: "survive.zanoski.com",
    tagline: "Top down zombie survival",
    facts: ["Plays in your browser", "Six branch skill tree", "A perk for every run home"],
    stack: "unity · webgl", icon: "boomshell.png",
  },
  {
    id: "manual", name: "Field Manual", tag: "web", domain: "survival-guide.zanoski.com",
    tagline: "Offline survival manual",
    facts: ["15 sections", "Works fully offline", "Installable PWA"],
    stack: "static html · inline svg", icon: "fieldmanual.png",
  },
  {
    id: "zell", name: "zell", tag: "cli", domain: "gitlab.com/Zanoshky",
    tagline: "One command for everything under ~/coding",
    facts: ["Is my change actually live?", "The path from commit to live site", "Reads and reports, never deploys"],
    stack: "go", mosaic: ZELL_ICON,
  },
  {
    id: "zanoski", name: "zanoski.com", tag: "home", domain: "zanoski.com",
    tagline: "Things I built and keep running",
    facts: ["11 apps, each live and maintained", "55 games, 35 developer tools", "Piggy, Skipper, Weky and more"],
    stack: "next.js · one grid", mosaic: diamond(19),
  },
];

function wrap(str, n) {
  const out = [];
  let line = "";
  for (const w of str.split(" ")) {
    if (line && (line + " " + w).length > n) { out.push(line); line = w; } else line = line ? line + " " + w : w;
  }
  if (line) out.push(line);
  return out;
}

function card(c, i) {
  const W = 405, H = 216;
  const s = new Svg(W, H, { fs: 13, title: `${c.name}: ${c.tagline}. ${c.facts.join(". ")}. ${c.domain}` });
  const { cw, ch } = s;
  const close = screen(s, { r: 12 });
  s.add(rain(s, { density: 0.22, seed: 20 + i }));
  const m = 10;
  s.add(panel(s, m, 16, W - 2 * m, H - 16 - m, c.id, c.tag, { bottom: c.stack }));
  // the icon, redrawn from the real one in phosphor ink, with its own glow
  const n = 20, px = 4.2, ix = 28, iy = 38;
  const cells = c.mosaic || iconMosaic(join(SRC, "icons", c.icon), n);
  const mz = mosaicSvg(cells, ix, iy, px * (20 / cells.length));
  s.defs.push(`<filter id="ig" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="8"/></filter>`);
  s.add(`<g filter="url(#ig)" opacity=".75">${mz}</g>`);
  s.add(mz);
  // text block
  const tx = 132;
  let y = 34;
  const nameFs = c.name.length > 14 ? 17 : 20;
  s.add(s.text(tx, y, c.name, C.white, { bold: true, fs: nameFs }));
  y += nameFs * 1.21 + 6;
  for (const l of wrap(c.tagline, Math.floor((W - tx - 22) / cw))) {
    s.add(s.text(tx, y, l, C.fg));
    y += ch;
  }
  y += 4;
  s.add(s.text(tx, y, c.domain, C.acct) + s.text(tx + (c.domain.length + 1) * cw, y, "↗", C.acc, { bold: true }));
  // the facts, one per line
  let fy = 136;
  c.facts.forEach((f, k) => {
    s.add(`<g class="show" style="animation-delay:${f2(0.3 + i * 0.08 + k * 0.12)}s">${s.text(28, fy, "›", C.acc, { bold: true })}${s.text(28 + 2 * cw, fy, f, C.br)}</g>`);
    fy += ch * 1.1;
  });
  // a sheen running along the top border, one card after another
  s.defs.push(`<linearGradient id="sh" x1="0" x2="1"><stop offset="0" stop-color="${C.white}" stop-opacity="0"/><stop offset=".5" stop-color="${C.white}"/><stop offset="1" stop-color="${C.white}" stop-opacity="0"/></linearGradient>`);
  s.add(`<rect class="sheen" style="--a:-140px;--b:${W + 20}px;--d:8s;animation-delay:${f1(1 + i * 0.9)}s;transform:translateX(-140px)" x="0" y="15.2" width="120" height="1.8" fill="url(#sh)"/>`);
  s.css.push("@keyframes show{0%{opacity:0}100%{opacity:1}}.show{animation:show .01s both}");
  close();
  return s;
}

/* ------------------------------------------------------------ strips and keys */

function skyStrip({ narrow }) {
  const W = narrow ? 400 : 830, rows = narrow ? 5 : 5;
  const s = new Svg(W, 0, { fs: narrow ? 11 : 14, title: "A night sky drawn in braille dots: stars, a crescent moon, drifting clouds and hills with pines." });
  s.h = Math.round(rows * s.ch + 16);
  const close = screen(s, { r: 10 });
  const cols = Math.floor((W - 16) / s.cw);
  s.add(sky(s, (W - cols * s.cw) / 2, 8, cols, rows, { seed: 7, moonAt: 0.86 }));
  close();
  return s;
}

function key(label, { lit, glyph = "↗", w } = {}) {
  const s = new Svg(0, 46, { fs: 14, title: label });
  const W = w || Math.round((label.length + (lit ? 8 : 6)) * s.cw + 8);
  s.w = W;
  const g = s.id("kg");
  s.defs.push(`<linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lit ? C.acct : C.dim}"/><stop offset=".5" stop-color="${lit ? C.acc : C.shade}"/><stop offset="1" stop-color="${lit ? "#0a3a9a" : C.faint}"/></linearGradient>`);
  s.defs.push(`<linearGradient id="kf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.acc}" stop-opacity="${lit ? 0.32 : 0.12}"/><stop offset="1" stop-color="${C.acc}" stop-opacity="0"/></linearGradient>`);
  s.add(`<rect x="1" y="1" width="${W - 2}" height="44" rx="7" fill="#000"/><rect x="1" y="1" width="${W - 2}" height="44" rx="7" fill="url(#kf)" stroke="url(#${g})" stroke-width="1.4"/>`);
  s.add(`<path d="M9 1.6H${W - 9}" stroke="${C.br}" stroke-opacity="${lit ? 0.8 : 0.35}" stroke-width=".8"/>`);
  const tx = 16;
  if (lit) s.add(s.text(tx, 14, "❯", C.acct, { bold: true }));
  s.add(s.text(tx + (lit ? 2 : 0) * s.cw, 14, label, lit ? C.white : C.br, { bold: lit }));
  s.add(s.text(W - 16 - s.cw, 14, glyph, lit ? C.acct : C.acc, { bold: true }));
  if (lit) s.add(`<rect class="sheen" style="--a:-80px;--b:${W + 20}px;--d:6s;animation-delay:2s;transform:translateX(-80px)" x="0" y="1" width="60" height="1.6" fill="${C.white}" opacity=".9"/>`);
  return s;
}

function footer({ narrow }) {
  const W = narrow ? 400 : 830;
  const s = new Svg(W, narrow ? 196 : 150, { fs: narrow ? 12.5 : 14, title: "Contact: Let's build something. Got an idea, a product that needs finishing, or just want to say hello? The inbox is open. marko@zanoski.com" });
  const { cw, ch } = s;
  const close = screen(s);
  s.add(rain(s, { density: 0.3, seed: 31 }));
  const m = 16;
  s.add(panel(s, m, 22, W - 2 * m, s.h - 22 - m, "contact", "~/mail"));
  let y = 44;
  s.add(s.text(36, y, "Let's build something", C.white, { bold: true, fs: narrow ? 17 : 20 }));
  y += (narrow ? 17 : 20) * 1.21 + 8;
  const body = narrow
    ? ["Got an idea, a product that needs", "finishing, or just want to say hello?", "The inbox is open."]
    : ["Got an idea, a product that needs finishing, or just want to say hello?", "The inbox is open."];
  for (const l of body) { s.add(s.text(36, y, l, C.fg)); y += ch * 1.2; }
  y += 6;
  const mail = "marko@zanoski.com";
  s.add(s.text(36, y, "❯", C.acc, { bold: true }) + s.text(36 + 2 * cw, y, mail, C.br, { bold: true }));
  s.add(`<rect class="cur" x="${f1(36 + (mail.length + 3) * cw)}" y="${f1(y + 1)}" width="${f1(cw)}" height="${f1(ch - 2)}" fill="${C.acc}"/>`);
  close();
  return s;
}

/* ------------------------------------------------------------ write */

// Draw once to learn where the content ends, then again at the right height.
function twoPass(fn, o) {
  const first = fn({ ...o });
  return fn({ ...o, H: Math.round(first.bottom + (o.narrow ? 26 : 30)) });
}

const files = {
  "hero.svg": twoPass(hero, { narrow: false }),
  "hero-narrow.svg": twoPass(hero, { narrow: true }),
  "whoami.svg": twoPass(whoami, { narrow: false }),
  "whoami-narrow.svg": twoPass(whoami, { narrow: true }),
  "sky.svg": skyStrip({ narrow: false }),
  "sky-narrow.svg": skyStrip({ narrow: true }),
  "contact.svg": footer({ narrow: false }),
  "contact-narrow.svg": footer({ narrow: true }),
  "key-site.svg": key("zanoski.com", { lit: true }),
  "key-gitlab.svg": key("gitlab"),
  "key-linkedin.svg": key("linkedin"),
  "key-mail.svg": key("mail"),
};
CARDS.forEach((c, i) => (files[`app-${c.id}.svg`] = card(c, i)));

for (const [name, svg] of Object.entries(files)) {
  const str = svg.toString();
  writeFileSync(join(OUT, name), str);
  console.log(name.padEnd(22), (str.length / 1024).toFixed(1).padStart(6), "KB");
}
