import { Circuit } from "./circuit";
import { layoutOf } from "./logic";
import { CELL, Point } from "./types";

export type WireStyle = "curved" | "ortho";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rasterabstand der Leiterbahnen (px): eine halbe Zelle, Pins liegen darauf. */
const P = CELL / 2;
/** Zusätzlicher Freiraum um die Schaltung, damit Rückführungen außen herum passen. */
const MARGIN = 8;
/** Länge des waagerechten Stücks direkt am Pin (Rasterschritte). */
const STUB = 1;
const STEP = 10;
const BEND = 80;
const CROSS = 60;
const EDGE = 5;
/** Aufschlag je Rasterpunkt, an dem eine fremde Spur mitbenutzt wird (nur als letzter Ausweg). */
/** Aufschlag je Rasterkante, die ein fremdes Netz bereits belegt (Überlappung). */
const SHARE_EDGE = 250;
const SHARE_PENALTY = 70;
/** Teilt sich ein Kabel die Spur mit dem eigenen Netz (Stamm), ist der Schritt billiger. */
const TRUNK_STEP = 4;
/** Strafe, wenn sich zwei Kabel an einem Endpunkt berühren. */
const TOUCH = 30;
/** Kantenlänge einer Grobzelle in Rasterpunkten. */
const C = 4;
/** Mindestanzahl freier Rasterpunkte, damit eine Grobzelle als begehbar gilt. */
const OPEN_MIN = 3;
/** Strafe je bereits belegtem Rasterpunkt einer Grobzelle. */
const LOAD_COST = 2;
/** Breite des Korridors um den Grobweg (in Grobzellen je Seite). */
const CORRIDOR = 1;
/** Ab dieser Manhattan-Länge (Rasterpunkte) wird erst ein Korridor geplant. */
const LONG = 40;
/** Gesamtbudget an Suchschritten (ca. 250 ms), danach nur noch schnelle Suche. */
const BUDGET = 1_500_000;
const MAX_NODES = 3_000_000;

const DX = [1, 0, -1, 0];

/** Binärer Min-Heap mit Zahlen-Schlüsseln (kein Objekt je Eintrag). */
class Heap {
  private keys = new Float64Array(1 << 12);
  private vals = new Int32Array(1 << 12);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Int32Array(this.size * 2);
      v.set(this.vals);
      this.vals = v;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }

  pop(): number {
    const top = this.vals[0];
    const key = this.keys[--this.size];
    const val = this.vals[this.size];
    let i = 0;
    const n = this.size;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.keys[i] = this.keys[c];
      this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = key;
    this.vals[i] = val;
    return top;
  }
}

/**
 * Rasterrouter: Bauteile und Modulblöcke sperren Rasterpunkte; jedes Netz
 * belegt seine Spuren exklusiv (Kreuzungen nur rechtwinklig mit Strafe), nur
 * das eigene Netz darf sich die Spur teilen (Stamm mit Abzweigen).
 */
class GridRouter {
  readonly w: number;
  readonly h: number;
  private comp: Uint8Array;
  private edge: Uint8Array;
  private block: Uint16Array;
  /** Netz, das den Punkt waagerecht (0) bzw. senkrecht (1) belegt. */
  private use: [Int32Array, Int32Array];
  /** Netz mit Pin-Stutzen links (Start) bzw. rechts (Ziel) vom Punkt. */
  private edgeUse: Int32Array;
  private stubW: Int32Array;
  private stubE: Int32Array;
  private g: Float32Array;
  private stamp: Uint32Array;
  private parent: Int32Array;
  private tick = 0;
  private heap = new Heap();
  /** Grobraster (C×C Rasterpunkte je Zelle) für den Korridor langer Kabel. */
  private cw: number;
  private ch: number;
  private cOpen: Uint8Array;
  private cBlk: Uint16Array;
  private cLoad: Uint16Array;
  private cg: Float32Array;
  private cStamp: Uint32Array;
  private cParent: Int32Array;
  /** Zellen des aktuellen Korridors (Stempel = Suchzähler), null = unbeschränkt. */
  private corridor: Uint32Array;
  private corridorOn = false;
  private corridorTick = 0;

