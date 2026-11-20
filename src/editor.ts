import { Circuit, UnitSnapshot } from "./circuit";
import { ExpandedFrame } from "./expand";
import { distToCurve, wireCurve } from "./geometry";
import {
  AlignMode,
  Box,
  ConnectPlan,
  FANOUT_MAX,
  addBitSelect,
  addFanOut,
  addReplicate,
  applyPlan,
  describePlan,
  findCollisions,
  planAlign,
  planAutoConnect,
  planConnect,
  planDistribute,
} from "./connect";
import { layoutOf, portWidths } from "./logic";
import { WireStyle, distToPolyline, getWireRoutes } from "./route";
import { CELL, Comp, EditorState, GroupInstance, Point, View } from "./types";

export interface EditorHooks {
  /** Struktur geändert (Bauteil/Kabel) */
  structural(): void;
  /** Nur Positionen verschoben (in der entpackten Ansicht ohne Neuberechnung). */
  moved(): void;
  /** Nur Signalwerte geändert */
  valueChange(): void;
  selectionChange(): void;
  /** Zeichenfläche neu zeichnen (nur nötig, wenn sich etwas geändert hat). */
  invalidate(): void;
  status(msg: string, kind?: "info" | "warn" | "err"): void;
  /** Setzt eine Modulvorlage auf die Fläche (App-seitig). */
  placeModule(moduleId: string, x: number, y: number): GroupInstance | null;
  /** Öffnet ein Modul im Modul-Editor (App-seitig). */
  openGroupModule(groupId: string): void;
  /** Öffnet den Speicher-Explorer für ROM/RAM (App-seitig). */
  openMemory?(compId: string): void;
}

interface Snapshot {
  comps: Map<string, { x: number; y: number }>;
  groups: Map<string, { x: number; y: number }>;
}

type Drag =
  | { mode: "none" }
  | { mode: "pan"; sx: number; sy: number; panX0: number; panY0: number }
  | {
      mode: "maybeMove";
      id: string;
      sx: number;
      sy: number;
      wx: number;
      wy: number;
      data: Snapshot;
    }
  | { mode: "move"; sx: number; sy: number; wx: number; wy: number; data: Snapshot }
  | { mode: "box"; x1: number; y1: number; x2: number; y2: number; additive: boolean };

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

export class Editor {
  state: EditorState = {
    tool: "select",
    selection: null,
    selected: [],
    box: null,
    ghost: null,
    wireDrag: null,
    hovered: null,
  };
  view: View = { panX: 80, panY: 60, zoom: 1 };
  /**
   * Nur-Lese-Ansicht (entpackte Ansicht): Auswählen und Einstellen ist erlaubt,
   * Verschieben, Verbinden und Löschen nicht.
   */
  readOnly = false;
  /** Felder der entpackten Ansicht für die Klick-Auswahl von Modulen. */
  frames: ExpandedFrame[] = [];
  /** Kabelführung – muss zur Anzeige passen, damit der Treffer-Test stimmt. */
  routeStyle: WireStyle = "ortho";

