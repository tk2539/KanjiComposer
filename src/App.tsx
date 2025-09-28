// --- Force stroke color for SVG (Kanji node only) ---
function forceStrokeColor(svgText: string, color = "#fff"): string {
  try {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = doc.querySelector("svg");
    if (!svg) return svgText;

    // Inject a scoped style so even if group styles are lost, paths render consistently
    const style = doc.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = `
      path, line, polyline {
        stroke: ${color} !important;
        stroke-width: 3 !important;
        stroke-linecap: round !important;
        stroke-linejoin: round !important;
        fill: none !important;
        vector-effect: non-scaling-stroke;
      }
    `;
    svg.insertBefore(style, svg.firstChild);

    // Also hard-set attributes on each drawable element (paranoid mode)
    doc.querySelectorAll("path,polyline,line").forEach((el) => {
      el.setAttribute("stroke", color);
      el.setAttribute("stroke-width", "3");
      el.setAttribute("stroke-linecap", "round");
      el.setAttribute("stroke-linejoin", "round");
      el.setAttribute("fill", "none");
      el.setAttribute("vector-effect", "non-scaling-stroke");
    });

    return new XMLSerializer().serializeToString(doc);
  } catch {
    return svgText;
  }
}
// --- Small memo caches and RAF/debounce helper ---

function svgToDataUrlWhite(svgText: string) {
  const white = forceStrokeColor(svgText, "#fff");
  return `data:image/svg+xml;utf8,${encodeURIComponent(white)}`;
}
const rangeSvgCache = new Map<string, string>();
const transformSvgCache = new Map<string, string>();
const compositeSvgCache = new Map<string, string>();
const rafDebounce = (fn: (...a: any[]) => void) => {
  let raf = 0; return (...a: any[]) => { if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(() => fn(...a)); };
};

function cacheKeyRange(base: string, s: number, e: number) {
  return base.length + ":" + s + "-" + e + ":" + base.slice(0, 64);
}
function getRangeSvgCached(base: string, s: number, e: number) {
  const k = cacheKeyRange(base, s, e);
  const hit = rangeSvgCache.get(k);
  if (hit) return hit;
  const out = applyRangeBaked(base, s, e);
  rangeSvgCache.set(k, out);
  return out;
}
function cacheKeyTransform(base: string, x: number, y: number, sx: number, sy: number) {
  return base.length + ":" + x + "," + y + "," + sx + "," + sy + ":" + base.slice(0, 64);
}
function getTransformSvgCached(base: string, x: number, y: number, sx: number, sy: number) {
  const k = cacheKeyTransform(base, x, y, sx, sy);
  const hit = transformSvgCache.get(k); if (hit) return hit;
  const out = applyTransform(base, x, y, sx, sy); transformSvgCache.set(k, out); return out;
}
function cacheKeyComposite(a: string, b: string, aa: number, ab: number, sw: boolean) {
  return a.length + "|" + b.length + "|" + aa + "|" + ab + "|" + (sw ? 1 : 0) + "|" + a.slice(0, 32) + "|" + b.slice(0, 32);
}
function getCompositeSvgCached(a: string, b: string, aa: number, ab: number, sw: boolean) {
  const k = cacheKeyComposite(a, b, aa, ab, sw); const hit = compositeSvgCache.get(k); if (hit) return hit;
  const out = compositeAlpha(a, b, aa, ab, sw); compositeSvgCache.set(k, out); return out;
}
import { bakeStrokes, applyRangeBaked, countStrokes } from "./lib/rangeStroke";

import React from "react";
import ReactFlow, {
  Background,
  Controls,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  Handle,
  Position,
  useStore
} from "reactflow";

import "reactflow/dist/style.css";

/* ===== Web Worker (inline) to offload SVG parsing/composition ===== */
let _worker: Worker | null = null;
let _reqId = 1;
const _pending = new Map<number, (svg: string | null) => void>();

function ensureWorker() {
  if (_worker) return _worker;
  const workerCode = `
    const pad5 = (hex) => hex.padStart(5, "0");
    function code5(ch) {
      const cp = ch.codePointAt(0);
      if (!cp) throw new Error("invalid char");
      return pad5(cp.toString(16).toLowerCase());
    }
    const githubSvgUrl = (c5) => "https://raw.githubusercontent.com/KanjiVG/kanjivg/master/kanji/" + c5 + ".svg";
    const localSvgUrl = (c5) => "/kanji/" + c5 + ".svg";

    async function tryFetch(url, timeoutMs = 6000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: "no-cache" });
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    }

    const svgCache = new Map();
    async function fetchKanjiVGSvg(char) {
      const c5 = code5(char);
      if (svgCache.has(c5)) return svgCache.get(c5);
      const gh = await tryFetch(githubSvgUrl(c5), 6000);
      if (gh) { svgCache.set(c5, gh); return gh; }
      const local = await tryFetch(localSvgUrl(c5), 6000);
      if (local) { svgCache.set(c5, local); return local; }
      throw new Error("KanjiVG not found: " + c5 + ".svg");
    }

    function hideStrokeNumbers(svgText) {
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      doc.querySelectorAll('[id^="kvg:StrokeNumbers_"]').forEach((g) => g.remove());
      return new XMLSerializer().serializeToString(doc);
    }

    // LEAF-ONLY annotateStrokes
    function annotateStrokes(svgText) {
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      // remove numbers/guides
      doc.querySelectorAll('[id^="kvg:StrokeNumbers_"], [id^="kvg:Numbers_"], [id^="kvg:Grid_"], [id^="kvg:Guideline_"]').forEach((n) => n.remove());
      const strokeIdRe = /-s(\\d+)$/;
      const findStrokeIndex = (el) => {
        let cur = el;
        while (cur && cur.tagName !== 'SVG') {
          const id = (cur.getAttribute && cur.getAttribute('id')) || '';
          const m = id.match(strokeIdRe);
          if (m) return m[1];
          cur = cur.parentElement;
        }
        return null;
      };
      Array.from(doc.querySelectorAll('path,polyline,line')).forEach((d) => {
        const idx = findStrokeIndex(d);
        if (idx) d.setAttribute('data-stroke', idx); else d.setAttribute('data-ignore', '1');
      });
      const svg = doc.querySelector('svg');
      if (svg) {
        svg.removeAttribute('width'); svg.removeAttribute('height');
        svg.setAttribute('width','100%'); svg.setAttribute('height','100%');
        svg.setAttribute('viewBox', svg.getAttribute('viewBox') || '0 0 109 109');
        svg.setAttribute('vector-effect','non-scaling-stroke');
        svg.setAttribute('preserveAspectRatio','xMidYMid meet');
      }
      return new XMLSerializer().serializeToString(doc);
    }

    // LEAF-ONLY applyRange
    function applyRange(svgText, start, end) {
      const annotated = annotateStrokes(svgText);
      const doc = new DOMParser().parseFromString(annotated, 'image/svg+xml');
      const svg = doc.querySelector('svg');
      if (!svg) return annotated;

      // reset
      svg.querySelectorAll('[data-stroke],[data-ignore]').forEach((el) => { el.removeAttribute('display'); el.removeAttribute('opacity'); });
      // always hide decorations
      svg.querySelectorAll('[data-ignore="1"]').forEach((el) => el.setAttribute('display','none'));
      // hide all leaves first
      svg.querySelectorAll('path[data-stroke], polyline[data-stroke], line[data-stroke]').forEach((el) => {
        el.setAttribute('display','none');
      });
      // show only in-range leaves and unhide ancestors
      const showEl = (el) => {
        el.removeAttribute('display');
        let p = el.parentElement;
        while (p && p.tagName !== 'SVG') {
          if (p.getAttribute('data-ignore') !== '1') p.removeAttribute('display');
          p = p.parentElement;
        }
      };
      svg.querySelectorAll('path[data-stroke], polyline[data-stroke], line[data-stroke]').forEach((el) => {
        const idx = Number(el.getAttribute('data-stroke') || '0');
        if (idx >= start && idx <= end) showEl(el);
      });

      return new XMLSerializer().serializeToString(doc);
    }
    function applyTransform(svgText, x, y, sx, sy) {
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const svg = doc.querySelector("svg");
      if (!svg) return svgText;
      const g = doc.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("transform", \`translate(\${x||0},\${y||0}) scale(\${sx||1},\${sy||1})\`);
      const keepTags = new Set(["style","defs"]);
      const toMove = [];
      Array.from(svg.children).forEach((c) => {
        const tag = c.tagName.toLowerCase();
        if (!keepTags.has(tag)) toMove.push(c);
      });
      toMove.forEach((c) => g.appendChild(c));
      svg.appendChild(g);
      return new XMLSerializer().serializeToString(doc);
    }
    function composite(svgA, svgB) {
      if (svgA === svgB) return svgA;
      const parser = new DOMParser();
      const a = parser.parseFromString(svgA, "image/svg+xml");
      const b = parser.parseFromString(svgB, "image/svg+xml");
      const out = a.querySelector("svg");
      const inb = b.querySelector("svg");
      if (!out || !inb) return svgA;
      Array.from(inb.children).forEach((child) => out.appendChild(child.cloneNode(true)));
      return new XMLSerializer().serializeToString(a);
    }

    async function evalInWorker(payload) {
      const { type, data } = payload;
      if (type === "kanji") {
        let raw = await fetchKanjiVGSvg(data.char);
        if (data.hideNumbers) raw = hideStrokeNumbers(raw);
        return annotateStrokes(raw);
      }
      if (type === "range") {
        const input = data.input;
        if (!input) return null;
        const start = Number.isFinite(data.start) && data.start > 0 ? data.start : 1;
        const end = Number.isFinite(data.end) ? data.end : Infinity;
        return applyRange(input, start, end);
      }
      if (type === "transform") {
        const input = data.input;
        if (!input) return null;
        return applyTransform(input, data.x||0, data.y||0, data.sx||1, data.sy||1);
      }
      if (type === "composite") {
        const a = data.A, b = data.B;
        if (a && b) return composite(a, b);
        return a || b || null;
      }
      return null;
    }

    self.onmessage = async (e) => {
      const { reqId, payload } = e.data || {};
      let svg = null;
      try {
        svg = await evalInWorker(payload);
      } catch (err) {}
      self.postMessage({ reqId, svg });
    };
  `;
  const blob = new Blob([workerCode], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url, { type: "module" });
  URL.revokeObjectURL(url);
  w.onmessage = (e: MessageEvent<{ reqId: number; svg: string | null }>) => {
    const { reqId, svg } = e.data || {};
    const resolve = _pending.get(reqId);
    if (resolve) {
      _pending.delete(reqId);
      resolve(svg ?? null);
    }
  };
  _worker = w;
  return w;
}

