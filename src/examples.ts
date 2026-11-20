import { Circuit } from "./circuit";
import { Comp, CompKind } from "./types";
import { buildCpu, buildMiniCpu } from "./cpu";
import { buildCpu32 } from "./cpu32";

function add(c: Circuit, kind: CompKind, x: number, y: number, opts: Partial<Comp> = {}): Comp {
  const comp = c.addComp(kind, x, y);
  Object.assign(comp, opts);
  return comp;
}

function link(c: Circuit, a: Comp, ap: number, b: Comp, bp: number): void {
  c.addWire(a.id, ap, b.id, bp);
}

interface Source {
  comp: Comp;
  port: number;
}

const GATE_XOR = "xor";
const GATE_AND = "and";
const GATE_OR = "or";

/** Baut einen 1-Bit-Volladdierer aus Gattern und verdrahtet die Quellen. */
function buildFullAdder(c: Circuit, bx: number, by: number, a: Source, b: Source, cin: Source) {
  const x1 = add(c, GATE_XOR, bx + 6, by);
  const a1 = add(c, GATE_AND, bx + 6, by + 4);
  const x2 = add(c, GATE_XOR, bx + 12, by);
  const a2 = add(c, GATE_AND, bx + 12, by + 4);
  const o1 = add(c, GATE_OR, bx + 18, by + 4);

  link(c, a.comp, a.port, x1, 0);
  link(c, b.comp, b.port, x1, 1);
  link(c, a.comp, a.port, a1, 0);
  link(c, b.comp, b.port, a1, 1);
  link(c, x1, 0, x2, 0);
  link(c, cin.comp, cin.port, x2, 1);
  link(c, x1, 0, a2, 0);
  link(c, cin.comp, cin.port, a2, 1);
  link(c, a1, 0, o1, 0);
  link(c, a2, 0, o1, 1);

  return { sum: { comp: x2, port: 0 } as Source, cout: { comp: o1, port: 0 } as Source };
}

function halfAdder(c: Circuit): void {
  const a = add(c, "input", 0, 0, { value: 1 });
  const b = add(c, "input", 0, 3, { value: 0 });
  const x = add(c, "xor", 6, 0);
  const n = add(c, "and", 6, 4);
  const sum = add(c, "output", 12, 0);
  const carry = add(c, "output", 12, 4);
  link(c, a, 0, x, 0);
  link(c, b, 0, x, 1);
  link(c, a, 0, n, 0);
  link(c, b, 0, n, 1);
  link(c, x, 0, sum, 0);
  link(c, n, 0, carry, 0);
}

function fullAdder(c: Circuit): void {
  const a = add(c, "input", 0, 0);
  const b = add(c, "input", 0, 4);
  const cin = add(c, "input", 0, 8);
  const { sum, cout } = buildFullAdder(c, 0, 1, { comp: a, port: 0 }, { comp: b, port: 0 }, { comp: cin, port: 0 });
  const s = add(c, "output", 30, 1);
  const co = add(c, "output", 30, 5);
  link(c, sum.comp, sum.port, s, 0);
  link(c, cout.comp, cout.port, co, 0);
}

function adder4(c: Circuit): void {
  const A = add(c, "input", 0, 0, { width: 4, value: 0b1010 });
  const B = add(c, "input", 0, 7, { width: 4, value: 0b0110 });
  const sa = add(c, "splitter", 4, 0, { width: 4 });
  const sb = add(c, "splitter", 4, 7, { width: 4 });
  link(c, A, 0, sa, 0);
  link(c, B, 0, sb, 0);

  const zero = add(c, "const", 12, 14, { value: 0 });
  let carry: Source = { comp: zero, port: 0 };
  const sums: Source[] = [];

  for (let i = 0; i < 4; i++) {
    const bx = 12 + i * 26;
    const by = 3;
    const bit = 3 - i;
    const { sum, cout } = buildFullAdder(
      c,
      bx,
      by,
      { comp: sa, port: bit },
      { comp: sb, port: bit },
      carry
    );
    sums.push(sum);
    carry = cout;
  }

  const j = add(c, "joiner", 12 + 4 * 26, 3, { width: 4 });
  for (let i = 0; i < 4; i++) link(c, sums[i].comp, sums[i].port, j, 3 - i);
  const out = add(c, "output", 12 + 4 * 26 + 4, 3, { width: 4 });
  link(c, j, 0, out, 0);
  const cout = add(c, "output", 12 + 3 * 26 + 24, 10, { width: 1 });
  link(c, carry.comp, carry.port, cout, 0);
}