  constructor(readonly ox: number, readonly oy: number, w: number, h: number) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.comp = new Uint8Array(n);
    this.edge = new Uint8Array(n);
    this.block = new Uint16Array(n);
    this.use = [new Int32Array(n), new Int32Array(n)];
    this.edgeUse = new Int32Array(n * 2);
    this.stubW = new Int32Array(n);
    this.stubE = new Int32Array(n);
    this.g = new Float32Array(n * 4);
    this.stamp = new Uint32Array(n * 4);
    this.parent = new Int32Array(n * 4);
    this.cw = Math.ceil(w / C);
    this.ch = Math.ceil(h / C);
    const cn = this.cw * this.ch;
    this.cOpen = new Uint8Array(cn);
    this.cBlk = new Uint16Array(cn);
    this.cLoad = new Uint16Array(cn);
    this.cg = new Float32Array(cn);
    this.cStamp = new Uint32Array(cn);
    this.cParent = new Int32Array(cn);
    this.corridor = new Uint32Array(cn);
  }

  /** Nach allen addRect-Aufrufen: Grobraster aus den Sperrflächen ableiten. */
  finish(): void {
    for (let n = 0; n < this.w * this.h; n++) {
      const c = Math.floor(n / this.w / C) * this.cw + Math.floor((n % this.w) / C);
      if (!this.comp[n]) this.cOpen[c]++;
      if (this.block[n] !== 0) this.cBlk[c] = this.block[n];
    }
  }

  /**
   * Grobsuche über Zellen: legt einen Korridor um den billigsten Weg, damit die
   * Feinsuche bei langen Kabeln nicht die ganze Fläche absucht.
   */
  planCorridor(s: number, t: number, okA: number, okB: number): boolean {
    const cw = this.cw;
    const cell = (n: number) => Math.floor(n / this.w / C) * cw + Math.floor((n % this.w) / C);
    const cs = cell(s);
    const ct = cell(t);
    const tick = ++this.tick;
    const heap = this.heap;
    heap.clear();
    this.cStamp[cs] = tick;
    this.cg[cs] = 0;
    this.cParent[cs] = -1;
    heap.push(0, cs);
    const tx = ct % cw;
    const ty = Math.floor(ct / cw);
    let ok = false;
    while (heap.size > 0) {
      const c = heap.pop();
      if (c === ct) {
        ok = true;
        break;
      }
      const cx = c % cw;
      const cy = Math.floor(c / cw);
      const gHere = this.cg[c];
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k];
        const ny = cy + DX[(k + 3) & 3];
        if (nx < 0 || ny < 0 || nx >= cw || ny >= this.ch) continue;
        const m = ny * cw + nx;
        if (m !== ct && m !== cs) {
          const b = this.cBlk[m];
          if (this.cOpen[m] < OPEN_MIN || (b !== 0 && b !== okA && b !== okB)) continue;
        }
        const cost = gHere + STEP * C + this.cLoad[m] * LOAD_COST;
        if (this.cStamp[m] === tick && this.cg[m] <= cost) continue;
        this.cStamp[m] = tick;
        this.cg[m] = cost;
        this.cParent[m] = c;
        heap.push(cost + (Math.abs(nx - tx) + Math.abs(ny - ty)) * STEP * C, m);
      }
    }
    if (!ok) return false;
    for (let c = ct; c >= 0; c = this.cParent[c]) {
      const cx = c % cw;
      const cy = Math.floor(c / cw);
      for (let dy = -CORRIDOR; dy <= CORRIDOR; dy++) {
        for (let dx = -CORRIDOR; dx <= CORRIDOR; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && y >= 0 && x < cw && y < this.ch) this.corridor[y * cw + x] = tick;
        }
      }
    }
    this.corridorTick = tick;
    return true;
  }

  useCorridor(on: boolean): void {
    this.corridorOn = on;
  }

  isBlocked(n: number, okA: number, okB: number): boolean {
    const b = this.block[n];
    return this.comp[n] === 1 || (b !== 0 && b !== okA && b !== okB);
  }

  node(px: number, py: number): number {
    return Math.round((py - this.oy) / P) * this.w + Math.round((px - this.ox) / P);
  }

  x(n: number): number {
    return this.ox + (n % this.w) * P;
  }

  y(n: number): number {
    return this.oy + Math.floor(n / this.w) * P;
  }

  /** Sperrt den Innenraum; Rand-Punkte erhalten nur eine kleine Strafe. */
  addRect(r: Rect, blockId = 0): void {
    const i0 = Math.ceil((r.x - this.ox) / P - 1e-6);
    const i1 = Math.floor((r.x + r.w - this.ox) / P + 1e-6);
    const j0 = Math.ceil((r.y - this.oy) / P - 1e-6);
    const j1 = Math.floor((r.y + r.h - this.oy) / P + 1e-6);
    for (let j = Math.max(0, j0); j <= Math.min(this.h - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.w - 1, i1); i++) {
        const n = j * this.w + i;
        const inner = i > i0 && i < i1 && j > j0 && j < j1;
        if (!inner) this.edge[n] = 1;
        else if (blockId) this.block[n] = blockId;
        else this.comp[n] = 1;
      }
    }
  }

  /** Belegt die Spuren eines fertigen Pfades für das Netz. */
  reserve(path: number[], net: number): void {
    for (let k = 1; k < path.length; k++) {
      const axis = Math.abs(path[k] - path[k - 1]) === 1 ? 0 : 1;
      this.use[axis][path[k - 1]] = net;
      this.use[axis][path[k]] = net;
      this.edgeUse[Math.min(path[k], path[k - 1]) * 2 + axis] = net;
    }
    for (const n of path) this.cLoad[Math.floor(n / this.w / C) * this.cw + Math.floor((n % this.w) / C)]++;
    this.stubW[path[0]] = net;
    this.stubE[path[path.length - 1]] = net;
  }

  /**
   * Kürzester Weg (Länge + Knicke + Kreuzungen) von Knoten s (Start läuft nach
   * rechts) zu Knoten t (Ziel wird von links erreicht).
   */
  search(s: number, t: number, net: number, okA: number, okB: number, heur: number, cap: number): number[] | null {
    const W = this.w;
    const tx = t % W;
    const ty = (t / W) | 0;
    let budget = cap;
    const tick = ++this.tick;
    const heap = this.heap;
    heap.clear();
    const sState = s * 4;
    this.stamp[sState] = tick;
    this.g[sState] = 0;
    this.parent[sState] = -1;
    heap.push(0, sState);
    let found = -1;
    while (heap.size > 0) {
      const state = heap.pop();
      routeStats.exp++;
      if (--budget < 0) return null;
      const n = state >> 2;
      const d = state & 3;
      const gHere = this.g[state];
      if (n === t) {
        found = state;
        break;
      }
      const nx = n % W;
      const ny = (n / W) | 0;
      for (let turn = 0; turn < 3; turn++) {
        const nd = turn === 0 ? d : turn === 1 ? (d + 1) & 3 : (d + 3) & 3;
        const px = nx + DX[nd];
        const py = ny + DX[(nd + 3) & 3];
        if (px < 0 || px >= W || py < 0 || py >= this.h) continue;
        const m = py * W + px;
        if (this.corridorOn && this.corridor[Math.floor(py / C) * this.cw + Math.floor(px / C)] !== this.corridorTick) continue;
        const isGoal = m === t;
        if (isGoal && nd === 2) continue;
        let cost = gHere;
        if (!isGoal && m !== s) {
          if (this.comp[m]) continue;
          const b = this.block[m];
          if (b !== 0 && b !== okA && b !== okB) continue;
          const sw = this.stubW[m];
          const se = this.stubE[m];
          if ((sw !== 0 && sw !== net) || (se !== 0 && se !== net)) cost += SHARE_PENALTY;
        }
        const axis = nd & 1;
        const arr = this.use[axis];
        const un = arr[n];
        const um = arr[m];
        // An den Endpunkten dürfen sich fremde Kabel nur berühren (Pins im engen Raster).
        if (un !== 0 && un !== net) {
          cost += n === s ? TOUCH : SHARE_PENALTY;
        }
        if (um !== 0 && um !== net) {
          cost += isGoal ? TOUCH : SHARE_PENALTY;
        }
        const eo = this.edgeUse[Math.min(n, m) * 2 + axis];
        if (eo !== 0 && eo !== net) cost += SHARE_EDGE;
        cost += eo === net ? TRUNK_STEP : STEP;
        if (this.edge[m]) cost += EDGE;
        if (nd !== d) cost += BEND;
        if (isGoal && nd !== 0) cost += BEND;
        // Kreuzung: gerade durch einen Punkt, der quer von einem fremden Netz belegt ist.
        if (nd === d) {
          const other = this.use[axis ^ 1][m];
          if (other !== 0 && other !== net) cost += CROSS;
        }
        const ms = m * 4 + nd;
        if (this.stamp[ms] === tick && this.g[ms] <= cost) continue;
        this.stamp[ms] = tick;
        this.g[ms] = cost;
        this.parent[ms] = state;
        const hx = tx - px;
        const hy = Math.abs(py - ty);
        const turns = hy > 0 ? (nd & 1 ? 1 : 2) : nd === 0 && hx >= 0 ? 0 : 2;
        const f = cost + (Math.abs(hx) + hy) * heur + turns * BEND;
        heap.push(f - cost * 1e-4, ms);
      }
    }
    if (found < 0) return null;
    const path: number[] = [];
    for (let st = found; st >= 0; st = this.parent[st]) path.push(st >> 2);
    path.reverse();
    return path;
  }
}

