export type CompKind =
  | "input"
  | "output"
  | "const"
  | "clock"
  | "not"
  | "buf"
  | "and"
  | "or"
  | "nand"
  | "nor"
  | "xor"
  | "xnor"
  | "dff"
  | "latch"
  | "splitter"
  | "joiner"
  | "rom"
  | "ram";

export type DisplayFormat = "bin" | "hex" | "dec";

export interface Comp {
  id: string;
  kind: CompKind;
  /** Rasterposition (Zellen) */
  x: number;
  y: number;
  /** Bit-Breite der Wert-Ports */
  width: number;
  /** Wert für Eingang/Konstante */
  value: number;
  /** Taktteiler des Taktgebers */
  div: number;
  /** Adress-/Datenbreite für ROM/RAM */
  addrWidth: number;
  dataWidth: number;
  /** Speicherinhalt ROM/RAM */
  data: number[];
  format: DisplayFormat;
  /** Optionale Bezeichnung (z. B. für Assembler und Modul-Pins) */
  label: string;

  /** Laufzeit-Zustand (nicht serialisiert) */
  outs: number[];
  prevClk: number;
  clkCounter: number;
}

/** Schnittstellen-Pin einer Modul-Instanz. */
export interface GroupPin {
  name: string;
  width: number;
  compId: string;
}

/** Eine platzierte Modul-Instanz auf der Fläche. */
export interface GroupInstance {
  id: string;
  moduleId: string;
  name: string;
  /** Position des kompakten Blocks in Rasterzellen */
  x: number;
  y: number;
  /** Größe des kompakten Blocks */
  cols: number;
  rows: number;
  /** Platzbedarf des Blocks (Module werden nicht aufgeklappt) */
  footprintCols: number;
  footprintRows: number;
  collapsed: boolean;
  members: string[];
  inputs: GroupPin[];
  outputs: GroupPin[];
}

export interface Wire {
  id: string;
  /** Ausgangs-Bauteil */
  from: string;
  fromPort: number;
  /** Eingangs-Bauteil */
  to: string;
  toPort: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Tool = "select" | { place: CompKind } | { module: string };

export type Selection = { type: "comp" | "wire" | "group"; id: string } | null;

export interface View {
  panX: number;
  panY: number;
  zoom: number;
}

export interface Ghost {
  kind: CompKind;
  x: number;
  y: number;
}

export interface WireDrag {
  comp: string;
  port: number;
  dir: "in" | "out";
  to: Point;
}

export interface EditorState {
  tool: Tool;
  selection: Selection;
  /** Alle ausgewählten Bauteile/Gruppen (Mehrfachauswahl) */
  selected: string[];
  /** Auswahlrahmen in Weltkoordinaten */
  box: { x1: number; y1: number; x2: number; y2: number } | null;
  ghost: Ghost | null;
  wireDrag: WireDrag | null;
  hovered: { comp: string; dir: "in" | "out"; port: number } | null;
  /** Vorschau der Massen-Verbindung (gestrichelte Kabel plus Beschriftung). */
  preview?: { pairs: { a: Point; b: Point; width: number }[]; label: string; at: Point } | null;
}

export const CELL = 24;

export function maskOf(width: number): number {
  if (width >= 32) return 0xffffffff;
  return (1 << width) - 1;
}

export function clampWidth(width: number): number {
  return Math.max(1, Math.min(32, Math.round(width)));
}