function counter4(c: Circuit): void {
  const clk = add(c, "clock", 8, 20, { div: 1 });
  const dffs: Comp[] = [];
  for (let i = 0; i < 4; i++) dffs.push(add(c, "dff", 8 + i * 10, 6, { width: 1 }));

  // synchroner Zähler: D_i = Q_i XOR (Q_0 & Q_1 & ... & Q_{i-1})
  const not0 = add(c, "not", 8, 0);
  link(c, dffs[0], 0, not0, 0);
  link(c, not0, 0, dffs[0], 0);

  const xor1 = add(c, "xor", 18, 0);
  link(c, dffs[1], 0, xor1, 0);
  link(c, dffs[0], 0, xor1, 1);
  link(c, xor1, 0, dffs[1], 0);

  const and1 = add(c, "and", 28, 0);
  link(c, dffs[0], 0, and1, 0);
  link(c, dffs[1], 0, and1, 1);

  const xor2 = add(c, "xor", 38, 0);
  link(c, dffs[2], 0, xor2, 0);
  link(c, and1, 0, xor2, 1);
  link(c, xor2, 0, dffs[2], 0);

  const and2 = add(c, "and", 48, 0);
  link(c, and1, 0, and2, 0);
  link(c, dffs[2], 0, and2, 1);

  const xor3 = add(c, "xor", 58, 0);
  link(c, dffs[3], 0, xor3, 0);
  link(c, and2, 0, xor3, 1);
  link(c, xor3, 0, dffs[3], 0);

  for (const d of dffs) link(c, clk, 0, d, 1);

  for (let i = 0; i < 4; i++) {
    const lamp = add(c, "output", 8 + i * 10, 14, { width: 1 });
    link(c, dffs[i], 0, lamp, 0);
  }
  const j = add(c, "joiner", 50, 14, { width: 4 });
  for (let i = 0; i < 4; i++) link(c, dffs[i], 0, j, 3 - i);
  const ro = add(c, "output", 56, 14, { width: 4, format: "bin" });
  link(c, j, 0, ro, 0);
}

/** Kompakter 1-Bit-Volladdierer (16×6 Zellen) für große Addierer. */
function buildFullAdderCompact(c: Circuit, bx: number, by: number, a: Source, b: Source, cin: Source) {
  const x1 = add(c, GATE_XOR, bx, by);
  const a1 = add(c, GATE_AND, bx, by + 3);
  const x2 = add(c, GATE_XOR, bx + 6, by);
  const a2 = add(c, GATE_AND, bx + 6, by + 3);
  const o1 = add(c, GATE_OR, bx + 12, by + 3);

  link(c, a.comp, a.port, x1, 0);
  link(c, b.comp, b.port, x1, 1);
  link(c, a.comp, a.port, a1, 0);
  link(c, b.comp, b.port, a1, 1);
  link(c, x1, 0, x2, 0);
  link(c, cin.comp, cin.port, x2, 1);
  link(c, x1, 0, a2, 0);
  link(c, cin.comp, cin.port, a2, 1);
  link(c, a1, 0, o1, 0);
  link(c, a2, 0, o1, 1);

  return { sum: { comp: x2, port: 0 } as Source, cout: { comp: o1, port: 0 } as Source };
}

/**
 * n-Bit-Ripple-Carry-Addierer aus Volladdierern.
 * Die Volladdierer laufen im Zickzack (4 pro Zeile), damit auch 32 Bit kompakt bleiben.
 */