/** Entfernt doppelte und kollineare Zwischenpunkte. */
function clean(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push({ x: p.x, y: p.y });
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const vertical = Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01;
    const horizontal = Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01;
    if (vertical || horizontal) out.splice(i, 1);
  }
  return out;
}

function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x - 1 && p.x <= r.x + r.w + 1 && p.y >= r.y - 1 && p.y <= r.y + r.h + 1;
}

/** Notlösung, wenn das Raster keinen Weg findet: einfache Z-Form. */
function zShape(from: Point, to: Point): Point[] {
  const mid = Math.round((from.x + to.x) / 2 / P) * P;
  const x = Math.max(from.x + P, mid);
  return clean([from, { x, y: from.y }, { x, y: to.y }, to]);
}

interface RouteCache {
  circuit: Circuit;
  version: number;
  hash: number;
  style: WireStyle;
  expanded: boolean;
  routes: Map<string, Point[]>;
}

let cache: RouteCache | null = null;

/** Kennzahlen des letzten Routinglaufs (Tests/Diagnose). */
export const routeStats = { exp: 0, fallback: 0 };

/** Schneller Fingerabdruck aller Positionen (auch während des Ziehens). */
function layoutHash(circuit: Circuit): number {
  let h = circuit.comps.size * 7919 + circuit.groups.size * 104729;
  for (const c of circuit.comps.values()) {
    // posOf zählt: in der entpackten Ansicht lassen sich Bauteile verschieben.
    const p = circuit.posOf(c);
    h = (h + Math.imul(p.x, 73856093) + Math.imul(p.y, 19349663)) | 0;
  }
  for (const g of circuit.groups.values()) {
    h = (h + Math.imul(g.x, 83492791) + Math.imul(g.y, 32452843)) | 0;
  }
  for (const f of circuit.expandedFrames) {
    h =
      (h +
        Math.imul(f.x, 19349663) +
        Math.imul(f.y, 83492791) +
        Math.imul(f.w, 73856093) +
        Math.imul(f.h, 32452843)) |
      0;
  }
  return h;
}

