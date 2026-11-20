import { CELL, Comp, CompKind, GroupInstance, Point, Wire, clampWidth, maskOf } from "./types";
import { KIND_INFO, computeOut, layoutOf, newId, portWidths } from "./logic";

export interface ExpandedLayoutData {
  /** Darstellungspositionen je Bauteil: [id, x, y]. */
  positions: [string, number, number][];
  /** Felder der Module in Zellen. */
  frames: { x: number; y: number; w: number; h: number; groupId?: string }[];
}

export interface SerializedCircuit {
  version: number;
  comps: Partial<Comp>[];
  wires: Wire[];
  groups?: GroupInstance[];
  /** Gesicherte Anordnung der entpackten Ansicht (Positionen und Felder). */
  expanded?: ExpandedLayoutData;
}

export function makeComp(kind: CompKind, x: number, y: number): Comp {
  const comp: Comp = {
    id: newId(kind.slice(0, 2)),
    kind,
    x,
    y,
    width: 1,
    value: 0,
    div: 1,
    addrWidth: 4,
    dataWidth: 8,
    data: [],
    format: "hex",
    label: "",
    outs: [0],
    prevClk: 0,
    clkCounter: 0,
  };
  if (kind === "rom" || kind === "ram") comp.data = new Array(1 << comp.addrWidth).fill(0);
  if (kind === "dff" || kind === "latch") comp.outs = [0, maskOf(comp.width)];
  return comp;
}

function key(compId: string, port: number): string {
  return `${compId}:${port}`;
}

/** Höhe der Kopfzeile eines Modulblocks in Zellen. */
export function groupHeaderRows(group: GroupInstance): number {
  return group.rows >= 6 ? 2 : 1;
}

/**
 * Position eines Block-Pins in Weltkoordinaten. Pins sitzen am linken bzw.
 * rechten Blockrand und werden gleichmäßig über die Blockhöhe verteilt.
 */
export function groupPinPoint(group: GroupInstance, input: boolean, index: number, count: number): Point {
  const header = groupHeaderRows(group);
  const usable = Math.max(1, group.rows - header);
  const y = group.y + header + (usable * (index + 0.5)) / Math.max(1, count);
  return { x: (input ? group.x : group.x + group.cols) * CELL, y: y * CELL };
}

export interface UnitSnapshot {
  comps: Partial<Comp>[];
  wires: Wire[];
  groups: GroupInstance[];
}