function callWorker(payload: any): Promise<string | null> {
  const w = ensureWorker();
  const reqId = _reqId++;
  return new Promise((resolve) => {
    _pending.set(reqId, resolve);
    w.postMessage({ reqId, payload });
  });
}

type KanjiMeta = { char: string; code5: string; strokeCount: number; radicals: string[] };
// 予備の最小インデックス（/kanji-index.json が無い場合のフォールバック）
const BUILTIN_INDEX: KanjiMeta[] = [
  { char: "永", code5: "06c38", strokeCount: 5, radicals: ["水"] },
  { char: "日", code5: "065e5", strokeCount: 4, radicals: ["日"] },
  { char: "月", code5: "06728", strokeCount: 4, radicals: ["月"] },
  { char: "木", code5: "06728", strokeCount: 4, radicals: ["木"] },
  { char: "水", code5: "06c34", strokeCount: 4, radicals: ["水"] },
  { char: "火", code5: "0706b", strokeCount: 4, radicals: ["火"] },
  { char: "人", code5: "04eba", strokeCount: 2, radicals: ["人"] },
  { char: "口", code5: "053e3", strokeCount: 3, radicals: ["口"] },
  { char: "田", code5: "07531", strokeCount: 5, radicals: ["田"] },
  { char: "心", code5: "05fc3", strokeCount: 4, radicals: ["心"] },
];

/* ===== KanjiVG 取得（GitHub→ローカル フォールバック） ===== */
const pad5 = (hex: string) => hex.padStart(5, "0");
function code5(ch: string): string {
  const cp = ch.codePointAt(0);
  if (!cp) throw new Error("invalid char");
  return pad5(cp.toString(16).toLowerCase()); // U+4E00 -> "04e00"
}
const githubSvgUrl = (c5: string) =>
  `https://raw.githubusercontent.com/KanjiVG/kanjivg/master/kanji/${c5}.svg`;
const localSvgUrl = (c5: string) => `/kanji/${c5}.svg`;

async function tryFetch(url: string, timeoutMs = 5000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-cache" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const svgCache = new Map<string, string>();
// Prepared SVG cache (after optional hide + annotate)
const preparedCache = new Map<string, string>(); // key: char + |hide
async function getPreparedSvg(char: string, hide: boolean): Promise<string> {
  const key = `${char}|${hide ? 1 : 0}`;
  if (preparedCache.has(key)) return preparedCache.get(key)!;
  const raw = await fetchKanjiVGSvg(char);
  const hidden = hide ? hideStrokeNumbers(raw) : raw;
  const annotated = annotateStrokes(hidden);
  const white = forceStrokeColor(annotated, "#fff");
  preparedCache.set(key, white);
  return white;
}
async function fetchKanjiVGSvg(char: string): Promise<string> {
  const c5 = code5(char);
  if (svgCache.has(c5)) return svgCache.get(c5)!;
  const gh = await tryFetch(githubSvgUrl(c5), 6000);
  if (gh) {
    svgCache.set(c5, gh);
    return gh;
  }
  const local = await tryFetch(localSvgUrl(c5), 6000);
  if (local) {
    svgCache.set(c5, local);
    return local;
  }
  throw new Error(`KanjiVG not found (GitHub & local): ${c5}.svg`);
}

async function loadKanjiIndex(): Promise<KanjiMeta[]> {
  try {
    const res = await fetch("/kanji-index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("no index");
    const json = await res.json();

    // 1) 期待その1: 配列形式 [{char, code5, strokeCount, radicals:[]}, ...]
    if (Array.isArray(json)) {
      return json as KanjiMeta[];
    }

    // 2) 期待その2: オブジェクト形式 { "描": { unicode, element, radical, stroke }, ... }
    if (json && typeof json === "object") {
      const out: KanjiMeta[] = [];
      for (const key of Object.keys(json as Record<string, any>)) {
        const v = (json as any)[key];
        if (!v) continue;
        // 正規化: 要求するKanjiMetaへ変換
        const char = v.element ?? key;
        const code5 = (v.unicode ?? "").toString().toLowerCase().padStart(5, "0");
        const strokeCount = Number(v.stroke ?? v.strokes ?? 0);
        const radical = v.radical ?? v.radicals ?? null;
        const radicals = Array.isArray(radical) ? radical : radical ? [radical] : [];
        if (char && code5) {
          out.push({ char, code5, strokeCount, radicals });
        }
      }
      if (out.length > 0) return out;
    }

    // どちらでもなければフォールバック
    return BUILTIN_INDEX;
  } catch {
    return BUILTIN_INDEX;
  }
}

/* ===== ストローク注釈・範囲・変形・合成 ===== */
function annotateStrokes(svgText: string): string {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");

  // ノイズ除去: 番号/グリッド/ガイドは丸ごと削除
  doc
    .querySelectorAll(
      '[id^="kvg:StrokeNumbers_"], [id^="kvg:Numbers_"], [id^="kvg:Grid_"], [id^="kvg:Guideline_"]'
    )
    .forEach((n) => n.remove());

  // 末尾 -sN で終わる要素を「キャリア」として扱う
  const strokeIdRe = /-s(\d+)$/;

  // 与えられた要素に対応する筆画番号を見つける（自身→先祖へ遡る）
  const findStrokeIndex = (el: Element): string | null => {
    let cur: Element | null = el;
    while (cur && cur.tagName !== "SVG") {
      const id = cur.getAttribute("id") || "";
      const m = id.match(strokeIdRe);
      if (m) return m[1];
      cur = cur.parentElement as Element | null;
    }
    return null;
  };

  // すべての描画要素（path/polyline/line）に対して、最寄りの -sN を探し data-stroke を付与
  doc.querySelectorAll("path,polyline,line").forEach((d) => {
    const idx = findStrokeIndex(d as Element);
    if (idx) {
      (d as Element).setAttribute("data-stroke", idx);
    } else {
      // 筆画に紐づかない描画は装飾として無視
      (d as Element).setAttribute("data-ignore", "1");
    }
  });

  // SVG 正規化
  const svg = doc.querySelector("svg");
  if (svg) {
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", svg.getAttribute("viewBox") || "0 0 109 109");
    svg.setAttribute("vector-effect", "non-scaling-stroke");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  }

  return new XMLSerializer().serializeToString(doc);
}
function applyRange(svgText: string, start: number, end: number): string {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) return svgText;

  // まず全要素の display をリセット
  svg.querySelectorAll("[data-stroke],[data-ignore]").forEach((el) => {
    (el as Element).removeAttribute("display");
    (el as Element).removeAttribute("opacity");
  });

  // 装飾は常時非表示
  svg.querySelectorAll('[data-ignore="1"]').forEach((el) => {
    (el as Element).setAttribute("display", "none");
  });

  // いったん全描画要素を隠す
  svg.querySelectorAll("path[data-stroke],polyline[data-stroke],line[data-stroke]").forEach((el) => {
    (el as Element).setAttribute("display", "none");
  });

  // 範囲内の描画だけ表示。親グループが display:none の影響を受けないよう、
  // 祖先の display も外す（装飾グループは除く）
  const showEl = (el: Element) => {
    el.removeAttribute("display");
    let p = el.parentElement as Element | null;
    while (p && p.tagName !== "SVG") {
      if (p.getAttribute("data-ignore") !== "1") p.removeAttribute("display");
      p = p.parentElement as Element | null;
    }
  };

  svg.querySelectorAll("path[data-stroke],polyline[data-stroke],line[data-stroke]").forEach((el) => {
    const idx = Number((el as Element).getAttribute("data-stroke") || "0");
    if (idx >= start && idx <= end) showEl(el as Element);
  });

  return new XMLSerializer().serializeToString(doc);
}
function applyTransform(svgText: string, x: number, y: number, sx: number, sy: number): string {
  try {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = doc.querySelector("svg");
    if (!svg) return svgText;

    const g = doc.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", `translate(${x || 0},${y || 0}) scale(${sx || 1},${sy || 1})`);

    // move drawable children into <g>, keep <style>/<defs> at root so CSS still applies
    const keepTags = new Set(["style", "defs"]); // keep at root
    const toMove: Element[] = [];
    Array.from(svg.children).forEach((c) => {
      const tag = c.tagName.toLowerCase();
      if (!keepTags.has(tag)) toMove.push(c);
    });
    toMove.forEach((c) => g.appendChild(c));

    svg.appendChild(g);
    return new XMLSerializer().serializeToString(doc);
  } catch {
    return svgText;
  }
}
function composite(svgA: string, svgB: string): string {
  if (svgA === svgB) return svgA; // avoid duplicating same tree
  const parser = new DOMParser();
  const a = parser.parseFromString(svgA, "image/svg+xml");
  const b = parser.parseFromString(svgB, "image/svg+xml");
  const out = a.querySelector("svg");
  const inb = b.querySelector("svg");
  if (!out || !inb) return svgA;
  Array.from(inb.children).forEach((child) => out.appendChild(child.cloneNode(true)));
  return new XMLSerializer().serializeToString(a);
}

function compositeAlpha(svgA: string, svgB: string, alphaA = 1, alphaB = 1, swap = false): string {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const parser = new DOMParser();
  const aDoc = parser.parseFromString(svgA, "image/svg+xml");
  const bDoc = parser.parseFromString(svgB, "image/svg+xml");
  const out = aDoc.querySelector("svg");
  const inb = bDoc.querySelector("svg");
  if (!out || !inb) return svgA;

  // Aの子を包む
  const gA = aDoc.createElementNS("http://www.w3.org/2000/svg", "g");
  Array.from(out.children).forEach((c) => gA.appendChild(c));
  gA.setAttribute("opacity", String(clamp(alphaA)));

  // Bの子を包む（複製して持ってくる）
  const gB = aDoc.createElementNS("http://www.w3.org/2000/svg", "g");
  Array.from(inb.children).forEach((c) => gB.appendChild(c.cloneNode(true)));
  gB.setAttribute("opacity", String(clamp(alphaB)));

  // クリアして順番通りに追加
  while (out.firstChild) out.removeChild(out.firstChild);
  if (swap) {
    out.appendChild(gB); // Bの上にA
    out.appendChild(gA);
  } else {
    out.appendChild(gA); // Aの上にB
    out.appendChild(gB);
  }
  return new XMLSerializer().serializeToString(aDoc);
}

/* ===== 書き順番号を非表示にする（任意） ===== */

function hideStrokeNumbers(svgText: string): string {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  doc.querySelectorAll('[id^="kvg:StrokeNumbers_"]').forEach((g) => g.remove());
  return new XMLSerializer().serializeToString(doc);
}

function countStrokesRobust(svgText: string): number {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return 0;

    const hasDisplayNone = (el: Element | null): boolean => {
      while (el && el.tagName !== 'SVG') {
        const disp = (el.getAttribute('display') || '').trim().toLowerCase();
        if (disp === 'none') return true;
        const style = (el.getAttribute('style') || '').toLowerCase();
        if (style.includes('display:none')) return true;
        el = el.parentElement as Element | null;
      }
      return false;
    };

    const visibleNums = new Set<number>();

    // 1) Prefer data-stroke on visible drawable leaves
    doc.querySelectorAll('path[data-stroke],polyline[data-stroke],line[data-stroke]').forEach((el) => {
      if ((el as Element).getAttribute('data-ignore') === '1') return; // skip decorations
      if (hasDisplayNone(el as Element)) return; // hidden by range or ancestor
      const v = Number((el as Element).getAttribute('data-stroke'));
      if (Number.isFinite(v) && v > 0) visibleNums.add(v);
    });

    // 2) Fallback: walk ancestors for ids ending with -sN, but still require visibility
    if (visibleNums.size === 0) {
      const strokeIdRe = /-s(\d+)$/;
      const all = doc.querySelectorAll('path,polyline,line,g');
      all.forEach((el) => {
        if ((el as Element).getAttribute('data-ignore') === '1') return;
        if (hasDisplayNone(el as Element)) return;
        let cur: Element | null = el as Element;
        while (cur && cur.tagName !== 'SVG') {
          const id = cur.getAttribute('id') || '';
          const m = id.match(strokeIdRe);
          if (m) {
            const n = Number(m[1]);
            if (Number.isFinite(n) && n > 0) visibleNums.add(n);
            break;
          }
          cur = cur.parentElement as Element | null;
        }
      });
    }

    if (visibleNums.size > 0) {
      // 筆画番号は 1..N 連番想定だが、念のためユニーク数と最大値の大きい方を返す
      const uniq = visibleNums.size;
      const maxv = Math.max(...Array.from(visibleNums));
      return Math.max(uniq, maxv);
    }
    return 0;
  } catch {
    return 0;
  }
}

