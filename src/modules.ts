import { Circuit, SerializedCircuit, makeComp } from "./circuit";
import { layoutOf, newId } from "./logic";
import { Comp, GroupInstance, Wire, maskOf } from "./types";

export interface ModulePinDef {
  name: string;
  width: number;
  templateId: string;
}

export interface ModuleDef {
  id: string;
  name: string;
  inputs: ModulePinDef[];
  outputs: ModulePinDef[];
  /** Schaltplan des Moduls; Eingänge/Ausgänge sind Puffer an den Blockrändern. */
  circuit: SerializedCircuit;
  block: { cols: number; rows: number };
  footprint: { cols: number; rows: number };
  /** Versionsnummer, wird beim Bearbeiten hochgezählt. */
  version?: number;
  /** Erklärung „Was macht das?“ (Freitext). */
  description?: string;
  /** Rubrik in der Palette (nur eingebaute Module). */
  category?: string;
  /** Eingebautes Standardmodul: nicht löschbar, wird nur persistiert, wenn bearbeitet (version > 1). */
  builtin?: boolean;
  /** Pin-Beschreibungen nach Pin-Name. */
  pinDocs?: Record<string, string>;
}

const STORAGE_KEY = "logic-sandbox-modules-v1";
const BLOCK_COLS = 6;
/** Kleinster Block: eine Zelle Kopfzeile plus Platz für die Pins. */
const MIN_BLOCK_COLS = 4;
const PIN_BUF_COLS = 4;
const PIN_STEP = 3;

/** Kopfzeile in Zellen: bei kleinen Blöcken nur eine Zelle. */
export function blockHeaderRows(rows: number): number {
  return rows >= 6 ? 2 : 1;
}

let library: ModuleDef[] = [];

/** Prüft, ob ein importiertes Objekt eine brauchbare Modulvorlage ist. */
function isValidModule(m: unknown): m is ModuleDef {
  if (!m || typeof m !== "object") return false;
  const def = m as ModuleDef;
  return (
    typeof def.id === "string" &&
    typeof def.name === "string" &&
    !!def.circuit &&
    Array.isArray(def.circuit.comps) &&
    Array.isArray(def.circuit.wires) &&
    Array.isArray(def.inputs) &&
    Array.isArray(def.outputs) &&
    !!def.block &&
    typeof def.block.cols === "number" &&
    typeof def.block.rows === "number"
  );
}

/** Übernimmt Modulvorlagen aus einer importierten Datei (gleiche ID wird ersetzt). */
export function importModuleDefs(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  let count = 0;
  for (const item of raw) {
    if (!isValidModule(item)) continue;
    const def: ModuleDef = {
      ...item,
      version: item.version ?? 1,
      footprint: item.footprint ?? item.block,
    };
    library = library.filter((m) => m.id !== def.id);
    library.push(def);
    count++;
  }
  if (count > 0) persist();
  return count;
}

export function loadModuleLibrary(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as ModuleDef[];
    if (!Array.isArray(parsed)) return;
    library = parsed.filter(isValidModule).map((m) => ({
      ...m,
      version: m.version ?? 1,
      footprint: m.footprint ?? m.block,
    }));
  } catch {
    library = [];
  }
}

function persist(): void {
  try {
    // Unveränderte Standardmodule werden bei jedem Start neu erzeugt und nicht gespeichert.
    const saved = library.filter((m) => !m.builtin || (m.version ?? 1) > 1);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* Speicher nicht verfügbar */
  }
}

export function listModules(): ModuleDef[] {
  return library;
}

export function getModule(id: string): ModuleDef | undefined {
  return library.find((m) => m.id === id);
}

export function addModule(def: ModuleDef): void {
  library = library.filter((m) => m.id !== def.id);
  library.push(def);
  persist();
}

export function removeModule(id: string): void {
  if (getModule(id)?.builtin) return;
  library = library.filter((m) => m.id !== id);
  persist();
}

function pinName(comp: Comp, prefix: string, index: number): string {
  const base = comp.label.trim();
  return base || `${prefix}${index + 1}`;
}

function snapshot(comp: Comp): Partial<Comp> {
  return {
    id: comp.id,
    kind: comp.kind,
    x: comp.x,
    y: comp.y,
    width: comp.width,
    value: comp.value,
    div: comp.div,
    addrWidth: comp.addrWidth,
    dataWidth: comp.dataWidth,
    data: [...comp.data],
    format: comp.format,
    label: comp.label,
  };
}

