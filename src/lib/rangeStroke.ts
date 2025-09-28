// src/lib/rangeStroke.ts
// KanjiVG SVG をベイクして筆画レンジを安定適用するユーティリティ

export type BakedSvg = { svg: string; count: number };
const SVG_NS = "http://www.w3.org/2000/svg";
const DRAW_TAGS = new Set(["path","polyline","line","circle","ellipse","rect","polygon"]);

/**
 * ベイク: id="...-sN" を持つ“ストロークキャリア”単位の描画要素を
 * ひとつの <g data-stroke="N"> にマージ（同じ N が複数あってもまとめる）。
 * 番号/グリッド/ガイドは削除し、109x109 前提で正規化。
 */
export function bakeStrokes(svgText: string): BakedSvg {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");

  // ノイズ削除
  doc.querySelectorAll(
    '[id^="kvg:StrokeNumbers_"], [id^="kvg:Numbers_"], [id^="kvg:Grid_"], [id^="kvg:Guideline_"]'
  ).forEach(n => n.remove());

  const svg = doc.querySelector("svg");
  if (!svg) return { svg: svgText, count: 0 };

  // 正規化
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("width","100%");
  svg.setAttribute("height","100%");
  svg.setAttribute("viewBox", svg.getAttribute("viewBox") || "0 0 109 109");
  svg.setAttribute("vector-effect","non-scaling-stroke");
  svg.setAttribute("preserveAspectRatio","xMidYMid meet");

  // `-sN` を持つ要素を列挙
  const carriers: Array<{ n:number; el:Element }> = [];
  doc.querySelectorAll("[id]").forEach(el => {
    const id = el.getAttribute("id") || "";
    const m = id.match(/-s(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) carriers.push({ n, el });
    }
  });

  // 同じ N をひとつの <g data-stroke=N> にマージ
  const bucket = new Map<number, Element>();
  const pushAllDrawables = (root: Element, into: Element) => {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    // @ts-ignore
    let cur: Element | null = walker.currentNode as Element;
    while (cur) {
      if (DRAW_TAGS.has(cur.tagName.toLowerCase())) into.appendChild(cur.cloneNode(true));
      // @ts-ignore
      cur = walker.nextNode() as Element | null;
    }
  };

  for (const { n, el } of carriers) {
    let wrap = bucket.get(n);
    if (!wrap) {
      wrap = doc.createElementNS(SVG_NS, "g");
      wrap.setAttribute("data-stroke", String(n));
      bucket.set(n, wrap);
    }
    pushAllDrawables(el, wrap);
  }

  // 既存 StrokePaths は非表示
  const sp = doc.querySelector('[id^="kvg:StrokePaths_"]');
  if (sp) (sp as Element).setAttribute("display","none");

  // 番号順に出力
  const bakedGroup = doc.createElementNS(SVG_NS, "g");
  bakedGroup.setAttribute("id","__baked_strokes__");
  const nums = [...bucket.keys()].sort((a,b)=>a-b);
  let count = 0;
  for (const n of nums) {
    const w = bucket.get(n)!;
    if (w.childNodes.length > 0) {
      bakedGroup.appendChild(w);
      count = Math.max(count, n);
    }
  }
  svg.appendChild(bakedGroup);

  return { svg: new XMLSerializer().serializeToString(doc), count: count || nums.length };
}

/** ベイク済み SVG に start..end を適用 */
export function applyRangeBaked(svgText: string, start: number, end: number): string {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) return svgText;
  const s = Math.min(start, end), e = Math.max(start, end);

  svg.querySelectorAll("g[data-stroke]").forEach(g => (g as Element).setAttribute("display","none"));
  svg.querySelectorAll("g[data-stroke]").forEach(g => {
    const n = parseInt((g as Element).getAttribute("data-stroke") || "0", 10);
    if (n >= s && n <= e) (g as Element).removeAttribute("display");
  });

  return new XMLSerializer().serializeToString(doc);
}

/** 総画数（ベイク済み優先、未ベイクは -sN の最大値） */
export function countStrokes(svgText: string): number {
  try {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const baked = doc.querySelectorAll("g[data-stroke]").length;
    if (baked > 0) return baked;

    let max = 0;
    doc.querySelectorAll("[id]").forEach(el => {
      const id = (el as Element).getAttribute("id") || "";
      const m = id.match(/-s(\\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return max || 1;
  } catch {
    return 1;
  }
}