  private drag: Drag = { mode: "none" };
  private lastMouse: Point = { x: 0, y: 0 };
  /** Interne Zwischenablage für Bauteile und Module. */
  private clipboard: UnitSnapshot | null = null;
  /** Massen-Verbindung: Quellen stehen fest, das Ziel wird angeklickt. */
  private bulk: { sources: string[] } | null = null;
  private menu: HTMLDivElement | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private circuit: Circuit,
    private hooks: EditorHooks
  ) {
    canvas.addEventListener("mousedown", this.onMouseDown);
    canvas.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("mouseleave", this.onMouseLeave);
  }

  /** Wechselt die bearbeitete Schaltung (z. B. in den Modul-Editor). */
  setCircuit(circuit: Circuit): void {
    this.circuit = circuit;
    this.drag = { mode: "none" };
    this.state.selection = null;
    this.state.selected = [];
    this.state.box = null;
    this.state.ghost = null;
    this.state.wireDrag = null;
    this.state.hovered = null;
    this.state.tool = "select";
    this.hooks.selectionChange();
    this.hooks.invalidate();
  }

  /** Setzt die Modulfelder der entpackten Ansicht (für Klicks auf Module). */
  setFrames(frames: ExpandedFrame[]): void {
    this.frames = frames;
  }

  setTool(tool: EditorState["tool"]): void {
    this.endBulk();
    this.closeMenu();
    this.state.tool = tool;
    this.state.ghost = null;
    this.hooks.invalidate();
    if (typeof tool !== "string" && "place" in tool) {
      const g = this.worldFromScreen(this.lastMouse.x, this.lastMouse.y);
      this.state.ghost = { kind: tool.place, x: Math.round(g.x / CELL), y: Math.round(g.y / CELL) };
    }
  }

  cancel(): void {
    this.endBulk();
    this.closeMenu();
    this.state.wireDrag = null;
    this.state.ghost = null;
    this.state.box = null;
    this.hooks.invalidate();
    if (this.state.tool !== "select") this.setTool("select");
  }

  select(sel: EditorState["selection"]): void {
    this.state.selection = sel;
    this.state.selected = sel && sel.type !== "wire" ? [sel.id] : [];
    this.hooks.selectionChange();
    this.hooks.invalidate();
  }

  private selectionForId(id: string): EditorState["selection"] {
    if (this.circuit.groups.has(id)) return { type: "group", id };
    if (this.circuit.comps.has(id)) return { type: "comp", id };
    return null;
  }

  private applySelected(ids: string[]): void {
    this.state.selected = [...new Set(ids)];
    const last = this.state.selected[this.state.selected.length - 1];
    this.state.selection = last ? this.selectionForId(last) : null;
    this.hooks.selectionChange();
    this.hooks.invalidate();
  }

  private toggleSelected(id: string): void {
    if (this.state.selected.includes(id)) {
      this.applySelected(this.state.selected.filter((x) => x !== id));
    } else {
      this.applySelected([...this.state.selected, id]);
    }
  }

  selectedCompIds(): string[] {
    const ids = new Set<string>();
    for (const id of this.state.selected) {
      const group = this.circuit.groups.get(id);
      if (group) {
        group.members.forEach((m) => ids.add(m));
      } else if (this.circuit.comps.has(id)) {
        ids.add(id);
      }
    }
    return [...ids];
  }

  deleteSelection(): void {
    const sel = this.state.selection;
    if (this.state.selected.length > 0) {
      for (const id of [...this.state.selected]) {
        if (this.circuit.groups.has(id)) this.circuit.removeGroup(id);
        else if (this.circuit.comps.has(id)) this.circuit.removeComp(id);
      }
      this.state.selection = null;
      this.state.selected = [];
      this.hooks.structural();
      this.hooks.status("Auswahl gelöscht.");
      return;
    }
    if (!sel) return;
    if (sel.type === "comp") this.circuit.removeComp(sel.id);
    else if (sel.type === "group") this.circuit.removeGroup(sel.id);
    else this.circuit.removeWire(sel.id);
    this.state.selection = null;
    this.state.selected = [];
    this.hooks.structural();
    this.hooks.status("Auswahl gelöscht.");
  }

  hasClipboard(): boolean {
    return !!this.clipboard && (this.clipboard.comps.length > 0 || this.clipboard.groups.length > 0);
  }

  /** Kopiert die aktuelle Auswahl in die interne Zwischenablage. */
  copySelection(): boolean {
    if (this.state.selected.length === 0) return false;
    const units = this.circuit.extractUnits(this.state.selected);
    if (units.comps.length === 0) return false;
    this.clipboard = units;
    return true;
  }

  cutSelection(): boolean {
    if (!this.copySelection()) return false;
    this.deleteSelection();
    return true;
  }

  /** Fügt die Zwischenablage an der Mausposition ein (mit freier Stelle). */
  pasteClipboard(world?: Point): string[] {
    if (!this.clipboard) return [];
    const units = this.clipboard;
    const bounds = this.circuit.unitsBounds(units);
    if (!bounds) return [];
    // Ohne Mausposition (z. B. direkt nach dem Laden) in die Mitte der Fläche einfügen.
    const fallback = this.worldFromScreen(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
    const target = world ?? (this.lastMouse.x || this.lastMouse.y ? this.worldFromScreen(this.lastMouse.x, this.lastMouse.y) : fallback);
    const dx = Math.round(target.x / CELL) - Math.round(bounds.x);
    const dy = Math.round(target.y / CELL) - Math.round(bounds.y);
    const spot = this.circuit.findFreeOffset(units, dx, dy);
    const ids = this.circuit.insertUnits(units, spot.dx, spot.dy);
    if (ids.length === 0) return [];
    this.applySelected(ids);
    this.hooks.structural();
    this.hooks.status(`${ids.length} Objekt${ids.length === 1 ? "" : "e"} eingefügt.`);
    return ids;
  }

  /** Dupliziert die Auswahl versetzt und sucht dafür die nächste freie Stelle. */
  duplicateSelection(): string[] {
    if (this.state.selected.length === 0) return [];
    const units = this.circuit.extractUnits(this.state.selected);
    if (!units.comps.length) return [];
    const spot = this.circuit.findFreeOffset(units, 2, 0);
    const ids = this.circuit.insertUnits(units, spot.dx, spot.dy);
    if (ids.length === 0) return [];
    this.applySelected(ids);
    this.hooks.structural();
    this.hooks.status(`${ids.length} Objekt${ids.length === 1 ? "" : "e"} dupliziert.`);
    return ids;
  }

  zoomBy(factor: number, center?: Point): void {
    const c = center ?? { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 };
    this.hooks.invalidate();
    const before = this.worldFromScreen(c.x, c.y);
    this.view.zoom = Math.max(0.05, Math.min(2.5, this.view.zoom * factor));
    const after = this.worldFromScreen(c.x, c.y);
    this.view.panX += (after.x - before.x) * this.view.zoom;
    this.view.panY += (after.y - before.y) * this.view.zoom;
  }

  centerContent(): void {
    if (this.circuit.comps.size === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of this.circuit.comps.values()) {
      if (this.circuit.isCompHidden(c.id)) continue;
      const l = layoutOf(c);
      const pos = this.circuit.posOf(c);
      minX = Math.min(minX, pos.x * CELL);
      minY = Math.min(minY, pos.y * CELL);
      maxX = Math.max(maxX, (pos.x + l.cols) * CELL);
      maxY = Math.max(maxY, (pos.y + l.rows) * CELL);
    }
    if (!this.circuit.expanded) {
      for (const g of this.circuit.groups.values()) {
        minX = Math.min(minX, g.x * CELL);
        minY = Math.min(minY, g.y * CELL);
        maxX = Math.max(maxX, (g.x + g.cols) * CELL);
        maxY = Math.max(maxY, (g.y + g.rows) * CELL);
      }
    }
    if (!Number.isFinite(minX)) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const zoom = Math.min(
      1.1,
      Math.max(0.05, Math.min((cw - 60) / Math.max(1, maxX - minX), (ch - 60) / Math.max(1, maxY - minY)))
    );
    this.view.zoom = zoom;
    this.view.panX = cw / 2 - ((minX + maxX) / 2) * zoom;
    this.view.panY = ch / 2 - ((minY + maxY) / 2) * zoom;
    this.hooks.invalidate();
  }

  private screenFromEvent(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private worldFromScreen(sx: number, sy: number): Point {
    return { x: (sx - this.view.panX) / this.view.zoom, y: (sy - this.view.panY) / this.view.zoom };
  }

  private worldFromEvent(e: MouseEvent): Point {
    const s = this.screenFromEvent(e);
    return this.worldFromScreen(s.x, s.y);
  }

  private hitPin(world: Point, compFilter?: "in" | "out"): { comp: Comp; dir: "in" | "out"; port: number } | null {
    const r = Math.max(9, 12 / this.view.zoom);
    let best: { comp: Comp; dir: "in" | "out"; port: number } | null = null;
    let bestDist = r;
    for (const comp of this.circuit.comps.values()) {
      if (this.circuit.isCompHidden(comp.id)) {
        const group = this.circuit.groupForComp(comp.id);
        if (!group) continue;
        // Nur die Schnittstellen-Pins bleiben am Block erreichbar.
        const isBoundaryIn = group.inputs.some((p) => p.compId === comp.id);
        const isBoundaryOut = group.outputs.some((p) => p.compId === comp.id);
        if (!isBoundaryIn && !isBoundaryOut) continue;
      }
      const l = layoutOf(comp);
      const check = (dir: "in" | "out", ports: typeof l.ins) => {
        ports.forEach((p, i) => {
          if (compFilter && compFilter !== dir) return;
          if (this.circuit.isCompHidden(comp.id)) {
            const group = this.circuit.groupForComp(comp.id)!;
            const boundary =
              dir === "in"
                ? group.inputs.some((x) => x.compId === comp.id)
                : group.outputs.some((x) => x.compId === comp.id);
            if (!boundary) return;
          }
          const pos = this.circuit.pinPos(comp, dir, i);
          void p;
          const d = Math.hypot(pos.x - world.x, pos.y - world.y);
          if (d < bestDist) {
            bestDist = d;
            best = { comp, dir, port: i };
          }
        });
      };
      check("in", l.ins);
      check("out", l.outs);
    }
    return best;
  }

  /** Trifft eine Stelle ein Modulfeld der entpackten Ansicht? */
  private hitFrame(world: Point): GroupInstance | null {
    const titleH = 18;
    for (const frame of this.frames) {
      const x = frame.x * CELL;
      const y = frame.y * CELL;
      const w = frame.w * CELL;
      const h = frame.h * CELL;
      if (world.x >= x && world.x <= x + w && world.y >= y - titleH && world.y <= y + h) return frame.group;
    }
    return null;
  }

  private hitGroupBlock(world: Point): GroupInstance | null {
    let found: GroupInstance | null = null;
    for (const group of this.circuit.groups.values()) {
      if (
        world.x >= group.x * CELL &&
        world.x <= (group.x + group.cols) * CELL &&
        world.y >= group.y * CELL &&
        world.y <= (group.y + group.rows) * CELL
      ) {
        found = group;
      }
    }
    return found;
  }

  private hitComp(world: Point): Comp | null {
    // Gleiche Reihenfolge wie beim Zeichnen: aufgeklappte Module liegen oben
    // und werden deshalb auch zuerst getroffen.
    let found: Comp | null = null;
    const hit = (comp: Comp): boolean => {
      const l = layoutOf(comp);
      const pos = this.circuit.posOf(comp);
      const x = pos.x * CELL;
      const y = pos.y * CELL;
      return world.x >= x && world.x <= x + l.cols * CELL && world.y >= y && world.y <= y + l.rows * CELL;
    };
    for (const comp of this.circuit.comps.values()) {
      if (this.circuit.isCompHidden(comp.id)) continue;
      if (this.circuit.groupForComp(comp.id)) continue;
      if (hit(comp)) found = comp;
    }
    for (const comp of this.circuit.comps.values()) {
      if (this.circuit.isCompHidden(comp.id)) continue;
      if (!this.circuit.groupForComp(comp.id)) continue;
      if (hit(comp)) found = comp;
    }
    return found;
  }

  private hitWire(world: Point): string | null {
    const tol = 7 / this.view.zoom;
    let found: string | null = null;
    let best = tol;
    const routes = getWireRoutes(this.circuit, this.routeStyle);
    for (const wire of this.circuit.wires) {
      if (this.circuit.isWireHidden(wire)) continue;
      const src = this.circuit.get(wire.from);
      const dst = this.circuit.get(wire.to);
      if (!src || !dst) continue;
      const route = routes.get(wire.id);
      let d: number;
      if (route) {
        d = distToPolyline(world, route);
      } else {
        const curve = wireCurve(
          this.circuit.pinPos(src, "out", wire.fromPort),
          this.circuit.pinPos(dst, "in", wire.toPort)
        );
        d = distToCurve(world, curve);
      }
      if (d < best) {
        best = d;
        found = wire.id;
      }
    }
    return found;
  }

  private snapshot(ids: string[]): Snapshot {
    const comps = new Map<string, { x: number; y: number }>();
    const groups = new Map<string, { x: number; y: number }>();
    const expanded = this.circuit.expanded;
    const addComp = (id: string) => {
      const c = this.circuit.get(id);
      if (c) comps.set(id, expanded ? this.circuit.posOf(c) : { x: c.x, y: c.y });
    };
    const addGroup = (id: string) => {
      const group = this.circuit.groups.get(id);
      if (!group) return;
      const frame = expanded ? this.frames.find((f) => f.group.id === group.id) : undefined;
      groups.set(group.id, frame ? { x: frame.x, y: frame.y } : { x: group.x, y: group.y });
    };
    for (const id of ids) {
      const group = this.circuit.groups.get(id);
      if (group) {
        addGroup(group.id);
        group.members.forEach(addComp);
        continue;
      }
      const comp = this.circuit.get(id);
      if (!comp) continue;
      addComp(id);
      // In der entpackten Ansicht lassen sich einzelne Gatter im Feld bewegen.
      const parent = expanded ? null : this.circuit.groupForComp(id);
      if (parent) {
        addGroup(parent.id);
        parent.members.forEach(addComp);
      }
    }
    return { comps, groups };
  }

  private overlapsAt(comp: Comp, x: number, y: number): boolean {
    const l = layoutOf(comp);
    for (const other of this.circuit.comps.values()) {
      if (other.id === comp.id) continue;
      // Zugeklappte Module belegen nur ihren Block, nicht das Innenleben.
      if (this.circuit.isCompHidden(other.id)) continue;
      const ol = layoutOf(other);
      if (rectsOverlap(x, y, l.cols, l.rows, other.x, other.y, ol.cols, ol.rows)) return true;
    }
    for (const group of this.circuit.groups.values()) {
      if (comp.id && group.members.includes(comp.id)) continue;
      const rect = this.circuit.groupVisibleBounds(group.id);
      if (!rect) continue;
      if (rectsOverlap(x, y, l.cols, l.rows, rect.x, rect.y, rect.w, rect.h)) return true;
    }
    return false;
  }

  /** Sucht die nächste freie Rasterposition, damit sich Bauteile nicht überlagern. */
  private freeSpot(comp: Comp): boolean {
    const ox = comp.x;
    const oy = comp.y;
    if (!this.overlapsAt(comp, ox, oy)) return false;
    for (let r = 1; r <= 32; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (!this.overlapsAt(comp, ox + dx, oy + dy)) {
            comp.x = ox + dx;
            comp.y = oy + dy;
            return true;
          }
        }
      }
    }
    return false;
  }

  private applyMove(data: Snapshot, dx: number, dy: number): void {
    if (this.circuit.expanded) {
      // Entpackte Ansicht: Positionen sind Darstellungspositionen; die Kabel
      // folgen über posOf() automatisch.
      for (const [id, pos] of data.comps) this.circuit.setExpandedPos(id, pos.x + dx, pos.y + dy);
      for (const [id, pos] of data.groups) {
        this.circuit.setExpandedFramePos(id, pos.x + dx, pos.y + dy);
        const frame = this.frames.find((f) => f.group.id === id);
        if (frame) {
          frame.x = pos.x + dx;
          frame.y = pos.y + dy;
        }
      }
      return;
    }
    for (const [id, pos] of data.comps) {
      const comp = this.circuit.get(id);
      if (!comp) continue;
      comp.x = pos.x + dx;
      comp.y = pos.y + dy;
    }
    for (const [id, pos] of data.groups) {
      const group = this.circuit.groups.get(id);
      if (!group) continue;
      group.x = pos.x + dx;
      group.y = pos.y + dy;
    }
  }

  /** Verschiebt die Auswahl per Pfeiltaste um ganze Zellen. */
  nudgeSelection(dx: number, dy: number): boolean {
    if (this.state.selected.length === 0) return false;
    const data = this.snapshot(this.state.selected);
    this.applyMove(data, dx, dy);
    if (this.circuit.expanded) this.hooks.moved();
    else this.hooks.structural();
    this.hooks.status(`Position gespeichert (${dx >= 0 ? "+" : ""}${dx}, ${dy >= 0 ? "+" : ""}${dy}).`);
    return true;
  }

  private startMaybeMove(id: string, world: Point, screen: Point): void {
    this.drag = {
      mode: "maybeMove",
      id,
      sx: screen.x,
      sy: screen.y,
      wx: world.x,
      wy: world.y,
      data: this.snapshot(this.state.selected),
    };
  }

  private onMouseDown = (e: MouseEvent): void => {
    const world = this.worldFromEvent(e);
    const screen = this.screenFromEvent(e);
    this.lastMouse = screen;
    this.hooks.invalidate();
    if (e.button === 2) return;
    // Mittlere Maustaste schiebt die Ansicht (links zieht eine Auswahl auf).
    if (e.button === 1) {
      e.preventDefault();
      this.drag = { mode: "pan", sx: screen.x, sy: screen.y, panX0: this.view.panX, panY0: this.view.panY };
      return;
    }

    this.closeMenu();
    if (this.bulk) {
      this.bulkClick(world);
      return;
    }

    if (this.readOnly) {
      // Entpackte Ansicht: auswählen und verschieben ja, verbinden/löschen nein.
      const comp = this.hitComp(world);
      const group = comp ? null : this.hitFrame(world) ?? this.hitGroupBlock(world);
      const wire = !comp && !group ? this.hitWire(world) : null;
      if (comp) {
        if (e.shiftKey) {
          this.toggleSelected(comp.id);
          return;
        }
        // Liegt das Bauteil schon in einer Mehrfachauswahl, wandert die ganze Auswahl.
        if (!this.state.selected.includes(comp.id)) {
          this.state.selection = { type: "comp", id: comp.id };
          this.state.selected = [comp.id];
          this.hooks.selectionChange();
        }
        this.startMaybeMove(comp.id, world, screen);
        return;
      }
      if (group) {
        if (e.shiftKey) {
          this.toggleSelected(group.id);
          return;
        }
        if (!this.state.selected.includes(group.id)) {
          this.state.selection = { type: "group", id: group.id };
          this.state.selected = [group.id];
          this.hooks.selectionChange();
        }
        this.startMaybeMove(group.id, world, screen);
        return;
      }
      if (wire) {
        this.state.selection = { type: "wire", id: wire };
        this.state.selected = [];
        this.hooks.selectionChange();
        return;
      }
      if (e.shiftKey) {
        this.drag = { mode: "box", x1: world.x, y1: world.y, x2: world.x, y2: world.y, additive: true };
        this.state.box = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
        return;
      }
      this.state.selection = null;
      this.state.selected = [];
      this.hooks.selectionChange();
      this.drag = { mode: "box", x1: world.x, y1: world.y, x2: world.x, y2: world.y, additive: false };
      this.state.box = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
      return;
    }

    if (typeof this.state.tool !== "string") {
      const cx = Math.round(world.x / CELL);
      const cy = Math.round(world.y / CELL);
      if ("place" in this.state.tool) {
        const comp = this.circuit.addComp(this.state.tool.place, cx, cy);
        this.freeSpot(comp);
        this.state.selection = { type: "comp", id: comp.id };
        this.state.selected = [comp.id];
        this.hooks.structural();
        this.hooks.selectionChange();
        this.hooks.status(`${this.state.tool.place} platziert. Rechtsklick oder Esc beendet das Platzieren.`);
      } else {
        const group = this.hooks.placeModule(this.state.tool.module, cx, cy);
        if (group) {
          this.state.selection = { type: "group", id: group.id };
          this.state.selected = [group.id];
          this.hooks.selectionChange();
        }
      }
      return;
    }

    const pin = this.hitPin(world);
    if (pin) {
      this.state.wireDrag = { comp: pin.comp.id, port: pin.port, dir: pin.dir, to: world };
      return;
    }

    const group = this.hitGroupBlock(world);
    if (group) {
      if (e.shiftKey) {
        this.toggleSelected(group.id);
      } else {
        if (!this.state.selected.includes(group.id)) {
          this.state.selection = { type: "group", id: group.id };
          this.state.selected = [group.id];
          this.hooks.selectionChange();
        }
        this.startMaybeMove(group.id, world, screen);
      }
      return;
    }

    const comp = this.hitComp(world);
    if (comp) {
      if (e.shiftKey) {
        this.toggleSelected(comp.id);
        return;
      }
      if (!this.state.selected.includes(comp.id)) {
        this.state.selection = { type: "comp", id: comp.id };
        this.state.selected = [comp.id];
        this.hooks.selectionChange();
      }
      this.startMaybeMove(comp.id, world, screen);
      return;
    }

    const wire = this.hitWire(world);
    if (wire) {
      this.state.selection = { type: "wire", id: wire };
      this.state.selected = [];
      this.hooks.selectionChange();
      return;
    }

    if (e.shiftKey) {
      this.drag = { mode: "box", x1: world.x, y1: world.y, x2: world.x, y2: world.y, additive: true };
      this.state.box = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
      return;
    }

    this.state.selection = null;
    this.state.selected = [];
    this.hooks.selectionChange();
    this.drag = { mode: "box", x1: world.x, y1: world.y, x2: world.x, y2: world.y, additive: false };
    this.state.box = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
  };

  private onMouseMove = (e: MouseEvent): void => {
    const screen = this.screenFromEvent(e);
    this.lastMouse = screen;
    this.hooks.invalidate();
    const world = this.worldFromScreen(screen.x, screen.y);

    if (this.state.ghost) {
      this.state.ghost.x = Math.round(world.x / CELL);
      this.state.ghost.y = Math.round(world.y / CELL);
    }

    if (this.bulk && this.drag.mode === "none") {
      this.updateBulkPreview(world);
      return;
    }

    if (this.state.wireDrag) {
      this.state.wireDrag.to = world;
      const want = this.state.wireDrag.dir === "out" ? "in" : "out";
      const pin = this.hitPin(world, want);
      this.state.hovered = pin ? { comp: pin.comp.id, dir: pin.dir, port: pin.port } : null;
      return;
    }

    if (this.drag.mode === "pan") {
      this.view.panX = this.drag.panX0 + (screen.x - this.drag.sx);
      this.view.panY = this.drag.panY0 + (screen.y - this.drag.sy);
      return;
    }

    if (this.drag.mode === "box") {
      this.drag.x2 = world.x;
      this.drag.y2 = world.y;
      this.state.box = { x1: this.drag.x1, y1: this.drag.y1, x2: world.x, y2: world.y };
      return;
    }

    if (this.drag.mode === "maybeMove") {
      const dist = Math.hypot(screen.x - this.drag.sx, screen.y - this.drag.sy);
      if (dist > 4) {
        this.drag = {
          mode: "move",
          sx: this.drag.sx,
          sy: this.drag.sy,
          wx: this.drag.wx,
          wy: this.drag.wy,
          data: this.drag.data,
        };
      } else {
        return;
      }
    }

    if (this.drag.mode === "move") {
      const dx = Math.round((world.x - this.drag.wx) / CELL);
      const dy = Math.round((world.y - this.drag.wy) / CELL);
      this.applyMove(this.drag.data, dx, dy);
      return;
    }

    const pin = this.hitPin(world);
    this.state.hovered = pin ? { comp: pin.comp.id, dir: pin.dir, port: pin.port } : null;
  };

  private onMouseUp = (e: MouseEvent): void => {
    const world = this.worldFromEvent(e);
    this.hooks.invalidate();

    if (this.state.wireDrag) {
      const start = this.state.wireDrag;
      const want = start.dir === "out" ? "in" : "out";
      const pin = this.hitPin(world, want);
      if (pin && !(pin.comp.id === start.comp && pin.port === start.port && pin.dir === start.dir)) {
        const ok = this.tryConnect(start.comp, start.port, start.dir, pin.comp.id, pin.port);
        if (!ok) this.widthMismatch(start, pin, this.screenFromEvent(e));
      }
      this.state.wireDrag = null;
      this.state.hovered = null;
      return;
    }

    if (this.drag.mode === "box") {
      const x1 = Math.min(this.drag.x1, this.drag.x2);
      const x2 = Math.max(this.drag.x1, this.drag.x2);
      const y1 = Math.min(this.drag.y1, this.drag.y2);
      const y2 = Math.max(this.drag.y1, this.drag.y2);
      const hits: string[] = this.drag.additive ? [...this.state.selected] : [];
      for (const group of this.circuit.groups.values()) {
        const frame = this.circuit.expanded ? this.frames.find((f) => f.group.id === group.id) : undefined;
        const gx = frame ? frame.x : group.x;
        const gy = frame ? frame.y : group.y;
        const gw = frame ? frame.w : group.cols;
        const gh = frame ? frame.h : group.rows;
        if (rectsOverlap(x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1), gx * CELL, gy * CELL, gw * CELL, gh * CELL)) {
          hits.push(group.id);
        }
      }
      for (const comp of this.circuit.comps.values()) {
        if (this.circuit.isCompHidden(comp.id)) continue;
        const l = layoutOf(comp);
        const pos = this.circuit.posOf(comp);
        if (
          rectsOverlap(
            x1,
            y1,
            Math.max(1, x2 - x1),
            Math.max(1, y2 - y1),
            pos.x * CELL,
            pos.y * CELL,
            l.cols * CELL,
            l.rows * CELL
          )
        ) {
          hits.push(comp.id);
        }
      }
      this.state.box = null;
      this.applySelected(hits);
      this.drag = { mode: "none" };
      return;
    }

    if (this.drag.mode === "maybeMove") {
      const comp = this.circuit.get(this.drag.id);
      if (!this.readOnly && comp && (comp.kind === "input" || comp.kind === "const")) {
        if (comp.kind === "input") {
          this.circuit.toggleInput(comp);
          this.hooks.valueChange();
        }
      }
    } else if (this.drag.mode === "move") {
      // Verschieben ist immer erlaubt: die Position wird übernommen, egal ob
      // sich Bauteile dabei berühren – kein Zurückspringen mehr.
      if (this.circuit.expanded) this.hooks.moved();
      else this.hooks.structural();
      this.hooks.status("Position gespeichert.");
    }
    this.drag = { mode: "none" };
  };

  private onDoubleClick = (e: MouseEvent): void => {
    this.hooks.invalidate();
    // Doppelklick auf einen Block öffnet nur dieses Modul im Modul-Editor.
    const world = this.worldFromEvent(e);
    const frame = this.readOnly ? this.hitFrame(world) : null;
    const group = frame ?? this.hitGroupBlock(world);
    if (group) {
      this.state.selection = { type: "group", id: group.id };
      this.state.selected = [group.id];
      this.hooks.selectionChange();
      this.hooks.openGroupModule(group.id);
      return;
    }
    const comp = this.hitComp(world);
    if (comp && (comp.kind === "rom" || comp.kind === "ram")) this.hooks.openMemory?.(comp.id);
  };

  // ---------- Smarte Verbindungs- und Layout-Werkzeuge ----------

  /** Oberste Einheiten der Auswahl (Module und sichtbare Bauteile). */
  private units(): string[] {
    return this.state.selected.filter(
      (id) => this.circuit.groups.has(id) || (this.circuit.comps.has(id) && !this.circuit.isCompHidden(id))
    );
  }

  private hitUnit(world: Point): string | null {
    const group = this.hitGroupBlock(world);
    if (group) return group.id;
    return this.hitComp(world)?.id ?? null;
  }

  isBulkConnect(): boolean {
    return !!this.bulk;
  }

  /** Startet die Massen-Verbindung: die Auswahl sind die Quellen, dann das Ziel anklicken. */
  startBulkConnect(): boolean {
    if (this.readOnly) return false;
    const sources = this.units();
    if (sources.length === 0) {
      this.hooks.status("Massen-Verbindung: zuerst Quelle(n) markieren, dann M drücken.", "warn");
      return false;
    }
    if (this.state.tool !== "select") this.setTool("select");
    this.bulk = { sources };
    this.hooks.status("Massen-Verbindung: Ziel anklicken – Esc oder Rechtsklick bricht ab.");
    this.hooks.invalidate();
    return true;
  }

  private endBulk(): void {
    if (!this.bulk && !this.state.preview) return;
    this.bulk = null;
    this.state.preview = null;
    this.hooks.invalidate();
  }

  private bulkPlan(world: Point): { target: string; plan: ConnectPlan } | null {
    const target = this.hitUnit(world);
    if (!target || !this.bulk || this.bulk.sources.includes(target)) return null;
    return { target, plan: planConnect(this.circuit, this.bulk.sources, target) };
  }

  private updateBulkPreview(world: Point): void {
    const hit = this.bulkPlan(world);
    if (!hit) {
      this.state.preview = null;
      return;
    }
    const { plan } = hit;
    const n = plan.pairs.length;
    const label = `${n} Verbindung${n === 1 ? "" : "en"}${plan.skipped.length ? `, ${plan.skipped.length} übersprungen` : ""}`;
    this.state.preview = {
      pairs: plan.pairs.map((p) => ({ a: p.from.pos, b: p.to.pos, width: p.from.width })),
      label,
      at: { x: world.x, y: world.y - CELL },
    };
  }

  private bulkClick(world: Point): void {
    const hit = this.bulkPlan(world);
    if (!hit) {
      this.hooks.status("Massen-Verbindung: auf das Ziel-Bauteil oder -Modul klicken (Esc bricht ab).", "warn");
      return;
    }
    const made = applyPlan(this.circuit, hit.plan);
    this.endBulk();
    if (made > 0) this.hooks.structural();
    this.hooks.status(describePlan(hit.plan, made), made > 0 ? "info" : "warn");
  }

  /** Verbindet genau zwei markierte Einheiten (linke → rechte, sonst umgekehrt). */
  autoConnectSelection(): boolean {
    const u = this.units();
    if (this.readOnly || u.length !== 2) {
      this.hooks.status("Auto-Verbinden braucht genau zwei markierte Bauteile oder Module.", "warn");
      return false;
    }
    const x = (id: string) => this.boxOf(id)?.x ?? 0;
    const [a, b] = x(u[0]) <= x(u[1]) ? u : [u[1], u[0]];
    const plan = planAutoConnect(this.circuit, a, b);
    const made = applyPlan(this.circuit, plan);
    if (made > 0) this.hooks.structural();
    this.hooks.status(describePlan(plan, made), made > 0 ? "info" : "warn");
    return made > 0;
  }

  private boxOf(id: string): Box | null {
    const group = this.circuit.groups.get(id);
    if (group) {
      const r = this.circuit.groupVisibleBounds(id);
      return r ? { id, ...r } : null;
    }
    const comp = this.circuit.get(id);
    if (!comp || this.circuit.isCompHidden(id)) return null;
    const l = layoutOf(comp);
    const pos = this.circuit.posOf(comp);
    return { id, x: pos.x, y: pos.y, w: l.cols, h: l.rows };
  }

  private layoutMove(mode: AlignMode | "distX" | "distY"): boolean {
    if (this.readOnly) return false;
    const boxes = this.units()
      .map((id) => this.boxOf(id))
      .filter((b): b is Box => !!b);
    const need = mode === "distX" || mode === "distY" ? 3 : 2;
    if (boxes.length < need) {
      this.hooks.status(`Dafür mindestens ${need} markierte Objekte nötig.`, "warn");
      return false;
    }
    const moves =
      mode === "distX" ? planDistribute(boxes, "x") : mode === "distY" ? planDistribute(boxes, "y") : planAlign(boxes, mode);
    if (moves.size === 0) {
      this.hooks.status("Schon ausgerichtet.");
      return false;
    }
    const sel = new Set(boxes.map((b) => b.id));
    const others: Box[] = [];
    for (const comp of this.circuit.comps.values()) {
      if (sel.has(comp.id) || this.circuit.isCompHidden(comp.id)) continue;
      const b = this.boxOf(comp.id);
      if (b) others.push(b);
    }
    for (const g of this.circuit.groups.values()) {
      const b = sel.has(g.id) ? null : this.boxOf(g.id);
      if (b) others.push(b);
    }
    const clash = findCollisions(boxes, moves, others);
    for (const [id, m] of moves) this.applyMove(this.snapshot([id]), m.dx, m.dy);
    this.hooks.structural();
    this.hooks.invalidate();
    this.hooks.status(
      clash.length > 0
        ? `${moves.size} Objekte verschoben – ${clash.length} überlappen jetzt andere Bauteile.`
        : `${moves.size} Objekte ${mode.startsWith("dist") ? "verteilt" : "ausgerichtet"}.`,
      clash.length > 0 ? "warn" : "info"
    );
    return true;
  }

  alignSelection(mode: AlignMode): boolean {
    return this.layoutMove(mode);
  }

  distributeSelection(axis: "x" | "y"): boolean {
    return this.layoutMove(axis === "x" ? "distX" : "distY");
  }

  /** Splitter plus Ausgangslampen für den ersten Busausgang des markierten Bauteils. */
  fanOutSelection(): boolean {
    const comp = this.state.selected.length === 1 ? this.circuit.get(this.state.selected[0]) : undefined;
    if (this.readOnly || !comp || this.circuit.isCompHidden(comp.id)) return false;
    const widths = portWidths(comp).out;
    const port = widths.findIndex((w) => w > 1);
    if (port < 0 || widths[port] > FANOUT_MAX) {
      this.hooks.status(`Bus auffächern: Ausgang mit 2–${FANOUT_MAX} Bit nötig.`, "warn");
      return false;
    }
    const pin = this.circuit.pinPos(comp, "out", port);
    const made = addFanOut(this.circuit, comp.id, port, { x: pin.x + 3 * CELL, y: pin.y - CELL }, (c) => this.freeSpot(c));
    if (!made) return false;
    this.applySelected(made.map((c) => c.id));
    this.hooks.structural();
    this.hooks.status(`Bus aufgefächert: Splitter und ${made.length - 1} Ausgangslampen.`);
    return true;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  /** Breiten passen nicht: Bit-Auswahl (N→1) bzw. Replizieren (1→N) anbieten. */
  private widthMismatch(
    start: { comp: string; port: number; dir: "in" | "out" },
    pin: { comp: Comp; port: number },
    at: Point
  ): void {
    const a = { comp: start.comp, port: start.port };
    const b = { comp: pin.comp.id, port: pin.port };
    const [from, to] = start.dir === "out" ? [a, b] : [b, a];
    const src = this.circuit.get(from.comp);
    const dst = this.circuit.get(to.comp);
    const fw = src ? portWidths(src).out[from.port] : undefined;
    const tw = dst ? portWidths(dst).in[to.port] : undefined;
    if (!src || !dst || fw === undefined || tw === undefined) return;
    const target = this.circuit.pinPos(dst, "in", to.port);
    const place = (c: Comp) => this.freeSpot(c);
    const done = (c: Comp | null, text: string) => {
      this.closeMenu();
      if (!c) return;
      this.hooks.structural();
      this.hooks.status(text);
    };
    const buttons: { text: string; run: () => void }[] = [];
    let title = "";
    if (fw > 1 && tw === 1) {
      title = `${fw} Bit → 1 Bit: welches Bit?`;
      for (let k = fw - 1; k >= 0; k--) {
        buttons.push({
          text: String(k),
          run: () =>
            done(
              addBitSelect(this.circuit, from.comp, from.port, to.comp, to.port, k, { x: target.x - 5 * CELL, y: target.y - CELL }, place),
              `Bit ${k} über Splitter verbunden.`
            ),
        });
      }
    } else if (fw === 1 && tw > 1) {
      title = `1 Bit → ${tw} Bit`;
      buttons.push({
        text: `auf ${tw} Bit replizieren`,
        run: () =>
          done(
            addReplicate(this.circuit, from.comp, from.port, to.comp, to.port, { x: target.x - 5 * CELL, y: target.y - CELL }, place),
            `Bit auf ${tw} Leitungen repliziert (Joiner).`
          ),
      });
    } else {
      this.hooks.status(`Verbindung nicht möglich: ${fw} Bit passt nicht zu ${tw} Bit.`, "warn");
      return;
    }
    const menu = document.createElement("div");
    menu.className = "pin-menu";
    menu.innerHTML = `<div class="pin-menu-title"></div><div class="pin-menu-items"></div>`;
    menu.querySelector(".pin-menu-title")!.textContent = title;
    const items = menu.querySelector(".pin-menu-items")!;
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.textContent = b.text;
      btn.addEventListener("click", b.run);
      items.appendChild(btn);
    }
    menu.style.left = `${Math.max(4, at.x + 8)}px`;
    menu.style.top = `${Math.max(4, at.y + 8)}px`;
    (this.canvas.parentElement ?? document.body).appendChild(menu);
    this.menu = menu;
  }

  private tryConnect(c1: string, p1: number, dir1: "in" | "out", c2: string, p2: number): boolean {
    if (dir1 === "out") return this.connect(c1, p1, c2, p2) !== null;
    return this.connect(c2, p2, c1, p1) !== null;
  }

  /** Verbindet Ausgang (from, fromPort) mit Eingang (to, toPort). */
  connect(from: string, fromPort: number, to: string, toPort: number) {
    const wire = this.circuit.addWire(from, fromPort, to, toPort);
    if (wire) {
      this.hooks.structural();
      this.hooks.status("Kabel verbunden.");
    }
    return wire;
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const center = this.screenFromEvent(e);
    this.hooks.invalidate();
    this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, center);
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (this.readOnly) return;
    this.hooks.invalidate();
    if (this.bulk) {
      this.endBulk();
      this.hooks.status("Massen-Verbindung abgebrochen.");
      return;
    }
    const world = this.worldFromEvent(e);
    const group = this.hitGroupBlock(world);
    if (group) {
      this.circuit.removeGroup(group.id);
      this.state.selection = null;
      this.state.selected = [];
      this.hooks.structural();
      this.hooks.selectionChange();
      this.hooks.status("Modul gelöscht.");
      return;
    }
    const comp = this.hitComp(world);
    if (comp) {
      this.circuit.removeComp(comp.id);
      if (this.state.selection?.id === comp.id) this.state.selection = null;
      this.state.selected = [];
      this.hooks.structural();
      this.hooks.selectionChange();
      this.hooks.status("Bauteil gelöscht.");
      return;
    }
    const wire = this.hitWire(world);
    if (wire) {
      this.circuit.removeWire(wire);
      if (this.state.selection?.id === wire) this.state.selection = null;
      this.state.selected = [];
      this.hooks.structural();
      this.hooks.selectionChange();
      this.hooks.status("Kabel gelöscht.");
      return;
    }
    this.cancel();
    this.hooks.status("Bereit.");
  };

  private onMouseLeave = (): void => {
    this.state.hovered = null;
    if (this.drag.mode === "pan") this.drag = { mode: "none" };
    this.hooks.invalidate();
  };
}