export interface ModuleBlockInfo {
  /** Standardgröße des kompakten Blocks in Rasterzellen. */
  autoCols: number;
  autoRows: number;
  /** Kleinste sinnvolle Größe (Pins müssen hineinpassen). */
  minCols: number;
  minRows: number;
  inputs: number;
  outputs: number;
}

/** Klemmt eine Blockgröße auf sinnvolle Werte. */
export function clampBlockSize(value: number, min: number): number {
  const n = Number.isFinite(value) ? Math.round(value) : min;
  return Math.max(min, Math.min(64, n));
}

/** Y-Position eines Pin-Puffers: gleichmäßig über die Blockhöhe verteilt. */
function pinRowY(rows: number, count: number, i: number): number {
  const header = blockHeaderRows(rows);
  const usable = Math.max(1, rows - header);
  const cy = header + (usable * (i + 0.5)) / Math.max(1, count);
  return Math.max(header, Math.round(cy - 1.5));
}

interface ModuleSelection {
  comps: Comp[];
  inputs: Comp[];
  outputs: Comp[];
  inner: Comp[];
  minX: number;
  minY: number;
}

function analyzeSelection(circuit: Circuit, ids: string[]): ModuleSelection | null {
  const memberIds = new Set<string>();
  const exposedIn = new Set<string>();
  const exposedOut = new Set<string>();
  for (const id of ids) {
    const group = circuit.groups.get(id) ?? circuit.groupForComp(id);
    if (group) {
      group.members.forEach((m) => memberIds.add(m));
      // Ausgewählte Module behalten ihre Pins, wenn sie Teil eines neuen Moduls werden.
      if (circuit.groups.get(id) === group) {
        group.inputs.forEach((p) => exposedIn.add(p.compId));
        group.outputs.forEach((p) => exposedOut.add(p.compId));
      }
    } else if (circuit.comps.has(id)) {
      memberIds.add(id);
    }
  }
  const comps = [...memberIds]
    .map((id) => circuit.comps.get(id))
    .filter((c): c is Comp => !!c);
  if (comps.length === 0) return null;

  const isInput = (c: Comp) => c.kind === "input" || exposedIn.has(c.id);
  const isOutput = (c: Comp) => c.kind === "output" || exposedOut.has(c.id);
  const inputs = comps.filter(isInput).sort((a, b) => a.y - b.y || a.x - b.x);
  const outputs = comps.filter((c) => isOutput(c) && !isInput(c)).sort((a, b) => a.y - b.y || a.x - b.x);
  if (inputs.length === 0 && outputs.length === 0) return null;

  const inner = comps.filter((c) => !isInput(c) && !isOutput(c));
  const minX = inner.length ? Math.min(...inner.map((c) => c.x)) : 0;
  const minY = inner.length ? Math.min(...inner.map((c) => c.y)) : 0;
  return { comps, inputs, outputs, inner, minX, minY };
}

/** Standard- und Mindestgröße des Modulblocks für eine Auswahl. */
export function moduleBlockDefaults(circuit: Circuit, ids: string[]): ModuleBlockInfo | null {
  const sel = analyzeSelection(circuit, ids);
  if (!sel) return null;
  const pins = Math.max(sel.inputs.length, sel.outputs.length, 1);
  const minRows = Math.max(3, 1 + Math.ceil(pins / 2));
  return {
    autoCols: BLOCK_COLS,
    autoRows: minRows,
    minCols: MIN_BLOCK_COLS,
    minRows,
    inputs: sel.inputs.length,
    outputs: sel.outputs.length,
  };
}

/**
 * Erzeugt aus einer Auswahl eine Modulvorlage (ohne sie in die Bibliothek zu
 * legen). Eingangs-/Ausgangsbauteile werden zu Puffern; die Innenschaltung
 * bleibt erhalten. Über `size` lässt sich die endgültige Blockgröße vorgeben.
 */
