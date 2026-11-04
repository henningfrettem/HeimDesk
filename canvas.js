/* canvas.js — a home-grown drawing canvas for HeimDesk's notes.
 *
 * A classic script rather than an ES module, because modules are refused on
 * file:// and the app is opened straight off disk. It exposes one global,
 * window.HeimDeskCanvas, and knows nothing about Supabase or notes: it is handed
 * a drawing, lets you edit it, and reports every finished change through
 * onChange. Saving is the caller's business.
 *
 *   const c = HeimDeskCanvas.create(element, { data, onChange(data) {}, startTyping });
 *   c.getData(); c.setData(data); c.fit(); c.tidyAll(); c.refresh();
 *   c.flush();    // finish any typing in progress, so getData() has it
 *   c.destroy();
 *   c.exportSVG() // a self-contained SVG for other apps: real text, no HTML
 *   HeimDeskCanvas.previewMarkup(data)   // a still picture of a drawing, as SVG markup
 *
 * startTyping: a new mind map whose central topic is empty opens with the
 * cursor already in it.
 *
 * Two kinds of drawing, both plain data that can be stored as JSON.
 *
 * A diagram, drawn by hand on a grid:
 *   { v: 1, type: "diagram",
 *     nodes: [{ id, shape: "rect" | "oval", x, y, w, h, color: 0-4, text }],
 *     links: [{ id, from: { node, side }, to: { node, side },
 *               style: "elbow" | "straight" | "curved",
 *               arrow: "end" | "both" | "none", label }] }
 *
 * A mind map, a tree whose boxes size themselves to their text:
 *   { v: 1, type: "mindmap",
 *     nodes: [{ id, parent, side, x, y, text, color: 0-4, folded: [sides] }] }
 *   One node has parent null: the central topic. Every other node hangs off
 *   its parent's `side`, and (x, y) is the point where its line meets it:
 *   the middle of its left edge for a node on the right, and so on. That way
 *   a box grows away from its parent as you type. `folded` lists the sides
 *   whose branches are tucked away; each side folds on its own.
 *
 * Sides are "top", "right", "bottom" and "left".
 */
(function () {
"use strict";

const SVGNS = "http://www.w3.org/2000/svg";
const GRID = 20;
const MIN_W = 40, MIN_H = 40;
const NEW_W = 160, NEW_H = 80;
const TEXT_MAX = 14, TEXT_MIN = 6;
const PAD = 6;           // text margin inside a diagram shape: kept small on purpose
const RADIUS = 6;        // a rectangle's corners: square, just softened
const BEND = 6;          // the same softening on a right-angled line's bends
const STUB = 20;         // straight run out of a connection point before any bend
const ZOOM_MIN = 0.2, ZOOM_MAX = 3;
const HISTORY = 100;

// Mind maps: box padding, fonts and the gaps automatic placement leaves.
const MM = {
  font: 13, rootFont: 15, lineHeight: 1.3,
  padX: 10, padY: 6, rootPadX: 16, rootPadY: 10,
  maxText: 220, rootMaxText: 260, minW: 44, rootMinW: 90,
  radius: 8,
  hGap: 56,       // parent to child, sideways
  vGap: 12,       // between siblings stacked on the left or right
  crossGap: 40,   // parent to child, up or down
  sideGap: 16     // between siblings side by side above or below
};

const COLORS = [
  { name: "White", fill: "#ffffff", stroke: "#bdb29a" },
  { name: "Sand",  fill: "#fbefc5", stroke: "#d4b458" },
  { name: "Sage",  fill: "#e1eed6", stroke: "#94b67d" },
  { name: "Sky",   fill: "#dce8f6", stroke: "#86a8d1" },
  { name: "Rose",  fill: "#f8ded6", stroke: "#d4907b" }
];
const SIDES = ["top", "right", "bottom", "left"];   // clockwise
const NORMAL = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const OPPOSITE = { top: "bottom", bottom: "top", left: "right", right: "left" };
const STYLES = ["elbow", "straight", "curved"];
const ARROWS = ["end", "both", "none"];
const across = side => side === "left" || side === "right";

/* ---------- small helpers ---------- */
const snap = v => Math.round(v / GRID) * GRID;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function svgEl(tag, attrs, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
}
function htmlEl(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

// Geometry below takes any box { x, y, w, h }.
function anchorPoint(r, side) {
  switch (side) {
    case "top": return { x: r.x + r.w / 2, y: r.y };
    case "right": return { x: r.x + r.w, y: r.y + r.h / 2 };
    case "bottom": return { x: r.x + r.w / 2, y: r.y + r.h };
    default: return { x: r.x, y: r.y + r.h / 2 };
  }
}
function nearestSide(r, p) {
  let best = "top", d = Infinity;
  for (const s of SIDES) {
    const q = dist(anchorPoint(r, s), p);
    if (q < d) { d = q; best = s; }
  }
  return best;
}
// The side of a box that faces a point, by the dominant direction.
function sideFacing(r, p) {
  const dx = p.x - (r.x + r.w / 2), dy = p.y - (r.y + r.h / 2);
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "bottom" : "top");
}
function overlaps(a, b, m) {
  return a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y;
}

/* ---------- normalising stored data ---------- */
function normalize(input) {
  const d = input && typeof input === "object" ? JSON.parse(JSON.stringify(input)) : {};
  return d.type === "mindmap" ? normalizeMind(d) : normalizeDiagram(d);
}

function normalizeDiagram(d) {
  const nodes = (Array.isArray(d.nodes) ? d.nodes : []).filter(n => n && n.id != null).map(n => ({
    id: String(n.id),
    shape: n.shape === "oval" ? "oval" : "rect",
    x: +n.x || 0,
    y: +n.y || 0,
    w: Math.max(MIN_W, +n.w || NEW_W),
    h: Math.max(MIN_H, +n.h || NEW_H),
    color: clamp(n.color | 0, 0, COLORS.length - 1),
    text: typeof n.text === "string" ? n.text : ""
  }));
  const ids = new Set(nodes.map(n => n.id));
  const end = e => e && ids.has(String(e.node)) && SIDES.includes(e.side)
    ? { node: String(e.node), side: e.side } : null;
  const links = (Array.isArray(d.links) ? d.links : []).map(l => ({
    id: l && l.id != null ? String(l.id) : uid(),
    from: end(l && l.from),
    to: end(l && l.to),
    style: STYLES.includes(l && l.style) ? l.style : "elbow",
    arrow: ARROWS.includes(l && l.arrow) ? l.arrow : "end",
    label: l && typeof l.label === "string" ? l.label : ""
  })).filter(l => l.from && l.to && l.from.node !== l.to.node);
  return { v: 1, type: "diagram", nodes, links };
}

// Always exactly one central topic, and a tree: anything orphaned or caught
// in a loop hangs off the centre instead.
function normalizeMind(d) {
  const nodes = (Array.isArray(d.nodes) ? d.nodes : []).filter(n => n && n.id != null).map(n => ({
    id: String(n.id),
    parent: n.parent != null ? String(n.parent) : null,
    side: SIDES.includes(n.side) ? n.side : "right",
    x: +n.x || 0,
    y: +n.y || 0,
    text: typeof n.text === "string" ? n.text : "",
    color: clamp(n.color | 0, 0, COLORS.length - 1),
    folded: Array.isArray(n.folded) ? SIDES.filter(x => n.folded.includes(x)) : n.folded ? [...SIDES] : []
  }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  let root = nodes.find(n => n.parent == null) || null;
  if (!root) {
    root = { id: uid(), parent: null, side: null, x: 0, y: 0, text: "", color: 1, folded: [] };
    nodes.unshift(root);
    byId.set(root.id, root);
  }
  root.parent = null;
  root.side = null;
  for (const n of nodes) {
    if (n !== root && (n.parent == null || !byId.has(n.parent) || n.parent === n.id)) n.parent = root.id;
  }
  for (const n of nodes) {
    if (n === root) continue;
    const seen = new Set([n.id]);
    let p = byId.get(n.parent);
    while (p && p.parent != null) {
      if (seen.has(p.id)) { n.parent = root.id; break; }
      seen.add(p.id);
      p = byId.get(p.parent);
    }
  }
  return { v: 1, type: "mindmap", nodes };
}

/* ---------- diagram text that shrinks to fit ---------- */
let measurer = null;
const fitCache = new Map();

// The area inside a shape that text may use. An oval's is the largest
// rectangle that sits comfortably inside the ellipse.
function textBox(n) {
  const k = n.shape === "oval" ? 0.72 : 1;
  const iw = n.w * k, ih = n.h * k;
  return {
    x: n.x + (n.w - iw) / 2 + PAD,
    y: n.y + (n.h - ih) / 2 + PAD,
    w: Math.max(4, iw - PAD * 2),
    h: Math.max(4, ih - PAD * 2)
  };
}
function fitFont(text, w, h) {
  if (!text) return TEXT_MAX;
  const key = w + "x" + h + "\u0000" + text;
  const hit = fitCache.get(key);
  if (hit) return hit;
  if (!measurer) {
    measurer = htmlEl("div", { class: "tc-label tc-measure", "aria-hidden": "true" });
    document.body.append(measurer);
  }
  measurer.style.width = w + "px";
  measurer.textContent = text;
  let size = TEXT_MAX;
  for (; size > TEXT_MIN; size -= 0.5) {
    measurer.style.fontSize = size + "px";
    if (measurer.scrollHeight <= h + 0.5 && measurer.scrollWidth <= w + 0.5) break;
  }
  if (fitCache.size > 3000) fitCache.clear();
  fitCache.set(key, size);
  return size;
}

/* ---------- mind map boxes that size themselves ---------- */
let mmMeasurer = null;
const mmCache = new Map();

function mindSize(text, isRoot) {
  const key = (isRoot ? "R" : "N") + "\u0000" + text;
  const hit = mmCache.get(key);
  if (hit) return hit;
  if (!mmMeasurer) {
    mmMeasurer = htmlEl("div", { class: "tc-mm-measure", "aria-hidden": "true" });
    document.body.append(mmMeasurer);
  }
  mmMeasurer.style.fontSize = (isRoot ? MM.rootFont : MM.font) + "px";
  mmMeasurer.style.fontWeight = isRoot ? "600" : "400";
  mmMeasurer.style.maxWidth = (isRoot ? MM.rootMaxText : MM.maxText) + "px";
  // A trailing line break only takes up room once something follows it, but
  // while typing the box should already have grown for the new line.
  const t = text || "";
  mmMeasurer.textContent = t + (t === "" || t.endsWith("\n") ? "​" : "");
  const r = mmMeasurer.getBoundingClientRect();
  const padX = isRoot ? MM.rootPadX : MM.padX, padY = isRoot ? MM.rootPadY : MM.padY;
  const size = {
    w: Math.max(isRoot ? MM.rootMinW : MM.minW, Math.ceil(r.width) + 1 + padX * 2),
    h: Math.ceil(r.height) + padY * 2,
    padX, padY
  };
  if (mmCache.size > 3000) mmCache.clear();
  mmCache.set(key, size);
  return size;
}

// Maps sides when a branch changes direction. Swapping to the opposite side
// mirrors (keeping the order of what's in it); a quarter turn rotates.
function sideMap(from, to) {
  if (from === to) return s => s;
  if (OPPOSITE[from] === to) {
    const pair = across(from) ? ["left", "right"] : ["top", "bottom"];
    return s => s === pair[0] ? pair[1] : s === pair[1] ? pair[0] : s;
  }
  const k = (SIDES.indexOf(to) - SIDES.indexOf(from) + 4) % 4;
  return s => SIDES[(SIDES.indexOf(s) + k) % 4];
}

/* ---------- line geometry ---------- */
function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const collinear = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01)
      || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01);
    if (collinear) out.splice(i, 1);
  }
  return out;
}
function segDir(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  return l < 0.01 ? null : [dx / l, dy / l];
}
function isOrthogonal(pts) {
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i].x - pts[i - 1].x) > 0.01 && Math.abs(pts[i].y - pts[i - 1].y) > 0.01) return false;
  }
  return true;
}
// How many of a path's segments pass through a box's interior.
function crossings(pts, r) {
  let n = 0;
  const x0 = r.x + 1, x1 = r.x + r.w - 1, y0 = r.y + 1, y1 = r.y + r.h - 1;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const lx = Math.min(a.x, b.x), hx = Math.max(a.x, b.x);
    const ly = Math.min(a.y, b.y), hy = Math.max(a.y, b.y);
    if (hx > x0 && lx < x1 && hy > y0 && ly < y1) n++;
  }
  return n;
}
function pathLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

