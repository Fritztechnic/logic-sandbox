import { Circuit } from "./circuit";
import { layoutOf } from "./logic";
import { CELL, Point } from "./types";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  owner: string;
}

/** Qualitätskennzahlen eines Kabelplans (für Tests und Vergleiche). */
export interface Metrics {
  wires: number;
  throughComp: number;
  throughBlock: number;
  crossings: number;
  bends: number;
  length: number;
  overlaps: number;
  diagonal: number;
  endsOff: number;
}

function segHits(a: Point, b: Point, r: Rect): boolean {
  const eps = 1;
  if (Math.abs(a.y - b.y) < 0.5) {
    if (a.y <= r.y + eps || a.y >= r.y + r.h - eps) return false;
    return Math.max(a.x, b.x) > r.x + eps && Math.min(a.x, b.x) < r.x + r.w - eps;
  }
  if (Math.abs(a.x - b.x) < 0.5) {
    if (a.x <= r.x + eps || a.x >= r.x + r.w - eps) return false;
    return Math.max(a.y, b.y) > r.y + eps && Math.min(a.y, b.y) < r.y + r.h - eps;
  }
  return false;
}

export function measure(c: Circuit, routes: Map<string, Point[]>): Metrics {
  const m: Metrics = { wires: 0, throughComp: 0, throughBlock: 0, crossings: 0, bends: 0, length: 0, overlaps: 0, diagonal: 0, endsOff: 0 };
  const comps: Rect[] = [];
  for (const comp of c.comps.values()) {
    if (c.isCompHidden(comp.id)) continue;
    const l = layoutOf(comp);
    const p = c.posOf(comp);
    comps.push({ x: p.x * CELL, y: p.y * CELL, w: l.cols * CELL, h: l.rows * CELL, owner: comp.id });
  }
  const blocks: (Rect & { gid: string })[] = [];
  if (!c.expanded) {
    for (const g of c.groups.values()) {
      blocks.push({ x: g.x * CELL, y: g.y * CELL, w: g.cols * CELL, h: g.rows * CELL, owner: g.id, gid: g.id });
    }
  } else {
    c.expandedFrames.forEach((f, i) =>
      blocks.push({ x: f.x * CELL, y: f.y * CELL, w: f.w * CELL, h: f.h * CELL, owner: `f${i}`, gid: `f${i}` })
    );
  }
  const inside = (r: Rect, p: Point) => p.x >= r.x - 1 && p.x <= r.x + r.w + 1 && p.y >= r.y - 1 && p.y <= r.y + r.h + 1;
  const hs: { y: number; x0: number; x1: number; net: string; id: string }[] = [];
  const vs: { x: number; y0: number; y1: number; net: string; id: string }[] = [];
  for (const w of c.wires) {
    if (c.isWireHidden(w)) continue;
    const pts = routes.get(w.id);
    if (!pts) continue;
    m.wires++;
    const net = `${w.from}:${w.fromPort}`;
    const src = c.get(w.from)!;
    const dst = c.get(w.to)!;
    const p0 = c.pinPos(src, "out", w.fromPort);
    const p1 = c.pinPos(dst, "in", w.toPort);
    const last = pts[pts.length - 1];
    if (Math.hypot(pts[0].x - p0.x, pts[0].y - p0.y) > 0.01 || Math.hypot(last.x - p1.x, last.y - p1.y) > 0.01) m.endsOff++;
    const ownGroups = new Set<string | undefined>([c.groupForComp(w.from)?.id, c.groupForComp(w.to)?.id]);
    if (c.expanded) for (const r of blocks) if (inside(r, p0) || inside(r, p1)) ownGroups.add(r.gid);
    m.bends += Math.max(0, pts.length - 2);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      if (dx > 0.01 && dy > 0.01) m.diagonal++;
      m.length += dx + dy;
      if (dy < 0.5) hs.push({ y: a.y, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), net, id: w.id });
      else if (dx < 0.5) vs.push({ x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), net, id: w.id });
      for (const r of comps) {
        if (r.owner === w.from || r.owner === w.to) continue;
        if (segHits(a, b, r)) m.throughComp++;
      }
      for (const r of blocks) {
        if (ownGroups.has(r.gid)) continue;
        if (segHits(a, b, r)) m.throughBlock++;
      }
    }
  }
  // Kreuzungen: nur echte Innenkreuzungen verschiedener Netze.
  for (const h of hs) {
    for (const v of vs) {
      if (h.net === v.net) continue;
      if (v.x > h.x0 + 0.5 && v.x < h.x1 - 0.5 && h.y > v.y0 + 0.5 && h.y < v.y1 - 0.5) m.crossings++;
    }
  }
  // Kollineare Überlappungen verschiedener Netze (Sweep je Spur).
  const lane = <T extends { net: string }>(list: T[], key: (t: T) => number, lo: (t: T) => number, hi: (t: T) => number) => {
    const byKey = new Map<number, T[]>();
    for (const t of list) {
      const k = Math.round(key(t) * 2);
      const arr = byKey.get(k) ?? [];
      arr.push(t);
      byKey.set(k, arr);
    }
    for (const arr of byKey.values()) {
      arr.sort((a, b) => lo(a) - lo(b));
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length && lo(arr[j]) < hi(arr[i]) - 0.5; j++) {
          if (arr[i].net !== arr[j].net) m.overlaps++;
        }
      }
    }
  };
  lane(hs, (t) => t.y, (t) => t.x0, (t) => t.x1);
  lane(vs, (t) => t.x, (t) => t.y0, (t) => t.y1);
  return m;
}

