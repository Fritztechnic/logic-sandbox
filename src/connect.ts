import { Circuit } from "./circuit";
import { layoutOf, portWidths } from "./logic";
import { CELL, Comp, Point } from "./types";

/** Ein Anschluss einer Einheit (Bauteil oder Modul) – bei Modulen der Pin-Puffer. */
export interface PinRef {
  comp: string;
  port: number;
  width: number;
  name: string;
  /** Position in Weltkoordinaten (für Sortierung und Vorschau). */
  pos: Point;
}

export interface Pair {
  from: PinRef;
  to: PinRef;
}

export interface Skip {
  pin: PinRef;
  dir: "in" | "out";
  reason: string;
}

export interface ConnectPlan {
  pairs: Pair[];
  skipped: Skip[];
  /** Eingänge des Ziels, die schon verdrahtet waren. */
  occupiedInputs: number;
}

const byPosition = (a: PinRef, b: PinRef) => a.pos.y - b.pos.y || a.pos.x - b.pos.x;

function pinsOfComp(c: Circuit, comp: Comp, dir: "in" | "out"): PinRef[] {
  const l = layoutOf(comp);
  const widths = portWidths(comp)[dir];
  return (dir === "in" ? l.ins : l.outs).map((p, i) => ({
    comp: comp.id,
    port: i,
    width: widths[i] ?? 1,
    name: p.name,
    pos: c.pinPos(comp, dir, i),
  }));
}