function buildAdderN(c: Circuit, n: number, initA: number, initB: number): void {
  const perRow = 4;
  const stepX = 18;
  const stepY = 8;
  const gridX = 8;

  const A = add(c, "input", 0, 0, { width: n, value: initA });
  const B = add(c, "input", 0, n + 3, { width: n, value: initB });
  const sa = add(c, "splitter", 4, 0, { width: n });
  const sb = add(c, "splitter", 4, n + 3, { width: n });
  link(c, A, 0, sa, 0);
  link(c, B, 0, sb, 0);

  // Übertrag in das niederwertigste Bit = 0
  const zero = add(c, "const", 0, 4, { width: 1, value: 0 });

  const sums: Source[] = [];
  let carry: Source = { comp: zero, port: 0 };
  // Vom niederwertigsten Bit (Port n-1) zum höchstwertigen (Port 0) rechnen.
  for (let bit = 0; bit < n; bit++) {
    const row = Math.floor(bit / perRow);
    const col = bit % perRow;
    const cx = gridX + (row % 2 === 0 ? col : perRow - 1 - col) * stepX;
    const cy = row * stepY;
    const port = n - 1 - bit;
    const { sum, cout } = buildFullAdderCompact(
      c,
      cx,
      cy,
      { comp: sa, port },
      { comp: sb, port },
      carry
    );
    sums.push(sum);
    carry = cout;
  }

  const gridRows = Math.ceil(n / perRow) * stepY;
  const joinerX = gridX + perRow * stepX + 2;
  const j = add(c, "joiner", joinerX, 0, { width: n });
  for (let bit = 0; bit < n; bit++) link(c, sums[bit].comp, sums[bit].port, j, n - 1 - bit);
  const out = add(c, "output", joinerX + 4, 0, { width: n });
  link(c, j, 0, out, 0);

  const cout = add(c, "output", joinerX + 4, gridRows + 2, { width: 1 });
  link(c, carry.comp, carry.port, cout, 0);
}

function adder16(c: Circuit): void {
  buildAdderN(c, 16, 0x1234, 0x0fed);
}

function adder32(c: Circuit): void {
  buildAdderN(c, 32, 0x12345678, 0x0fedcba9);
}

/**
 * n-Bit-Synchronzähler: D_i = Q_i XOR (Q_0 AND ... AND Q_{i-1}).
 * Die Bits laufen im Zickzack (8 pro Zeile); alle Flip-Flops teilen sich den Takt.
 */
function buildCounterN(c: Circuit, n: number): void {
  const perRow = 8;
  const colW = 10;
  const rowH = 8;
  const gridX = 10;

  const clk = add(c, "clock", 0, 0, { div: 1 });
  const rst = add(c, "input", 0, 4, { width: 1, value: 0 });

  const dffs: Comp[] = [];
  let carry: Source | null = null;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const x = gridX + (row % 2 === 0 ? col : perRow - 1 - col) * colW;
    const y = row * rowH;
    const dff = add(c, "dff", x, y, { width: 1 });
    dffs.push(dff);
    link(c, clk, 0, dff, 1);
    link(c, rst, 0, dff, 2);

    if (i === 0) {
      // Bit 0 toggelt bei jedem Takt: D0 = Q̄0
      link(c, dff, 1, dff, 0);
      carry = { comp: dff, port: 0 };
      continue;
    }

    const x1 = add(c, "xor", x + 5, y, { width: 1 });
    link(c, dff, 0, x1, 0);
    link(c, carry!.comp, carry!.port, x1, 1);
    link(c, x1, 0, dff, 0);

    const a1 = add(c, "and", x + 5, y + 4, { width: 1 });
    link(c, carry!.comp, carry!.port, a1, 0);
    link(c, dff, 0, a1, 1);
    carry = { comp: a1, port: 0 };
  }

  const j = add(c, "joiner", gridX + perRow * colW + 2, 0, { width: n });
  for (let i = 0; i < n; i++) link(c, dffs[i], 0, j, n - 1 - i);
  const out = add(c, "output", gridX + perRow * colW + 6, 0, { width: n });
  link(c, j, 0, out, 0);
}

function counter16(c: Circuit): void {
  buildCounterN(c, 16);
}

function counter32(c: Circuit): void {
  buildCounterN(c, 32);
}


export interface Example {
  name: string;
  build: (c: Circuit) => void;
}

export const EXAMPLES: Example[] = [
  { name: "Halbaddierer (XOR + AND)", build: halfAdder },
  { name: "Volladdierer", build: fullAdder },
  { name: "4-Bit-Addierer (mit Bussen)", build: adder4 },
  { name: "16-Bit-Addierer (Ripple-Carry)", build: adder16 },
  { name: "32-Bit-Addierer (Ripple-Carry)", build: adder32 },
  { name: "4-Bit-Zähler (sequenziell)", build: counter4 },
  { name: "16-Bit-Zähler (sequenziell)", build: counter16 },
  { name: "32-Bit-Zähler (sequenziell)", build: counter32 },
  { name: "Mini-CPU (8 Bit, Module + externes ROM/RAM)", build: buildMiniCpu },
  { name: "Mini-CPU (16 Bit, Module + externes ROM/RAM)", build: (c) => buildCpu(c, 16) },
  { name: "CPU 32 Bit (RISC, Registerfeld, 1024 Wörter)", build: (c) => buildCpu32(c) },
];
