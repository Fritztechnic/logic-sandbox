import { CELL, Comp, CompKind, maskOf } from "./types";

export interface PortLayout {
  name: string;
  fx: number;
  fy: number;
}

export interface Layout {
  cols: number;
  rows: number;
  ins: PortLayout[];
  outs: PortLayout[];
}

export interface KindInfo {
  label: string;
  icon: string;
  group: string;
  hint: string;
}

export const KIND_GROUPS = ["Ein-/Ausgabe", "Gatter", "Sequenziell", "Bus & Speicher"] as const;

export const KIND_INFO: Record<CompKind, KindInfo> = {
  input: { label: "Eingang", icon: "◍", group: "Ein-/Ausgabe", hint: "Schalter, den du per Klick umschaltest" },
  output: { label: "Ausgang", icon: "▣", group: "Ein-/Ausgabe", hint: "Lampe/Anzeige für ein Signal" },
  const: { label: "Konstante", icon: "№", group: "Ein-/Ausgabe", hint: "Fester Wert (0, 1 oder Bitmuster)" },
  clock: { label: "Taktgeber", icon: "◷", group: "Ein-/Ausgabe", hint: "Rechtecksignal für sequenzielle Logik" },
  not: { label: "NOT", icon: "¬", group: "Gatter", hint: "Invertiert alle Bits" },
  buf: { label: "Puffer", icon: "▷", group: "Gatter", hint: "Leitet das Signal weiter" },
  and: { label: "AND", icon: "∧", group: "Gatter", hint: "1 wenn A und B 1 sind" },
  or: { label: "OR", icon: "∨", group: "Gatter", hint: "1 wenn A oder B 1 ist" },
  nand: { label: "NAND", icon: "⊼", group: "Gatter", hint: "Negiertes AND (universelles Gatter)" },
  nor: { label: "NOR", icon: "⊽", group: "Gatter", hint: "Negiertes OR" },
  xor: { label: "XOR", icon: "⊕", group: "Gatter", hint: "1 wenn A und B verschieden sind" },
  xnor: { label: "XNOR", icon: "⊙", group: "Gatter", hint: "1 wenn A und B gleich sind" },
  dff: { label: "D-Flip-Flop", icon: "▤", group: "Sequenziell", hint: "Register: speichert D bei steigender Taktflanke" },
  latch: { label: "D-Latch", icon: "▥", group: "Sequenziell", hint: "Transparent, solange EN = 1" },
  splitter: { label: "Splitter", icon: "⑂", group: "Bus & Speicher", hint: "Zerlegt einen Bus in einzelne Bits" },
  joiner: { label: "Joiner", icon: "⑃", group: "Bus & Speicher", hint: "Fügt einzelne Bits zu einem Bus zusammen" },
  rom: { label: "ROM", icon: "▦", group: "Bus & Speicher", hint: "Festprogrammierter Speicher (Programm)" },
  ram: { label: "RAM", icon: "▧", group: "Bus & Speicher", hint: "Schreib-/Lesespeicher (Daten)" },
};

export const PALETTE: CompKind[][] = KIND_GROUPS.map((g) =>
  (Object.keys(KIND_INFO) as CompKind[]).filter((k) => KIND_INFO[k].group === g)
);

function rowPin(i: number, n: number): number {
  return (i + 0.5) / n;
}

export function layoutOf(comp: Comp): Layout {
  const w = comp.width;
  switch (comp.kind) {
    case "input":
    case "output":
    case "const":
    case "clock":
      return {
        cols: 3,
        rows: 2,
        ins: comp.kind === "output" ? [{ name: "X", fx: 0, fy: 0.5 }] : [],
        outs: comp.kind === "output" ? [] : [{ name: "Q", fx: 1, fy: 0.5 }],
      };
    case "not":
    case "buf":
      return { cols: 4, rows: 3, ins: [{ name: "A", fx: 0, fy: 0.5 }], outs: [{ name: "Y", fx: 1, fy: 0.5 }] };
    case "and":
    case "or":
    case "nand":
    case "nor":
    case "xor":
    case "xnor":
      return {
        cols: 4,
        rows: 3,
        ins: [
          { name: "A", fx: 0, fy: 1 / 3 },
          { name: "B", fx: 0, fy: 2 / 3 },
        ],
        outs: [{ name: "Y", fx: 1, fy: 0.5 }],
      };
    case "dff":
      return {
        cols: 4,
        rows: 4,
        ins: [
          { name: "D", fx: 0, fy: 0.22 },
          { name: "CLK", fx: 0, fy: 0.5 },
          { name: "RST", fx: 0, fy: 0.78 },
        ],
        outs: [
          { name: "Q", fx: 1, fy: 0.32 },
          { name: "Q̄", fx: 1, fy: 0.68 },
        ],
      };
    case "latch":
      return {
        cols: 4,
        rows: 3,
        ins: [
          { name: "D", fx: 0, fy: 1 / 3 },
          { name: "EN", fx: 0, fy: 2 / 3 },
        ],
        outs: [
          { name: "Q", fx: 1, fy: 1 / 3 },
          { name: "Q̄", fx: 1, fy: 2 / 3 },
        ],
      };
    case "splitter": {
      const rows = Math.max(2, w + 1);
      const outs: PortLayout[] = [];
      for (let i = 0; i < w; i++) {
        outs.push({ name: `b${w - 1 - i}`, fx: 1, fy: (1 + ((i + 0.5) * (rows - 1)) / w) / rows });
      }
      return { cols: 3, rows, ins: [{ name: "A", fx: 0, fy: rowPin(0, rows) }], outs };
    }
    case "joiner": {
      const rows = Math.max(2, w + 1);
      const ins: PortLayout[] = [];
      for (let i = 0; i < w; i++) {
        ins.push({ name: `b${w - 1 - i}`, fx: 0, fy: (((i + 0.5) * (rows - 1)) / w) / rows });
      }
      return { cols: 3, rows, ins, outs: [{ name: "Y", fx: 1, fy: rowPin(rows - 1, rows) }] };
    }
    case "rom":
      return { cols: 5, rows: 3, ins: [{ name: "ADDR", fx: 0, fy: 0.5 }], outs: [{ name: "DATA", fx: 1, fy: 0.5 }] };
    case "ram":
      return {
        cols: 5,
        rows: 4,
        ins: [
          { name: "ADDR", fx: 0, fy: 0.14 },
          { name: "DIN", fx: 0, fy: 0.4 },
          { name: "WE", fx: 0, fy: 0.64 },
          { name: "CLK", fx: 0, fy: 0.88 },
        ],
        outs: [{ name: "DOUT", fx: 1, fy: 0.5 }],
      };
  }
}