// A right-angled route between two connection points. Each end first runs
// straight out of its side, then a handful of candidate routes are scored:
// shorter and fewer bends is better, never doubling back into either shape,
// and passing through a shape is heavily penalised.
function elbowPoints(p1, n1, p2, n2, ra, rb) {
  const A = { x: p1.x + n1[0] * STUB, y: p1.y + n1[1] * STUB };
  const B = { x: p2.x + n2[0] * STUB, y: p2.y + n2[1] * STUB };
  const xs = [(A.x + B.x) / 2], ys = [(A.y + B.y) / 2];
  if (ra && rb) {
    xs.push(Math.min(ra.x, rb.x) - STUB, Math.max(ra.x + ra.w, rb.x + rb.w) + STUB);
    ys.push(Math.min(ra.y, rb.y) - STUB, Math.max(ra.y + ra.h, rb.y + rb.h) + STUB);
  }
  const candidates = [
    [A, B],
    [A, { x: B.x, y: A.y }, B],
    [A, { x: A.x, y: B.y }, B]
  ];
  for (const x of xs) candidates.push([A, { x, y: A.y }, { x, y: B.y }, B]);
  for (const y of ys) candidates.push([A, { x: A.x, y }, { x: B.x, y }, B]);

  let best = null, bestCost = Infinity;
  for (const c of candidates) {
    const pts = simplify(c);
    if (!isOrthogonal(pts)) continue;
    if (pts.length > 1) {
      const first = segDir(pts[0], pts[1]);
      const last = segDir(pts[pts.length - 2], pts[pts.length - 1]);
      if (first && first[0] * n1[0] + first[1] * n1[1] < -0.01) continue;
      if (last && last[0] * n2[0] + last[1] * n2[1] > 0.01) continue;
    }
    let cost = pathLength(pts) + (pts.length - 2) * 40;
    if (ra) cost += 100000 * crossings(pts, ra);
    if (rb) cost += 100000 * crossings(pts, rb);
    if (cost < bestCost) { bestCost = cost; best = pts; }
  }
  return simplify([p1, ...(best || [A, { x: B.x, y: A.y }, B]), p2]);
}

function roundedPath(pts, r) {
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p = pts[i], p2 = pts[i + 1];
    const rr = Math.min(r, dist(p0, p) / 2, dist(p, p2) / 2);
    const a = { x: p.x + (p0.x - p.x) * rr / dist(p0, p), y: p.y + (p0.y - p.y) * rr / dist(p0, p) };
    const b = { x: p.x + (p2.x - p.x) * rr / dist(p, p2), y: p.y + (p2.y - p.y) * rr / dist(p, p2) };
    d += ` L${a.x} ${a.y} Q${p.x} ${p.y} ${b.x} ${b.y}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${last.x} ${last.y}`;
}

// ra/rb are the two shapes, used to steer right-angled lines around them.
function routeD(style, p1, side1, p2, side2, ra, rb) {
  if (style === "straight" || !side2) return `M${p1.x} ${p1.y} L${p2.x} ${p2.y}`;
  const n1 = NORMAL[side1], n2 = NORMAL[side2];
  if (style === "curved") {
    const k = Math.max(30, dist(p1, p2) / 2.2);
    return `M${p1.x} ${p1.y} C${p1.x + n1[0] * k} ${p1.y + n1[1] * k} `
      + `${p2.x + n2[0] * k} ${p2.y + n2[1] * k} ${p2.x} ${p2.y}`;
  }
  return roundedPath(elbowPoints(p1, n1, p2, n2, ra, rb), BEND);
}

/* ---------- icons for the toolbars ---------- */
const I = (d, extra) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" `
  + `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra || ""}>${d}</svg>`;
