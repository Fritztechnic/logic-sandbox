import { Point } from "./types";

export interface Curve {
  p0: Point;
  c1: Point;
  c2: Point;
  p1: Point;
}

export function wireCurve(p0: Point, p1: Point): Curve {
  const dx = Math.abs(p1.x - p0.x);
  const d = Math.max(26, Math.min(140, dx * 0.5 + 18));
  return {
    p0,
    c1: { x: p0.x + d, y: p0.y },
    c2: { x: p1.x - d, y: p1.y },
    p1,
  };
}

export function curvePoint(curve: Curve, t: number): Point {
  const { p0, c1, c2, p1 } = curve;
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  };
}

export function curveSamples(curve: Curve, n = 24): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) pts.push(curvePoint(curve, i / n));
  return pts;
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

export function distToCurve(p: Point, curve: Curve, samples = 24): number {
  let min = Infinity;
  let prev = curvePoint(curve, 0);
  for (let i = 1; i <= samples; i++) {
    const cur = curvePoint(curve, i / samples);
    min = Math.min(min, distToSegment(p, prev, cur));
    prev = cur;
  }
  return min;
}