interface Job {
  id: string;
  net: string;
  from: Point;
  to: Point;
  len: number;
}

/**
 * Rechtwinklige Kabelwege auf einem Raster: nie durch Bauteile oder Module,
 * getrennte Spuren je Netz, gemeinsamer Stamm bei gleicher Quelle. Das Ergebnis
 * wird zwischengespeichert, bis sich etwas ändert.
 */
export function getWireRoutes(circuit: Circuit, style: WireStyle = "ortho"): Map<string, Point[]> {
  if (style !== "ortho") return new Map();
  const hash = layoutHash(circuit);
  if (
    cache &&
    cache.circuit === circuit &&
    cache.version === circuit.structureVersion &&
    cache.hash === hash &&
    cache.style === style &&
    cache.expanded === circuit.expanded
  ) {
    return cache.routes;
  }
  const routes = new Map<string, Point[]>();
  routeStats.fallback = 0;
  routeStats.exp = 0;
  cache = { circuit, version: circuit.structureVersion, hash, style, expanded: circuit.expanded, routes };

  const compRects: Rect[] = [];
  for (const comp of circuit.comps.values()) {
    if (circuit.isCompHidden(comp.id)) continue;
    const l = layoutOf(comp);
    const pos = circuit.posOf(comp);
    compRects.push({ x: pos.x * CELL, y: pos.y * CELL, w: l.cols * CELL, h: l.rows * CELL });
  }
  // Modulblöcke (zugeklappt) bzw. Modulfelder (entpackt) sperren ebenfalls.
  const blocks: Rect[] = [];
  if (!circuit.expanded) {
    for (const group of circuit.groups.values()) {
      const r = circuit.groupVisibleBounds(group.id);
      if (r) blocks.push({ x: r.x * CELL, y: r.y * CELL, w: r.w * CELL, h: r.h * CELL });
    }
  } else {
    for (const f of circuit.expandedFrames) {
      blocks.push({ x: f.x * CELL, y: f.y * CELL, w: f.w * CELL, h: f.h * CELL });
    }
  }

  const jobs: Job[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const r of compRects) {
    grow(r.x, r.y);
    grow(r.x + r.w, r.y + r.h);
  }
  for (const r of blocks) {
    grow(r.x, r.y);
    grow(r.x + r.w, r.y + r.h);
  }
  for (const wire of circuit.wires) {
    if (circuit.isWireHidden(wire)) continue;
    const src = circuit.get(wire.from);
    const dst = circuit.get(wire.to);
    if (!src || !dst) continue;
    const from = circuit.pinPos(src, "out", wire.fromPort);
    const to = circuit.pinPos(dst, "in", wire.toPort);
    grow(from.x, from.y);
    grow(to.x, to.y);
    jobs.push({
      id: wire.id,
      net: `${wire.from}:${wire.fromPort}`,
      from,
      to,
      len: Math.abs(to.x - from.x) + Math.abs(to.y - from.y),
    });
  }
  if (jobs.length === 0) return routes;

  const pad = MARGIN * P;
  const ox = Math.floor((minX - pad) / P) * P;
  const oy = Math.floor((minY - pad) / P) * P;
  const gw = Math.ceil((maxX + pad - ox) / P) + 1;
  const gh = Math.ceil((maxY + pad - oy) / P) + 1;

  if (gw * gh > MAX_NODES) {
    for (const j of jobs) routes.set(j.id, zShape(j.from, j.to));
    return routes;
  }

  const router = new GridRouter(ox, oy, gw, gh);
  for (const r of compRects) router.addRect(r);
  blocks.forEach((r, i) => router.addRect(r, i + 1));
  router.finish();

  // Netze nach kürzester Verbindung geordnet, innerhalb eines Netzes die
  // nächsten Ziele zuerst: so entsteht ein Stamm, an dem die Abzweige hängen.
  const netMin = new Map<string, number>();
  for (const j of jobs) netMin.set(j.net, Math.min(netMin.get(j.net) ?? Infinity, j.len));
  const netIds = new Map<string, number>();
  jobs.sort((a, b) => {
    const d = netMin.get(a.net)! - netMin.get(b.net)!;
    if (d !== 0) return d;
    if (a.net !== b.net) return a.net < b.net ? -1 : 1;
    return a.len - b.len || (a.id < b.id ? -1 : 1);
  });

  for (const job of jobs) {
    let net = netIds.get(job.net);
    if (net === undefined) {
      net = netIds.size + 1;
      netIds.set(job.net, net);
    }
    // Ein Kabel darf Modulfelder betreten, in denen seine Pins liegen.
    let okA = 0;
    let okB = 0;
    if (circuit.expanded) {
      blocks.forEach((r, i) => {
        if (rectContains(r, job.from)) okA = i + 1;
        if (rectContains(r, job.to)) okB = i + 1;
      });
    }
    // Stoßen Bauteile direkt an den Pin, fehlt Platz für den Stutzen: dann
    // läuft das Kabel am Pin selbst los (entlang der Bauteilkante).
    let s = router.node(job.from.x + STUB * P, job.from.y);
    if (router.isBlocked(s, okA, okB)) s = router.node(job.from.x, job.from.y);
    let t = router.node(job.to.x - STUB * P, job.to.y);
    if (router.isBlocked(t, okA, okB)) t = router.node(job.to.x, job.to.y);
    let path: number[] | null = null;
    const dist = Math.abs(router.x(s) - router.x(t)) / P + Math.abs(router.y(s) - router.y(t)) / P;
    if (dist > LONG && router.planCorridor(s, t, okA, okB)) {
      router.useCorridor(true);
      path = router.search(s, t, net, okA, okB, STEP, 40000);
      router.useCorridor(false);
    }
    if (!path && routeStats.exp > BUDGET) {
      // Sehr große Schaltung: Rechenbudget aufgebraucht, nur noch schnelle Suche.
      path = router.search(s, t, net, okA, okB, 3 * STEP, 5000);
    } else if (!path) {
      for (const [heur, cap] of [
        [STEP, 8000],
        [4 * STEP, 60000],
        [STEP, Infinity],
      ]) {
        path = router.search(s, t, net, okA, okB, heur, cap);
        if (path) break;
      }
    }
    if (!path) {
      routeStats.fallback++;
      routes.set(job.id, zShape(job.from, job.to));
      continue;
    }
    router.reserve(path, net);
    const pts: Point[] = [job.from, { x: router.x(path[0]), y: job.from.y }];
    for (const n of path) pts.push({ x: router.x(n), y: router.y(n) });
    pts.push({ x: router.x(path[path.length - 1]), y: job.to.y }, job.to);
    routes.set(job.id, clean(pts));
  }
  return routes;
}

/** Punkt bei Anteil t (0…1) entlang einer Polylinie. */
export function pointAtPolyline(points: Point[], t: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  let want = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (want <= len || i === points.length - 1) {
      const k = len === 0 ? 0 : want / len;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    want -= len;
  }
  return points[points.length - 1];
}

/** Kürzester Abstand eines Punktes zu einer Polylinie. */
export function distToPolyline(p: Point, points: Point[]): number {
  let min = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    min = Math.min(min, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return min;
}
