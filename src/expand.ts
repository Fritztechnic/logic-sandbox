import { Circuit } from "./circuit";
import { layoutOf } from "./logic";
import { GroupInstance } from "./types";

export interface ExpandedFrame {
  group: GroupInstance;
  /** Rahmen in Zellen (Weltkoordinaten) */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExpandedLayout {
  positions: Map<string, { x: number; y: number }>;
  frames: ExpandedFrame[];
}

interface Panel {
  group: GroupInstance;
  w: number;
  h: number;
  minX: number;
  minY: number;
  members: string[];
}

const GAP = 10;
const PAD = 2;

function boundsOf(circuit: Circuit, ids: string[]): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const comp = circuit.get(id);
    if (!comp) continue;
    const l = layoutOf(comp);
    minX = Math.min(minX, comp.x);
    minY = Math.min(minY, comp.y);
    maxX = Math.max(maxX, comp.x + l.cols);
    maxY = Math.max(maxY, comp.y + l.rows);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function pack(panels: Panel[], maxWidth: number): { rows: { panels: Panel[]; width: number }[]; width: number; height: number } {
  const rows: { panels: Panel[]; width: number }[] = [];
  let row: Panel[] = [];
  let rowWidth = 0;
  let totalHeight = 0;
  for (const panel of panels) {
    if (row.length > 0 && rowWidth + GAP + panel.w > maxWidth) {
      rows.push({ panels: row, width: rowWidth });
      totalHeight += Math.max(...row.map((p) => p.h)) + GAP;
      row = [];
      rowWidth = 0;
    }
    if (row.length > 0) rowWidth += GAP;
    row.push(panel);
    rowWidth += panel.w;
  }
  if (row.length > 0) {
    rows.push({ panels: row, width: rowWidth });
    totalHeight += Math.max(...row.map((p) => p.h));
  }
  return { rows, width: Math.max(0, ...rows.map((r) => r.width)), height: totalHeight };
}

/**
 * Übernimmt eine gespeicherte Anordnung, sofern sie noch vollständig zur
 * Schaltung passt (alle Bauteile und alle Module vorhanden). Sonst null.
 */
export function savedExpandedLayout(circuit: Circuit): ExpandedLayout | null {
  const saved = circuit.savedExpanded;
  if (!saved || saved.positions.size === 0) return null;
  const groups = [...circuit.groups.values()];
  if (groups.length === 0) return null;
  // Alle Innenteile brauchen eine Position; die Außenbeschaltung behält ihre.
  const members = new Set<string>();
  for (const group of groups) group.members.forEach((id) => members.add(id));
  for (const id of members) if (!saved.positions.has(id)) return null;
  const frames: ExpandedFrame[] = [];
  for (const group of groups) {
    const frame = saved.frames.find((f) => f.groupId === group.id);
    if (!frame) return null;
    frames.push({ group, x: frame.x, y: frame.y, w: frame.w, h: frame.h });
  }
  return { positions: new Map(saved.positions), frames };
}

/**
 * Berechnet eine ruhige, überlappungsfreie Anordnung für die entpackte
 * Gesamtansicht: die Außenbeschaltung bleibt stehen, jedes Modul bekommt
 * darunter ein eigenes Feld mit Titel, in dem seine Innenschaltung liegt.
 */
export function computeExpandedLayout(circuit: Circuit, aspect = 16 / 9): ExpandedLayout {
  const memberIds = new Set<string>();
  for (const group of circuit.groups.values()) group.members.forEach((id) => memberIds.add(id));

  const topIds = [...circuit.comps.keys()].filter((id) => !memberIds.has(id));
  const top = boundsOf(circuit, topIds);

  const panels: Panel[] = [];
  for (const group of circuit.groups.values()) {
    const box = boundsOf(circuit, group.members);
    if (!box) continue;
    panels.push({
      group,
      w: box.w + PAD * 2,
      h: box.h + PAD * 2,
      minX: box.x,
      minY: box.y,
      members: [...group.members],
    });
  }

  const positions = new Map<string, { x: number; y: number }>();
  const frames: ExpandedFrame[] = [];

  if (panels.length === 0) {
    return { positions, frames };
  }

  // Große Module zuerst, damit die Reihen kompakt bleiben.
  panels.sort((a, b) => b.h - a.h || b.w - a.w || a.group.name.localeCompare(b.group.name));

  // Breite wählen, die die Gesamtfläche bestmöglich in das Ansichtsfenster bringt.
  const mainW = top?.w ?? 0;
  const mainH = top?.h ?? 0;
  const widest = Math.max(40, ...panels.map((p) => p.w));
  const candidates: number[] = [];
  for (let w = 60; w <= widest + 40; w += 10) candidates.push(w);
  let best = candidates[0];
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const p = pack(panels, candidate);
    const width = Math.max(mainW, p.width);
    const height = mainH + GAP + p.height;
    const score = Math.max(width / aspect, height);
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = candidate;
    }
  }

  const packed = pack(panels, best);
  const startX = top?.x ?? 0;
  let y = (top ? top.y + top.h + GAP : 0);

  for (const row of packed.rows) {
    const rowHeight = Math.max(...row.panels.map((p) => p.h));
    let x = startX;
    for (const panel of row.panels) {
      const dx = x - panel.minX + PAD;
      const dy = y - panel.minY + PAD;
      for (const id of panel.members) {
        const comp = circuit.get(id);
        if (!comp) continue;
        positions.set(id, { x: comp.x + dx, y: comp.y + dy });
      }
      const box = boundsOf(circuit, panel.members);
      if (box) {
        frames.push({
          group: panel.group,
          x: box.x + dx - PAD,
          y: box.y + dy - PAD,
          w: box.w + PAD * 2,
          h: box.h + PAD * 2,
        });
      }
      x += panel.w + GAP;
    }
    y += rowHeight + GAP;
  }

  return { positions, frames };
}