export function buildModuleDef(
  circuit: Circuit,
  ids: string[],
  name: string,
  size?: { cols?: number; rows?: number },
  meta?: { id?: string; version?: number }
): ModuleDef | null {
  const sel = analyzeSelection(circuit, ids);
  if (!sel) return null;
  const { comps, inputs, outputs, inner, minX, minY } = sel;

  const pins = Math.max(inputs.length, outputs.length, 1);
  const minRows = Math.max(3, 1 + Math.ceil(pins / 2));
  const cols = clampBlockSize(size?.cols ?? BLOCK_COLS, MIN_BLOCK_COLS);
  const rows = clampBlockSize(size?.rows ?? minRows, minRows);

  const templateComps: Partial<Comp>[] = [];
  const idMap = new Map<string, string>();
  comps.forEach((c, i) => idMap.set(c.id, `t${i}`));

  const inputDefs: ModulePinDef[] = [];
  const outputDefs: ModulePinDef[] = [];
  const usedNames = new Set<string>();
  const uniqueName = (base: string) => {
    let candidate = base;
    let n = 2;
    while (usedNames.has(candidate)) candidate = `${base}_${n++}`;
    usedNames.add(candidate);
    return candidate;
  };

  // Pins stehen im Schaltplan links bzw. rechts der Innenschaltung.
  inputs.forEach((comp, i) => {
    const id = idMap.get(comp.id)!;
    const label = uniqueName(pinName(comp, "IN", i));
    templateComps.push({
      ...snapshot(comp),
      id,
      kind: "buf",
      x: 0,
      y: 2 + i * PIN_STEP,
      label,
    });
    inputDefs.push({ name: label, width: comp.width, templateId: id });
  });

  const innerComps: Partial<Comp>[] = [];
  for (const comp of inner) {
    innerComps.push({
      ...snapshot(comp),
      id: idMap.get(comp.id)!,
      x: comp.x - minX + 8,
      y: comp.y - minY + 2,
    });
  }
  let innerRight = 8;
  for (const raw of innerComps) {
    const temp: Comp = { ...makeComp(raw.kind!, raw.x ?? 0, raw.y ?? 0), ...raw } as Comp;
    innerRight = Math.max(innerRight, (raw.x ?? 0) + layoutOf(temp).cols);
  }
  templateComps.push(...innerComps);

  outputs.forEach((comp, i) => {
    const id = idMap.get(comp.id)!;
    const label = uniqueName(pinName(comp, "OUT", i));
    templateComps.push({
      ...snapshot(comp),
      id,
      kind: "buf",
      x: innerRight + 4,
      y: 2 + i * PIN_STEP,
      label,
    });
    outputDefs.push({ name: label, width: comp.width, templateId: id });
  });

  const templateWires = circuit.wires
    .filter((w) => idMap.has(w.from) && idMap.has(w.to))
    .map((w, i) => ({
      id: `tw${i}`,
      from: idMap.get(w.from)!,
      fromPort: w.fromPort,
      to: idMap.get(w.to)!,
      toPort: w.toPort,
    }));

  return {
    id: meta?.id ?? `mod_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim() || "Modul",
    inputs: inputDefs,
    outputs: outputDefs,
    circuit: { version: 1, comps: templateComps, wires: templateWires },
    block: { cols, rows },
    // Module werden nie aufgeklappt: die gewählte Größe ist die Endgröße.
    footprint: { cols, rows },
    version: meta?.version ?? 1,
  };
}

/** Erzeugt eine Modulvorlage aus einer Auswahl und legt sie in der Bibliothek ab. */
export function createModuleFromSelection(
  circuit: Circuit,
  ids: string[],
  name: string,
  size?: { cols?: number; rows?: number }
): ModuleDef | null {
  const def = buildModuleDef(circuit, ids, name, size);
  if (def) addModule(def);
  return def;
}

/** Schaltplan einer Modulvorlage zum Bearbeiten (Pins als Ein-/Ausgänge). */
export function editableCircuitForDef(def: ModuleDef): SerializedCircuit {
  const inIds = new Set(def.inputs.map((p) => p.templateId));
  const outIds = new Set(def.outputs.map((p) => p.templateId));
  const comps = def.circuit.comps.map((c) => {
    const copy = { ...c } as Partial<Comp>;
    if (copy.id && inIds.has(copy.id)) {
      copy.kind = "input";
      copy.value = 0;
    } else if (copy.id && outIds.has(copy.id)) {
      copy.kind = "output";
      copy.value = 0;
    }
    return copy;
  });
  return { version: 1, comps, wires: def.circuit.wires.map((w) => ({ ...w })), groups: [] };
}

/** Schaltplan einer platzierten Modul-Instanz zum Bearbeiten. */
export function editableCircuitForGroup(circuit: Circuit, groupId: string): SerializedCircuit | null {
  const group = circuit.groups.get(groupId);
  if (!group) return null;
  const memberIds = new Set(group.members);
  const inIds = new Set(group.inputs.map((p) => p.compId));
  const outIds = new Set(group.outputs.map((p) => p.compId));
  const comps: Partial<Comp>[] = [];
  for (const id of group.members) {
    const comp = circuit.comps.get(id);
    if (!comp) continue;
    const copy = snapshot(comp);
    if (inIds.has(id)) {
      copy.kind = "input";
      copy.value = 0;
    } else if (outIds.has(id)) {
      copy.kind = "output";
      copy.value = 0;
    }
    comps.push(copy);
  }

  // Pin-Bauteile für die Bearbeitung links/rechts neben die Innenschaltung legen.
  const inner = comps.filter((c) => c.id && !inIds.has(c.id) && !outIds.has(c.id));
  if (inner.length > 0) {
    const minX = Math.min(...inner.map((c) => c.x ?? 0));
    const maxX = Math.max(...inner.map((c) => c.x ?? 0));
    const minY = Math.min(...inner.map((c) => c.y ?? 0));
    const maxY = Math.max(...inner.map((c) => c.y ?? 0));
    const spread = (i: number, n: number) =>
      Math.round(n <= 1 ? (minY + maxY) / 2 : minY + ((maxY - minY) * i) / (n - 1));
    comps.forEach((c) => {
      if (!c.id) return;
      const iIn = group.inputs.findIndex((p) => p.compId === c.id);
      if (iIn >= 0) {
        c.x = minX - 6;
        c.y = spread(iIn, group.inputs.length);
      }
      const iOut = group.outputs.findIndex((p) => p.compId === c.id);
      if (iOut >= 0) {
        c.x = maxX + 2;
        c.y = spread(iOut, group.outputs.length);
      }
    });
  }

  return {
    version: 1,
    comps,
    wires: circuit.wires
      .filter((w) => memberIds.has(w.from) && memberIds.has(w.to))
      .map((w) => ({ ...w })),
    groups: [],
  };
}

/**
 * Ersetzt die Innenschaltung einer platzierten Instanz durch eine neue
 * Vorlage. Kabel zur Außenwelt werden über die Pin-Reihenfolge übernommen.
 */
export function replaceGroupInternals(circuit: Circuit, groupId: string, def: ModuleDef): GroupInstance | null {
  const old = circuit.groups.get(groupId);
  if (!old) return null;
  const members = new Set(old.members);
  const inIndex = new Map(old.inputs.map((p, i) => [p.compId, i]));
  const outIndex = new Map(old.outputs.map((p, i) => [p.compId, i]));

  const outside: { external: string; externalPort: number; side: "from" | "to"; pin: number; port: number }[] = [];
  const remaining: Wire[] = [];
  for (const wire of circuit.wires) {
    const fromMember = members.has(wire.from);
    const toMember = members.has(wire.to);
    if (fromMember === toMember) {
      remaining.push(wire);
      continue;
    }
    if (fromMember) {
      const pin = outIndex.get(wire.from);
      if (pin === undefined) continue;
      outside.push({ external: wire.to, externalPort: wire.toPort, side: "to", pin, port: wire.fromPort });
    } else {
      const pin = inIndex.get(wire.to);
      if (pin === undefined) continue;
      outside.push({ external: wire.from, externalPort: wire.fromPort, side: "from", pin, port: wire.toPort });
    }
  }

  for (const id of members) {
    circuit.comps.delete(id);
  }
  circuit.wires = remaining;
  circuit.groups.delete(groupId);

  const group = instantiateModule(circuit, def, old.x, old.y);
  for (const item of outside) {
    // `side` ist die Seite des Außenkabels: "to" = Modul speist nach außen,
    // "from" = außen speist in das Modul.
    if (item.side === "to") {
      const pin = group.outputs[item.pin];
      if (pin) circuit.addWire(pin.compId, item.port, item.external, item.externalPort);
    } else {
      const pin = group.inputs[item.pin];
      if (pin) circuit.addWire(item.external, item.externalPort, pin.compId, item.port);
    }
  }
  circuit.rebuild();
  circuit.reset();
  return group;
}

/** Ersetzt alle platzierten Instanzen eines Moduls durch eine neue Vorlage. */
export function replaceModuleInstances(circuit: Circuit, moduleId: string, def: ModuleDef): number {
  const ids = [...circuit.groups.values()].filter((g) => g.moduleId === moduleId).map((g) => g.id);
  let count = 0;
  for (const id of ids) {
    if (replaceGroupInternals(circuit, id, def)) count++;
  }
  return count;
}

/** Setzt eine Modulvorlage als kompakte Instanz in die Schaltung. */
export function instantiateModule(
  circuit: Circuit,
  def: ModuleDef,
  gx: number,
  gy: number
): GroupInstance {
  const map = new Map<string, string>();
  const newIds: string[] = [];
  for (const raw of def.circuit.comps) {
    if (!raw.kind) continue;
    const id = newId(raw.kind.slice(0, 2));
    map.set(raw.id ?? "", id);
    const comp: Comp = {
      ...makeComp(raw.kind, gx + (raw.x ?? 0), gy + (raw.y ?? 0)),
      ...raw,
      id,
      x: gx + (raw.x ?? 0),
      y: gy + (raw.y ?? 0),
      outs: [0],
      prevClk: 0,
      clkCounter: 0,
    } as Comp;
    if (comp.kind === "dff" || comp.kind === "latch") comp.outs = [0, maskOf(comp.width)];
    comp.data = [...(raw.data ?? [])];
    if ((comp.kind === "rom" || comp.kind === "ram") && comp.data.length === 0) {
      comp.data = new Array(1 << comp.addrWidth).fill(0);
    }
    circuit.comps.set(comp.id, comp);
    newIds.push(comp.id);
  }

  // Pin-Puffer immer an die Blockränder der Endgröße legen – auch bei älteren Vorlagen.
  def.inputs.forEach((p, i) => {
    const comp = circuit.comps.get(map.get(p.templateId) ?? "");
    if (!comp) return;
    comp.x = gx;
    comp.y = gy + pinRowY(def.block.rows, def.inputs.length, i);
  });
  def.outputs.forEach((p, i) => {
    const comp = circuit.comps.get(map.get(p.templateId) ?? "");
    if (!comp) return;
    comp.x = gx + def.block.cols - PIN_BUF_COLS;
    comp.y = gy + pinRowY(def.block.rows, def.outputs.length, i);
  });

  for (const wire of def.circuit.wires) {
    const from = map.get(wire.from);
    const to = map.get(wire.to);
    if (!from || !to) continue;
    circuit.wires.push({ id: newId("w"), from, fromPort: wire.fromPort, to, toPort: wire.toPort });
  }

  const group: GroupInstance = {
    id: newId("g"),
    moduleId: def.id,
    name: def.name,
    x: gx,
    y: gy,
    cols: def.block.cols,
    rows: def.block.rows,
    footprintCols: def.footprint.cols,
    footprintRows: def.footprint.rows,
    collapsed: true,
    members: newIds,
    inputs: def.inputs.map((p) => ({
      name: p.name,
      width: p.width,
      compId: map.get(p.templateId) ?? "",
    })),
    outputs: def.outputs.map((p) => ({
      name: p.name,
      width: p.width,
      compId: map.get(p.templateId) ?? "",
    })),
  };
  group.inputs = group.inputs.filter((p) => !!p.compId);
  group.outputs = group.outputs.filter((p) => !!p.compId);
  circuit.addGroup(group);
  circuit.rebuild();
  circuit.reset();
  return group;
}

function rectOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/** Sucht eine freie Stelle für eine Modul-Instanz. Platzbedarf ist der kompakte Block. */
export function findModuleSpot(
  circuit: Circuit,
  def: ModuleDef,
  x: number,
  y: number
): { x: number; y: number } | null {
  const blockers: { x: number; y: number; w: number; h: number }[] = [];
  for (const c of circuit.comps.values()) {
    // Zugeklappte Module sind nur als Block sichtbar – ihr Innenleben blockiert nichts.
    if (circuit.isCompHidden(c.id)) continue;
    const l = layoutOf(c);
    blockers.push({ x: c.x, y: c.y, w: l.cols, h: l.rows });
  }
  for (const g of circuit.groups.values()) {
    const rect = circuit.groupVisibleBounds(g.id);
    if (rect) blockers.push(rect);
  }
  const free = (px: number, py: number) =>
    !blockers.some((b) => rectOverlap(px, py, def.block.cols, def.block.rows, b.x, b.y, b.w, b.h));
  if (free(x, y)) return { x, y };
  for (let r = 1; r <= 48; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (free(x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
  }
  return null;
}