function rectsOverlap(
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

export class Circuit {
  comps = new Map<string, Comp>();
  /** Entpackte Gesamtansicht: alle Innenteile sichtbar, Positionen nur fürs Zeichnen. */
  expanded = false;
  private layoutOverride: Map<string, { x: number; y: number }> | null = null;
  wires: Wire[] = [];
  groups = new Map<string, GroupInstance>();
  /** Schnelle Zuordnung Bauteil → Gruppe. */
  private compGroup = new Map<string, string>();
  /** Geordnete Ausführungsreihenfolge (topologisch) */
  order: string[] = [];
  /** Bauteile in einer kombinatorischen Schleife */
  loopComps = new Set<string>();
  loopWires = new Set<string>();
  /** Kabel mit inkompatibler Breite */
  invalidWires = new Set<string>();
  /** Kabel je Eingangsport (garantiert einzelner Treiber) */
  inWire = new Map<string, Wire>();
  stepCount = 0;
  /** Zähler für Struktur-/Positionsänderungen (Cache für Kabelwege). */
  structureVersion = 0;

  private compSeq = 0;
  /** Portbreiten je Bauteil – nur bei Strukturänderungen neu berechnet. */
  private portCache = new Map<string, { in: number[]; out: number[] }>();
  /** Treiber je Eingangsport, indexiert für den Simulations-Hotpath. */
  private inPortWires = new Map<string, (Wire | undefined)[]>();
  private scratch: number[] = [];

  private widthsOf(comp: Comp): { in: number[]; out: number[] } {
    let w = this.portCache.get(comp.id);
    if (!w) {
      w = portWidths(comp);
      this.portCache.set(comp.id, w);
    }
    return w;
  }

  /** Füllt die Eingangswerte in ein wiederverwendetes Array. */
  private fillInputs(comp: Comp, out: number[]): number[] {
    const widths = this.widthsOf(comp).in;
    out.length = widths.length;
    const wires = this.inPortWires.get(comp.id);
    for (let i = 0; i < widths.length; i++) {
      const wire = wires?.[i];
      if (!wire) {
        out[i] = 0;
        continue;
      }
      const src = this.comps.get(wire.from);
      out[i] = src ? (src.outs[wire.fromPort] ?? 0) & maskOf(widths[i]) : 0;
    }
    return out;
  }

  addComp(kind: CompKind, x: number, y: number): Comp {
    const c = makeComp(kind, x, y);
    c.id = `${kind.slice(0, 2)}${(this.compSeq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    this.comps.set(c.id, c);
    return c;
  }

  get(id: string): Comp | undefined {
    return this.comps.get(id);
  }

  clear(): void {
    this.comps.clear();
    this.wires = [];
    this.groups.clear();
    this.compGroup.clear();
    this.layoutOverride = null;
    this.savedExpanded = null;
    this.expanded = false;
    this.expandedFrames = [];
    this.portCache.clear();
    this.inPortWires.clear();
    this.compSeq = 0;
    this.stepCount = 0;
    this.rebuild();
    this.reset();
  }

  removeComp(id: string): void {
    const group = this.groupForComp(id);
    if (group) {
      this.removeGroup(group.id);
      return;
    }
    this.comps.delete(id);
    this.wires = this.wires.filter((w) => w.from !== id && w.to !== id);
    this.rebuild();
  }

  groupForComp(id: string): GroupInstance | null {
    const groupId = this.compGroup.get(id);
    return groupId ? this.groups.get(groupId) ?? null : null;
  }

  addGroup(group: GroupInstance): void {
    this.groups.set(group.id, group);
    for (const m of group.members) this.compGroup.set(m, group.id);
  }

  /** Entfernt eine komplette Modul-Instanz inklusive aller Innenteile. */
  removeGroup(id: string): void {
    const group = this.groups.get(id);
    if (!group) return;
    const members = new Set(group.members);
    for (const m of members) {
      this.comps.delete(m);
      this.compGroup.delete(m);
    }
    this.wires = this.wires.filter((w) => !members.has(w.from) && !members.has(w.to));
    this.groups.delete(id);
    this.rebuild();
  }

  private clockNetCache: { version: number; set: Set<string> } | null = null;

  /**
   * Taktnetz: Taktgeber plus alle Puffer/Inverter, die direkt daran hängen.
   * Diese Leitungen werden beim Laufen sichtbar gepulst, damit der Takt auch
   * bei sehr hoher Taktfrequenz erkennbar blinkt.
   */
  clockNet(): Set<string> {
    if (this.clockNetCache && this.clockNetCache.version === this.structureVersion) {
      return this.clockNetCache.set;
    }
    const set = new Set<string>();
    const queue: string[] = [];
    for (const c of this.comps.values()) {
      if (c.kind === "clock") {
        set.add(c.id);
        queue.push(c.id);
      }
    }
    while (queue.length > 0) {
      const id = queue.pop()!;
      for (const wire of this.wires) {
        if (wire.from !== id) continue;
        const dst = this.comps.get(wire.to);
        if (!dst) continue;
        if (dst.kind !== "buf" && dst.kind !== "not") continue;
        if (set.has(dst.id)) continue;
        set.add(dst.id);
        queue.push(dst.id);
      }
    }
    this.clockNetCache = { version: this.structureVersion, set };
    return set;
  }

  /**
   * Felder der entpackten Ansicht in Zellen. Die Kabelführung behandelt sie als
   * Hindernisse, damit keine Leiterbahn hinter einem Modul verschwindet.
   */
  expandedFrames: { x: number; y: number; w: number; h: number; groupId?: string }[] = [];

  /**
   * Anordnung der entpackten Ansicht aus einer gespeicherten Schaltung. Sie
   * wird erst beim Öffnen der entpackten Ansicht übernommen.
   */
  savedExpanded: { positions: Map<string, { x: number; y: number }>; frames: ExpandedLayoutData["frames"] } | null = null;

  /** Setzt die Anordnung der entpackten Ansicht (null = normale Blockansicht). */
  setExpandedLayout(
    positions: Map<string, { x: number; y: number }> | null,
    frames: { x: number; y: number; w: number; h: number; groupId?: string }[] = []
  ): void {
    if (!positions) {
      // Beim Verlassen die eigene Anordnung einfrieren, damit sie beim
      // nächsten Speichern (auch außerhalb der Ansicht) erhalten bleibt.
      if (this.layoutOverride && this.expandedFrames.length > 0) {
        this.savedExpanded = {
          positions: new Map(this.layoutOverride),
          frames: this.expandedFrames.map((f) => ({ ...f })),
        };
      }
      this.layoutOverride = null;
      this.expanded = false;
      this.expandedFrames = [];
      return;
    }
    this.layoutOverride = positions;
    this.expanded = true;
    this.expandedFrames = frames.map((f) => ({ ...f }));
  }

  /** Zeichenposition eines Bauteils (in der entpackten Ansicht ggf. umgelegt). */
  posOf(comp: Comp): { x: number; y: number } {
    const p = this.layoutOverride?.get(comp.id);
    return p ?? { x: comp.x, y: comp.y };
  }

  /** Verschiebt ein Bauteil in der entpackten Ansicht (nur die Darstellung). */
  setExpandedPos(compId: string, x: number, y: number): void {
    if (!this.layoutOverride) return;
    this.layoutOverride.set(compId, { x, y });
  }

  /** Verschiebt ein Modulfeld in der entpackten Ansicht. */
  setExpandedFramePos(groupId: string, x: number, y: number): void {
    const frame = this.expandedFrames.find((f) => f.groupId === groupId);
    if (!frame) return;
    frame.x = x;
    frame.y = y;
  }

  /** Module werden außerhalb der entpackten Ansicht als kompakter Block gezeigt. */
  isCompHidden(id: string): boolean {
    return !this.expanded && !!this.groupForComp(id);
  }

  isWireHidden(wire: Wire): boolean {
    if (this.expanded) return false;
    const a = this.groupForComp(wire.from);
    const b = this.groupForComp(wire.to);
    return !!a && a === b;
  }

  /** Verschiebt eine Modul-Instanz samt Inhalt. */
  moveGroup(id: string, dx: number, dy: number): void {
    const group = this.groups.get(id);
    if (!group) return;
    group.x += dx;
    group.y += dy;
    for (const m of group.members) {
      const comp = this.comps.get(m);
      if (!comp) continue;
      comp.x += dx;
      comp.y += dy;
    }
  }

  /** Sichtbare Fläche einer Modul-Instanz (kompakter Block). */
  groupVisibleBounds(id: string): { x: number; y: number; w: number; h: number } | null {
    const group = this.groups.get(id);
    if (!group) return null;
    return { x: group.x, y: group.y, w: group.cols, h: group.rows };
  }

  private snapshotComp(comp: Comp): Partial<Comp> {
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

  /** Kopiert eine Auswahl (Bauteile/Gruppen) für Zwischenablage oder Duplikat. */
  extractUnits(ids: string[]): UnitSnapshot {
    const compIds = new Set<string>();
    const groupIds = new Set<string>();
    for (const id of ids) {
      const group = this.groups.get(id);
      if (group) {
        groupIds.add(group.id);
        group.members.forEach((m) => compIds.add(m));
        continue;
      }
      if (!this.comps.has(id)) continue;
      compIds.add(id);
      const parent = this.groupForComp(id);
      if (parent) {
        groupIds.add(parent.id);
        parent.members.forEach((m) => compIds.add(m));
      }
    }
    const comps: Partial<Comp>[] = [];
    for (const cid of compIds) {
      const comp = this.comps.get(cid);
      if (comp) comps.push(this.snapshotComp(comp));
    }
    const wires = this.wires
      .filter((w) => compIds.has(w.from) && compIds.has(w.to))
      .map((w) => ({ ...w }));
    const groups = [...groupIds]
      .map((gid) => this.groups.get(gid))
      .filter((g): g is GroupInstance => !!g)
      .map((g) => ({
        ...g,
        members: [...g.members],
        inputs: g.inputs.map((p) => ({ ...p })),
        outputs: g.outputs.map((p) => ({ ...p })),
      }));
    return { comps, wires, groups };
  }

  /** Fügt eine Kopie ein und liefert die neuen IDs (Gruppen bzw. Bauteile). */
  insertUnits(units: UnitSnapshot, dx: number, dy: number): string[] {
    const map = new Map<string, string>();
    const newCompIds: string[] = [];
    for (const raw of units.comps) {
      if (!raw.id || !raw.kind) continue;
      const base = makeComp(raw.kind, (raw.x ?? 0) + dx, (raw.y ?? 0) + dy);
      const comp: Comp = {
        ...base,
        ...raw,
        id: newId(raw.kind.slice(0, 2)),
        x: (raw.x ?? 0) + dx,
        y: (raw.y ?? 0) + dy,
        outs: base.outs,
        prevClk: 0,
        clkCounter: 0,
      } as Comp;
      if (comp.kind === "dff" || comp.kind === "latch") comp.outs = [0, maskOf(comp.width)];
      comp.data = [...(raw.data ?? [])];
      this.comps.set(comp.id, comp);
      map.set(raw.id, comp.id);
      newCompIds.push(comp.id);
    }
    for (const wire of units.wires) {
      const from = map.get(wire.from);
      const to = map.get(wire.to);
      if (!from || !to) continue;
      this.wires.push({ id: newId("w"), from, fromPort: wire.fromPort, to, toPort: wire.toPort });
    }
    const newGroupIds: string[] = [];
    for (const group of units.groups) {
      const members = group.members.map((m) => map.get(m)).filter((m): m is string => !!m);
      if (members.length === 0) continue;
      const copy: GroupInstance = {
        ...group,
        id: newId("g"),
        x: group.x + dx,
        y: group.y + dy,
        members,
        inputs: group.inputs
          .map((p) => ({ ...p, compId: map.get(p.compId) ?? "" }))
          .filter((p) => !!p.compId),
        outputs: group.outputs
          .map((p) => ({ ...p, compId: map.get(p.compId) ?? "" }))
          .filter((p) => !!p.compId),
      };
      this.addGroup(copy);
      newGroupIds.push(copy.id);
    }
    this.rebuild();
    return newGroupIds.length > 0 ? newGroupIds : newCompIds;
  }

  /** Dupliziert eine Auswahl versetzt und liefert die neuen IDs. */
  duplicateUnits(ids: string[], dx: number, dy: number): string[] {
    const units = this.extractUnits(ids);
    const spot = this.findFreeOffset(units, dx, dy);
    return this.insertUnits(units, spot.dx, spot.dy);
  }

  private rawLayout(raw: Partial<Comp>) {
    const temp: Comp = { ...makeComp(raw.kind as CompKind, 0, 0), ...raw } as Comp;
    return layoutOf(temp);
  }

  /** Umliegende Fläche einer Kopiervorlage in Rasterzellen. */
  unitsBounds(units: UnitSnapshot): { x: number; y: number; w: number; h: number } | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const raw of units.comps) {
      if (!raw.kind) continue;
      const l = this.rawLayout(raw);
      minX = Math.min(minX, raw.x ?? 0);
      minY = Math.min(minY, raw.y ?? 0);
      maxX = Math.max(maxX, (raw.x ?? 0) + l.cols);
      maxY = Math.max(maxY, (raw.y ?? 0) + l.rows);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** Prüft, ob eine Kopiervorlage an dieser Stelle frei liegt (nur sichtbare Flächen). */
  unitsFitAt(units: UnitSnapshot, dx: number, dy: number): boolean {
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    for (const raw of units.comps) {
      if (!raw.kind) continue;
      const l = this.rawLayout(raw);
      boxes.push({ x: (raw.x ?? 0) + dx, y: (raw.y ?? 0) + dy, w: l.cols, h: l.rows });
    }
    for (const b of boxes) {
      for (const comp of this.comps.values()) {
        if (this.isCompHidden(comp.id)) continue;
        const ol = layoutOf(comp);
        if (rectsOverlap(b.x, b.y, b.w, b.h, comp.x, comp.y, ol.cols, ol.rows)) return false;
      }
      for (const group of this.groups.values()) {
        const rect = this.groupVisibleBounds(group.id);
        if (!rect) continue;
        if (rectsOverlap(b.x, b.y, b.w, b.h, rect.x, rect.y, rect.w, rect.h)) return false;
      }
    }
    return true;
  }

  /** Sucht den nächsten freien Versatz für eine Kopiervorlage. */
  findFreeOffset(units: UnitSnapshot, dx: number, dy: number): { dx: number; dy: number } {
    if (this.unitsFitAt(units, dx, dy)) return { dx, dy };
    for (let r = 1; r <= 64; r++) {
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
          if (this.unitsFitAt(units, dx + ox, dy + oy)) return { dx: dx + ox, dy: dy + oy };
        }
      }
    }
    return { dx, dy };
  }

  addWire(from: string, fromPort: number, to: string, toPort: number): Wire | null {
    const src = this.comps.get(from);
    const dst = this.comps.get(to);
    if (!src || !dst) return null;
    const sw = portWidths(src).out[fromPort];
    const dw = portWidths(dst).in[toPort];
    if (sw === undefined || dw === undefined) return null;
    if (sw !== dw) return null;
    // ein Eingangsport hat genau einen Treiber
    this.wires = this.wires.filter((w) => !(w.to === to && w.toPort === toPort));
    const wire: Wire = { id: newId("w"), from, fromPort, to, toPort };
    this.wires.push(wire);
    this.rebuild();
    return wire;
  }

  removeWire(id: string): void {
    this.wires = this.wires.filter((w) => w.id !== id);
    this.rebuild();
  }

  /** Neuberechnung von Reihenfolge, Gültigkeit und Schleifen. Bei Strukturänderungen aufrufen. */
  rebuild(): void {
    this.structureVersion++;
    this.inWire.clear();
    this.inPortWires.clear();
    this.invalidWires.clear();
    this.loopComps.clear();
    this.loopWires.clear();
    this.portCache.clear();
    // Zuordnung Bauteil → Modul aktuell halten (auch nach Import/Kopieren).
    this.compGroup.clear();
    for (const g of this.groups.values()) {
      for (const m of g.members) this.compGroup.set(m, g.id);
    }

    this.wires = this.wires.filter((w) => this.comps.has(w.from) && this.comps.has(w.to));

    const adj = new Map<string, string[]>();
    const indeg = new Map<string, number>();
    for (const id of this.comps.keys()) {
      adj.set(id, []);
      indeg.set(id, 0);
    }

    for (const w of this.wires) {
      const src = this.comps.get(w.from);
      const dst = this.comps.get(w.to);
      if (!src || !dst) continue;
      const sw = portWidths(src).out[w.fromPort];
      const dw = portWidths(dst).in[w.toPort];
      if (sw === undefined || dw === undefined || sw !== dw) {
        this.invalidWires.add(w.id);
        continue;
      }
      this.inWire.set(key(w.to, w.toPort), w);
      let ports = this.inPortWires.get(w.to);
      if (!ports) {
        ports = new Array(this.widthsOf(dst).in.length);
        this.inPortWires.set(w.to, ports);
      }
      ports[w.toPort] = w;
      // Ein D-Flip-Flop liefert seinen gespeicherten Wert, keine kombinatorische Abhängigkeit
      if (dst.kind === "dff") continue;
      adj.get(w.from)!.push(w.to);
      indeg.set(w.to, (indeg.get(w.to) ?? 0) + 1);
    }

    const queue: string[] = [];
    for (const [id, d] of indeg) if (d === 0) queue.push(id);
    const order: string[] = [];
    for (let qi = 0; qi < queue.length; qi++) {
      const id = queue[qi];
      order.push(id);
      for (const nb of adj.get(id) ?? []) {
        const d = (indeg.get(nb) ?? 0) - 1;
        indeg.set(nb, d);
        if (d === 0) queue.push(nb);
      }
    }
    this.order = order;
    for (const id of this.comps.keys()) if (!order.includes(id)) this.loopComps.add(id);

    for (const w of this.wires) {
      if (this.loopComps.has(w.from) || this.loopComps.has(w.to)) this.loopWires.add(w.id);
    }
  }

  inputValues(comp: Comp): number[] {
    return this.fillInputs(comp, []);
  }

  evalComb(): void {
    const scratch = this.scratch;
    for (const id of this.order) {
      const c = this.comps.get(id);
      if (!c) continue;
      c.outs = computeOut(c, this.fillInputs(c, scratch));
    }
    for (const id of this.loopComps) {
      const c = this.comps.get(id);
      if (!c) continue;
      c.outs = new Array(this.widthsOf(c).out.length).fill(0);
    }
  }

  /** Ein vollständiger Taktzyklus: niedrig → hoch → niedrig. */
  step(): void {
    this.stepCount++;
    this.halfStep();
    this.halfStep();
  }

  /** Ein halber Takt (erzeugt bzw. beendet eine Flanke). */
  halfStep(): void {
    for (const c of this.comps.values()) {
      if (c.kind !== "clock") continue;
      c.clkCounter++;
      if (c.clkCounter >= Math.max(1, c.div)) {
        c.clkCounter = 0;
        const m = maskOf(c.width);
        c.outs[0] = ((c.outs[0] ?? 0) ^ m) & m;
      }
    }

    this.evalComb();

    const dffNext: { c: Comp; q: number }[] = [];
    for (const c of this.comps.values()) {
      if (c.kind !== "dff") continue;
      const ins = this.fillInputs(c, this.scratch);
      const clk = ins[1] & 1;
      const rst = ins[2] & 1;
      const m = maskOf(c.width);
      const prev = c.outs[0] & m;
      let next = prev;
      if (rst) next = 0;
      else if (c.prevClk === 0 && clk === 1) next = ins[0] & m;
      dffNext.push({ c, q: next });
      c.prevClk = clk;
    }

    const ramWrites: { c: Comp; addr: number; din: number }[] = [];
    for (const c of this.comps.values()) {
      if (c.kind !== "ram") continue;
      const ins = this.fillInputs(c, this.scratch);
      const clk = ins[3] & 1;
      const we = ins[2] & 1;
      if (c.prevClk === 0 && clk === 1 && we) {
        ramWrites.push({
          c,
          addr: (ins[0] ?? 0) & maskOf(c.addrWidth),
          din: (ins[1] ?? 0) & maskOf(c.dataWidth),
        });
      }
      c.prevClk = clk;
    }

    let changed = false;
    for (const { c, q } of dffNext) {
      const m = maskOf(c.width);
      if ((c.outs[0] & m) !== q) changed = true;
      c.outs[0] = q;
      c.outs[1] = ~q & m;
    }
    for (const { c, addr, din } of ramWrites) {
      if (c.data[addr] !== din) changed = true;
      c.data[addr] = din;
    }

    if (changed) this.evalComb();
  }

  reset(): void {
    this.stepCount = 0;
    for (const c of this.comps.values()) {
      if (c.kind === "dff" || c.kind === "latch") c.outs = [0, maskOf(c.width)];
      else if (c.kind === "clock") c.outs = [0];
      else c.outs = new Array(portWidths(c).out.length).fill(0);
      c.prevClk = 0;
      c.clkCounter = 0;
    }
    this.evalComb();
    // Takt-Eingänge an den Ausgangszustand angleichen, damit beim ersten Schritt
    // keine Phantom-Flanke entsteht.
    for (const c of this.comps.values()) {
      const clkIndex = c.kind === "dff" ? 1 : c.kind === "ram" ? 3 : -1;
      if (clkIndex >= 0) c.prevClk = this.inputValues(c)[clkIndex] & 1;
    }
  }

  setWidth(comp: Comp, width: number): void {
    comp.width = clampWidth(width);
    comp.value &= maskOf(comp.width);
    if (comp.kind === "dff" || comp.kind === "latch") comp.outs = [comp.outs[0] & maskOf(comp.width), maskOf(comp.width)];
    const group = this.groupForComp(comp.id);
    if (group) {
      const pin = [...group.inputs, ...group.outputs].find((p) => p.compId === comp.id);
      if (pin) pin.width = comp.width;
    }
    this.rebuild();
  }

  toggleInput(comp: Comp): void {
    const m = maskOf(comp.width);
    comp.value = (comp.value ^ 1) & m;
    this.evalComb();
  }

  setInputValue(comp: Comp, value: number): void {
    comp.value = value & maskOf(comp.width);
    this.evalComb();
  }

  toggleBit(comp: Comp, bit: number): void {
    comp.value = (comp.value ^ (1 << bit)) & maskOf(comp.width);
    this.evalComb();
  }

  pinPos(comp: Comp, dir: "in" | "out", index: number): Point {
    // Pins einer kompakten Modul-Instanz liegen am Blockrand, nicht am
    // (verborgenen) Innenbauteil. In der entpackten Ansicht zählt die echte Position.
    if (!this.expanded) {
      const group = this.groupForComp(comp.id);
      if (group) {
        const pins = dir === "in" ? group.inputs : group.outputs;
        const pinIndex = pins.findIndex((p) => p.compId === comp.id);
        if (pinIndex >= 0) return groupPinPoint(group, dir === "in", pinIndex, pins.length);
      }
    }
    const pos = this.posOf(comp);
    const l = layoutOf(comp);
    const p = dir === "in" ? l.ins[index] : l.outs[index];
    if (!p) return { x: pos.x * CELL, y: pos.y * CELL };
    return {
      x: pos.x * CELL + p.fx * l.cols * CELL,
      y: pos.y * CELL + p.fy * l.rows * CELL,
    };
  }

  serialize(): SerializedCircuit {
    const comps: Partial<Comp>[] = [];
    for (const c of this.comps.values()) {
      comps.push({
        id: c.id,
        kind: c.kind,
        x: c.x,
        y: c.y,
        width: c.width,
        value: c.value,
        div: c.div,
        addrWidth: c.addrWidth,
        dataWidth: c.dataWidth,
        data: [...c.data],
        format: c.format,
        label: c.label,
      });
    }
    const result: SerializedCircuit = {
      version: 1,
      comps,
      wires: this.wires.map((w) => ({ ...w })),
      groups: [...this.groups.values()].map((g) => ({
        ...g,
        members: [...g.members],
        inputs: g.inputs.map((p) => ({ ...p })),
        outputs: g.outputs.map((p) => ({ ...p })),
      })),
    };
    // Eigene Anordnung der entpackten Ansicht dauerhaft mitspeichern – auch
    // dann, wenn gerade die normale Blockansicht zu sehen ist.
    if (this.layoutOverride) {
      result.expanded = {
        positions: [...this.layoutOverride.entries()].map(([id, p]) => [id, p.x, p.y]),
        frames: this.expandedFrames.map((f) => ({ ...f })),
      };
    } else if (this.savedExpanded) {
      result.expanded = {
        positions: [...this.savedExpanded.positions.entries()].map(([id, p]) => [id, p.x, p.y]),
        frames: this.savedExpanded.frames.map((f) => ({ ...f })),
      };
    }
    return result;
  }

  load(data: SerializedCircuit): void {
    this.comps.clear();
    this.wires = [];
    this.groups.clear();
    this.compGroup.clear();
    this.compSeq = 0;
    this.layoutOverride = null;
    this.savedExpanded = null;
    this.expanded = false;
    this.expandedFrames = [];
    for (const raw of data.comps ?? []) {
      if (!raw.kind || !raw.id) continue;
      if (!(raw.kind in KIND_INFO)) continue;
      const base = makeComp(raw.kind as CompKind, raw.x ?? 0, raw.y ?? 0);
      const c: Comp = {
        ...base,
        ...raw,
        outs: base.outs,
        prevClk: 0,
        clkCounter: 0,
      } as Comp;
      this.comps.set(c.id, c);
    }
    this.wires = (data.wires ?? []).filter((w) => this.comps.has(w.from) && this.comps.has(w.to));
    for (const g of data.groups ?? []) {
      if (!g || !g.id || !g.members) continue;
      const members = g.members.filter((m) => this.comps.has(m));
      if (members.length === 0) continue;
      this.addGroup({
        ...g,
        members,
        inputs: (g.inputs ?? []).filter((p) => this.comps.has(p.compId)),
        outputs: (g.outputs ?? []).filter((p) => this.comps.has(p.compId)),
        collapsed: true,
      });
    }
    const saved = data.expanded;
    if (saved && Array.isArray(saved.positions)) {
      const positions = new Map<string, { x: number; y: number }>();
      for (const entry of saved.positions) {
        if (!Array.isArray(entry) || entry.length < 3) continue;
        const [id, x, y] = entry;
        if (typeof id !== "string" || !this.comps.has(id)) continue;
        if (typeof x !== "number" || typeof y !== "number") continue;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        positions.set(id, { x, y });
      }
      const frames = (Array.isArray(saved.frames) ? saved.frames : [])
        .filter(
          (f) =>
            !!f &&
            typeof f.x === "number" &&
            typeof f.y === "number" &&
            typeof f.w === "number" &&
            typeof f.h === "number"
        )
        .map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, groupId: f.groupId }));
      if (positions.size > 0) this.savedExpanded = { positions, frames };
    }
    this.rebuild();
    this.reset();
  }
}