/* ===== Kanji ノード ===== */
import { useReactFlow } from "reactflow";
import type { Node as FlowNode } from "reactflow";

const KanjiNode = ({ id, data }: any) => {
  const { char } = data;
  const [svg, setSvg] = React.useState<string | null>(null);
  const { setNodes } = useReactFlow();

  React.useEffect(() => {
    let alive = true;

    // Always fetch SVG for kanji node (no style variants)
    (async () => {
      try {
        // ガード：1文字のみ許可
        if (!char || [...String(char)].length !== 1) {
          if (alive) setSvg(null);
          return;
        }

        // まずはメイン側の安定パイプライン（下流ノードと同じ）
        const prepared = await getPreparedSvg(char, true);
        if (alive) {
          const white = forceStrokeColor(prepared, "#fff");
          setSvg(white);
          const cnt = countStrokesRobust(prepared);
          window.dispatchEvent(new CustomEvent('node-preview', { detail: { id, svg: prepared, count: cnt } }));
          return;
        }
      } catch (e) {
        // メイン側失敗時は Worker にフォールバック
        // （ネットワーク遅延やCORSなどに備える）
      }

      try {
        const resp = await callWorker({ type: "kanji", data: { char, hideNumbers: true } });
        const fallback = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><text x="8" y="36" font-size="12" fill="white" opacity="0.7">N/A</text></svg>`;
        if (alive) {
          if (resp) {
            const cnt = countStrokesRobust(resp);
            setSvg(forceStrokeColor(resp, "#fff"));
            window.dispatchEvent(new CustomEvent('node-preview', { detail: { id, svg: resp, count: cnt } }));
          } else {
            setSvg(fallback);
          }
        }
      } catch (e) {
        console.error(e);
        if (alive) {
          setSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><text x="8" y="36" font-size="12" fill="white" opacity="0.7">N/A</text></svg>`);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [char]);

  return (
    <div className="relative kanji-node border border-white/10 rounded-xl bg-[#121826] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04),0_10px_30px_rgba(0,0,0,0.45)] p-3 w-[240px]">
      <button
        className="absolute top-1 right-1 text-xs bg-red-600 text-white rounded px-1"
        onClick={() => setNodes((nds: FlowNode[]) => nds.filter((n) => n.id !== id))}
        title="Delete node"
      >
        ×
      </button>
      <div className="rounded bg-[#0b1220] border border-white/10 w-full overflow-hidden">
        <div className="w-full grid place-items-center" style={{ aspectRatio: "1 / 1" }}>
          {svg ? (
            <img
              className="w-full h-full overflow-hidden"
              src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
              alt={char}
            />
          ) : (
            <span className="text-xs text-white/60">Loading…</span>
          )}
        </div>
      </div>
      <Handle id="in" type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
};

// --- Range ノード: ベイク + レンジ適用（start/end） ---

type RangeNodeData = { start: number; end: number; setOutputs?: any; setOutputCounts?: any };

const RangeSelectionNode = ({ id, data }: { id: string; data: RangeNodeData }) => {
  const rf = useReactFlow();
  const { setNodes } = rf;

  // Pull setOutputs and setOutputCounts from data (passed from App)
  const setOutputs = data.setOutputs;
  const setOutputCounts = data.setOutputCounts;

  // const previewRef = React.useRef<HTMLDivElement | null>(null);
  const baseRef = React.useRef<{ svg: string; count: number } | null>(null);
  const [count, setCount] = React.useState<number>(0);
  const [start, setStart] = React.useState<number>(data.start ?? 1);
  const [end, setEnd] = React.useState<number>(data.end ?? 1);

  const [imgSrc, setImgSrc] = React.useState<string | null>(null);

  // 入力エッジの sourceId
  const sourceId = useStore((s) => {
    const e = s.edges.find((ed) => ed.target === id && (!ed.targetHandle || ed.targetHandle === undefined));
    return e ? e.source : "";
  });

  // 上流 Kanji から char を取得
  const getUpstreamKanji = React.useCallback(() => {
    if (!sourceId) return null;
    const n = rf.getNode(sourceId) as any;
    if (!n || n.type !== "kanji") return null;
    const { char } = n.data || {};
    if (!char) return null;
    return { char: String(char) };
  }, [rf, sourceId]);

  // ベース（ベイク済み）をロード
  const loadBase = React.useCallback(async () => {
    const up = getUpstreamKanji();
    if (!up) {
      baseRef.current = null;
      setCount(0);
      setImgSrc(null);
      return;
    }
    try {
      const raw = await fetchKanjiVGSvg(up.char);
      const cooked = hideStrokeNumbers(raw);
      const baked = bakeStrokes(cooked);
      baseRef.current = baked;
      rangeSvgCache.clear();
      const c = Math.max(1, baked.count || countStrokes(baked.svg));
      setCount(c);
      setStart((s) => Math.min(Math.max(1, s || 1), c));
      setEnd((e) => Math.min(Math.max(1, e || c), c));
      {
        const sVal = Math.min(start || 1, end || c);
        const eVal = Math.max(start || 1, end || c);
        const svgNow = getRangeSvgCached(baked.svg, sVal, eVal);
        setImgSrc(svgToDataUrlWhite(svgNow));
        window.dispatchEvent(new CustomEvent('node-preview', { detail: { id, svg: svgNow, count: Math.max(0, (eVal - sVal + 1)) } }));
        if (typeof setOutputs === "function") setOutputs((prev: any) => ({ ...prev, [id]: svgNow }));
        if (typeof setOutputCounts === "function") setOutputCounts((prev: any) => ({ ...prev, [id]: Math.max(0, (eVal - sVal + 1)) }));
      }
    } catch (err) {
      console.error(err);
      baseRef.current = null;
      setCount(0);
      setImgSrc(null);
    }
  }, [getUpstreamKanji, setOutputs, setOutputCounts, id, start, end]);

  // 入力変化でロード
  React.useEffect(() => { void loadBase(); }, [loadBase]);

  // Debounced commit for node data
  const commitNodeData = React.useMemo(() => rafDebounce((s: number, e: number) => {
    setNodes((nds: any[]) => nds.map(n => n.id === id ? { ...n, data: { ...n.data, start: s, end: e } } : n));
  }), [id, setNodes]);
  // スライダー変更でプレビュー＆ノードデータ反映
  React.useEffect(() => {
    if (!baseRef.current) return;
    const s = Math.min(start || 1, end || count || 1);
    const e = Math.max(start || 1, end || count || 1);
    const svgNow = getRangeSvgCached(baseRef.current.svg, s, e);
    setImgSrc(svgToDataUrlWhite(svgNow));
    window.dispatchEvent(new CustomEvent('node-preview', { detail: { id, svg: svgNow, count: Math.max(0, (e - s + 1)) } }));
    if (typeof setOutputs === "function") setOutputs((prev: any) => ({ ...prev, [id]: svgNow }));
    if (typeof setOutputCounts === "function") setOutputCounts((prev: any) => ({ ...prev, [id]: Math.max(0, (e - s + 1)) }));
    commitNodeData(s, e);
  }, [start, end, count, id, setNodes, commitNodeData, setOutputs, setOutputCounts]);

  return (
    <div className="relative kanji-node border border-white/10 rounded-xl bg-[#121826] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04),0_10px_30px_rgba(0,0,0,0.45)] p-3 w-64">
      <button
        className="absolute top-1 right-1 text-xs bg-red-600 text-white rounded px-1"
        onClick={() => setNodes((nds: any[]) => nds.filter((n) => n.id !== id))}
        title="Delete node"
      >×</button>

      <div className="text-xs opacity-70 mb-2">RangeSelection</div>

      <div className="rounded bg-[#0b1220] border border-white/10 mb-2 w-full overflow-hidden">
        <div className="w-full grid place-items-center" style={{ aspectRatio: "1 / 1" }}>
          {imgSrc ? (
            <img className="w-full h-full overflow-hidden" src={imgSrc} alt="range" />
          ) : (
            !sourceId
              ? <div className="text-white/60 text-[11px]">左から Kanji を接続</div>
              : <div className="text-white/60 text-[11px]">Loading…</div>
          )}
        </div>
      </div>

      <div className="text-[11px] text-white/80 mb-2">
        総画数: <span className="font-semibold">{count || "-"}</span>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="range" min={1} max={Math.max(1, count)} step={1}
          value={start} onChange={(e) => setStart(parseInt(e.target.value, 10) || 1)}
          className="flex-1"
        />
        <span className="text-xs w-6 text-center">{start}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="range" min={1} max={Math.max(1, count)} step={1}
          value={end} onChange={(e) => setEnd(parseInt(e.target.value, 10) || 1)}
          className="flex-1"
        />
        <span className="text-xs w-6 text-center">{end}</span>
      </div>

      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
};

// --- Transform ノード（上流を再帰評価してプレビュー） ---
type TransformNodeData = {
  x: number; y: number; sx: number; sy: number;
  set: (p: Partial<{ x: number; y: number; sx: number; sy: number }>) => void;
};

const TransformNode = ({ id, data }: { id: string; data: TransformNodeData }) => {
  const rf = useReactFlow();
  const { setNodes } = rf;

  // このノードに入ってくるエッジ（ハンドル未指定＝デフォルト入力）
  const sourceId = useStore((s) => {
    const e = s.edges.find((ed) => ed.target === id && (!ed.targetHandle || ed.targetHandle === undefined));
    return e ? e.source : "";
  });

  // 全エッジ（再帰評価で使う）
  const edgesAll = useStore((s) => s.edges);

  const baseRef = React.useRef<string | null>(null);
  // const previewRef = React.useRef<HTMLDivElement | null>(null);
  const upstreamCountRef = React.useRef<number | null>(null);

  const [imgSrc, setImgSrc] = React.useState<string | null>(null);

  const setDebounced = React.useMemo(() => rafDebounce((p: any) => data.set(p)), [data]);
  // 上流を評価して SVG を返す軽量再帰（メモ化あり）
  const evalNodeSvg = React.useCallback(async (nodeId: string, depth = 0, memo = new Map<string, Promise<string | null>>()): Promise<string | null> => {
    if (!nodeId) return null;
    if (depth > 20) return null; // 事故防止
    if (memo.has(nodeId)) return memo.get(nodeId)!;

    const p = (async () => {
      const node = rf.getNode(nodeId) as any;
      if (!node) return null;

      // ヘルパ：特定ハンドルの上流 SVG を取得
      const getIn = async (handle?: string) => {
        const edge = edgesAll.find(e => e.target === nodeId && (handle ? e.targetHandle === handle : !e.targetHandle));
        return edge ? await evalNodeSvg(edge.source, depth + 1, memo) : null;
      };

      if (node.type === "kanji") {
        const ch = node.data?.char as string;
        if (!ch) return null;
        return await getPreparedSvg(ch, true);
      }

      if (node.type === "range") {
        const input = await getIn();
        if (!input) return null;
        const baked = bakeStrokes(input);
        const maxC = baked.count || countStrokes(baked.svg) || 1;
        const sRaw = Number(node.data?.start) || 1;
        const eRaw = Number(node.data?.end) || maxC;
        const s = Math.min(Math.max(1, Math.min(sRaw, eRaw)), maxC);
        const e = Math.min(Math.max(1, Math.max(sRaw, eRaw)), maxC);
        return applyRangeBaked(baked.svg, s, e);
      }

      if (node.type === "transform") {
        const input = await getIn();
        if (!input) return null;
        const x = Number(node.data?.x ?? 0);
        const y = Number(node.data?.y ?? 0);
        const sx = Number(node.data?.sx ?? 1);
        const sy = Number(node.data?.sy ?? 1);
        return applyTransform(input, x, y, sx, sy);
      }

      if (node.type === "composite") {
        const a = await getIn("A");
        const b = await getIn("B");
        if (a && b) return composite(a, b);
        return a || b;
      }

      return null;
    })();

    memo.set(nodeId, p);
    return p;
  }, [rf, edgesAll]);

  // 入力が変わった/パラメータが変わったらプレビュー更新
  const refresh = React.useCallback(async () => {
    baseRef.current = null;
    if (!sourceId) { setImgSrc(null); return; }

    const upstream = await evalNodeSvg(sourceId);
    baseRef.current = upstream;

    const svgNow = upstream
      ? getTransformSvgCached(upstream, data.x, data.y, data.sx, data.sy)
      : "";
    setImgSrc(svgNow ? svgToDataUrlWhite(svgNow) : null);
    if (svgNow) {
      const cnt = upstreamCountRef.current ?? countStrokesRobust(svgNow);
      window.dispatchEvent(new CustomEvent('node-preview', { detail: { id, svg: svgNow, count: cnt } }));
    }
  }, [sourceId, data.x, data.y, data.sx, data.sy, evalNodeSvg]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  // x/y/sx/sy 変更時は都度再描画（上流は据え置き）
  React.useEffect(() => {
    if (!baseRef.current) return;
    const svgNow = getTransformSvgCached(baseRef.current, data.x, data.y, data.sx, data.sy);
    setImgSrc(svgToDataUrlWhite(svgNow));
    const cnt = upstreamCountRef.current ?? countStrokesRobust(svgNow);
    window.dispatchEvent(new CustomEvent('node-preview', { detail: { id, svg: svgNow, count: cnt } }));
  }, [data.x, data.y, data.sx, data.sy]);

  // 上流ノード(Range/Kanji/Transform/Composite)からのプレビュー更新を受け取り、自身も更新
  React.useEffect(() => {
    const handler = (e: any) => {
      const { id: fromId, svg, count } = (e.detail || {}) as { id?: string; svg?: string; count?: number };
      if (!svg) return;
      if (fromId !== sourceId) return; // 自分の入力ではない
      // 上流SVGを差し替えて、現在のTransformパラメータで再描画
      baseRef.current = svg;
      upstreamCountRef.current = (e.detail && typeof e.detail.count === 'number') ? e.detail.count : countStrokesRobust(svg);
      const svgNow = getTransformSvgCached(svg, data.x, data.y, data.sx, data.sy);
      setImgSrc(svgToDataUrlWhite(svgNow));
      const cnt = upstreamCountRef.current ?? countStrokesRobust(svgNow);
      window.dispatchEvent(new CustomEvent('node-preview', { detail: { id, svg: svgNow, count: cnt } }));
    };
    window.addEventListener('node-preview', handler as EventListener);
    return () => window.removeEventListener('node-preview', handler as EventListener);
  }, [sourceId, data.x, data.y, data.sx, data.sy, id]);

  // ドラッグ/ホイール操作（既存のUIそのまま）
  const dragState = React.useRef({ startX: 0, startY: 0, ox: 0, oy: 0, dragging: false });
  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, ox: data.x, oy: data.y, dragging: true };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragState.current.dragging) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    setDebounced({ x: Math.round(dragState.current.ox + dx), y: Math.round(dragState.current.oy + dy) });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    dragState.current.dragging = false;
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!e.altKey && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = -Math.sign(e.deltaY) * 0.05;
    if (e.ctrlKey || e.metaKey) {
      setDebounced({ sy: Math.max(0.05, +(data.sy + delta).toFixed(2)) });
    } else {
      setDebounced({ sx: Math.max(0.05, +(data.sx + delta).toFixed(2)) });
    }
  };
  const reset = () => setDebounced({ x: 0, y: 0, sx: 1, sy: 1 });

  return (
    <div className="relative kanji-node border border-white/10 rounded-xl bg-[#121826] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04),0_10px_30px_rgba(0,0,0,0.45)] p-3 w-[300px]">
      <button
        className="absolute top-1 right-1 text-xs bg-red-600 text-white rounded px-1"
        onClick={() => setNodes((nds: any[]) => nds.filter((n) => n.id !== id))}
        title="Delete node"
      >×</button>

      <div className="text-xs opacity-70 mb-2">Transform</div>

      {/* 正方形プレビュー */}
      <div className="rounded bg-[#0b1220] border border-white/10 mb-2 w-full overflow-hidden select-none">
        <div
          className="w-full grid place-items-center relative"
          style={{ aspectRatio: "1 / 1" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={reset}
          onWheel={onWheel}
          title="ドラッグで移動 / Alt+ホイール=拡大縮小 / Ctrl(or ⌘)+ホイール=縦だけ拡大縮小 / ダブルクリック=リセット"
        >
          {imgSrc ? (
            <img className="w-full h-full overflow-hidden" src={imgSrc} alt="transform" />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-white/60 text-[11px]">
              {sourceId ? "Loading…" : "左から入力を接続してください"}
            </div>
          )}
        </div>
      </div>

      {/* スライダーUI（既存） */}
      <div className="grid grid-cols-[auto,1fr_auto] gap-x-2 gap-y-2 text-sm">
        <span>X</span>
        <input type="range" min={-200} max={200} step={1}
          value={data.x} onChange={(e) => setDebounced({ x: Number(e.target.value) })} />
        <input type="number" className="w-16 px-2 py-1 rounded bg-[#0b1220] border border-white/10"
          value={data.x} onChange={(e) => setDebounced({ x: Number(e.target.value) })} />

        <span>Y</span>
        <input type="range" min={-200} max={200} step={1}
          value={data.y} onChange={(e) => setDebounced({ y: Number(e.target.value) })} />
        <input type="number" className="w-16 px-2 py-1 rounded bg-[#0b1220] border border-white/10"
          value={data.y} onChange={(e) => setDebounced({ y: Number(e.target.value) })} />

        <span>ScaleX</span>
        <input type="range" min={0.05} max={3} step={0.01}
          value={data.sx} onChange={(e) => setDebounced({ sx: Number(e.target.value) })} />
        <input type="number" className="w-16 px-2 py-1 rounded bg-[#0b1220] border border-white/10"
          value={data.sx} onChange={(e) => setDebounced({ sx: Number(e.target.value) })} />

        <span>ScaleY</span>
        <input type="range" min={0.05} max={3} step={0.01}
          value={data.sy} onChange={(e) => setDebounced({ sy: Number(e.target.value) })} />
        <input type="number" className="w-16 px-2 py-1 rounded bg-[#0b1220] border border-white/10"
          value={data.sy} onChange={(e) => setDebounced({ sy: Number(e.target.value) })} />
      </div>

      <div className="mt-2 text-right">
        <button onClick={reset}
          className="text-xs px-2 py-1 rounded bg-[#1f2a44] border border-white/10">
          Reset
        </button>
      </div>

      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
};

const CompositeNode = ({ id, data }: { id: string; data: { alphaA?: number; alphaB?: number; swap?: boolean } }) => {
  const rf = useReactFlow();
  const { setNodes } = rf;

  // 入力エッジ（A/B）の source
  const srcA = useStore((s) => {
    const e = s.edges.find((ed) => ed.target === id && ed.targetHandle === "A");
    return e ? e.source : "";
  });
  const srcB = useStore((s) => {
    const e = s.edges.find((ed) => ed.target === id && ed.targetHandle === "B");
    return e ? e.source : "";
  });
  const edgesAll = useStore((s) => s.edges);

  // const previewRef = React.useRef<HTMLDivElement | null>(null);
  const [imgSrc, setImgSrc] = React.useState<string | null>(null);
  const [local, setLocal] = React.useState({
    alphaA: data.alphaA ?? 1,
    alphaB: data.alphaB ?? 1,
    swap: !!data.swap,
  });
  const countARef = React.useRef<number | null>(null);
  const countBRef = React.useRef<number | null>(null);

  // 上流を評価してSVGを返す（TransformNodeと同じノリ）
  const evalNodeSvg = React.useCallback(
    async (
      nodeId: string,
      depth = 0,
      memo = new Map<string, Promise<string | null>>()
    ): Promise<string | null> => {
      if (!nodeId) return null;
      if (depth > 20) return null;
      if (memo.has(nodeId)) return memo.get(nodeId)!;

      const p = (async () => {
        const node = rf.getNode(nodeId) as any;
        if (!node) return null;

        const getIn = async (handle?: string) => {
          const e = edgesAll.find(
            (ed) => ed.target === nodeId && (handle ? ed.targetHandle === handle : !ed.targetHandle)
          );
          return e ? await evalNodeSvg(e.source, depth + 1, memo) : null;
        };

        if (node.type === "kanji") {
          const ch = node.data?.char as string;
          if (!ch) return null;
          return await getPreparedSvg(ch, true);
        }
        if (node.type === "range") {
          const input = await getIn();
          if (!input) return null;
          const baked = bakeStrokes(input);
          const maxC = baked.count || countStrokes(baked.svg) || 1;
          const sRaw = Number(node.data?.start) || 1;
          const eRaw = Number(node.data?.end) || maxC;
          const s = Math.min(Math.max(1, Math.min(sRaw, eRaw)), maxC);
          const e = Math.min(Math.max(1, Math.max(sRaw, eRaw)), maxC);
          return applyRangeBaked(baked.svg, s, e);
        }
        if (node.type === "transform") {
          const input = await getIn();
          if (!input) return null;
          const x = Number(node.data?.x ?? 0);
          const y = Number(node.data?.y ?? 0);
          const sx = Number(node.data?.sx ?? 1);
          const sy = Number(node.data?.sy ?? 1);
          return applyTransform(input, x, y, sx, sy);
        }
        if (node.type === "composite") {
          const a = await getIn("A");
          const b = await getIn("B");
          const aa = Number(node.data?.alphaA ?? 1);
          const ab = Number(node.data?.alphaB ?? 1);
          const sw = !!node.data?.swap;
          if (a && b) return compositeAlpha(a, b, aa, ab, sw);
          return a || b;
        }
        return null;
      })();

      memo.set(nodeId, p);
      return p;
    },
    [rf, edgesAll]
  );

  const setDataDebounced = React.useMemo(() => rafDebounce((patch: any) => {
    setLocal(v => ({ ...v, ...patch }));
    setNodes((nds: any[]) => nds.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
  }), [id, setNodes]);
  const refresh = React.useCallback(async () => {
    const a = srcA ? await evalNodeSvg(srcA) : null;
    const b = srcB ? await evalNodeSvg(srcB) : null;
    const svg = a && b ? getCompositeSvgCached(a, b, local.alphaA, local.alphaB, local.swap) : a || b || "";
    setImgSrc(svg ? svgToDataUrlWhite(svg) : null);
    if (svg) {
      if (a) countARef.current = countARef.current ?? countStrokesRobust(a);
      if (b) countBRef.current = countBRef.current ?? countStrokesRobust(b);
      const sum = (countARef.current ?? 0) + (countBRef.current ?? 0);
      window.dispatchEvent(new CustomEvent('node-preview', { detail: { id, svg, count: sum } }));
    }
  }, [srcA, srcB, local.alphaA, local.alphaB, local.swap, evalNodeSvg]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // A/B いずれかの上流からプレビューが届いたら合成を更新
  React.useEffect(() => {
    const handler = (e: any) => {
      const { id: fromId, svg, count } = (e.detail || {}) as { id?: string; svg?: string; count?: number };
      if (!svg) return;
      if (fromId !== srcA && fromId !== srcB) return; // 自分の入力ではない
      // 最新のA/B SVGをそれぞれ取り直してキャッシュ合成
      (async () => {
        let a = srcA && fromId === srcA ? svg : (srcA ? await evalNodeSvg(srcA) : null);
        let b = srcB && fromId === srcB ? svg : (srcB ? await evalNodeSvg(srcB) : null);

        // 更新元に応じてカウントも反映
        if (fromId === srcA) {
          countARef.current = (e.detail && typeof e.detail.count === 'number') ? e.detail.count : (a ? countStrokesRobust(a) : null);
        }
        if (fromId === srcB) {
          countBRef.current = (e.detail && typeof e.detail.count === 'number') ? e.detail.count : (b ? countStrokesRobust(b) : null);
        }

        const out = a && b ? getCompositeSvgCached(a, b, local.alphaA, local.alphaB, local.swap) : (a || b || "");
        setImgSrc(out ? svgToDataUrlWhite(out) : null);
        if (out) {
          const sum = (countARef.current ?? (a ? countStrokesRobust(a) : 0)) + (countBRef.current ?? (b ? countStrokesRobust(b) : 0));
          window.dispatchEvent(new CustomEvent('node-preview', { detail: { id, svg: out, count: sum } }));
        }
      })();
    };
    window.addEventListener('node-preview', handler as EventListener);
    return () => window.removeEventListener('node-preview', handler as EventListener);
  }, [srcA, srcB, local.alphaA, local.alphaB, local.swap, id, evalNodeSvg]);


  return (
    <div className="relative kanji-node border border-white/10 rounded-xl bg-[#121826] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04),0_10px_30px_rgba(0,0,0,0.45)] p-3 w-[300px]">
      <button
        className="absolute top-1 right-1 text-xs bg-red-600 text-white rounded px-1"
        onClick={() => setNodes((nds: any[]) => nds.filter((n) => n.id !== id))}
        title="Delete node"
      >
        ×
      </button>

      <div className="text-xs opacity-70 mb-2">Composite</div>

      {/* 正方形プレビュー */}
      <div className="rounded bg-[#0b1220] border border-white/10 mb-2 w-full overflow-hidden">
        <div className="w-full grid place-items-center" style={{ aspectRatio: "1 / 1" }}>
          {imgSrc ? (
            <img className="w-full h-full overflow-hidden" src={imgSrc} alt="composite" />
          ) : (
            (!srcA && !srcB)
              ? <div className="text-white/60 text-[11px]">左から A / B を接続</div>
              : <div className="text-white/60 text-[11px]">Loading…</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[auto,1fr_auto] gap-x-2 gap-y-2 text-sm">
        <span>A α</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={local.alphaA}
          onChange={(e) => setDataDebounced({ alphaA: Number(e.target.value) })}
        />
        <input
          type="number"
          className="w-16 px-2 py-1 rounded bg-[#0b1220] border border-white/10"
          value={local.alphaA}
          min={0}
          max={1}
          step={0.05}
          onChange={(e) => setDataDebounced({ alphaA: Number(e.target.value) })}
        />

        <span>B α</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={local.alphaB}
          onChange={(e) => setDataDebounced({ alphaB: Number(e.target.value) })}
        />
        <input
          type="number"
          className="w-16 px-2 py-1 rounded bg-[#0b1220] border border-white/10"
          value={local.alphaB}
          min={0}
          max={1}
          step={0.05}
          onChange={(e) => setDataDebounced({ alphaB: Number(e.target.value) })}
        />
      </div>

      <div className="mt-2 flex items-center justify-between text-xs">
        <div className="text-white/70">描画順: {local.swap ? "B → A" : "A → B"}</div>
        <button
          onClick={() => setDataDebounced({ swap: !local.swap })}
          className="px-2 py-1 rounded bg-[#1f2a44] border border-white/10"
        >
          Swap
        </button>
      </div>

      <Handle id="A" type="target" position={Position.Left} style={{ top: 28 }} />
      <Handle id="B" type="target" position={Position.Left} style={{ top: 54 }} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
};

// Wrap RangeSelectionNode to inject setOutputs/setOutputCounts from App
const nodeTypes = {
  kanji: KanjiNode,
  range: (props: any) => (
    <RangeSelectionNode
      {...props}
      data={{
        ...props.data,
        setOutputs: props.data.setOutputs,
        setOutputCounts: props.data.setOutputCounts,
      }}
    />
  ),
  transform: TransformNode,
  composite: CompositeNode,
};

/* ===== App ===== */
export default function App() {
  // 初期は空
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const onConnect = React.useCallback(
    (params: any) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  // 追加用UIの状態
  const [newChar, setNewChar] = React.useState("");

  // サイドバー状態とインデックス
  const [sidebarOpen] = React.useState(true);
  const [leftOpen, setLeftOpen] = React.useState(true); // 左サイド（検索）開閉
  const [rightOpen, setRightOpen] = React.useState(true); // 右サイド（プレビュー）開閉
  const [kanjiIndex, setKanjiIndex] = React.useState<KanjiMeta[]>([]);
  const [filterRadical, setFilterRadical] = React.useState("");
  const [filterMin, setFilterMin] = React.useState<number | "">("");
  const [filterMax, setFilterMax] = React.useState<number | "">("");
  // manual evaluation toggle
  const [autoEval, setAutoEval] = React.useState(true);
  const [evalTick, setEvalTick] = React.useState(0);
  const triggerEval = () => setEvalTick(t => t + 1);
  // ページング
  const [page, setPage] = React.useState(0);
  const PAGE_SIZE = 60; // 1ページあたり表示数（3列グリッドに合わせて調整可）
  React.useEffect(() => {
    loadKanjiIndex().then(setKanjiIndex).catch(() => setKanjiIndex(BUILTIN_INDEX));
  }, []);
  const filtered = React.useMemo(() => {
    const r = (filterRadical || "").trim();
    const min = typeof filterMin === "number" ? filterMin : -Infinity;
    const max = typeof filterMax === "number" ? filterMax : Infinity;
    return kanjiIndex.filter(k =>
      (r ? k.radicals.some(x => x.includes(r)) : true) &&
      k.strokeCount >= min && k.strokeCount <= max
    );
  }, [kanjiIndex, filterRadical, filterMin, filterMax]);
  React.useEffect(() => {
    setPage(0);
  }, [filterRadical, filterMin, filterMax, kanjiIndex]);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageItems = React.useMemo(() =>
    filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
    [filtered, currentPage, PAGE_SIZE]);

  // ノードID採番 & 配置
  const idRef = React.useRef(1);
  const nextId = () => String(idRef.current++);
  const layoutRef = React.useRef({ x: 60, y: 60 });
  const nextPos = () => {
    // ざっくり右へ並べ、はみ出したら下の段へ
    const pos = { ...layoutRef.current };
    layoutRef.current.x += 140;
    if (layoutRef.current.x > 800) {
      layoutRef.current.x = 60;
      layoutRef.current.y += 160;
    }
    return pos;
  };

  // --- Arrange nodes by type: columns (Kanji / Range / Transform / Composite) ---
  const layoutByType = React.useCallback(() => {
    setNodes((nds: any[]) => {
      // Updated column x-positions for more margin
      const colX: Record<string, number> = {
        kanji: 100,
        range: 400,
        transform: 700,
        composite: 1000,
      };
      // For dynamic vertical spacing
      const top = 80;
      const bottom = 80;
      const canvasHeight = 800;

      // keep original ordering within each type by current y (then by id as tiebreaker)
      const byType: Record<string, any[]> = { kanji: [], range: [], transform: [], composite: [] };
      nds.forEach((n) => {
        const t = (n.type as string) || 'kanji';
        if (byType[t as keyof typeof byType]) byType[t].push(n); else byType.kanji.push(n);
      });
      (Object.keys(byType) as (keyof typeof byType)[]).forEach((k) => {
        byType[k].sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0) || (Number(a.id) - Number(b.id)));
      });

      // rebuild in original order but with new positions
      const idToPos: Record<string, { x: number; y: number }> = {};
      (Object.keys(byType) as (keyof typeof byType)[]).forEach((k) => {
        const list = byType[k];
        const count = list.length;
        const availableHeight = canvasHeight - top - bottom;
        const gap = count > 0 ? (availableHeight / Math.max(count, 1)) : 0;
        list.forEach((n, idx) => {
          idToPos[n.id] = { x: colX[k], y: top + idx * gap };
        });
      });

      return nds.map((n) => ({ ...n, position: idToPos[n.id] ? idToPos[n.id] : n.position }));
    });
  }, [setNodes]);

  const addChar = (c: string) => {
    const ch = c.trim();
    if (!ch) return;
    if ([...ch][0] !== ch) {
      alert("1文字だけ入力してください");
      return;
    }
    const id = nextId();
    setNodes((nds) => [
      ...nds,
      { id, type: "kanji", position: nextPos(), data: { char: ch } }
    ]);
    setPreviewId(id); // 追加文字をプレビュー対象に
  };
  const addKanji = () => addChar(newChar);

  // 出力とプレビューID
  const [outputs, setOutputs] = React.useState<Record<string, string | null>>({});
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [outputCounts, setOutputCounts] = React.useState<Record<string, number>>({});

  const [pngSize, setPngSize] = React.useState<number>(1024);

  // --- Settings / behavior toggles ---
  const [followSelection, setFollowSelection] = React.useState(true);  // 選択に自動追従
  const [snapToColumns, setSnapToColumns] = React.useState(false);    // 整列スナップ
  const [showSettings, setShowSettings] = React.useState(false);      // 設定モーダル開閉

  // --- Busy indicator for toolbar status ---
  const [busy, setBusy] = React.useState<"idle" | "queue" | "running">("idle");

  // --- React Flow instance (fitView 用) ---
  const rfRef = React.useRef<any | null>(null);

  const downloadBlob = React.useCallback((filename: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const extractViewBox = (svgText: string): { w: number; h: number } => {
    try {
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const svg = doc.querySelector('svg');
      if (!svg) return { w: 109, h: 109 };
      const vb = (svg.getAttribute('viewBox') || '').trim();
      if (vb) {
        const parts = vb.split(/\s+/).map(Number);
        if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
          return { w: Math.max(1, parts[2]), h: Math.max(1, parts[3]) };
        }
      }
      const w = Number(svg.getAttribute('width') || '109');
      const h = Number(svg.getAttribute('height') || '109');
      return { w: Math.max(1, w), h: Math.max(1, h) };
    } catch {
      return { w: 109, h: 109 };
    }
  };

  const handleSaveSVG = React.useCallback(() => {
    if (!previewId) return;
    const raw = outputs[previewId];
    if (!raw) return;

    // 1) Ensure white strokes (as in on-screen preview)
    const svgWhite = forceStrokeColor(raw, '#fff');

    // 2) Parse and normalize geometry
    const doc = new DOMParser().parseFromString(svgWhite, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return;

    // Extract viewBox for sizing
    const vbAttr = (svg.getAttribute('viewBox') || '0 0 109 109').trim();
    const parts = vbAttr.split(/\s+/).map(Number);
    const vb = (parts.length === 4 && parts.every(Number.isFinite)) ? parts : [0, 0, 109, 109];
    const size = Math.max(16, Math.min(4096, Number(pngSize) || 1024));

    // 3) Use explicit pixel size so standalone viewers render correctly
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));

    // 4) Insert black background so white strokes are visible on white viewers
    const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(vb[0]));
    rect.setAttribute('y', String(vb[1]));
    rect.setAttribute('width', String(vb[2]));
    rect.setAttribute('height', String(vb[3]));
    rect.setAttribute('fill', '#000');
    // place as the very first drawable element (before strokes)
    svg.insertBefore(rect, svg.firstChild);

    const out = new XMLSerializer().serializeToString(doc);
    const blob = new Blob([out], { type: 'image/svg+xml;charset=utf-8' });
    downloadBlob(`${previewId}.svg`, blob);
  }, [outputs, previewId, pngSize, downloadBlob]);

  const handleSavePNG = React.useCallback(async () => {
    if (!previewId) return;
    const raw = outputs[previewId];
    if (!raw) return;

    // 1) SVG（白ストローク）をそのまま黒背景に描画して書き出し
    const svgWhite = forceStrokeColor(raw, '#fff');
    const { w: vbw, h: vbh } = extractViewBox(svgWhite);
    const size = Math.max(16, Math.min(4096, Number(pngSize) || 1024));

    // 正方形に contain でフィット
    const scale = Math.min(size / vbw, size / vbh);
    const dw = vbw * scale;
    const dh = vbh * scale;
    const dx = (size - dw) / 2;
    const dy = (size - dh) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 背景を黒で塗る（透過なし）
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.restore();

    // SVG を描画（白ストローク）
    const img = new Image();
    img.decoding = 'sync';
    img.crossOrigin = 'anonymous';
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgWhite)}`;

    await new Promise((res, rej) => { img.onload = () => res(null); img.onerror = rej; });

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, dx, dy, dw, dh);

    canvas.toBlob((blob) => {
      if (blob) downloadBlob(`${previewId}_${size}.png`, blob);
    }, 'image/png');
  }, [outputs, previewId, pngSize, downloadBlob]);

  // グラフ評価（選択中ノードのみ）
  React.useEffect(() => {
    let cancelled = false;
    if (!autoEval) return;
    if (!previewId) return;

    const t = setTimeout(() => {
      const byId: Record<string, any> = Object.fromEntries(nodes.map((n) => [n.id, n]));
      const ins = (id: string) => edges.filter((e) => e.target === id);
      const memo = new Map<string, Promise<string | null>>();

      // Fallback SVG for preview error states
      const FALLBACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><text x="8" y="36" font-size="12" fill="white" opacity="0.7">N/A</text></svg>';

      const evalNode = async (id: string): Promise<string | null> => {
        if (memo.has(id)) return memo.get(id)!;
        const n = byId[id]; if (!n) return null;

        // 依存を先に評価
        ins(id).forEach((e) => {
          if (!memo.has(e.source)) memo.set(e.source, evalNode(e.source));
        });

        const p = (async () => {
          const getIn = async (handle?: string): Promise<string | null> => {
            const edge = ins(id).find((e) => (handle ? e.targetHandle === handle : true));
            if (!edge) return null;
            return await memo.get(edge.source)!;
          };

          if (n.type === "kanji") {
            const ch = n.data?.char as string | undefined;
            if (!ch) return null;
            try {
              return await getPreparedSvg(ch, true);
            } catch (e) {
              try {
                const svg = await callWorker({ type: "kanji", data: { char: ch, hideNumbers: true } });
                return svg ?? null;
              } catch {
                return null;
              }
            }
          }
          if (n.type === "range") {
            const input = await getIn();
            if (!input) return null;
            const baked = bakeStrokes(input);
            const s = Math.max(1, Math.min(Number(n.data.start) || 1, baked.count || 1));
            const e = Math.max(1, Math.min(Number(n.data.end) || baked.count || 1, baked.count || 1));
            return applyRangeBaked(baked.svg, Math.min(s, e), Math.max(s, e));
          }
          if (n.type === "transform") {
            const input = await getIn();
            if (!input) return null;
            const x = Number(n.data.x || 0);
            const y = Number(n.data.y || 0);
            const sx = Number(n.data.sx || 1);
            const sy = Number(n.data.sy || 1);
            return applyTransform(input, x, y, sx, sy);
          }
          if (n.type === "composite") {
            const a = await getIn("A");
            const b = await getIn("B");
            const alphaA = Number(n.data?.alphaA ?? 1);
            const alphaB = Number(n.data?.alphaB ?? 1);
            const swap = !!n.data?.swap;
            if (a && b) return compositeAlpha(a, b, alphaA, alphaB, swap);
            return a || b;
          }
          return null;
        })();

        memo.set(id, p);
        return p;
      };

      (async () => {
        const svg = await evalNode(previewId);
        if (!cancelled) {
          if (svg) {
            setOutputs({ [previewId]: svg });
            const sc = countStrokesRobust(svg);
            setOutputCounts({ [previewId]: sc });
          }
          // if svg is null, keep previous preview as-is
        }
      })();
    }, 80);
    return () => { clearTimeout(t); cancelled = true; };
  }, [nodes, edges, previewId, autoEval, evalTick]);

  // Listen for node-preview events to update sidebar preview in real time
  React.useEffect(() => {
    const handler = (e: any) => {
      const { id: fromId, svg, count } = (e.detail || {}) as { id?: string; svg?: string; count?: number };
      if (!fromId || fromId !== previewId || !svg) return;
      setOutputs({ [fromId]: svg });
      // setOutputCounts({ [fromId]: count }); // [stroke count update is disabled]
    };
    window.addEventListener('node-preview', handler as EventListener);
    return () => window.removeEventListener('node-preview', handler as EventListener);
  }, [previewId]);

  // previewId が削除された場合のフォールバック
  React.useEffect(() => {
    if (!previewId) return;
    if (!nodes.find((n) => n.id === previewId)) {
      setPreviewId(nodes.length ? nodes[nodes.length - 1].id : null);
    }
  }, [nodes, previewId]);

  // ===== Keyboard Shortcuts =====
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ignore if focus is on input/textarea/select or contenteditable
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase?.() ?? "";
      const isEditable =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (e.target as HTMLElement)?.isContentEditable;
      if (isEditable) return;

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // For key, always use lower-case
      const k = e.key.toLowerCase();
      if (k === "r") {
        // Cmd/Ctrl+R → Add Range node
        e.preventDefault();
        const id = nextId();
        setNodes(nds => [...nds, {
          id, type: "range", position: nextPos(),
          data: { start: 1, end: 1 }
        }]);
        setPreviewId(id);
      } else if (k === "t") {
        // Cmd/Ctrl+T → Add Transform node
        e.preventDefault();
        const id = nextId();
        setNodes(nds => [...nds, {
          id, type: "transform", position: nextPos(),
          data: { x: 0, y: 0, sx: 1, sy: 1, set: (() => { const f = rafDebounce((p: any) => setNodes(n2 => n2.map(n => n.id === id ? { ...n, data: { ...n.data, ...p } } : n))); return f; })() }
        }]);
        setPreviewId(id);
      } else if (k === "c") {
        // Cmd/Ctrl+C → Add Composite node
        e.preventDefault();
        const id = nextId();
        setNodes(nds => [...nds, { id, type: "composite", position: nextPos(), data: { alphaA: 1, alphaB: 1, swap: false } }]);
        setPreviewId(id);
      } else if (k === "s") {
        // Cmd/Ctrl+S → Save SVG
        e.preventDefault();
        handleSaveSVG();
      } else if (k === "p") {
        // Cmd/Ctrl+P → Save PNG
        e.preventDefault();
        handleSavePNG();
      } else if (k === "z") {
        // Cmd/Ctrl+Z → Undo last node (remove most recent node)
        e.preventDefault();
        setNodes(nds => {
          if (nds.length === 0) return nds;
          const newNds = nds.slice(0, -1);
          // If previewId was the removed node, update to last node or null
          if (previewId === nds[nds.length - 1].id) {
            setPreviewId(newNds.length ? newNds[newNds.length - 1].id : null);
          }
          return newNds;
        });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setNodes, setPreviewId, handleSaveSVG, handleSavePNG, nextId, nextPos, previewId]);

  // Handle node deletion from ReactFlow
  const onNodesDelete = React.useCallback(
    (deleted: FlowNode[]) => {
      setNodes((nds) => nds.filter((n) => !deleted.find((d) => d.id === n.id)));
    },
    [setNodes]
  );

  // Prepare nodeTypes with setOutputs/setOutputCounts injected for RangeSelectionNode
  // (used below in ReactFlow)

  // When rendering nodes, inject setOutputs/setOutputCounts into RangeSelectionNode's data
  const nodesWithInjected = React.useMemo(() => {
    return nodes.map(n => {
      if (n.type === "range") {
        return {
          ...n,
          data: {
            ...n.data,
            setOutputs,
            setOutputCounts,
          }
        };
      }
      return n;
    });
  }, [nodes, setOutputs, setOutputCounts]);

  return (
    <ReactFlowProvider>
      <div className="h-screen w-screen flex bg-[#0b1020] text-white">
        {sidebarOpen && (
          <>
            <aside
              className={`${leftOpen ? 'w-[360px]' : 'w-0'} shrink-0 border-r border-white/10 bg-[#0e1424] flex flex-col overflow-hidden transition-[width] duration-200`}
            >
              <div className="p-3 border-b border-white/10 text-sm font-medium">検索 / 追加</div>
              <div className="p-3 border-b border-white/10 grid gap-3 text-sm">
                <div className="grid grid-cols-[80px,1fr] items-center gap-2">
                  <label className="text-white/70">部首</label>
                  <input
                    className="px-2 py-1 rounded bg-[#0b1220] border border-white/10"
                    placeholder="例: 扌, 氵, 心 …"
                    value={filterRadical}
                    onChange={(e) => setFilterRadical(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-[80px,1fr_1fr] items-center gap-2">
                  <label className="text-white/70">画数</label>
                  <input
                    type="number"
                    min={1}
                    className="px-2 py-1 rounded bg-[#0b1220] border border-white/10"
                    placeholder="最小"
                    value={typeof filterMin === 'number' ? filterMin : ''}
                    onChange={(e) => setFilterMin(e.target.value === '' ? '' : Number(e.target.value))}
                  />
                  <input
                    type="number"
                    min={1}
                    className="px-2 py-1 rounded bg-[#0b1220] border border-white/10"
                    placeholder="最大"
                    value={typeof filterMax === 'number' ? filterMax : ''}
                    onChange={(e) => setFilterMax(e.target.value === '' ? '' : Number(e.target.value))}
                  />
                </div>
                <div className="text-xs text-white/60">該当: <span className="font-semibold text-white/80">{filtered.length}</span> 件</div>
              </div>

              <div className="flex-1 overflow-auto p-3 grid grid-cols-3 gap-2">
                {filtered.length > 0 ? (
                  filtered.map((k) => (
                    <button
                      key={k.code5}
                      onClick={() => addChar(k.char)}
                      className="aspect-square rounded-lg bg-[#121826] border border-white/10 hover:border-white/20 hover:bg-[#182033] grid place-items-center text-2xl"
                      title={`${k.char} (${k.strokeCount}画) [${k.radicals.join(',')}]`}
                    >
                      {k.char}
                    </button>
                  ))
                ) : (
                  <div className="col-span-3 text-center text-white/60 text-sm py-6">該当なし</div>
                )}
              </div>
            </aside>
            {/* 折りたたみトグル（常時表示の細いバー） */}
            <button
              onClick={() => setLeftOpen((v) => !v)}
              className="shrink-0 w-5 bg-[#0e1424] border-r border-white/10 hover:bg-[#16203a] flex items-center justify-center text-white/70"
              title={leftOpen ? '検索をたたむ' : '検索を開く'}
            >
              <span className="text-xs leading-none select-none">{leftOpen ? '‹' : '›'}</span>
            </button>
          </>
        )}
        <div className="flex-1 flex flex-col min-w-0">
          {/* ツールバー */}
          <div className="p-3 bg-[#0f172a] border-b border-white/10 flex items-center gap-3">
            <input
              className="px-2 py-1 w-32 rounded-md bg-[#0b1220] text-white placeholder-white/40 border border-white/10 focus:outline-none focus:ring-2 focus:ring-[#2e3a5c]"
              placeholder="漢字1文字"
              value={newChar}
              onChange={(e) => setNewChar(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) addKanji();
              }}
            />
            <button
              onClick={addKanji}
              className="px-3 py-1 rounded-lg bg-[#1f2a44] hover:bg-[#2b3a5c] active:bg-[#233250] text-white border border-white/10 shadow"
            >
              追加
            </button>
            <label className="ml-4 text-sm flex items-center gap-2 text-white/80">
              <input type="checkbox" checked={autoEval} onChange={(e) => setAutoEval(e.target.checked)} />
              自動評価
            </label>
            {!autoEval && (
              <button
                onClick={triggerEval}
                className="ml-2 px-3 py-1 rounded-lg bg-[#284066] hover:bg-[#2f4b78] active:bg-[#243a5a] text-white border border-white/10 shadow"
                title="プレビュー対象のみ再評価"
              >
                Evaluate
              </button>
            )}
            <button
              onClick={layoutByType}
              className="ml-2 px-3 py-1 rounded-lg bg-[#1f2a44] hover:bg-[#2b3a5c] active:bg-[#233250] text-white border border-white/10 shadow"
              title="種類ごとに列を分けて縦に整列"
            >
              ノード整理
            </button>
            <div className="ml-auto flex items-center gap-2 text-xs">
              <button onClick={() => {
                const id = nextId();
                setNodes(nds => [...nds, {
                  id, type: "range", position: nextPos(),
                  data: { start: 1, end: 1 }
                }]);
                setPreviewId(id); // ← 追加：Rangeも即プレビュー
              }} className="px-2 py-1 rounded bg-[#1f2a44] border border-white/10">+Range</button>
              <button onClick={() => {
                const id = nextId();
                setNodes(nds => [...nds, {
                  id, type: "transform", position: nextPos(),
                  data: { x: 0, y: 0, sx: 1, sy: 1, set: (() => { const f = rafDebounce((p: any) => setNodes(n2 => n2.map(n => n.id === id ? { ...n, data: { ...n.data, ...p } } : n))); return f; })() }
                }]);
                setPreviewId(id);
              }} className="px-2 py-1 rounded bg-[#1f2a44] border border-white/10">+Transform</button>
              <button onClick={() => {
                const id = nextId();
                setNodes(nds => [...nds, { id, type: "composite", position: nextPos(), data: { alphaA: 1, alphaB: 1, swap: false } }]);
                setPreviewId(id);
              }} className="px-2 py-1 rounded bg-[#1f2a44] border border-white/10">+Composite</button>
            </div>
          </div>

          {/* キャンバス */}
          <div className="flex-1 bg-[#0b1020]">
            <ReactFlow
              nodes={nodesWithInjected}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView={false}
              onNodesDelete={onNodesDelete}
              onNodeClick={(e, node) => setPreviewId(node.id)}
              onSelectionChange={(params) => {
                if (params.nodes && params.nodes.length) {
                  setPreviewId(params.nodes[params.nodes.length - 1].id);
                }
              }}
            >
              <Background color="#2e3a5c" gap={32} />
              <Controls />
            </ReactFlow>
          </div>
        </div>

        {sidebarOpen && (
          <>
            {/* 折りたたみトグル（右サイド用・常時表示の細いバー） */}
            <button
              onClick={() => setRightOpen((v) => !v)}
              className="shrink-0 w-5 bg-[#0e1424] border-l border-white/10 hover:bg-[#16203a] flex items-center justify-center text-white/70"
              title={rightOpen ? 'プレビューをたたむ' : 'プレビューを開く'}
            >
              <span className="text-xs leading-none select-none">{rightOpen ? '›' : '‹'}</span>
            </button>
            <aside className={`${rightOpen ? 'w-[360px]' : 'w-0'} shrink-0 border-l border-white/10 bg-[#0e1424] flex flex-col overflow-hidden transition-[width] duration-200`}>
              <div className="p-3 border-b border-white/10 text-sm font-medium">プレビュー</div>
              <div className="p-3 border-b border-white/10 grid gap-2">
                <select
                  className="px-2 py-1 rounded bg-[#0b1220] border border-white/10"
                  value={previewId ?? ''}
                  onChange={(e) => setPreviewId(e.target.value || null)}
                >
                  <option value="">(選択なし)</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.id} – {n.type}
                    </option>
                  ))}
                </select>
                <div className="rounded-lg bg-[#0b1220] border border-white/10 p-2 w-full overflow-hidden">
                  <div className="w-full grid place-items-center" style={{ aspectRatio: '1 / 1' }}>
                    {previewId ? (
                      outputs[previewId] ? (
                        <div
                          className="w-full h-full"
                          dangerouslySetInnerHTML={{ __html: outputs[previewId]! }}
                        />
                      ) : (
                        <div className="text-white/60 text-xs">Evaluating…</div>
                      )
                    ) : (
                      <div className="text-white/60 text-xs">ノードを選ぶとここに出力が表示されます</div>
                    )}
                  </div>
                </div>
                {/*
                <div className="mt-2 text-xs text-white/70">
                  画数: <span className="font-semibold text-white/90">{previewId && outputCounts[previewId] !== undefined ? outputCounts[previewId] : '-'}</span>
                </div>
                */}
                <div className="mt-2 grid grid-cols-[1fr_auto_auto] items-center gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-white/60">サイズ</span>
                    <input
                      type="number"
                      min={16}
                      max={4096}
                      step={16}
                      className="w-20 px-2 py-1 rounded bg-[#0b1220] border border-white/10"
                      value={pngSize}
                      onChange={(e) => setPngSize(Number(e.target.value) || 1024)}
                    />
                    <span className="text-white/60">px</span>
                  </div>
                  <button
                    onClick={handleSaveSVG}
                    disabled={!previewId || !outputs[previewId]}
                    className="px-3 py-1 rounded bg-[#1f2a44] border border-white/10 disabled:opacity-50"
                    title="現在のプレビューをSVGで保存"
                  >
                    SVG保存
                  </button>
                  <button
                    onClick={handleSavePNG}
                    disabled={!previewId || !outputs[previewId]}
                    className="px-3 py-1 rounded bg-[#1f2a44] border border-white/10 disabled:opacity-50"
                    title="現在のプレビューをPNGで保存"
                  >
                    PNG保存
                  </button>
                </div>
              </div>
            </aside>
          </>
        )}

      </div>
    </ReactFlowProvider>
  );
}