/** Alle Anschlüsse einer Einheit (Bauteil-ID oder Modul-ID), von oben nach unten sortiert. */
export function unitPins(c: Circuit, unitId: string, dir: "in" | "out"): PinRef[] {
  const group = c.groups.get(unitId);
  if (group) {
    const out: PinRef[] = [];
    for (const p of dir === "in" ? group.inputs : group.outputs) {
      const comp = c.get(p.compId);
      if (comp) out.push({ comp: comp.id, port: 0, width: p.width, name: p.name, pos: c.pinPos(comp, dir, 0) });
    }
    return out.sort(byPosition);
  }
  const comp = c.get(unitId);
  if (!comp || c.isCompHidden(comp.id)) return [];
  return pinsOfComp(c, comp, dir).sort(byPosition);
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Plant die Massen-Verbindung: freie Ausgänge der Quellen (oben→unten, links→rechts)
 * werden mit freien, breitengleichen Eingängen des Ziels gepaart. Gleiche Pin-Namen
 * haben Vorrang, der Rest wird der Reihe nach zugeordnet.
 */
export function planConnect(c: Circuit, sourceIds: string[], targetId: string): ConnectPlan {
  const usedOut = new Set<string>();
  const usedIn = new Set<string>();
  for (const w of c.wires) {
    usedOut.add(`${w.from}:${w.fromPort}`);
    usedIn.add(`${w.to}:${w.toPort}`);
  }
  const plan: ConnectPlan = { pairs: [], skipped: [], occupiedInputs: 0 };

  const outs: PinRef[] = [];
  for (const id of new Set(sourceIds)) {
    if (id === targetId) continue;
    for (const p of unitPins(c, id, "out")) {
      if (usedOut.has(`${p.comp}:${p.port}`)) plan.skipped.push({ pin: p, dir: "out", reason: "Ausgang schon verbunden" });
      else outs.push(p);
    }
  }
  outs.sort(byPosition);

  const ins: PinRef[] = [];
  for (const p of unitPins(c, targetId, "in")) {
    if (usedIn.has(`${p.comp}:${p.port}`)) plan.occupiedInputs++;
    else ins.push(p);
  }

  const taken = new Set<PinRef>();
  const paired = new Map<PinRef, PinRef>();
  for (const o of outs) {
    const hit = ins.find((i) => !taken.has(i) && i.width === o.width && norm(i.name) === norm(o.name));
    if (hit) {
      taken.add(hit);
      paired.set(o, hit);
    }
  }
  for (const o of outs) {
    if (!paired.has(o)) {
      const hit = ins.find((i) => !taken.has(i) && i.width === o.width);
      if (hit) {
        taken.add(hit);
        paired.set(o, hit);
      }
    }
    const to = paired.get(o);
    if (to) plan.pairs.push({ from: o, to });
    else {
      const free = ins.filter((i) => !taken.has(i)).length;
      plan.skipped.push({
        pin: o,
        dir: "out",
        reason: free === 0 ? "kein freier Eingang am Ziel" : `kein freier Eingang mit ${o.width} Bit`,
      });
    }
  }
  return plan;
}

/** Auto-Verbinden für zwei Einheiten: A → B, bei Misserfolg B → A. */
export function planAutoConnect(c: Circuit, a: string, b: string): ConnectPlan & { from: string; to: string } {
  const ab = planConnect(c, [a], b);
  if (ab.pairs.length > 0) return { ...ab, from: a, to: b };
  const ba = planConnect(c, [b], a);
  return ba.pairs.length > 0 ? { ...ba, from: b, to: a } : { ...ab, from: a, to: b };
}

/** Legt die Kabel eines Plans an; liefert die Anzahl wirklich angelegter Kabel. */
export function applyPlan(c: Circuit, plan: ConnectPlan): number {
  let n = 0;
  for (const p of plan.pairs) if (c.addWire(p.from.comp, p.from.port, p.to.comp, p.to.port)) n++;
  return n;
}

/** Kurzer Statustext zu einem Plan. */
export function describePlan(plan: ConnectPlan, made = plan.pairs.length): string {
  const reasons = new Map<string, number>();
  for (const s of plan.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  if (plan.occupiedInputs > 0) reasons.set("Eingang am Ziel belegt", plan.occupiedInputs);
  const skipped = plan.skipped.length;
  let msg = `${made} Verbindung${made === 1 ? "" : "en"} angelegt`;
  if (skipped > 0) msg += `, ${skipped} übersprungen`;
  if (reasons.size > 0) msg += ` (${[...reasons].map(([r, n]) => `${n}× ${r}`).join("; ")})`;
  return msg + ".";
}

// ---------- Bus-Helfer ----------

type Place = (comp: Comp) => void;

/** Bit k eines N-Bit-Ausgangs auf einen 1-Bit-Eingang: fügt einen Splitter ein. */
export function addBitSelect(
  c: Circuit,
  from: string,
  fromPort: number,
  to: string,
  toPort: number,
  bit: number,
  at: Point,
  place?: Place
): Comp | null {
  const src = c.get(from);
  const dst = c.get(to);
  if (!src || !dst) return null;
  const w = portWidths(src).out[fromPort];
  if (w === undefined || w < 2 || w > 32 || bit < 0 || bit >= w) return null;
  if (portWidths(dst).in[toPort] !== 1) return null;
  const sp = c.addComp("splitter", Math.round(at.x / CELL), Math.round(at.y / CELL));
  sp.width = w;
  place?.(sp);
  // Splitter-Ausgang i trägt Bit (w-1-i)
  const ok = c.addWire(from, fromPort, sp.id, 0) && c.addWire(sp.id, w - 1 - bit, to, toPort);
  if (!ok) {
    c.removeComp(sp.id);
    return null;
  }
  return sp;
}

/** 1-Bit-Quelle auf N-Bit-Eingang: Joiner, alle Eingänge vom selben Bit. */
export function addReplicate(
  c: Circuit,
  from: string,
  fromPort: number,
  to: string,
  toPort: number,
  at: Point,
  place?: Place
): Comp | null {
  const src = c.get(from);
  const dst = c.get(to);
  if (!src || !dst) return null;
  const n = portWidths(dst).in[toPort];
  if (portWidths(src).out[fromPort] !== 1 || n === undefined || n < 2 || n > 32) return null;
  const jo = c.addComp("joiner", Math.round(at.x / CELL), Math.round(at.y / CELL));
  jo.width = n;
  place?.(jo);
  let ok = !!c.addWire(jo.id, 0, to, toPort);
  for (let i = 0; i < n && ok; i++) ok = !!c.addWire(from, fromPort, jo.id, i);
  if (!ok) {
    c.removeComp(jo.id);
    return null;
  }
  return jo;
}

/** Größte sinnvolle Busbreite für „Bus auffächern“. */
export const FANOUT_MAX = 16;

/** Bus auffächern: Splitter plus je eine Ausgangslampe pro Bit (höchstes Bit oben). */
export function addFanOut(c: Circuit, from: string, fromPort: number, at: Point, place?: Place): Comp[] | null {
  const src = c.get(from);
  const w = src ? portWidths(src).out[fromPort] : undefined;
  if (!src || w === undefined || w < 2 || w > FANOUT_MAX) return null;
  const x = Math.round(at.x / CELL);
  const y = Math.round(at.y / CELL);
  const sp = c.addComp("splitter", x, y);
  sp.width = w;
  place?.(sp);
  const made: Comp[] = [sp];
  c.addWire(from, fromPort, sp.id, 0);
  for (let i = 0; i < w; i++) {
    const lamp = c.addComp("output", sp.x + 5, sp.y + i * 2);
    lamp.label = `b${w - 1 - i}`;
    place?.(lamp);
    made.push(lamp);
    c.addWire(sp.id, i, lamp.id, 0);
  }
  return made;
}

// ---------- Ausrichten / Verteilen ----------

/** Rechteck einer Einheit in Rasterzellen. */
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AlignMode = "left" | "right" | "top" | "bottom" | "centerX" | "centerY";
export type Move = { dx: number; dy: number };

/** Verschiebungen (ganze Zellen), die alle Boxen an einer gemeinsamen Kante/Mitte ausrichten. */
export function planAlign(boxes: Box[], mode: AlignMode): Map<string, Move> {
  const moves = new Map<string, Move>();
  if (boxes.length < 2) return moves;
  const minX = Math.min(...boxes.map((b) => b.x));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  for (const b of boxes) {
    let dx = 0;
    let dy = 0;
    if (mode === "left") dx = minX - b.x;
    else if (mode === "right") dx = maxX - b.w - b.x;
    else if (mode === "centerX") dx = Math.round((minX + maxX - b.w) / 2) - b.x;
    else if (mode === "top") dy = minY - b.y;
    else if (mode === "bottom") dy = maxY - b.h - b.y;
    else dy = Math.round((minY + maxY - b.h) / 2) - b.y;
    if (dx !== 0 || dy !== 0) moves.set(b.id, { dx, dy });
  }
  return moves;
}

/** Gleichmäßige Abstände entlang einer Achse; erstes und letztes Objekt bleiben stehen. */
export function planDistribute(boxes: Box[], axis: "x" | "y"): Map<string, Move> {
  const moves = new Map<string, Move>();
  if (boxes.length < 3) return moves;
  const pos = (b: Box) => (axis === "x" ? b.x : b.y);
  const size = (b: Box) => (axis === "x" ? b.w : b.h);
  const sorted = [...boxes].sort((a, b) => pos(a) - pos(b) || a.id.localeCompare(b.id));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = pos(last) + size(last) - pos(first);
  const free = span - sorted.reduce((s, b) => s + size(b), 0);
  const gap = free / (sorted.length - 1);
  let cursor = pos(first) + size(first);
  for (let i = 1; i < sorted.length - 1; i++) {
    const target = Math.round(cursor + gap);
    const d = target - pos(sorted[i]);
    if (d !== 0) moves.set(sorted[i].id, axis === "x" ? { dx: d, dy: 0 } : { dx: 0, dy: d });
    cursor = target + size(sorted[i]);
  }
  return moves;
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** IDs der bewegten Boxen, die nach der Verschiebung andere Boxen oder einander überlappen. */
export function findCollisions(boxes: Box[], moves: Map<string, Move>, others: Box[]): string[] {
  const moved = boxes.map((b) => {
    const m = moves.get(b.id);
    return m ? { ...b, x: b.x + m.dx, y: b.y + m.dy } : b;
  });
  const hit = new Set<string>();
  moved.forEach((a, i) => {
    if (!moves.has(a.id)) return;
    if (others.some((o) => overlap(a, o)) || moved.some((b, j) => i !== j && overlap(a, b))) hit.add(a.id);
  });
  return [...hit];
}