export function sizePx(comp: Comp): { w: number; h: number } {
  const l = layoutOf(comp);
  return { w: l.cols * CELL, h: l.rows * CELL };
}

export function portWidths(comp: Comp): { in: number[]; out: number[] } {
  const w = comp.width;
  switch (comp.kind) {
    case "input":
    case "const":
    case "clock":
      return { in: [], out: [w] };
    case "output":
      return { in: [w], out: [] };
    case "not":
    case "buf":
      return { in: [w], out: [w] };
    case "and":
    case "or":
    case "nand":
    case "nor":
    case "xor":
    case "xnor":
      return { in: [w, w], out: [w] };
    case "dff":
      return { in: [w, 1, 1], out: [w, w] };
    case "latch":
      return { in: [w, 1], out: [w, w] };
    case "splitter":
      return { in: [w], out: new Array(w).fill(1) };
    case "joiner":
      return { in: new Array(w).fill(1), out: [w] };
    case "rom":
      return { in: [comp.addrWidth], out: [comp.dataWidth] };
    case "ram":
      return { in: [comp.addrWidth, comp.dataWidth, 1, 1], out: [comp.dataWidth] };
  }
}

/** Berechnet die Ausgänge rein kombinatorisch. Sequenzielle Bauteile lesen ihren Zustand aus comp.outs. */
export function computeOut(comp: Comp, ins: number[]): number[] {
  const m = maskOf(comp.width);
  const a = (ins[0] ?? 0) & m;
  const b = (ins[1] ?? 0) & m;
  switch (comp.kind) {
    case "input":
    case "const":
      return [comp.value & m];
    case "clock":
      return [comp.outs[0] ?? 0];
    case "output":
      return [];
    case "buf":
      return [a];
    case "not":
      return [~a & m];
    case "and":
      return [a & b];
    case "or":
      return [a | b];
    case "nand":
      return [~(a & b) & m];
    case "nor":
      return [~(a | b) & m];
    case "xor":
      return [a ^ b];
    case "xnor":
      return [~(a ^ b) & m];
    case "dff": {
      const q = comp.outs[0] ?? 0;
      return [q & m, ~q & m];
    }
    case "latch": {
      if (b & 1) comp.outs[0] = a;
      const q = comp.outs[0] & m;
      return [q, ~q & m];
    }
    case "splitter": {
      const val = a;
      const outs: number[] = [];
      for (let i = 0; i < comp.width; i++) outs.push((val >> (comp.width - 1 - i)) & 1);
      return outs;
    }
    case "joiner": {
      let val = 0;
      for (let i = 0; i < comp.width; i++) val |= (ins[i] ?? 0) & 1 ? 1 << (comp.width - 1 - i) : 0;
      return [val & m];
    }
    case "rom": {
      const addr = (ins[0] ?? 0) & maskOf(comp.addrWidth);
      return [(comp.data[addr] ?? 0) & maskOf(comp.dataWidth)];
    }
    case "ram": {
      const addr = (ins[0] ?? 0) & maskOf(comp.addrWidth);
      return [(comp.data[addr] ?? 0) & maskOf(comp.dataWidth)];
    }
  }
}

export function isSequential(kind: CompKind): boolean {
  return kind === "dff" || kind === "latch" || kind === "ram";
}

export function isGate(kind: CompKind): boolean {
  return ["not", "buf", "and", "or", "nand", "nor", "xor", "xnor"].includes(kind);
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}