const ICON = {
  rect: I('<rect x="3.5" y="6" width="17" height="12" rx="2"/>'),
  oval: I('<ellipse cx="12" cy="12" rx="8.5" ry="6"/>'),
  undo: I('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  redo: I('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
  zoomIn: I('<circle cx="11" cy="11" r="6.5"/><path d="M11 8v6M8 11h6M20 20l-4.2-4.2"/>'),
  zoomOut: I('<circle cx="11" cy="11" r="6.5"/><path d="M8 11h6M20 20l-4.2-4.2"/>'),
  fit: I('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  dup: I('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  front: I('<rect x="9" y="9" width="11" height="11" rx="1.5" fill="currentColor" fill-opacity=".25"/><path d="M15 5H5v10"/>'),
  back: I('<rect x="4" y="4" width="11" height="11" rx="1.5" fill="currentColor" fill-opacity=".25"/><path d="M9 19h10V9"/>'),
  trash: I('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  elbow: I('<path d="M4 18h6a2 2 0 0 0 2-2V8a2 2 0 0 1 2-2h6"/>'),
  straight: I('<path d="M4 19 20 5"/>'),
  curved: I('<path d="M4 19C12 19 12 5 20 5"/>'),
  arrowEnd: I('<path d="M4 12h15M14 7l5 5-5 5"/>'),
  arrowBoth: I('<path d="M5 12h14M10 7l-5 5 5 5M14 7l5 5-5 5"/>'),
  arrowNone: I('<path d="M4 12h16"/>'),
  flip: I('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
  label: I('<path d="M5 18 10 6h1l5 12M7 14h7"/><path d="M18 9v9"/>'),
  copy: I('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  tidy: I('<rect x="3" y="10" width="6" height="4" rx="1"/><rect x="15" y="4" width="6" height="4" rx="1"/>'
    + '<rect x="15" y="16" width="6" height="4" rx="1"/><path d="M9 12h3M12 6v12M12 6h3M12 18h3"/>'),
  fold: I('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12h8"/>'),
  unfold: I('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12h8M12 8v8"/>')
};

/* ---------- styles, injected once ---------- */
function injectStyles() {
  if (document.getElementById("tc-styles")) return;
  const accent = "var(--accent, #a0391c)";
  const font = 'var(--font-body, "Segoe UI", system-ui, sans-serif)';
  const css = `
  .tc-root [hidden] { display: none !important; }
  .tc-root { position: relative; width: 100%; height: 100%; overflow: hidden; outline: none;
    background: var(--paper, #faf8f3); user-select: none; -webkit-user-select: none;
    font-family: ${font}; color: var(--ink, #141108); }
  .tc-svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
  .tc-root.tc-placing .tc-svg { cursor: crosshair; }
  .tc-root.tc-pan-ready .tc-svg, .tc-root.tc-pan-ready .tc-svg * { cursor: grab !important; }
  .tc-root.tc-panning .tc-svg, .tc-root.tc-panning .tc-svg * { cursor: grabbing !important; }
  .tc-menu { position: absolute; right: 12px; bottom: 58px; flex-direction: column; align-items: stretch;
    min-width: 170px; }
  .tc-menu button { display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: 5px;
    background: transparent; font: inherit; font-size: 13px; text-align: left; color: #2f2a22; cursor: pointer; }
  .tc-menu button:hover { background: var(--paper-2, #ece7db); }
  .tc-flash { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 4;
    max-width: calc(100% - 24px); padding: 6px 12px; border-radius: 6px; background: #141108; color: #faf8f3;
    font-size: 12.5px; text-align: center; pointer-events: none; }
  .tc-help { position: absolute; left: 12px; bottom: 14px; max-width: calc(100% - 230px); font-size: 11px;
    line-height: 1.4; color: #8a8070; pointer-events: none; user-select: none; }
  .tc-node { cursor: move; }
  .tc-shape { stroke-width: 1.5; }
  .tc-fo { pointer-events: none; overflow: visible; }
  .tc-fo.editing { pointer-events: auto; }
  .tc-box { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .tc-label { width: 100%; max-height: 100%; text-align: center; white-space: pre-wrap; overflow-wrap: anywhere;
    line-height: 1.25; color: var(--ink, #141108); font-family: ${font}; outline: none; }
  .tc-mm .tc-label { max-height: none; line-height: ${MM.lineHeight}; }
  .tc-label[contenteditable] { cursor: text; user-select: text; -webkit-user-select: text; min-height: 1.25em; }
  .tc-measure { position: fixed; left: -10000px; top: 0; visibility: hidden; max-height: none; }
  .tc-mm-measure { position: fixed; left: -10000px; top: 0; visibility: hidden; display: inline-block;
    white-space: pre-wrap; overflow-wrap: anywhere; line-height: ${MM.lineHeight}; font-family: ${font}; }
  .tc-link-hit { fill: none; stroke: transparent; cursor: pointer; }
  .tc-link-line { fill: none; stroke: #6a6252; stroke-width: 1.6; stroke-linejoin: round; pointer-events: none; }
  .tc-link.selected .tc-link-line { stroke: ${accent}; }
  .tc-mm-line { fill: none; stroke: #8a8070; stroke-width: 1.6; pointer-events: none; }
  .tc-link-label { cursor: pointer; }
  .tc-link-label rect { fill: var(--paper, #faf8f3); }
  .tc-link-label text { font-size: 12px; fill: #2f2a22; font-family: ${font}; }
  .tc-sel { fill: none; stroke: ${accent}; stroke-width: 1.5; vector-effect: non-scaling-stroke; pointer-events: none; }
  .tc-drop { fill: rgba(160, 57, 28, .06); stroke: ${accent}; stroke-width: 2; stroke-dasharray: 5 3;
    vector-effect: non-scaling-stroke; pointer-events: none; }
  .tc-handle { fill: #fff; stroke: ${accent}; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .tc-anchor { fill: #fff; stroke: ${accent}; stroke-width: 1.5; vector-effect: non-scaling-stroke; cursor: crosshair; }
  .tc-anchor.hot { fill: ${accent}; }
  .tc-plus, .tc-fold { cursor: pointer; }
  .tc-plus circle { fill: #fff; stroke: ${accent}; stroke-width: 1.2; vector-effect: non-scaling-stroke; opacity: .9; }
  .tc-plus:hover circle { fill: ${accent}; }
  .tc-plus path { stroke: ${accent}; stroke-width: 1.6; vector-effect: non-scaling-stroke; }
  .tc-plus:hover path { stroke: #fff; }
  .tc-fold circle { fill: #fff; stroke: #8a8070; stroke-width: 1.2; vector-effect: non-scaling-stroke; }
  .tc-fold:hover circle { stroke: ${accent}; }
  .tc-fold path { stroke: #6a6252; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .tc-fold text { fill: #2f2a22; font-family: ${font}; font-weight: 600; }
  .tc-fold.folded circle { fill: var(--paper-2, #ece7db); }
  .tc-end { fill: #fff; stroke: ${accent}; stroke-width: 1.5; vector-effect: non-scaling-stroke; cursor: grab; }
  .tc-marquee { fill: rgba(160, 57, 28, .06); stroke: ${accent}; stroke-width: 1; stroke-dasharray: 4 3;
    vector-effect: non-scaling-stroke; pointer-events: none; }
  .tc-rubber { fill: none; stroke: ${accent}; stroke-width: 1.5; stroke-dasharray: 5 4;
    vector-effect: non-scaling-stroke; pointer-events: none; }
  .tc-bar { position: absolute; display: flex; align-items: center; gap: 2px; padding: 4px;
    background: #fff; border: 1px solid var(--rule, #cdc3ae); border-radius: 8px;
    box-shadow: 0 6px 18px rgba(26, 22, 18, .1), 0 1px 3px rgba(26, 22, 18, .08); z-index: 2; }
  .tc-tools { left: 12px; top: 50%; transform: translateY(-50%); flex-direction: column; }
  .tc-zoom { right: 12px; bottom: 12px; }
  .tc-ctx { transform: translateX(-50%); }
  .tc-btn { width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 6px;
    background: transparent; color: #2f2a22; cursor: pointer; padding: 0; }
  .tc-btn:hover { background: var(--paper-2, #ece7db); }
  .tc-btn.on { background: rgba(160, 57, 28, .1); color: ${accent}; }
  .tc-btn:disabled { opacity: .35; cursor: default; background: transparent; }
  .tc-sep { width: 1px; align-self: stretch; margin: 4px 3px; background: var(--rule-soft, #ddd4be); }
  .tc-tools .tc-sep { width: auto; height: 1px; margin: 3px 4px; }
  .tc-swatch { width: 22px; height: 22px; margin: 0 2px; border-radius: 50%; cursor: pointer; padding: 0;
    border: 1.5px solid; box-sizing: border-box; }
  .tc-swatch.on { box-shadow: 0 0 0 2px #fff, 0 0 0 3.5px ${accent}; }
  .tc-zoom-level { min-width: 44px; text-align: center; font-size: 12px; color: #6a6252;
    font-variant-numeric: tabular-nums; }
  .tc-empty { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: 280px;
    text-align: center; font-size: 13px; line-height: 1.5; color: #8a8070; pointer-events: none; }
  .tc-preview .tc-node, .tc-preview .tc-link-hit { cursor: inherit; }
  .tc-label-input { position: absolute; z-index: 3; transform: translate(-50%, -50%); width: 180px;
    padding: 5px 8px; font: inherit; font-size: 13px; text-align: center; border: 1px solid ${accent};
    border-radius: 6px; outline: none; background: #fff; box-shadow: 0 4px 14px rgba(26, 22, 18, .12); }
  /* Fingers: bigger buttons. */
  @media (pointer: coarse) {
    .tc-btn { width: 40px; height: 40px; }
    .tc-swatch { width: 28px; height: 28px; margin: 0 3px; }
    .tc-zoom-level { min-width: 40px; }
    .tc-menu button { padding: 12px 14px; font-size: 15px; }
    .tc-menu { bottom: 68px; }
    .tc-label-input { font-size: 16px; }
    .tc-help { top: 10px; bottom: auto; left: 12px; right: 12px; max-width: none; text-align: center; }
    /* The bar over a selection wraps rather than run off a narrow screen. */
    .tc-ctx { flex-wrap: wrap; justify-content: center; width: max-content; max-width: calc(100% - 16px); }
  }
  `;
  document.head.append(htmlEl("style", { id: "tc-styles" }, css));
}

let instances = 0;

/* ---------- the editor ---------- */
function create(container, opts) {
  opts = opts || {};
  injectStyles();
  const ID = "tc" + (++instances);
  const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};

  let data = normalize(opts.data);
  let view = { x: 0, y: 0, z: 1 };        // screen = world * z + (x, y)
  let selNodes = new Set();
  let selLink = null;
  let tool = null;                        // "rect" | "oval" while placing a diagram shape
  let hover = null;                       // node whose connection points are showing
  let gesture = null;                     // the pointer interaction in progress
  let editing = null;                     // { node, label, fo, before, fresh } while typing in a box
  let labelEdit = null;                   // { link, before } while typing a line's label
  let lastColor = 0;
  let spaceHeld = false;                  // Space+drag pans, like Figma and Miro
  // Fingers (pointerType "touch"): one drags a box or moves around, two pinch
  // to zoom, and two quick taps on a box edit its text. A mouse never gets here.
  const coarse = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
  const touches = new Map();              // fingers down, by pointer id
  let pinch = null;                       // two fingers: where they started, and the view then
  let lastTap = null;                     // the box tapped last, for a double tap
  let touchEditAt = 0;                    // when a double tap started editing
  let pendingBefore = null;
  const undoStack = [], redoStack = [];
  const isMind = () => data.type === "mindmap";

  /* DOM */
  const root = htmlEl("div", { class: "tc-root", tabindex: "0" });
  const svg = svgEl("svg", { class: "tc-svg" });
  const defs = svgEl("defs", {}, svg);
  const pattern = svgEl("pattern", {
    id: ID + "-grid", width: GRID, height: GRID, x: -GRID / 2, y: -GRID / 2, patternUnits: "userSpaceOnUse"
  }, defs);
  svgEl("circle", { cx: GRID / 2, cy: GRID / 2, r: 1.1, fill: "#cfc5b0" }, pattern);
  for (const [suffix, color] of [["", "#6a6252"], ["-sel", "#a0391c"]]) {
    const m = svgEl("marker", {
      id: ID + "-arrow" + suffix, viewBox: "0 0 10 10", refX: 9, refY: 5,
      markerWidth: 6.5, markerHeight: 6.5, orient: "auto-start-reverse"
    }, defs);
    svgEl("path", { d: "M0 1 L9.5 5 L0 9 z", fill: color }, m);
  }
  const world = svgEl("g", {}, svg);
  const gridRect = svgEl("rect", {
    x: -100000, y: -100000, width: 200000, height: 200000, fill: `url(#${ID}-grid)`
  }, world);
  const linkLayer = svgEl("g", {}, world);
  const nodeLayer = svgEl("g", {}, world);
  const overlay = svgEl("g", {}, world);

  const btn = (icon, title, onclick, extra) => htmlEl("button", Object.assign({
    class: "tc-btn", type: "button", title, "aria-label": title, html: icon,
    onmousedown: e => e.preventDefault(), onclick
  }, extra || {}));
  const sep = () => htmlEl("span", { class: "tc-sep" });

  const rectTool = btn(ICON.rect, "Rectangle: click, then click the canvas", () => setTool("rect"));
  const ovalTool = btn(ICON.oval, "Oval: click, then click the canvas", () => setTool("oval"));
  const tidyTool = btn(ICON.tidy, "Tidy the whole map", () => tidyAll());
  const undoBtn = btn(ICON.undo, "Undo (Ctrl+Z)", () => undo());
  const redoBtn = btn(ICON.redo, "Redo (Ctrl+Y)", () => redo());
  const tools = htmlEl("div", { class: "tc-bar tc-tools" });
  let toolsFor = null;
  function buildTools() {
    toolsFor = data.type;
    tools.textContent = "";
    if (isMind()) tools.append(tidyTool, sep(), undoBtn, redoBtn);
    else tools.append(rectTool, ovalTool, sep(), undoBtn, redoBtn);
  }

  const zoomLevel = htmlEl("span", { class: "tc-zoom-level" }, "100%");
  const zoomBar = htmlEl("div", { class: "tc-bar tc-zoom" },
    btn(ICON.zoomOut, "Zoom out", () => zoomCentre(1 / 1.25)),
    zoomLevel,
    btn(ICON.zoomIn, "Zoom in", () => zoomCentre(1.25)),
    sep(),
    btn(ICON.fit, "Fit to screen", () => fit()),
    sep(),
    btn(ICON.copy, "Copy as an image or as SVG", () => { copyMenu.hidden = !copyMenu.hidden; }));
  const copyMenu = htmlEl("div", { class: "tc-bar tc-menu", hidden: true },
    htmlEl("button", { type: "button", onmousedown: e => e.preventDefault(), onclick: () => copyOut("png") },
      "Copy as image"),
    htmlEl("button", { type: "button", onmousedown: e => e.preventDefault(), onclick: () => copyOut("svg") },
      "Copy as SVG"));
  const flashEl = htmlEl("div", { class: "tc-flash", hidden: true, role: "status" });
  let flashTimer = 0;
  function flash(msg) {
    flashEl.textContent = msg;
    flashEl.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashEl.hidden = true; }, 2200);
  }

  const ctx = htmlEl("div", { class: "tc-bar tc-ctx", hidden: true });
  let ctxKind = null;

  const labelInput = htmlEl("input", {
    class: "tc-label-input", type: "text", maxlength: "80", placeholder: "Label", hidden: true
  });
  const emptyHint = htmlEl("div", { class: "tc-empty", hidden: true },
    coarse ? "Pick a rectangle or an oval on the left, then tap the canvas to place it."
      : "Pick a rectangle or an oval on the left, then click the canvas to place it.");
  const help = htmlEl("div", { class: "tc-help" }, coarse
    ? "Move around: drag the background \u00b7 Zoom: pinch \u00b7 Edit text: double-tap"
    : "Move around: Ctrl+drag, Space+drag or right-drag \u00b7 Zoom: scroll");

  root.append(svg, emptyHint, help, tools, zoomBar, copyMenu, flashEl, ctx, labelInput);
  container.append(root);

  /* ---------- lookups and geometry ---------- */
  function toWorld(e) {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.z, y: (e.clientY - r.top - view.y) / view.z };
  }
  const toScreen = p => ({ x: p.x * view.z + view.x, y: p.y * view.z + view.y });
  const nodeById = id => data.nodes.find(n => n.id === id) || null;
  const linkById = id => isMind() ? null : data.links.find(l => l.id === id) || null;

  // A node's box. A diagram shape stores its own; a mind-map box is sized by
  // its text and placed from the point where its line meets it.
  function geom(n) {
    if (!isMind()) return n;
    const s = mindSize(n.text, !n.parent);
    switch (n.parent ? n.side : null) {
      case "right": return { x: n.x, y: n.y - s.h / 2, w: s.w, h: s.h };
      case "left": return { x: n.x - s.w, y: n.y - s.h / 2, w: s.w, h: s.h };
      case "bottom": return { x: n.x - s.w / 2, y: n.y, w: s.w, h: s.h };
      case "top": return { x: n.x - s.w / 2, y: n.y - s.h, w: s.w, h: s.h };
      default: return { x: n.x - s.w / 2, y: n.y - s.h / 2, w: s.w, h: s.h };
    }
  }
  const childrenOf = id => data.nodes.filter(n => n.parent === id);
  function descendants(n) {
    const out = [];
    const stack = [n.id];
    while (stack.length) {
      const id = stack.pop();
      for (const c of data.nodes) if (c.parent === id) { out.push(c); stack.push(c.id); }
    }
    return out;
  }
  const isFolded = (n, side) => !!(n.folded && n.folded.includes(side));
  // A box's branches on one side, and everything under them.
  function sideBranches(n, side) {
    const out = [];
    for (const c of childrenOf(n.id)) if (c.side === side) out.push(c, ...descendants(c));
    return out;
  }
  // Everything not tucked away on a folded side.
  function visibleNodes() {
    if (!isMind()) return data.nodes;
    const hidden = new Set();
    for (const n of data.nodes) {
      for (const side of n.folded || []) for (const d of sideBranches(n, side)) hidden.add(d.id);
    }
    return data.nodes.filter(n => !hidden.has(n.id));
  }
  function nodeAt(p, except) {
    const skip = except instanceof Set ? except : new Set(except ? [except] : []);
    const nodes = visibleNodes();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const g = geom(n);
      if (!skip.has(n.id) && p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + g.h) return n;
    }
    return null;
  }

  /* ---------- history ---------- */
  const snapshot = () => JSON.stringify(data);
  function commitFrom(before) {
    if (before == null || snapshot() === before) return;
    undoStack.push(before);
    if (undoStack.length > HISTORY) undoStack.shift();
    redoStack.length = 0;
    onChange(getData());
  }
  function begin() { pendingBefore = snapshot(); }
  function commit() { commitFrom(pendingBefore); pendingBefore = null; }
  function change(fn) {
    const before = snapshot();
    fn();
    commitFrom(before);
    render();
  }
  function restore(json) {
    data = JSON.parse(json);
    selNodes = new Set([...selNodes].filter(id => nodeById(id)));
    if (selLink && !linkById(selLink)) selLink = null;
    hover = null;
    onChange(getData());
    render();
  }
  function undo() {
    if (finishEditing() === "discarded") return;
    finishLabel(true);
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
  }
  function redo() {
    finishEditing();
    finishLabel(true);
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
  }

  /* ---------- rendering ---------- */
  let frame = 0;
  function scheduleRender() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  }

  const nodeEls = new Map();
  function makeNodeEl(n) {
    const g = svgEl("g", { class: "tc-node", "data-node": n.id });
    svgEl("rect", { class: "tc-shape tc-rect" }, g);
    svgEl("ellipse", { class: "tc-shape tc-oval" }, g);
    const fo = svgEl("foreignObject", { class: "tc-fo" }, g);
    const box = htmlEl("div", { class: "tc-box" });
    const label = htmlEl("div", { class: "tc-label" });
    box.append(label);
    fo.append(box);
    g._rect = g.children[0];
    g._oval = g.children[1];
    g._fo = fo;
    g._label = label;
    return g;
  }
  function updateNodeEl(g, n) {
    const c = COLORS[n.color] || COLORS[0];
    const mind = isMind();
    const isOval = !mind && n.shape === "oval";
    g._rect.style.display = isOval ? "none" : "";
    g._oval.style.display = isOval ? "" : "none";
    const r = geom(n);
    const shape = isOval ? g._oval : g._rect;
    if (isOval) {
      shape.setAttribute("cx", r.x + r.w / 2);
      shape.setAttribute("cy", r.y + r.h / 2);
      shape.setAttribute("rx", r.w / 2);
      shape.setAttribute("ry", r.h / 2);
    } else {
      shape.setAttribute("x", r.x);
      shape.setAttribute("y", r.y);
      shape.setAttribute("width", r.w);
      shape.setAttribute("height", r.h);
      shape.setAttribute("rx", mind ? MM.radius : RADIUS);
      shape.setAttribute("ry", mind ? MM.radius : RADIUS);
    }
    shape.setAttribute("fill", c.fill);
    shape.setAttribute("stroke", c.stroke);

    let tb, size;
    if (mind) {
      const s = mindSize(n.text, !n.parent);
      tb = { x: r.x + s.padX, y: r.y + s.padY, w: r.w - s.padX * 2, h: r.h - s.padY * 2 };
      size = n.parent ? MM.font : MM.rootFont;
      g._label.style.fontWeight = n.parent ? "400" : "600";
    } else {
      tb = textBox(n);
      g._label.style.fontWeight = "";
    }
    g._fo.setAttribute("x", tb.x);
    g._fo.setAttribute("y", tb.y);
    g._fo.setAttribute("width", Math.max(1, tb.w));
    g._fo.setAttribute("height", Math.max(1, tb.h));
    // The box being typed in manages its own text.
    if (editing && editing.node.id === n.id) return;
    if (g._label.textContent !== n.text) g._label.textContent = n.text;
    g._label.style.fontSize = (mind ? size : fitFont(n.text, tb.w, tb.h)) + "px";
  }
  function renderNodes() {
    const seen = new Set();
    const nodes = visibleNodes();
    nodes.forEach((n, i) => {
      seen.add(n.id);
      let g = nodeEls.get(n.id);
      if (!g) { g = makeNodeEl(n); nodeEls.set(n.id, g); }
      updateNodeEl(g, n);
      if (nodeLayer.children[i] !== g) nodeLayer.insertBefore(g, nodeLayer.children[i] || null);
    });
    for (const [id, g] of nodeEls) {
      if (!seen.has(id)) { g.remove(); nodeEls.delete(id); }
    }
  }

  function linkGeometry(l, override) {
    const a = nodeById(l.from.node), b = nodeById(l.to.node);
    let from = { node: a, side: l.from.side }, to = { node: b, side: l.to.side };
    if (override) {
      if (override.end === "from") from = override.target;
      else to = override.target;
    }
    const pa = from.node ? anchorPoint(from.node, from.side) : from.point;
    const pb = to.node ? anchorPoint(to.node, to.side) : to.point;
    // A loose end follows the pointer as a straight line until it lands.
    const style = from.node && to.node ? l.style : "straight";
    return routeD(style, pa, from.side, pb, to.side, from.node, to.node);
  }
  function renderLinks() {
    linkLayer.textContent = "";
    if (isMind()) {
      // A mind map's lines are its tree: each box to its parent, curved.
      const shown = new Set(visibleNodes().map(n => n.id));
      for (const n of data.nodes) {
        if (!n.parent || !shown.has(n.id)) continue;
        const p = nodeById(n.parent);
        if (!p) continue;
        const a = anchorPoint(geom(p), n.side), b = anchorPoint(geom(n), OPPOSITE[n.side]);
        svgEl("path", { class: "tc-mm-line", d: routeD("curved", a, n.side, b, OPPOSITE[n.side]) }, linkLayer);
      }
    } else {
      const hitWidth = 12 / view.z;
      for (const l of data.links) {
        const relinking = gesture && gesture.kind === "relink" && gesture.link === l.id ? gesture : null;
        const d = linkGeometry(l, relinking && relinking.target ? relinking : null);
        const selected = selLink === l.id;
        const g = svgEl("g", { class: "tc-link" + (selected ? " selected" : ""), "data-link": l.id }, linkLayer);
        svgEl("path", { d, class: "tc-link-hit", "stroke-width": hitWidth }, g);
        const marker = `url(#${ID}-arrow${selected ? "-sel" : ""})`;
        const line = svgEl("path", {
          d, class: "tc-link-line",
          "marker-end": l.arrow !== "none" ? marker : null,
          "marker-start": l.arrow === "both" ? marker : null
        }, g);
        if (l.label && !(labelEdit && labelEdit.link === l.id)) {
          const mid = line.getPointAtLength(line.getTotalLength() / 2);
          const lg = svgEl("g", { class: "tc-link-label" }, g);
          const bg = svgEl("rect", {}, lg);
          const t = svgEl("text", { x: mid.x, y: mid.y, "text-anchor": "middle", "dominant-baseline": "central" }, lg);
          t.textContent = l.label;
          const bb = t.getBBox();
          bg.setAttribute("x", bb.x - 5);
          bg.setAttribute("y", bb.y - 2);
          bg.setAttribute("width", bb.width + 10);
          bg.setAttribute("height", bb.height + 4);
          bg.setAttribute("rx", 4);
        }
      }
    }
    if (gesture && gesture.kind === "connect") {
      const src = nodeById(gesture.from.node);
      const sg = geom(src);
      const p1 = anchorPoint(sg, gesture.from.side);
      const t = gesture.target;
      const d = t
        ? routeD("elbow", p1, gesture.from.side, anchorPoint(t.node, t.side), t.side, sg, t.node)
        : `M${p1.x} ${p1.y} L${gesture.p.x} ${gesture.p.y}`;
      svgEl("path", { d, class: "tc-rubber" }, linkLayer);
    }
  }

  // Which sides of a mind-map box can grow a new branch: all four on the
  // central topic, and every side but the one facing back to the parent.
  function growSides(n) {
    return isMind() && n.parent ? SIDES.filter(s => s !== OPPOSITE[n.side]) : SIDES;
  }
  // Where the + buttons go. Past the centre only on the side facing away
  // from it: in a column of boxes a + above or below would sit inside the
  // neighbour. The other sides grow by dragging out from their dot.
  function plusSidesOf(n) {
    return isMind() && n.parent ? [n.side] : SIDES;
  }

  function renderOverlay() {
    overlay.textContent = "";
    const z = view.z;
    const mind = isMind();
    const busy = gesture && gesture.kind !== "marquee";

    for (const id of selNodes) {
      const n = nodeById(id);
      if (!n) continue;
      const g = geom(n);
      svgEl("rect", {
        class: "tc-sel", x: g.x - 3 / z, y: g.y - 3 / z, width: g.w + 6 / z, height: g.h + 6 / z,
        rx: !mind && n.shape === "oval" ? 0 : (mind ? MM.radius : RADIUS) + 2 / z
      }, overlay);
    }

    // Where a dragged mind-map branch would be re-attached.
    if (gesture && gesture.kind === "move" && gesture.dropOn) {
      const g = geom(gesture.dropOn);
      svgEl("rect", {
        class: "tc-drop", x: g.x - 5 / z, y: g.y - 5 / z, width: g.w + 10 / z, height: g.h + 10 / z,
        rx: MM.radius + 4 / z
      }, overlay);
    }

    // Resize handles on a single selected diagram shape.
    if (!mind && selNodes.size === 1 && !editing && (!gesture || gesture.kind === "resize")) {
      const n = nodeById([...selNodes][0]);
      if (n) {
        const s = 8 / z;
        const corners = { nw: [n.x, n.y], ne: [n.x + n.w, n.y], se: [n.x + n.w, n.y + n.h], sw: [n.x, n.y + n.h] };
        for (const [c, [x, y]] of Object.entries(corners)) {
          const h = svgEl("rect", {
            class: "tc-handle", "data-handle": c, x: x - s / 2, y: y - s / 2, width: s, height: s, rx: 1.5 / z
          }, overlay);
          h.style.cursor = c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize";
        }
      }
    }

    // Fold buttons, one for each side of a box that has branches, folding
    // only that side. A folded side's button always shows, with how much is
    // tucked away; an open side's only on hover or selection.
    if (mind && !busy) {
      for (const n of visibleNodes()) {
        const kidSides = [...new Set(childrenOf(n.id).map(k => k.side))];
        if (!kidSides.length) continue;
        const active = n === hover || selNodes.has(n.id);
        const g = geom(n);
        for (const side of kidSides) {
          const folded = isFolded(n, side);
          if (!folded && !active) continue;
          const a = anchorPoint(g, side);
          const r = (folded ? 8 : 6.5) / z;
          const fg = svgEl("g", {
            class: "tc-fold" + (folded ? " folded" : ""), "data-fold": n.id, "data-fold-side": side
          }, overlay);
          svgEl("title", {}, fg).textContent = folded ? "Unfold these branches" : "Fold the branches on this side";
          svgEl("circle", { cx: a.x, cy: a.y, r }, fg);
          if (folded) {
            const t = svgEl("text", {
              x: a.x, y: a.y, "text-anchor": "middle", "dominant-baseline": "central", "font-size": 9 / z
            }, fg);
            t.textContent = String(sideBranches(n, side).length);
          } else {
            const k = 3 / z;
            svgEl("path", { d: `M${a.x - k} ${a.y} H${a.x + k}` }, fg);
          }
        }
      }
    }

    // Connection points and + buttons on the box under the pointer.
    const connectTarget = gesture && (gesture.kind === "connect" || gesture.kind === "relink") && gesture.target;
    const show = connectTarget ? connectTarget.node : (!busy ? hover : null);
    // Never for a box that has just been folded away or deleted.
    if (show && nodeById(show.id) && (!mind || visibleNodes().includes(show))) {
      const g = geom(show);
      const branchSides = mind ? new Set(childrenOf(show.id).map(k => k.side)) : new Set();
      const dotSides = growSides(show);
      const plusSides = plusSidesOf(show);
      for (const side of SIDES) {
        const a = anchorPoint(g, side);
        const hot = connectTarget && connectTarget.side === side;
        // On a mind map, a side that already has branches shows its fold
        // button there instead, and the side facing the parent shows nothing.
        const dot = !mind || (dotSides.includes(side) && !branchSides.has(side));
        if (dot) {
          svgEl("circle", {
            class: "tc-anchor" + (hot ? " hot" : ""), "data-anchor": side, "data-node": show.id,
            cx: a.x, cy: a.y, r: (hot ? 6.5 : 5) / z
          }, overlay);
        }
        if (connectTarget || !plusSides.includes(side)) continue;
        const [nx, ny] = NORMAL[side];
        const off = 26 / z;
        const pg = svgEl("g", { class: "tc-plus", "data-plus": side, "data-node": show.id }, overlay);
        svgEl("title", {}, pg).textContent = mind ? "Add a branch" : "Add a connected shape";
        const cx = a.x + nx * off, cy = a.y + ny * off, r = 8.5 / z, k = 4 / z;
        svgEl("circle", { cx, cy, r }, pg);
        svgEl("path", { d: `M${cx - k} ${cy} H${cx + k} M${cx} ${cy - k} V${cy + k}` }, pg);
      }
    }

    // The ends of a selected line can be dragged to another shape.
    if (selLink && !gesture) {
      const l = linkById(selLink);
      if (l) {
        for (const end of ["from", "to"]) {
          const n = nodeById(l[end].node);
          if (!n) continue;
          const p = anchorPoint(n, l[end].side);
          svgEl("circle", { class: "tc-end", "data-end": end, cx: p.x, cy: p.y, r: 6 / z }, overlay);
        }
      }
    }

    if (gesture && gesture.kind === "marquee") {
      const r = marqueeRect(gesture);
      svgEl("rect", { class: "tc-marquee", x: r.x, y: r.y, width: r.w, height: r.h }, overlay);
    }
  }

  function render() {
    if (toolsFor !== data.type) { buildTools(); ctxKind = null; }
    root.classList.toggle("tc-mm", isMind());
    world.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.z})`);
    gridRect.style.display = isMind() || view.z < 0.45 ? "none" : "";
    renderLinks();
    renderNodes();
    renderOverlay();
    placeContextBar();
    root.classList.toggle("tc-placing", !!tool);
    emptyHint.hidden = isMind() || data.nodes.length > 0 || !!tool;
    rectTool.classList.toggle("on", tool === "rect");
    ovalTool.classList.toggle("on", tool === "oval");
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
    zoomLevel.textContent = Math.round(view.z * 100) + "%";
  }

  /* ---------- the floating toolbar ---------- */
  function swatches() {
    return COLORS.map((c, i) => htmlEl("button", {
      class: "tc-swatch", type: "button", title: c.name, "aria-label": c.name, "data-color": i,
      style: `background:${c.fill};border-color:${c.stroke}`,
      onmousedown: e => e.preventDefault(),
      onclick: () => setColor(i)
    }));
  }
  function buildCtx(kind) {
    ctx.textContent = "";
    ctxKind = kind;
    if (kind === "node") {
      ctx.append(...swatches(), sep(),
        btn(ICON.rect, "Rectangle", () => setShape("rect"), { "data-shape": "rect" }),
        btn(ICON.oval, "Oval", () => setShape("oval"), { "data-shape": "oval" }),
        sep(),
        btn(ICON.dup, "Duplicate", () => duplicate()),
        btn(ICON.front, "Bring to front", () => restack(true)),
        btn(ICON.back, "Send to back", () => restack(false)),
        sep(),
        btn(ICON.trash, "Delete", () => deleteSelection()));
    } else if (kind === "mind") {
      ctx.append(...swatches(), sep(),
        btn(ICON.tidy, "Tidy this branch", () => tidySelected()),
        btn(ICON.fold, "Fold or unfold this branch", () => toggleFoldSelected(), { "data-fold-btn": "" }),
        sep(),
        btn(ICON.trash, "Delete this branch", () => deleteSelection(), { "data-delete": "" }));
    } else if (kind === "link") {
      ctx.append(
        btn(ICON.elbow, "Right-angled line", () => setLink({ style: "elbow" }), { "data-style": "elbow" }),
        btn(ICON.straight, "Straight line", () => setLink({ style: "straight" }), { "data-style": "straight" }),
        btn(ICON.curved, "Curved line", () => setLink({ style: "curved" }), { "data-style": "curved" }),
        sep(),
        btn(ICON.arrowEnd, "Arrow", () => setLink({ arrow: "end" }), { "data-arrow": "end" }),
        btn(ICON.arrowBoth, "Arrows at both ends", () => setLink({ arrow: "both" }), { "data-arrow": "both" }),
        btn(ICON.arrowNone, "Plain line", () => setLink({ arrow: "none" }), { "data-arrow": "none" }),
        btn(ICON.flip, "Flip direction", () => flipLink()),
        sep(),
        btn(ICON.label, "Label (or double-click the line)", () => { const l = linkById(selLink); if (l) startLabel(l); }),
        sep(),
        btn(ICON.trash, "Delete", () => deleteSelection()));
    }
  }
  function placeContextBar() {
    const kind = gesture && gesture.kind !== "marquee" ? null
      : selNodes.size ? (isMind() ? "mind" : "node") : selLink ? "link" : null;
    if (!kind || labelEdit) { ctx.hidden = true; return; }
    if (kind !== ctxKind) buildCtx(kind);
    ctx.hidden = false;

    let top, left, below;
    if (kind === "node" || kind === "mind") {
      const ns = [...selNodes].map(nodeById).filter(Boolean);
      if (!ns.length) { ctx.hidden = true; return; }
      const colors = new Set(ns.map(n => n.color));
      ctx.querySelectorAll("[data-color]").forEach(b =>
        b.classList.toggle("on", colors.size === 1 && colors.has(+b.dataset.color)));
      if (kind === "node") {
        const shapes = new Set(ns.map(n => n.shape));
        ctx.querySelectorAll("[data-shape]").forEach(b =>
          b.classList.toggle("on", shapes.size === 1 && shapes.has(b.dataset.shape)));
      } else {
        const foldBtn = ctx.querySelector("[data-fold-btn]");
        const withKids = ns.filter(n => childrenOf(n.id).length);
        foldBtn.hidden = !withKids.length;
        foldBtn.innerHTML = withKids.length && withKids.every(allFolded) ? ICON.unfold : ICON.fold;
        ctx.querySelector("[data-delete]").hidden = ns.every(n => !n.parent);
      }
      const gs = ns.map(geom);
      const x0 = Math.min(...gs.map(g => g.x)), x1 = Math.max(...gs.map(g => g.x + g.w));
      const y0 = Math.min(...gs.map(g => g.y)), y1 = Math.max(...gs.map(g => g.y + g.h));
      const a = toScreen({ x: (x0 + x1) / 2, y: y0 }), b = toScreen({ x: 0, y: y1 });
      // Clear of the + buttons just outside the box, where there are any: a
      // mind-map branch has its only + on the side facing away from the centre.
      const gap = kind === "mind" && ns.every(n => n.parent && across(n.side)) ? 12 : 44;
      left = a.x; top = a.y - gap; below = b.y + gap;
    } else {
      const l = linkById(selLink);
      if (!l) { ctx.hidden = true; return; }
      ctx.querySelectorAll("[data-style]").forEach(b => b.classList.toggle("on", b.dataset.style === l.style));
      ctx.querySelectorAll("[data-arrow]").forEach(b => b.classList.toggle("on", b.dataset.arrow === l.arrow));
      const m = linkMid(l);
      left = m.x; top = m.y - 18; below = m.y + 18;
    }
    const h = ctx.offsetHeight, w = ctx.offsetWidth;
    const rw = root.clientWidth;
    const y = top - h < 8 ? below : top - h;
    ctx.style.top = Math.round(y) + "px";
    ctx.style.left = Math.round(clamp(left, w / 2 + 8, rw - w / 2 - 8)) + "px";
  }
  function linkMid(l) {
    const p = svgEl("path", { d: linkGeometry(l) }, linkLayer);
    const m = p.getPointAtLength(p.getTotalLength() / 2);
    p.remove();
    return toScreen(m);
  }

  /* ---------- editing: shared ---------- */
  function selectOnly(n) {
    selNodes = new Set(n ? [n.id] : []);
    selLink = null;
  }
  function clearSelection() {
    selNodes = new Set();
    selLink = null;
  }
  function setColor(i) {
    lastColor = i;
    change(() => { for (const id of selNodes) { const n = nodeById(id); if (n) n.color = i; } });
  }
  function deleteSelection() {
    if (!selNodes.size && !selLink) return;
    finishEditing();
    if (isMind()) {
      // A box goes with its whole branch. The central topic stays.
      const gone = new Set();
      for (const id of selNodes) {
        const n = nodeById(id);
        if (!n || !n.parent) continue;
        gone.add(n.id);
        for (const d of descendants(n)) gone.add(d.id);
      }
      if (!gone.size) return;
      change(() => { data.nodes = data.nodes.filter(n => !gone.has(n.id)); });
    } else {
      change(() => {
        if (selNodes.size) {
          data.nodes = data.nodes.filter(n => !selNodes.has(n.id));
          data.links = data.links.filter(l => !selNodes.has(l.from.node) && !selNodes.has(l.to.node));
        }
        if (selLink) data.links = data.links.filter(l => l.id !== selLink);
      });
    }
    clearSelection();
    hover = null;
    render();
  }

  /* ---------- editing: diagrams ---------- */
  function setTool(t) {
    finishEditing();
    tool = tool === t ? null : t;
    render();
  }
  function newNode(shape, x, y, like) {
    return {
      id: uid(), shape, x: snap(x), y: snap(y),
      w: like ? like.w : NEW_W, h: like ? like.h : NEW_H,
      color: like ? like.color : lastColor, text: ""
    };
  }
  function newLink(from, to) {
    return { id: uid(), from, to, style: "elbow", arrow: "end", label: "" };
  }
  function placeShape(shape, p) {
    const n = newNode(shape, p.x - NEW_W / 2, p.y - NEW_H / 2);
    tool = null;
    change(() => data.nodes.push(n));
    selectOnly(n);
    startEditing(n);
  }
  function freeSpot(r) {
    return !data.nodes.some(o => overlaps(r, o, GRID - 1));
  }
  // The + beside a shape: a copy of it, one step away in that direction,
  // already connected. Sideways steps find room if the spot is taken.
  function quickAdd(src, side) {
    const [nx, ny] = NORMAL[side];
    const gap = GRID * 4;
    const base = { x: src.x + nx * (src.w + gap), y: src.y + ny * (src.h + gap) };
    const step = nx ? { x: 0, y: src.h + GRID * 2 } : { x: src.w + GRID * 2, y: 0 };
    let spot = { x: snap(base.x), y: snap(base.y), w: src.w, h: src.h };
    for (let i = 1; i <= 12 && !freeSpot(spot); i++) {
      const k = Math.ceil(i / 2) * (i % 2 ? 1 : -1);
      spot = { x: snap(base.x + step.x * k), y: snap(base.y + step.y * k), w: src.w, h: src.h };
    }
    const n = newNode(src.shape, spot.x, spot.y, src);
    change(() => {
      data.nodes.push(n);
      data.links.push(newLink({ node: src.id, side }, { node: n.id, side: OPPOSITE[side] }));
    });
    selectOnly(n);
    startEditing(n);
  }
  function setShape(s) {
    change(() => { for (const id of selNodes) { const n = nodeById(id); if (n) n.shape = s; } });
  }
  function restack(toFront) {
    change(() => {
      const moving = data.nodes.filter(n => selNodes.has(n.id));
      const rest = data.nodes.filter(n => !selNodes.has(n.id));
      data.nodes = toFront ? [...rest, ...moving] : [...moving, ...rest];
    });
  }
  function duplicate() {
    const map = new Map();
    const copies = [];
    change(() => {
      for (const n of data.nodes.filter(x => selNodes.has(x.id))) {
        const c = Object.assign({}, n, { id: uid(), x: n.x + GRID * 2, y: n.y + GRID * 2 });
        map.set(n.id, c.id);
        copies.push(c);
      }
      data.nodes.push(...copies);
      // Lines between duplicated shapes come along; lines to the rest don't.
      for (const l of data.links.filter(x => map.has(x.from.node) && map.has(x.to.node))) {
        data.links.push(Object.assign({}, l, {
          id: uid(),
          from: { node: map.get(l.from.node), side: l.from.side },
          to: { node: map.get(l.to.node), side: l.to.side }
        }));
      }
    });
    selNodes = new Set(copies.map(c => c.id));
    render();
  }
  function setLink(patch) {
    change(() => { const l = linkById(selLink); if (l) Object.assign(l, patch); });
  }
  function flipLink() {
    change(() => {
      const l = linkById(selLink);
      if (l) [l.from, l.to] = [l.to, l.from];
    });
  }

  /* ---------- editing: mind maps ---------- */
  function translateBranch(n, dx, dy) {
    for (const m of [n, ...descendants(n)]) { m.x += dx; m.y += dy; }
  }
  // The box around a branch as it shows: the box itself, plus everything
  // under it that isn't folded away.
  function branchBox(n) {
    const g = geom(n);
    const b = { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h };
    for (const c of childrenOf(n.id)) {
      if (isFolded(n, c.side)) continue;
      const cb = branchBox(c);
      b.x0 = Math.min(b.x0, cb.x0); b.y0 = Math.min(b.y0, cb.y0);
      b.x1 = Math.max(b.x1, cb.x1); b.y1 = Math.max(b.y1, cb.y1);
    }
    return b;
  }
  // Lays out everything under a box, neatly, from where the box is now.
  // Each child's branch is first laid out around the origin, measured, and
  // then stacked beside its siblings, centred on the parent.
  // A folded side is left as it is, to reappear where it was.
  function layoutKids(n) {
    const r = geom(n);
    // Sideways branches first; branches going up or down then keep clear of
    // whatever those take up beside the box.
    const placed = [];
    for (const side of ["right", "left", "bottom", "top"]) {
      if (isFolded(n, side)) continue;
      const kids = childrenOf(n.id).filter(k => k.side === side);
      if (!kids.length) continue;
      // Keep the order they already have on screen.
      const key = across(side) ? "y" : "x";
      kids.sort((a, b) => a[key] - b[key]);
      const boxes = kids.map(k => {
        translateBranch(k, -k.x, -k.y);
        layoutKids(k);
        return branchBox(k);
      });
      if (across(side)) {
        const total = boxes.reduce((s, b) => s + (b.y1 - b.y0), 0) + MM.vGap * (kids.length - 1);
        let cursor = r.y + r.h / 2 - total / 2;
        const x = side === "right" ? r.x + r.w + MM.hGap : r.x - MM.hGap;
        kids.forEach((k, i) => {
          const b = boxes[i];
          const ax = side === "right" ? x - Math.min(0, b.x0) : x - Math.max(0, b.x1);
          translateBranch(k, ax, cursor - b.y0);
          cursor += (b.y1 - b.y0) + MM.vGap;
          placed.push(branchBox(k));
        });
      } else {
        const total = boxes.reduce((s, b) => s + (b.x1 - b.x0), 0) + MM.sideGap * (kids.length - 1);
        let cursor = r.x + r.w / 2 - total / 2;
        const gx0 = cursor, gx1 = cursor + total;
        let y = side === "bottom" ? r.y + r.h + MM.crossGap : r.y - MM.crossGap;
        for (const b of placed) {
          if (b.x1 <= gx0 || b.x0 >= gx1) continue;
          if (side === "bottom") y = Math.max(y, b.y1 + MM.crossGap / 2);
          else y = Math.min(y, b.y0 - MM.crossGap / 2);
        }
        kids.forEach((k, i) => {
          const b = boxes[i];
          const ay = side === "bottom" ? y - Math.min(0, b.y0) : y - Math.max(0, b.y1);
          translateBranch(k, cursor - b.x0, ay);
          cursor += (b.x1 - b.x0) + MM.sideGap;
        });
      }
    }
  }
  function collides(n, skip) {
    const g = geom(n);
    return visibleNodes().some(o => o !== n && !skip.has(o.id) && overlaps(g, geom(o), 6));
  }
  // Where a new branch goes: beyond the last one on that side, or level with
  // the parent if it's the first; then further along until it's clear.
  function autoPlace(parent, side, n) {
    const r = geom(parent);
    const s = mindSize(n.text, false);
    const sibs = childrenOf(parent.id).filter(k => k.side === side && k !== n);
    if (across(side)) {
      n.x = side === "right" ? r.x + r.w + MM.hGap : r.x - MM.hGap;
      n.y = sibs.length ? Math.max(...sibs.map(k => branchBox(k).y1)) + MM.vGap + s.h / 2 : r.y + r.h / 2;
    } else {
      n.y = side === "bottom" ? r.y + r.h + MM.crossGap : r.y - MM.crossGap;
      n.x = sibs.length ? Math.max(...sibs.map(k => branchBox(k).x1)) + MM.sideGap + s.w / 2 : r.x + r.w / 2;
    }
    // Its own branch (when re-attaching one) is about to move with it.
    const skip = new Set(descendants(n).map(d => d.id));
    const step = across(side) ? { x: 0, y: s.h + MM.vGap } : { x: s.w + MM.sideGap, y: 0 };
    for (let i = 0; i < 40 && collides(n, skip); i++) { n.x += step.x; n.y += step.y; }
  }
  // A new branch, placed automatically or where it was dropped (at: the point
  // its line should meet it). Typing starts straight away.
  function addChild(parent, side, at) {
    const before = snapshot();
    const n = {
      id: uid(), parent: parent.id, side, x: 0, y: 0, text: "",
      // Branches off the centre start white; deeper ones take their parent's colour.
      color: parent.parent ? parent.color : 0, folded: []
    };
    change(() => {
      parent.folded = parent.folded.filter(x => x !== side);
      data.nodes.push(n);
      if (at) { n.x = at.x; n.y = at.y; } else autoPlace(parent, side, n);
    });
    selectOnly(n);
    startEditing(n, { fresh: before });
  }
  // When a box added or grown in a crowded map ends up on top of another,
  // the branches around it are re-laid out: first its own siblings, then,
  // only if that isn't enough, further out, one level at a time.
  // Only overlaps involving the branch in question count, so boxes someone
  // has deliberately dragged on top of each other elsewhere are left alone.
  function clashesAround(a) {
    const inside = new Set([a.id, ...descendants(a).map(d => d.id)]);
    const boxes = visibleNodes().map(v => [v, geom(v)]);
    for (const [v, g] of boxes) {
      if (!inside.has(v.id)) continue;
      for (const [w, h] of boxes) if (w !== v && overlaps(g, h, -1)) return true;
    }
    return false;
  }
  function makeRoom(n) {
    if (!isMind()) return;
    for (let a = n.parent && nodeById(n.parent); a; a = a.parent && nodeById(a.parent)) {
      if (!clashesAround(a)) return;
      layoutKids(a);
    }
  }

  // A new box on the same level, straight after this one: same parent, same
  // side, just below it (or beside it, for branches above or below), with
  // whatever came after it moved along to make room. It takes the colour of
  // the box it follows.
  function addSiblingAfter(n) {
    const parent = n.parent && nodeById(n.parent);
    if (!parent) return;
    const before = snapshot();
    const side = n.side;
    const m = { id: uid(), parent: parent.id, side, x: 0, y: 0, text: "", color: n.color, folded: [] };
    const s = mindSize("", false);
    const b = branchBox(n);
    change(() => {
      for (const k of childrenOf(parent.id)) {
        if (k === n || k.side !== side) continue;
        if (across(side) && k.y > n.y) translateBranch(k, 0, s.h + MM.vGap);
        if (!across(side) && k.x > n.x) translateBranch(k, s.w + MM.sideGap, 0);
      }
      if (across(side)) { m.x = n.x; m.y = b.y1 + MM.vGap + s.h / 2; }
      else { m.x = b.x1 + MM.sideGap + s.w / 2; m.y = n.y; }
      data.nodes.push(m);
      makeRoom(m);
    });
    selectOnly(m);
    startEditing(m, { fresh: before });
  }
  // Moves a branch to a different side, keeping the box where it is.
  function turnBranch(n, side) {
    if (!n.parent || side === n.side) return;
    const g = geom(n);
    const map = sideMap(n.side, side);
    for (const d of descendants(n)) d.side = map(d.side);
    n.side = side;
    const a = anchorPoint(g, OPPOSITE[side]);
    n.x = a.x;
    n.y = a.y;
    layoutKids(n);
  }
  // After a branch is dragged freely: if it crossed to the other side of its
  // parent, it turns to face the right way. Only a mirror flip, never a
  // quarter turn, so nudging a box in a long column can't tip it over.
  function settleSide(n) {
    const parent = n.parent && nodeById(n.parent);
    if (!parent) return;
    const pg = geom(parent), g = geom(n);
    const cx = g.x + g.w / 2 - (pg.x + pg.w / 2), cy = g.y + g.h / 2 - (pg.y + pg.h / 2);
    const flipped = (n.side === "right" && cx < 0) || (n.side === "left" && cx > 0)
      || (n.side === "bottom" && cy < 0) || (n.side === "top" && cy > 0);
    if (flipped) turnBranch(n, OPPOSITE[n.side]);
  }
  // Dropping a branch onto another box makes it that box's branch, carried on
  // in the same direction, or to whichever side of the centre it was dropped.
  function reattach(n, target, p) {
    if (!n.parent || n === target || descendants(n).includes(target)) return false;
    const tg = geom(target);
    const side = target.parent ? target.side : (p.x < tg.x + tg.w / 2 ? "left" : "right");
    const kids = descendants(n);
    const map = sideMap(n.side, side);
    for (const d of kids) d.side = map(d.side);
    const turned = side !== n.side;
    const ox = n.x, oy = n.y;
    n.parent = target.id;
    n.side = side;
    target.folded = target.folded.filter(x => x !== side);
    autoPlace(target, side, n);
    for (const d of kids) { d.x += n.x - ox; d.y += n.y - oy; }
    if (turned) layoutKids(n);
    return true;
  }
  function tidyAll() {
    const centre = data.nodes.find(n => !n.parent);
    if (isMind() && centre) change(() => layoutKids(centre));
  }
  function tidySelected() {
    change(() => { for (const id of selNodes) { const n = nodeById(id); if (n) layoutKids(n); } });
  }
  function toggleFold(n, side) {
    change(() => {
      n.folded = isFolded(n, side) ? n.folded.filter(x => x !== side) : [...n.folded, side];
    });
    // Nothing stays selected inside a branch that just folded away.
    const shown = new Set(visibleNodes().map(v => v.id));
    selNodes = new Set([...selNodes].filter(id => shown.has(id)));
    render();
  }
  const branchSidesOf = n => [...new Set(childrenOf(n.id).map(k => k.side))];
  const allFolded = n => branchSidesOf(n).every(x => isFolded(n, x));
  // The toolbar's button folds every side of the selected boxes at once, or
  // opens them all again if they're all folded.
  function toggleFoldSelected() {
    const ns = [...selNodes].map(nodeById).filter(n => n && childrenOf(n.id).length);
    if (!ns.length) return;
    const fold = !ns.every(allFolded);
    change(() => { for (const n of ns) n.folded = fold ? branchSidesOf(n) : []; });
    const shown = new Set(visibleNodes().map(v => v.id));
    selNodes = new Set([...selNodes].filter(id => shown.has(id)));
    render();
  }

  /* ---------- typing in a box ---------- */
  function readText(label) {
    return label.innerText.replace(/\r/g, "").replace(/\n$/, "");
  }
  function startEditing(n, opts) {
    finishEditing();
    finishLabel(true);
    render();
    const g = nodeEls.get(n.id);
    if (!g) return;
    editing = { node: n, label: g._label, fo: g._fo, before: snapshot(), fresh: opts && opts.fresh };
    g._fo.classList.add("editing");
    g._label.setAttribute("contenteditable", "plaintext-only");
    g._label.addEventListener("input", onEditInput);
    g._label.addEventListener("blur", onEditBlur);
    g._label.focus();
    const r = document.createRange();
    r.selectNodeContents(g._label);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    render();
  }
  function onEditInput() {
    if (!editing) return;
    const { node, label } = editing;
    node.text = readText(label);
    if (isMind()) {
      // The box grows as you type, pushing its line along with it.
      scheduleRender();
    } else {
      const tb = textBox(node);
      label.style.fontSize = fitFont(node.text, tb.w, tb.h) + "px";
    }
  }
  // Clicking anywhere outside the text ends typing, on the canvas or off it.
  function onEditBlur() { finishEditing(); }
  function finishEditing() {
    if (!editing) return null;
    const { node, label, fo, before, fresh } = editing;
    editing = null;
    label.removeEventListener("input", onEditInput);
    label.removeEventListener("blur", onEditBlur);
    const text = readText(label).replace(/\s+$/, "");
    // Asked before the text stops being editable: that drops focus to the
    // page at once, and the next key (Esc, say) would then miss the canvas.
    const hadFocus = document.activeElement === label;
    label.removeAttribute("contenteditable");
    fo.classList.remove("editing");
    if (hadFocus) root.focus({ preventScroll: true });
    // A mind-map box added a moment ago and left empty is taken back, as if
    // it had never been added.
    if (fresh != null && isMind() && !text) {
      if (undoStack[undoStack.length - 1] === fresh) undoStack.pop();
      data = JSON.parse(fresh);
      clearSelection();
      hover = null;
      onChange(getData());
      render();
      return "discarded";
    }
    if (nodeById(node.id)) {
      node.text = text;
      // It may have grown into a neighbour while being typed in.
      makeRoom(node);
    }
    commitFrom(before);
    render();
    return "done";
  }

  /* ---------- a line's label ---------- */
  function startLabel(l) {
    finishEditing();
    selLink = l.id;
    selNodes = new Set();
    labelEdit = { link: l.id, before: snapshot() };
    render();
    const m = linkMid(l);
    labelInput.style.left = m.x + "px";
    labelInput.style.top = m.y + "px";
    labelInput.value = l.label || "";
    labelInput.hidden = false;
    labelInput.focus();
    labelInput.select();
  }
  function finishLabel(keep) {
    if (!labelEdit) return;
    const { link, before } = labelEdit;
    labelEdit = null;
    labelInput.hidden = true;
    const l = linkById(link);
    if (l && keep) l.label = labelInput.value.trim().slice(0, 80);
    commitFrom(before);
    if (document.activeElement === labelInput) root.focus({ preventScroll: true });
    render();
  }
  labelInput.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finishLabel(true); }
    else if (e.key === "Escape") { e.preventDefault(); finishLabel(false); }
  });
  labelInput.addEventListener("blur", () => finishLabel(true));

  /* ---------- zoom ---------- */
  function zoomAt(factor, sx, sy) {
    const z = clamp(view.z * factor, ZOOM_MIN, ZOOM_MAX);
    const k = z / view.z;
    view.x = sx - (sx - view.x) * k;
    view.y = sy - (sy - view.y) * k;
    view.z = z;
    scheduleRender();
  }
  function zoomCentre(factor) {
    zoomAt(factor, svg.clientWidth / 2, svg.clientHeight / 2);
  }
  function fit() {
    const w = svg.clientWidth || 800, h = svg.clientHeight || 500;
    const gs = visibleNodes().map(geom);
    if (!gs.length) {
      view = { x: w / 2, y: h / 2, z: 1 };
      render();
      return;
    }
    const pad = 60;
    const x0 = Math.min(...gs.map(g => g.x)), x1 = Math.max(...gs.map(g => g.x + g.w));
    const y0 = Math.min(...gs.map(g => g.y)), y1 = Math.max(...gs.map(g => g.y + g.h));
    if (coarse) {
      // On a narrow touch screen the drawing sits between the toolbar on
      // the left and the edge, not under the toolbar.
      const padL = 76, padR = 20, room = w - padL - padR;
      const z = clamp(Math.min(room / (x1 - x0), (h - pad * 2) / (y1 - y0)), ZOOM_MIN, 1.25);
      view = { z, x: padL + (room - (x1 - x0) * z) / 2 - x0 * z, y: h / 2 - ((y0 + y1) / 2) * z };
      render();
      return;
    }
    const z = clamp(Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (y1 - y0)), ZOOM_MIN, 1.25);
    view = { z, x: w / 2 - ((x0 + x1) / 2) * z, y: h / 2 - ((y0 + y1) / 2) * z };
    render();
  }

  /* ---------- pointer ---------- */
  function marqueeRect(g) {
    return {
      x: Math.min(g.p0.x, g.p1.x), y: Math.min(g.p0.y, g.p1.y),
      w: Math.abs(g.p1.x - g.p0.x), h: Math.abs(g.p1.y - g.p0.y)
    };
  }
  // The box under the pointer, or failing that the nearest one within reach
  // of its dots and + buttons, which sit just outside it.
  function hoverAt(p) {
    const inside = nodeAt(p);
    if (inside) return inside;
    const m = 36 / view.z;
    let best = null, bestD = Infinity;
    for (const n of visibleNodes()) {
      const g = geom(n);
      const dx = Math.max(g.x - p.x, 0, p.x - (g.x + g.w));
      const dy = Math.max(g.y - p.y, 0, p.y - (g.y + g.h));
      const d = Math.hypot(dx, dy);
      if (dx <= m && dy <= m && d < bestD) { bestD = d; best = n; }
    }
    return best;
  }
  // Where a dragged diagram line end would land: a connection point it's
  // over, else the nearest one on the shape it's over.
  function dropTarget(e, p, exceptId) {
    const dot = e.target.closest && e.target.closest("[data-anchor]");
    if (dot && dot.dataset.node !== exceptId) {
      const n = nodeById(dot.dataset.node);
      if (n) return { node: n, side: dot.dataset.anchor };
    }
    const n = nodeAt(p, exceptId);
    return n ? { node: n, side: nearestSide(n, p) } : null;
  }
  // The topmost selected mind-map boxes: selecting a box and something in its
  // branch moves the branch once, not twice.
  function branchHeads() {
    const heads = [];
    for (const id of selNodes) {
      const n = nodeById(id);
      if (!n) continue;
      let p = n.parent && nodeById(n.parent), covered = false;
      while (p) { if (selNodes.has(p.id)) { covered = true; break; } p = p.parent && nodeById(p.parent); }
      if (!covered) heads.push(n);
    }
    return heads;
  }
  function capture(e) {
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
  }

  // Two fingers: whatever the first one started is undone, and the pair
  // zooms and moves the view.
  function startPinch() {
    const g = gesture;
    gesture = null;
    root.classList.remove("tc-panning");
    if (g && pendingBefore && (g.kind === "move" || g.kind === "resize")) data = JSON.parse(pendingBefore);
    pendingBefore = null;
    hover = null;
    const [a, b] = [...touches.values()];
    const r = svg.getBoundingClientRect();
    pinch = {
      d: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top,
      view: { ...view }
    };
    lastTap = null;
    render();
  }
  function movePinch() {
    const [a, b] = [...touches.values()];
    const r = svg.getBoundingClientRect();
    const v = pinch.view;
    const z = clamp(v.z * (Math.hypot(b.x - a.x, b.y - a.y) || 1) / pinch.d, ZOOM_MIN, ZOOM_MAX);
    // The point that was between the fingers stays between them.
    const wx = (pinch.mx - v.x) / v.z, wy = (pinch.my - v.y) / v.z;
    view.z = z;
    view.x = (a.x + b.x) / 2 - r.left - wx * z;
    view.y = (a.y + b.y) / 2 - r.top - wy * z;
    scheduleRender();
  }

  function onDown(e) {
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) { e.preventDefault(); startPinch(); return; }
      if (touches.size > 2 || pinch) return;
    }
    if (editing && editing.label.contains(e.target)) return; // clicking inside the text being typed
    root.focus({ preventScroll: true });
    finishEditing();
    finishLabel(true);
    const p = toWorld(e);

    const panning = e.button === 1 || e.button === 2
      || (e.button === 0 && (e.ctrlKey || e.metaKey || spaceHeld));
    if (panning) {
      e.preventDefault();
      gesture = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      root.classList.add("tc-panning");
      capture(e);
      return;
    }
    if (e.button !== 0) return;
    if (tool && !isMind()) { placeShape(tool, p); return; }

    const t = e.target;
    const fold = t.closest("[data-fold]");
    if (fold) { const n = nodeById(fold.dataset.fold); if (n) toggleFold(n, fold.dataset.foldSide); return; }

    const plus = t.closest("[data-plus]");
    if (plus) {
      const n = nodeById(plus.dataset.node);
      if (n) { if (isMind()) addChild(n, plus.dataset.plus); else quickAdd(n, plus.dataset.plus); }
      return;
    }

    const anchor = t.closest("[data-anchor]");
    if (anchor) {
      gesture = { kind: "connect", from: { node: anchor.dataset.node, side: anchor.dataset.anchor }, p, start: p, target: null };
      capture(e);
      render();
      return;
    }
    const handle = t.closest("[data-handle]");
    if (handle) {
      const n = nodeById([...selNodes][0]);
      if (n) {
        begin();
        gesture = { kind: "resize", node: n, corner: handle.dataset.handle, start: { x: n.x, y: n.y, w: n.w, h: n.h } };
        capture(e);
      }
      return;
    }
    const endEl = t.closest("[data-end]");
    if (endEl && selLink) {
      gesture = { kind: "relink", link: selLink, end: endEl.dataset.end, p, target: null };
      capture(e);
      render();
      return;
    }
    const nodeEl = t.closest("[data-node]");
    if (nodeEl) {
      const n = nodeById(nodeEl.dataset.node);
      if (!n) return;
      if (e.shiftKey) {
        if (selNodes.has(n.id)) selNodes.delete(n.id); else selNodes.add(n.id);
        selLink = null;
      } else if (!selNodes.has(n.id)) {
        selectOnly(n);
      }
      if (e.pointerType === "touch") hover = n;
      begin();
      // On a mind map a box drags its whole branch along.
      const moving = isMind()
        ? [...new Set(branchHeads().flatMap(h => [h, ...descendants(h)]))]
        : [...selNodes].map(nodeById).filter(Boolean);
      const starts = new Map(moving.map(m => [m.id, { x: m.x, y: m.y }]));
      gesture = { kind: "move", p0: p, grab: n, starts, moved: false, dropOn: null };
      capture(e);
      render();
      return;
    }
    const linkEl = t.closest("[data-link]");
    if (linkEl) {
      selNodes = new Set();
      selLink = linkEl.dataset.link;
      render();
      return;
    }
    // Empty canvas: a finger moves around, and lets go of the selection.
    if (e.pointerType === "touch") {
      hover = null;
      lastTap = null;
      clearSelection();
      gesture = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      capture(e);
      render();
      return;
    }
    // Empty canvas: drag a box to select.
    gesture = { kind: "marquee", p0: p, p1: p, base: e.shiftKey ? new Set(selNodes) : new Set() };
    if (!e.shiftKey) clearSelection();
    capture(e);
    render();
  }

  function showPanReady(on) {
    root.classList.toggle("tc-pan-ready", !!on && !editing);
  }

  function onMove(e) {
    if (e.pointerType === "touch") {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch) { if (touches.size === 2) movePinch(); return; }
      if (!gesture) return; // a finger doesn't hover
    }
    const p = toWorld(e);
    if (!gesture) showPanReady(e.ctrlKey || e.metaKey || spaceHeld);
    if (!gesture) {
      // Over one of the current box's own dots or buttons: stay on that box,
      // even where they overlap a neighbour.
      const own = e.target.closest && e.target.closest("[data-plus], [data-anchor], [data-fold]");
      if (own && hover && (own.dataset.node || own.dataset.fold) === hover.id) return;
      const h = hoverAt(p);
      if (h !== hover) { hover = h; scheduleRender(); }
      return;
    }
    const g = gesture;
    if (g.kind === "pan") {
      view.x = g.vx + (e.clientX - g.sx);
      view.y = g.vy + (e.clientY - g.sy);
      scheduleRender();
    } else if (g.kind === "move") {
      const dx = p.x - g.p0.x, dy = p.y - g.p0.y;
      if (!g.moved && Math.hypot(dx, dy) * view.z < 3) return;
      g.moved = true;
      let ddx = dx, ddy = dy;
      if (!isMind()) {
        // Snap the shape that was grabbed; the rest keep their offsets to it.
        const s = g.starts.get(g.grab.id) || { x: g.grab.x, y: g.grab.y };
        ddx = snap(s.x + dx) - s.x;
        ddy = snap(s.y + dy) - s.y;
      }
      for (const [id, st] of g.starts) {
        const n = nodeById(id);
        if (n) { n.x = st.x + ddx; n.y = st.y + ddy; }
      }
      // A single branch dragged over another box would be re-attached there.
      if (isMind()) {
        const heads = branchHeads();
        g.dropOn = heads.length === 1 && heads[0].parent ? nodeAt(p, new Set(g.starts.keys())) : null;
      }
      scheduleRender();
    } else if (g.kind === "resize") {
      const s = g.start, c = g.corner, n = g.node;
      let left = s.x, top = s.y, right = s.x + s.w, bottom = s.y + s.h;
      if (c.includes("w")) left = Math.min(snap(p.x), right - MIN_W);
      if (c.includes("e")) right = Math.max(snap(p.x), left + MIN_W);
      if (c.includes("n")) top = Math.min(snap(p.y), bottom - MIN_H);
      if (c.includes("s")) bottom = Math.max(snap(p.y), top + MIN_H);
      n.x = left; n.y = top; n.w = right - left; n.h = bottom - top;
      scheduleRender();
    } else if (g.kind === "connect") {
      g.p = p;
      g.target = isMind() ? null : dropTarget(e, p, g.from.node);
      scheduleRender();
    } else if (g.kind === "relink") {
      g.p = p;
      const l = linkById(g.link);
      const other = l && (g.end === "from" ? l.to.node : l.from.node);
      g.target = dropTarget(e, p, other) || { node: null, point: p, side: null };
      scheduleRender();
    } else if (g.kind === "marquee") {
      g.p1 = p;
      const r = marqueeRect(g);
      selNodes = new Set(g.base);
      for (const n of visibleNodes()) if (overlaps(r, geom(n), 0)) selNodes.add(n.id);
      scheduleRender();
    }
  }

  function onUp(e) {
    if (e.pointerType === "touch") {
      touches.delete(e.pointerId);
      if (pinch) { if (touches.size < 2) pinch = null; return; }
    }
    const g = gesture;
    if (!g) return;
    gesture = null;
    try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    root.classList.remove("tc-panning");
    const p = toWorld(e);

    // Two quick taps on the same box edit its text.
    if (e.pointerType === "touch" && e.type === "pointerup" && g.kind === "move" && !g.moved) {
      const now = Date.now();
      if (lastTap && lastTap.id === g.grab.id && now - lastTap.t < 450) {
        lastTap = null;
        commit();
        selectOnly(g.grab);
        touchEditAt = now;
        startEditing(g.grab);
        return;
      }
      lastTap = { id: g.grab.id, t: now };
    }
    if (g.kind === "move" && !g.moved && !e.shiftKey && selNodes.size > 1) {
      // A plain click on one of several selected boxes picks just that one.
      selectOnly(g.grab);
      commit();
    } else if (g.kind === "move") {
      if (isMind() && g.moved) {
        const heads = branchHeads();
        if (g.dropOn && heads.length === 1) reattach(heads[0], g.dropOn, p);
        else if (heads.length === 1) settleSide(heads[0]);
      }
      commit();
    } else if (g.kind === "resize") {
      commit();
    } else if (g.kind === "connect") {
      const src = nodeById(g.from.node);
      if (isMind()) {
        // Dragging from a side's dot out into open space grows a branch there.
        if (src && dist(p, g.start) * view.z > 30 && !nodeAt(p)) addChild(src, g.from.side, p);
        render();
        return;
      }
      const target = dropTarget(e, p, g.from.node);
      if (src && target) {
        const l = newLink(g.from, { node: target.node.id, side: target.side });
        change(() => data.links.push(l));
      } else if (src && dist(p, g.start) * view.z > 30) {
        // Dropped on empty canvas: a new shape there, connected.
        const n = newNode(src.shape, p.x - src.w / 2, p.y - src.h / 2, src);
        change(() => {
          data.nodes.push(n);
          data.links.push(newLink(g.from, { node: n.id, side: sideFacing(n, anchorPoint(src, g.from.side)) }));
        });
        selectOnly(n);
        startEditing(n);
        return;
      }
    } else if (g.kind === "relink") {
      const l = linkById(g.link);
      const other = l && (g.end === "from" ? l.to.node : l.from.node);
      const target = dropTarget(e, p, other);
      if (l && target) change(() => { l[g.end] = { node: target.node.id, side: target.side }; });
    }
    render();
  }

  // The pointer is captured on each press so drags keep tracking, which makes
  // the browser aim the double-click at the whole canvas rather than at the
  // box under the pointer. So what was double-clicked is looked up by
  // position instead of trusting the event's target.
  function onDouble(e) {
    if (Date.now() - touchEditAt < 800) return;
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (!svg.contains(el)) continue;
      if (el.closest("[data-plus], [data-anchor], [data-fold], [data-handle], [data-end]")) return;
      const nodeEl = el.closest("[data-node]");
      if (nodeEl) {
        const n = nodeById(nodeEl.dataset.node);
        if (n) { selectOnly(n); startEditing(n); }
        return;
      }
      const linkEl = el.closest("[data-link]");
      if (linkEl) {
        const l = linkById(linkEl.dataset.link);
        if (l) startLabel(l);
        return;
      }
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(Math.exp(-dy * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }

  function onKey(e) {
    if (editing) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finishEditing(); }
      else if (e.key === "Tab" && isMind()) {
        // Typing a topic, then Tab: on to its first branch.
        e.preventDefault();
        e.stopPropagation();
        const n = editing.node;
        if (finishEditing() !== "discarded" && nodeById(n.id)) addChild(n, n.parent ? n.side : "right");
      } else if (e.key === "Enter" && isMind() && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
        // Enter: on to the next box on the same level. Shift+Enter is left to
        // the browser, and makes a line break inside the box. Enter on a new
        // box that's still empty takes it back and stops, so Enter, Enter
        // ends a list; on the central topic, which has no level to share,
        // it just finishes typing.
        e.preventDefault();
        e.stopPropagation();
        const n = editing.node;
        if (finishEditing() === "discarded") return;
        const again = nodeById(n.id);
        if (again && again.parent) addSiblingAfter(again);
      }
      return;
    }
    if (e.target === labelInput) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const one = selNodes.size === 1 ? nodeById([...selNodes][0]) : null;
    if (mod && k === "z") { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && k === "y") { e.preventDefault(); e.stopPropagation(); redo(); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (selNodes.size || selLink) { e.preventDefault(); e.stopPropagation(); deleteSelection(); }
    } else if (isMind() && one && e.key === "Tab" && !mod) {
      // Keyboard extras on a mind map: Tab adds a branch, Enter a sibling.
      e.preventDefault();
      e.stopPropagation();
      addChild(one, one.parent ? one.side : "right");
    } else if (isMind() && one && e.key === "Enter" && !mod) {
      e.preventDefault();
      e.stopPropagation();
      if (one.parent) addSiblingAfter(one);
      else startEditing(one);
    } else if (e.key === "Escape" && !copyMenu.hidden) {
      e.preventDefault();
      e.stopPropagation();
      copyMenu.hidden = true;
    } else if (e.key === "Escape") {
      if (tool || selNodes.size || selLink) {
        e.preventDefault();
        e.stopPropagation();
        tool = null;
        clearSelection();
        render();
      }
    }
  }

  svg.addEventListener("pointerdown", onDown);
  svg.addEventListener("pointerdown", () => { copyMenu.hidden = true; });
  // A press on the canvas would otherwise move focus once the event is over,
  // taking it away from a box that has just been added and is waiting for
  // text, which then counts as left empty. onDown focuses what it needs.
  // Inside the text being typed the press is left alone, to place the caret.
  svg.addEventListener("mousedown", e => {
    if (editing && editing.label.contains(e.target)) return;
    e.preventDefault();
  });
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerup", onUp);
  svg.addEventListener("pointercancel", onUp);
  svg.addEventListener("pointerleave", e => {
    if (e.pointerType === "touch") return;
    if (!gesture && hover) { hover = null; scheduleRender(); }
  });
  svg.addEventListener("dblclick", onDouble);
  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("contextmenu", e => e.preventDefault());
  root.addEventListener("keydown", onKey);
  root.addEventListener("keydown", e => {
    if (editing || e.target === labelInput) return;
    if (e.key === " ") {
      e.preventDefault(); // no page scroll, no button press
      spaceHeld = true;
      showPanReady(true);
    } else if (e.key === "Control" || e.key === "Meta") {
      showPanReady(true);
    }
  });
  root.addEventListener("keyup", e => {
    if (e.key === " ") spaceHeld = false;
    if (e.key === " " || e.key === "Control" || e.key === "Meta") showPanReady(spaceHeld);
  });
  root.addEventListener("blur", () => { spaceHeld = false; showPanReady(false); });
  const resizeObserver = new ResizeObserver(() => scheduleRender());
  resizeObserver.observe(root);

  /* ---------- public ---------- */
  function getData() { return JSON.parse(JSON.stringify(data)); }
  function setData(d) {
    finishEditing();
    finishLabel(false);
    data = normalize(d);
    tool = null;
    clearSelection();
    hover = null;
    undoStack.length = 0;
    redoStack.length = 0;
    render();
  }
  function destroy() {
    resizeObserver.disconnect();
    if (frame) cancelAnimationFrame(frame);
    root.remove();
  }
  function flush() {
    finishEditing();
    finishLabel(true);
  }
  /* ---------- copying out ---------- */
  // A drawing for other apps (Confluence, Teams, Figma, PowerPoint...): all of
  // it plain SVG, with every colour written onto the element, since none of
  // this page's styles go along. Text is real SVG text, wrapped as it is on
  // screen, where the editor itself uses HTML that only a browser can show.
  // Arrowheads are plain triangles, which other apps keep more reliably than
  // SVG markers.
  const OUT = { line: "#6a6252", mmLine: "#8a8070", text: "#141108", label: "#2f2a22", labelBg: "#ffffff" };
  // The lines a box's text breaks into, exactly as the page breaks them: the
  // text is laid out in a hidden label of the same width and font, and each
  // character's line is read back. (Imitating the browser's rules instead,
  // for hyphens, slashes and letter widths, never quite matches.)
  function laidOutLines(text, css) {
    const box = htmlEl("div", { class: "tc-label tc-measure", "aria-hidden": "true" });
    Object.assign(box.style, css);
    box.textContent = text;
    document.body.append(box);
    const tn = box.firstChild, lines = [], same = parseFloat(css.fontSize) * 0.6;
    let line = "", top = null;
    for (let i = 0; tn && i < text.length;) {
      const ch = String.fromCodePoint(text.codePointAt(i));
      const r = document.createRange();
      r.setStart(tn, i);
      r.setEnd(tn, i + ch.length);
      i += ch.length;
      if (ch === "\n") { lines.push(line); line = ""; top = null; continue; }
      const rect = [...r.getClientRects()].find(x => x.width > 0);
      if (rect && top !== null && Math.abs(rect.top - top) > same) { lines.push(line); line = ""; }
      if (rect) top = rect.top;
      line += ch;
    }
    lines.push(line);
    box.remove();
    return lines.map(l => l.trimEnd());
  }
  // How far a line's baseline sits below its middle, as a share of the font
  // size, for the font the page uses.
  function baselineShift(family) {
    const g = document.createElement("canvas").getContext("2d");
    g.font = "100px " + family;
    const m = g.measureText("Hg");
    const v = (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 200;
    return g.font.startsWith("100px") && v > 0 && v < 1 ? v : 0.35;
  }
  function labelWidth(text, size) {
    const t = svgEl("text", { "font-size": size, "font-family": getComputedStyle(root).fontFamily }, linkLayer);
    t.textContent = text;
    const w = t.getComputedTextLength();
    t.remove();
    return w;
  }
  const xesc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const f2 = v => Math.round(v * 100) / 100;
  function arrowHead(p, dir) {
    const L = 9, W = 4.5;
    const bx = p.x - dir[0] * L, by = p.y - dir[1] * L, nx = -dir[1], ny = dir[0];
    return `${f2(p.x)},${f2(p.y)} ${f2(bx + nx * W)},${f2(by + ny * W)} ${f2(bx - nx * W)},${f2(by - ny * W)}`;
  }
  function unit(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }

  function exportMarkup() {
    flush();
    const nodes = visibleNodes();
    if (!nodes.length) return "";
    const family = getComputedStyle(root).fontFamily;
    const shift = baselineShift(family);
    const gs = nodes.map(geom);
    let x0 = Math.min(...gs.map(g => g.x)), x1 = Math.max(...gs.map(g => g.x + g.w));
    let y0 = Math.min(...gs.map(g => g.y)), y1 = Math.max(...gs.map(g => g.y + g.h));
    const lines = [], shapes = [], labels = [];
    const grow = b => {
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
    };
    const measurePath = d => {
      const el = svgEl("path", { d }, linkLayer);
      return { box: el.getBBox(), len: el.getTotalLength(), el };
    };

    if (isMind()) {
      for (const nd of nodes) {
        if (!nd.parent) continue;
        const parent = nodeById(nd.parent);
        const d = routeD("curved", anchorPoint(geom(parent), nd.side), nd.side,
          anchorPoint(geom(nd), OPPOSITE[nd.side]), OPPOSITE[nd.side]);
        const m = measurePath(d);
        grow(m.box);
        m.el.remove();
        lines.push(`<path d="${d}" fill="none" stroke="${OUT.mmLine}" stroke-width="1.6"/>`);
      }
    } else {
      for (const l of data.links) {
        const a = nodeById(l.from.node), b = nodeById(l.to.node);
        if (!a || !b) continue;
        const d = linkGeometry(l);
        const m = measurePath(d);
        grow(m.box);
        lines.push(`<path d="${d}" fill="none" stroke="${OUT.line}" stroke-width="1.6" stroke-linejoin="round"/>`);
        const pa = anchorPoint(a, l.from.side), pb = anchorPoint(b, l.to.side);
        const straight = l.style === "straight";
        const endDir = straight ? unit(pa, pb) : [-NORMAL[l.to.side][0], -NORMAL[l.to.side][1]];
        const startDir = straight ? unit(pb, pa) : [-NORMAL[l.from.side][0], -NORMAL[l.from.side][1]];
        if (l.arrow !== "none") lines.push(`<polygon points="${arrowHead(pb, endDir)}" fill="${OUT.line}"/>`);
        if (l.arrow === "both") lines.push(`<polygon points="${arrowHead(pa, startDir)}" fill="${OUT.line}"/>`);
        if (l.label) {
          const mid = m.el.getPointAtLength(m.len / 2);
          const w = labelWidth(l.label, 12) + 10, h = 18;
          labels.push(`<rect x="${f2(mid.x - w / 2)}" y="${f2(mid.y - h / 2)}" width="${f2(w)}" height="${h}" rx="4" fill="${OUT.labelBg}"/>`
            + `<text x="${f2(mid.x)}" y="${f2(mid.y + 12 * shift)}" text-anchor="middle" font-size="12" fill="${OUT.label}">${xesc(l.label)}</text>`);
          grow({ x: mid.x - w / 2, y: mid.y - h / 2, width: w, height: h });
        }
        m.el.remove();
      }
    }

    nodes.forEach((nd, i) => {
      const g = gs[i], c = COLORS[nd.color] || COLORS[0];
      const paint = `fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"`;
      if (!isMind() && nd.shape === "oval") {
        shapes.push(`<ellipse cx="${f2(g.x + g.w / 2)}" cy="${f2(g.y + g.h / 2)}" rx="${f2(g.w / 2)}" ry="${f2(g.h / 2)}" ${paint}/>`);
      } else {
        const r = isMind() ? MM.radius : RADIUS;
        shapes.push(`<rect x="${f2(g.x)}" y="${f2(g.y)}" width="${f2(g.w)}" height="${f2(g.h)}" rx="${r}" ${paint}/>`);
      }
      if (!nd.text) return;
      // A last line break shows nothing on the page until something follows it.
      const text = nd.text.replace(/\n$/, "");
      let tb, size, weight, lh;
      if (isMind()) {
        const sz = mindSize(nd.text, !nd.parent);
        tb = { x: g.x + sz.padX, y: g.y + sz.padY, w: g.w - sz.padX * 2, h: g.h - sz.padY * 2 };
        size = nd.parent ? MM.font : MM.rootFont;
        weight = nd.parent ? 400 : 600;
        lh = MM.lineHeight;
      } else {
        tb = textBox(nd);
        size = fitFont(nd.text, tb.w, tb.h);
        weight = 400;
        lh = 1.25;
      }
      const rows = laidOutLines(text, { width: tb.w + "px", fontSize: size + "px", fontWeight: String(weight) });
      const lineH = size * lh;
      const top = tb.y + tb.h / 2 - (rows.length * lineH) / 2;
      const cx = f2(tb.x + tb.w / 2);
      const spans = rows.map((t, k) => t
        ? `<tspan x="${cx}" y="${f2(top + lineH * (k + 0.5) + size * shift)}">${xesc(t)}</tspan>` : "").join("");
      shapes.push(`<text text-anchor="middle" font-size="${size}" font-weight="${weight}" fill="${OUT.text}" xml:space="preserve">${spans}</text>`);
    });

    const pad = 16;
    const w = Math.ceil(x1 - x0 + pad * 2), h = Math.ceil(y1 - y0 + pad * 2);
    return `<svg xmlns="${SVGNS}" width="${w}" height="${h}" viewBox="${f2(x0 - pad)} ${f2(y0 - pad)} ${w} ${h}" `
      + `font-family="${xesc(family)}">${lines.join("")}${shapes.join("")}${labels.join("")}</svg>`;
  }

  // The same picture as a PNG, twice the size for sharpness, on white.
  function toPng(svgText) {
    return new Promise((resolve, reject) => {
      const m = svgText.match(/width="([\d.]+)" height="([\d.]+)"/);
      const w = +m[1], h = +m[2];
      const scale = Math.min(2, 8000 / Math.max(w, h));
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = Math.ceil(w * scale);
        cv.height = Math.ceil(h * scale);
        const g = cv.getContext("2d");
        g.fillStyle = "#ffffff";
        g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(b => b ? resolve(b) : reject(new Error("the image couldn't be made")), "image/png");
      };
      img.onerror = () => reject(new Error("the drawing couldn't be turned into an image"));
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
    });
  }

  async function copyOut(kind) {
    copyMenu.hidden = true;
    const svgText = exportMarkup();
    if (!svgText) { flash("Nothing to copy yet"); return; }
    try {
      if (kind === "png") {
        // Handing the clipboard a promise keeps the click's permission to
        // write while the image is being made.
        await navigator.clipboard.write([new ClipboardItem({ "image/png": toPng(svgText) })]);
        flash("Copied as an image");
      } else {
        // As text too: many apps (Figma, draw.io, editors) take SVG pasted as
        // text; others read the SVG image type where the browser offers it.
        const items = { "text/plain": new Blob([svgText], { type: "text/plain" }) };
        if (window.ClipboardItem && ClipboardItem.supports && ClipboardItem.supports("image/svg+xml")) {
          items["image/svg+xml"] = new Blob([svgText], { type: "image/svg+xml" });
        }
        await navigator.clipboard.write([new ClipboardItem(items)]);
        flash("Copied as SVG");
      }
    } catch (err) {
      flash(err && err.name === "NotAllowedError"
        ? "Couldn't copy: the browser didn't allow it here"
        : "Couldn't copy: " + (err && err.message ? err.message : err));
    }
  }

  // The drawing as a still picture: its lines and boxes, cropped to what's
  // there, as standalone SVG markup. Empty when there's nothing to show.
  function stillMarkup() {
    flush();
    hover = null;
    gesture = null;
    clearSelection();
    render();
    const gs = visibleNodes().map(geom);
    if (!gs.length) return "";
    let x0 = Math.min(...gs.map(g => g.x)), x1 = Math.max(...gs.map(g => g.x + g.w));
    let y0 = Math.min(...gs.map(g => g.y)), y1 = Math.max(...gs.map(g => g.y + g.h));
    if (linkLayer.childNodes.length) {
      const b = linkLayer.getBBox();
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
    }
    const pad = 12;
    const w = Math.ceil(x1 - x0 + pad * 2), h = Math.ceil(y1 - y0 + pad * 2);
    const out = svgEl("svg", {
      xmlns: SVGNS, class: "tc-preview" + (isMind() ? " tc-mm" : ""),
      viewBox: `${x0 - pad} ${y0 - pad} ${w} ${h}`, width: w, height: h
    });
    out.append(defs.cloneNode(true), linkLayer.cloneNode(true), nodeLayer.cloneNode(true));
    return out.outerHTML;
  }

  render();
  if (!opts.still) {
    const ready = () => {
      fit();
      if (opts.startTyping && isMind()) {
        const centre = data.nodes.find(n => !n.parent);
        if (centre && !centre.text) { selectOnly(centre); startEditing(centre); }
      }
    };
    // Straight away when the container already has its size, so the first
    // keys typed land in the new map; otherwise once it has been laid out.
    if (svg.clientWidth && svg.clientHeight) ready();
    else requestAnimationFrame(ready);
  }
  return {
    getData, setData, fit, tidyAll, destroy, undo, redo, flush,
    snapshot: stillMarkup, exportSVG: exportMarkup, copy: copyOut, toPng,
    refresh: render, element: root
  };
}

// A still picture of a drawing, for showing it where it isn't being edited.
// Drawn by a throwaway editor out of sight, so it looks exactly the same.
function previewMarkup(data) {
  injectStyles();
  const host = htmlEl("div", {
    "aria-hidden": "true",
    style: "position:fixed;left:-10000px;top:0;width:800px;height:600px;visibility:hidden"
  });
  document.body.append(host);
  try {
    const c = create(host, { data, still: true });
    const markup = c.snapshot();
    c.destroy();
    return markup;
  } finally {
    host.remove();
  }
}

window.HeimDeskCanvas = { create, normalize, previewMarkup, COLORS: COLORS.map(c => Object.assign({}, c)) };
})();
