import { Circuit } from "./circuit";
import { Comp, CompKind, GroupInstance } from "./types";
import { layoutOf, newId } from "./logic";
import { assemble } from "./assembler";
import { addModule, buildModuleDef, editableCircuitForGroup, getModule, replaceGroupInternals } from "./modules";

/**
 * Mini-CPU (8 Bit) als Beispielschaltung:
 * - eigene Module mit echten Pins: ALU, Akkumulator, Programmzähler, Ausgabe
 * - Programm-ROM, Steuer-ROM und Daten-RAM stecken NICHT im CPU-Modul,
 *   sondern liegen als eigene Bauteile daneben und werden per Kabel angeschlossen
 * - ein Takt = ein Befehl
 * Befehle: LDA #/addr, STA addr, ADD/SUB/AND/OR/XOR #/addr, OUT, JMP, JZ, JNZ, HLT
 */

interface Source {
  comp: Comp;
  port: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PinSpec {
  comp: Comp;
  name: string;
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Legt Bauteile kollisionsfrei ab und sammelt sie für Modulblöcke. */
class CpuBuilder {
  /** Alle Bauteile (auch versteckte Innenschaltungen). */
  private boxes: Box[] = [];
  /** Nur sichtbare Bauteile und Modulblöcke – daran richtet sich das Layout aus. */
  private visible: Box[] = [];
  private target: Comp[] | null = null;

  constructor(private c: Circuit) {}

  section(target: Comp[] | null): void {
    this.target = target;
  }

  /** Reserviert einen Blockbereich im sichtbaren Layout. */
  reserve(rect: Box): void {
    this.visible.push(rect);
  }

  add(kind: CompKind, x: number, y: number, opts: Partial<Comp> = {}): Comp {
    const comp = this.c.addComp(kind, Math.round(x), Math.round(y));
    Object.assign(comp, opts);
    const l = layoutOf(comp);
    const obstacles = this.target ? this.boxes : this.visible;
    const spot = this.freeSpot(Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), l.cols, l.rows, obstacles);
    comp.x = spot.x;
    comp.y = spot.y;
    const box = { x: comp.x, y: comp.y, w: l.cols, h: l.rows };
    this.boxes.push(box);
    if (!this.target) this.visible.push(box);
    this.target?.push(comp);
    return comp;
  }

  private freeSpot(
    x: number,
    y: number,
    w: number,
    h: number,
    obstacles: Box[]
  ): { x: number; y: number } {
    const fits = (px: number, py: number) =>
      !obstacles.some((b) => boxesOverlap({ x: px, y: py, w, h }, b));
    if (fits(x, y)) return { x, y };
    for (let r = 1; r <= 200; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const px = Math.max(0, x + dx);
          const py = Math.max(0, y + dy);
          if (fits(px, py)) return { x: px, y: py };
        }
      }
    }
    return { x, y };
  }

  wire(a: Source, b: Comp, port: number): void {
    if (!this.c.addWire(a.comp.id, a.port, b.id, port)) {
      throw new Error(`CPU-Verdrahtung fehlgeschlagen: ${a.comp.kind}[${a.port}] → ${b.kind}[${port}]`);
    }
  }
}

function bitOf(split: Comp, width: number, bit: number): Source {
  return { comp: split, port: width - 1 - bit };
}

/** Verbindet Bits (LSB zuerst) zu einem Bus. */
function joinSources(b: CpuBuilder, x: number, y: number, bits: Source[]): Comp {
  const j = b.add("joiner", x, y, { width: bits.length });
  bits.forEach((s, i) => b.wire(s, j, bits.length - 1 - i));
  return j;
}

function orSources(b: CpuBuilder, x: number, y: number, sources: Source[]): Source {
  let level = sources.slice();
  let row = 0;
  while (level.length > 1) {
    const next: Source[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      const g = b.add("or", x + (i / 2) * 5, y + row * 4);
      b.wire(level[i], g, 0);
      b.wire(level[i + 1], g, 1);
      next.push({ comp: g, port: 0 });
    }
    level = next;
    row++;
  }
  return level[0];
}

function cpuFullAdder(b: CpuBuilder, x: number, y: number, a: Source, bb: Source, cin: Source) {
  const x1 = b.add("xor", x, y);
  const a1 = b.add("and", x, y + 3);
  const x2 = b.add("xor", x + 6, y);
  const a2 = b.add("and", x + 6, y + 3);
  const o1 = b.add("or", x + 12, y + 3);
  b.wire(a, x1, 0);
  b.wire(bb, x1, 1);
  b.wire(a, a1, 0);
  b.wire(bb, a1, 1);
  b.wire({ comp: x1, port: 0 }, x2, 0);
  b.wire(cin, x2, 1);
  b.wire({ comp: x1, port: 0 }, a2, 0);
  b.wire(cin, a2, 1);
  b.wire({ comp: a1, port: 0 }, o1, 0);
  b.wire({ comp: a2, port: 0 }, o1, 1);
  return { sum: { comp: x2, port: 0 } as Source, cout: { comp: o1, port: 0 } as Source };
}

/** n-Bit-Ripple-Carry-Addierer aus einzelnen Bits (LSB zuerst). */
function cpuAdder(b: CpuBuilder, x: number, y: number, aBits: Source[], bBits: Source[], cin: Source): Source[] {
  const sums: Source[] = [];
  let carry = cin;
  for (let i = 0; i < aBits.length; i++) {
    const row = Math.floor(i / 4);
    const col = i % 4;
    const bx = x + (row % 2 === 0 ? col : 3 - col) * 18;
    const by = y + row * 8;
    const { sum, cout } = cpuFullAdder(b, bx, by, aBits[i], bBits[i], carry);
    sums.push(sum);
    carry = cout;
  }
  return sums;
}

/**
 * Fasst Bauteile zu einem kompakten Modulblock mit Pins zusammen. Der Block
 * ist nur das Symbol – die Innenschaltung liegt verborgen dahinter und wird
 * im Modul-Editor bearbeitet.
 */
function finishBlock(
  c: Circuit,
  moduleId: string,
  name: string,
  members: Comp[],
  inputs: PinSpec[],
  outputs: PinSpec[],
  block: { x: number; y: number; cols: number; rows: number }
): Box {
  const group: GroupInstance = {
    id: newId("m"),
    moduleId,
    name,
    x: block.x,
    y: block.y,
    cols: block.cols,
    rows: block.rows,
    footprintCols: block.cols,
    footprintRows: block.rows,
    collapsed: true,
    members: members.map((p) => p.id),
    inputs: inputs.map((p) => ({ name: p.name, width: p.comp.width, compId: p.comp.id })),
    outputs: outputs.map((p) => ({ name: p.name, width: p.comp.width, compId: p.comp.id })),
  };
  c.addGroup(group);
  return { x: block.x, y: block.y, w: block.cols, h: block.rows };
}

/* ---------- Modul: ALU 8 Bit ---------- */

function buildAlu(b: CpuBuilder, x0: number, y0: number, bits: number) {
  const parts: Comp[] = [];
  b.section(parts);
  const A = b.add("buf", x0, y0 + 2, { width: bits, label: "A" });
  const B = b.add("buf", x0, y0 + 6, { width: bits, label: "B" });
  const M = b.add("buf", x0, y0 + 10, { width: 3, label: "Modus" });
  const E = b.add("buf", x0, y0 + 14, { width: 1, label: "Enable" });

  const aSplit = b.add("splitter", x0 + 6, y0, { width: bits });
  b.wire({ comp: A, port: 0 }, aSplit, 0);
  const bSplit = b.add("splitter", x0 + 6, y0 + 10, { width: bits });
  b.wire({ comp: B, port: 0 }, bSplit, 0);
  const mSplit = b.add("splitter", x0 + 6, y0 + 20, { width: 3 });
  b.wire({ comp: M, port: 0 }, mSplit, 0);

  const m0 = bitOf(mSplit, 3, 0);
  const m1 = bitOf(mSplit, 3, 1);
  const m2 = bitOf(mSplit, 3, 2);
  const nm0: Source = { comp: b.add("not", x0 + 12, y0 + 20), port: 0 };
  b.wire(m0, nm0.comp, 0);
  const nm1: Source = { comp: b.add("not", x0 + 12, y0 + 24), port: 0 };
  b.wire(m1, nm1.comp, 0);
  const nm2: Source = { comp: b.add("not", x0 + 12, y0 + 28), port: 0 };
  b.wire(m2, nm2.comp, 0);

  const lit = (i: number, want: number): Source => (want ? [m0, m1, m2][i] : [nm0, nm1, nm2][i]);
  const term = (op: number): Source => {
    const g1 = b.add("and", x0 + 18, y0 + op * 4);
    b.wire(lit(0, op & 1), g1, 0);
    b.wire(lit(1, (op >> 1) & 1), g1, 1);
    const g2 = b.add("and", x0 + 23, y0 + op * 4);
    b.wire({ comp: g1, port: 0 }, g2, 0);
    b.wire(lit(2, (op >> 2) & 1), g2, 1);
    return { comp: g2, port: 0 };
  };
  const tHold = term(0);
  const tAdd = term(1);
  const tSub = term(2);
  const tAnd = term(3);
  const tOr = term(4);
  const tXor = term(5);
  const tPass = term(6);

  const notE: Source = { comp: b.add("not", x0 + 30, y0 + 14), port: 0 };
  b.wire({ comp: E, port: 0 }, notE.comp, 0);
  const gate = (src: Source, row: number): Source => {
    const g = b.add("and", x0 + 36, y0 + row * 4);
    b.wire(src, g, 0);
    b.wire({ comp: E, port: 0 }, g, 1);
    return { comp: g, port: 0 };
  };
  const gAdd = gate(tAdd, 1);
  const gSub = gate(tSub, 2);
  const gAnd = gate(tAnd, 3);
  const gOr = gate(tOr, 4);
  const gXor = gate(tXor, 5);
  const gPass = gate(tPass, 6);
  const mHold: Source = { comp: b.add("or", x0 + 36, y0), port: 0 };
  b.wire(tHold, mHold.comp, 0);
  b.wire(notE, mHold.comp, 1);
  const sumOp: Source = { comp: b.add("or", x0 + 36, y0 + 28), port: 0 };
  b.wire(gAdd, sumOp.comp, 0);
  b.wire(gSub, sumOp.comp, 1);

  // Arithmetik: A + (B XOR Sub) + Sub
  const bxBits: Source[] = range(bits).map((i) => {
    const g = b.add("xor", x0 + 42, y0 + i * 4);
    b.wire(bitOf(bSplit, bits, i), g, 0);
    b.wire(gSub, g, 1);
    return { comp: g, port: 0 };
  });
  const sums = cpuAdder(
    b,
    x0 + 48,
    y0,
    range(bits).map((i) => bitOf(aSplit, bits, i)),
    bxBits,
    gSub
  );
  const sumJoin = joinSources(b, x0 + 122, y0, sums);

  // Logik
  const andRes = b.add("and", x0 + 128, y0, { width: bits });
  b.wire({ comp: A, port: 0 }, andRes, 0);
  b.wire({ comp: B, port: 0 }, andRes, 1);
  const orRes = b.add("or", x0 + 128, y0 + 4, { width: bits });
  b.wire({ comp: A, port: 0 }, orRes, 0);
  b.wire({ comp: B, port: 0 }, orRes, 1);
  const xorRes = b.add("xor", x0 + 128, y0 + 8, { width: bits });
  b.wire({ comp: A, port: 0 }, xorRes, 0);
  b.wire({ comp: B, port: 0 }, xorRes, 1);

  const maskHold = joinSources(b, x0 + 42, y0 + 34, range(bits).map(() => mHold));
  const maskPass = joinSources(b, x0 + 46, y0 + 34, range(bits).map(() => gPass));
  const maskSum = joinSources(b, x0 + 50, y0 + 34, range(bits).map(() => sumOp));
  const maskAnd = joinSources(b, x0 + 54, y0 + 34, range(bits).map(() => gAnd));
  const maskOr = joinSources(b, x0 + 58, y0 + 34, range(bits).map(() => gOr));
  const maskXor = joinSources(b, x0 + 62, y0 + 34, range(bits).map(() => gXor));

  const contrib = (src: Source, mask: Comp, row: number): Source => {
    const g = b.add("and", x0 + 134, y0 + row * 4, { width: bits });
    b.wire(src, g, 0);
    b.wire({ comp: mask, port: 0 }, g, 1);
    return { comp: g, port: 0 };
  };
  let acc: Source[] = [
    contrib({ comp: A, port: 0 }, maskHold, 0),
    contrib({ comp: B, port: 0 }, maskPass, 1),
    contrib({ comp: sumJoin, port: 0 }, maskSum, 2),
    contrib({ comp: andRes, port: 0 }, maskAnd, 3),
    contrib({ comp: orRes, port: 0 }, maskOr, 4),
    contrib({ comp: xorRes, port: 0 }, maskXor, 5),
  ];
  let row = 0;
  while (acc.length > 1) {
    const next: Source[] = [];
    for (let i = 0; i < acc.length; i += 2) {
      if (i + 1 >= acc.length) {
        next.push(acc[i]);
        continue;
      }
      const g = b.add("or", x0 + 140 + (i / 2) * 5, y0 + row * 4, { width: bits });
      b.wire(acc[i], g, 0);
      b.wire(acc[i + 1], g, 1);
      next.push({ comp: g, port: 0 });
    }
    acc = next;
    row++;
  }
  const F = b.add("buf", x0 + 152, y0 + 2, { width: bits, label: "F" });
  b.wire(acc[0], F, 0);

  return { parts, A, B, M, E, F };
}

/* ---------- Modul: Akkumulator ---------- */

function buildAcc(b: CpuBuilder, x0: number, y0: number, bits: number) {
  const parts: Comp[] = [];
  b.section(parts);
  const D = b.add("buf", x0, y0 + 2, { width: bits, label: "D" });
  const CLK = b.add("buf", x0, y0 + 6, { width: 1, label: "CLK" });
  const RST = b.add("buf", x0, y0 + 10, { width: 1, label: "RST" });
  const reg = b.add("dff", x0 + 6, y0, { width: bits, label: "AKKU" });
  b.wire({ comp: D, port: 0 }, reg, 0);
  b.wire({ comp: CLK, port: 0 }, reg, 1);
  b.wire({ comp: RST, port: 0 }, reg, 2);
  const Q = b.add("buf", x0 + 12, y0 + 2, { width: bits, label: "Q" });
  b.wire({ comp: reg, port: 0 }, Q, 0);
  return { parts, D, CLK, RST, Q };
}

/* ---------- Modul: Programmzähler ---------- */

function buildPc(b: CpuBuilder, x0: number, y0: number) {
  const parts: Comp[] = [];
  b.section(parts);
  const Ziel = b.add("buf", x0, y0 + 2, { width: 8, label: "Ziel" });
  const Sprung = b.add("buf", x0, y0 + 6, { width: 1, label: "Sprung" });
  const Halt = b.add("buf", x0, y0 + 10, { width: 1, label: "Halt" });
  const CLK = b.add("buf", x0, y0 + 14, { width: 1, label: "CLK" });
  const RST = b.add("buf", x0, y0 + 18, { width: 1, label: "RST" });

  const pc = b.add("dff", x0 + 6, y0, { width: 8, label: "PC" });
  b.wire({ comp: CLK, port: 0 }, pc, 1);
  b.wire({ comp: RST, port: 0 }, pc, 2);
  const pcSplit = b.add("splitter", x0 + 12, y0, { width: 8 });
  b.wire({ comp: pc, port: 0 }, pcSplit, 0);
  const zSplit = b.add("splitter", x0 + 12, y0 + 10, { width: 8 });
  b.wire({ comp: Ziel, port: 0 }, zSplit, 0);

  const notJump = b.add("not", x0 + 12, y0 + 20);
  b.wire({ comp: Sprung, port: 0 }, notJump, 0);
  const notHalt = b.add("not", x0 + 16, y0 + 20);
  b.wire({ comp: Halt, port: 0 }, notHalt, 0);

  const aBits: Source[] = range(8).map((i) => {
    const g = b.add("and", x0 + 18 + i * 5, y0);
    b.wire(bitOf(pcSplit, 8, i), g, 0);
    b.wire({ comp: notJump, port: 0 }, g, 1);
    return { comp: g, port: 0 };
  });

  const bBits: Source[] = [];
  const b0a = b.add("and", x0 + 18, y0 + 6);
  b.wire(bitOf(zSplit, 8, 0), b0a, 0);
  b.wire({ comp: Sprung, port: 0 }, b0a, 1);
  const b0b = b.add("and", x0 + 18, y0 + 10);
  b.wire({ comp: notJump, port: 0 }, b0b, 0);
  b.wire({ comp: notHalt, port: 0 }, b0b, 1);
  const b0 = b.add("or", x0 + 23, y0 + 6);
  b.wire({ comp: b0a, port: 0 }, b0, 0);
  b.wire({ comp: b0b, port: 0 }, b0, 1);
  bBits.push({ comp: b0, port: 0 });
  for (let i = 1; i < 8; i++) {
    const g = b.add("and", x0 + 28 + (i - 1) * 5, y0 + 6);
    b.wire(bitOf(zSplit, 8, i), g, 0);
    b.wire({ comp: Sprung, port: 0 }, g, 1);
    bBits.push({ comp: g, port: 0 });
  }

  const zero = b.add("const", x0 + 6, y0 + 24, { value: 0 });
  const sums = cpuAdder(b, x0 + 68, y0, aBits, bBits, { comp: zero, port: 0 });
  const pcJoin = joinSources(b, x0 + 142, y0, sums);
  b.wire({ comp: pcJoin, port: 0 }, pc, 0);

  const PC = b.add("buf", x0 + 146, y0 + 2, { width: 8, label: "PC" });
  b.wire({ comp: pc, port: 0 }, PC, 0);
  return { parts, Ziel, Sprung, Halt, CLK, RST, PC };
}

/* ---------- Modul: Ausgabe ---------- */

function buildOut(b: CpuBuilder, x0: number, y0: number, bits: number) {
  const parts: Comp[] = [];
  b.section(parts);
  const D = b.add("buf", x0, y0 + 2, { width: bits, label: "D" });
  const Laden = b.add("buf", x0, y0 + 6, { width: 1, label: "Laden" });
  const CLK = b.add("buf", x0, y0 + 10, { width: 1, label: "CLK" });
  const RST = b.add("buf", x0, y0 + 14, { width: 1, label: "RST" });

  const reg = b.add("dff", x0 + 8, y0, { width: bits, label: "AUSGABE" });
  const notLaden = b.add("not", x0 + 6, y0 + 6);
  b.wire({ comp: Laden, port: 0 }, notLaden, 0);
  const maskOn = joinSources(b, x0 + 12, y0 + 6, range(bits).map(() => ({ comp: Laden, port: 0 })));
  const maskOff = joinSources(b, x0 + 12, y0 + 16, range(bits).map(() => ({ comp: notLaden, port: 0 })));
  const andOn = b.add("and", x0 + 18, y0 + 6, { width: bits });
  b.wire({ comp: D, port: 0 }, andOn, 0);
  b.wire({ comp: maskOn, port: 0 }, andOn, 1);
  const andOff = b.add("and", x0 + 18, y0 + 16, { width: bits });
  b.wire({ comp: reg, port: 0 }, andOff, 0);
  b.wire({ comp: maskOff, port: 0 }, andOff, 1);
  const next = b.add("or", x0 + 24, y0 + 6, { width: bits });
  b.wire({ comp: andOn, port: 0 }, next, 0);
  b.wire({ comp: andOff, port: 0 }, next, 1);
  b.wire({ comp: next, port: 0 }, reg, 0);
  b.wire({ comp: CLK, port: 0 }, reg, 1);
  b.wire({ comp: RST, port: 0 }, reg, 2);
  const Q = b.add("buf", x0 + 30, y0 + 2, { width: bits, label: "Q" });
  b.wire({ comp: reg, port: 0 }, Q, 0);
  return { parts, D, Laden, CLK, RST, Q };
}

/* ---------- Steuerwort ---------- */

interface CtrlSpec {
  m?: number;
  e?: number;
  mem?: number;
  we?: number;
  out?: number;
  jmp?: number;
  jz?: number;
  jnz?: number;
  halt?: number;
}

/** Bit 0–2 Modus, 3 Enable, 4 Speicher statt Operand, 5 RAM schreiben,
 *  6 Ausgabe laden, 7 JMP, 8 JZ, 9 JNZ, 10 HLT. */
function ctrlWord(opts: CtrlSpec): number {
  return (
    ((opts.m ?? 0) & 7) |
    ((opts.e ?? 0) << 3) |
    ((opts.mem ?? 0) << 4) |
    ((opts.we ?? 0) << 5) |
    ((opts.out ?? 0) << 6) |
    ((opts.jmp ?? 0) << 7) |
    ((opts.jz ?? 0) << 8) |
    ((opts.jnz ?? 0) << 9) |
    ((opts.halt ?? 0) << 10)
  );
}

const CPU_PROGRAM = `; Mini-CPU: 5 + 7 rechnen, ablegen, wieder laden und ausgeben
start:
  LDA #5
  ADD #7
  STA 32
  LDA #0
  ADD 32
  OUT
  HLT
`;

const CPU_PROGRAM16 = `; Mini-CPU 16 Bit: 0x1234 + 0x1111 rechnen, ablegen, wieder laden und ausgeben
start:
  LDA #0x1234
  ADD #0x1111
  STA 32
  LDA #0
  ADD 32
  OUT
  HLT
`;

const CPU_PROGRAM32 = `; Mini-CPU 32 Bit: 0x12345678 + 0x11111111 rechnen, ablegen und ausgeben
start:
  LDA #0x12345678
  ADD #0x11111111
  STA 32
  LDA #0
  ADD 32
  OUT
  HLT
`;

/** IDs der vier CPU-Module des 8-Bit-Presets. */
export const CPU_MODULE_IDS = ["mini-cpu-alu", "mini-cpu-acc", "mini-cpu-pc", "mini-cpu-out"];

/** Modul-IDs der CPU-Variante mit der angegebenen Datenbreite. */
export function cpuModuleIds(bits: 8 | 16 | 32): string[] {
  const prefix = bits === 8 ? "mini-cpu" : `cpu${bits}`;
  return [`${prefix}-alu`, `${prefix}-acc`, `${prefix}-pc`, `${prefix}-out`];
}

/**
 * Stellt sicher, dass die CPU-Module in der Bibliothek liegen – auch ohne
 * geladenes Beispiel. Bereits vorhandene (ggf. vom Nutzer bearbeitete)
 * Vorlagen bleiben unangetastet.
 */
export function ensureCpuModules(): void {
  if (CPU_MODULE_IDS.every((id) => getModule(id))) return;
  const tmp = new Circuit();
  buildCpu(tmp, 8);
}

/** 8-Bit-Mini-CPU (bisheriges Beispiel). */
export function buildMiniCpu(c: Circuit): void {
  buildCpu(c, 8);
}

/**
 * Mini-CPU mit wählbarer Datenbreite (8, 16 oder 32 Bit). Alle Pfade
 * (ALU, Akkumulator, RAM, Ausgabe) rechnen mit dieser Breite; der
 * Programmzähler und die Speicheradressen bleiben 8 Bit (256 Wörter).
 * Ab 16 Bit liegen Opcode und Operand in getrennten ROMs, weil ein
 * Programmspeicher mit mehr als 16 Bit Datenbreite nicht darstellbar ist.
 */
export function buildCpu(c: Circuit, bits: 8 | 16 | 32): void {
  const b = new CpuBuilder(c);
  const wide = bits > 8;
  const prefix = bits === 8 ? "mini-cpu" : `cpu${bits}`;

  const clk = b.add("clock", 0, 0, { div: 1, label: "TAKT" });
  const rst = b.add("const", 0, 4, { label: "RESET", value: 0 });
  b.add("const", 0, 8, { label: "0", value: 0 });

  // Innenschaltungen der CPU-Module (verborgen, im Modul-Editor bearbeitbar).
  const alu = buildAlu(b, 40, 0, bits);
  const acc = buildAcc(b, 250, 0, bits);
  const pc = buildPc(b, 280, 0);
  const outReg = buildOut(b, 470, 0, bits);

  // Sichtbare Symbole: kompakt, maximal 4 × 4 Zellen.
  b.section(null);
  b.reserve(
    finishBlock(
      c,
      `${prefix}-alu`,
      `ALU ${bits} Bit`,
      alu.parts,
      [
        { comp: alu.A, name: "A" },
        { comp: alu.B, name: "B" },
        { comp: alu.M, name: "Modus" },
        { comp: alu.E, name: "Enable" },
      ],
      [{ comp: alu.F, name: "F" }],
      { x: 8, y: 0, cols: 4, rows: 4 }
    )
  );
  b.reserve(
    finishBlock(
      c,
      `${prefix}-acc`,
      "Akkumulator",
      acc.parts,
      [
        { comp: acc.D, name: "D" },
        { comp: acc.CLK, name: "CLK" },
        { comp: acc.RST, name: "RST" },
      ],
      [{ comp: acc.Q, name: "Q" }],
      { x: 14, y: 0, cols: 4, rows: 3 }
    )
  );
  b.reserve(
    finishBlock(
      c,
      `${prefix}-pc`,
      "Programmzähler",
      pc.parts,
      [
        { comp: pc.Ziel, name: "Ziel" },
        { comp: pc.Sprung, name: "Sprung" },
        { comp: pc.Halt, name: "Halt" },
        { comp: pc.CLK, name: "CLK" },
        { comp: pc.RST, name: "RST" },
      ],
      [{ comp: pc.PC, name: "PC" }],
      { x: 20, y: 0, cols: 4, rows: 4 }
    )
  );
  b.reserve(
    finishBlock(
      c,
      `${prefix}-out`,
      "Ausgabe",
      outReg.parts,
      [
        { comp: outReg.D, name: "D" },
        { comp: outReg.Laden, name: "Laden" },
        { comp: outReg.CLK, name: "CLK" },
        { comp: outReg.RST, name: "RST" },
      ],
      [{ comp: outReg.Q, name: "Q" }],
      { x: 26, y: 0, cols: 4, rows: 4 }
    )
  );

  // Programmspeicher: bis 8 Bit ein gemeinsames 16-Bit-Wort, ab 16 Bit
  // getrennte ROMs für Opcode und Operand (größere Wörter sind nicht möglich).
  const source = bits === 16 ? CPU_PROGRAM16 : bits === 32 ? CPU_PROGRAM32 : CPU_PROGRAM;
  const program = assemble(source, bits);
  const size = 256;
  const progRom = b.add("rom", 0, 12, {
    addrWidth: 8,
    dataWidth: wide ? 8 : 16,
    data: new Array(size).fill(0),
    label: "PROGRAMM",
  });
  if (wide) {
    program.opcodes.forEach((v, i) => {
      if (i < size) progRom.data[i] = v;
    });
  } else {
    program.words.forEach((v, i) => {
      if (i < size) progRom.data[i] = v;
    });
  }

  let opcodeSrc: Source;
  let operandSrc: Source;
  let addrSrc: Source;
  if (wide) {
    const operandRom = b.add("rom", 0, 20, {
      addrWidth: 8,
      dataWidth: bits,
      data: new Array(size).fill(0),
      label: "OPERAND",
    });
    program.operands.forEach((v, i) => {
      if (i < size) operandRom.data[i] = v;
    });
    // Opcode und Operand liegen an derselben Adresse: der PC adressiert beide.
    b.wire({ comp: pc.PC, port: 0 }, operandRom, 0);
    operandSrc = { comp: operandRom, port: 0 };
    const operandSplit = b.add("splitter", 6, 20, { width: bits });
    b.wire(operandSrc, operandSplit, 0);
    addrSrc = {
      comp: joinSources(b, 10, 24, range(8).map((i) => bitOf(operandSplit, bits, i))),
      port: 0,
    };
    opcodeSrc = { comp: progRom, port: 0 };
  } else {
    const progSplit = b.add("splitter", 6, 12, { width: 16 });
    b.wire({ comp: progRom, port: 0 }, progSplit, 0);
    opcodeSrc = {
      comp: joinSources(b, 10, 12, range(8).map((i) => bitOf(progSplit, 16, 8 + i))),
      port: 0,
    };
    operandSrc = {
      comp: joinSources(b, 10, 21, range(8).map((i) => bitOf(progSplit, 16, i))),
      port: 0,
    };
    addrSrc = operandSrc;
  }

  // Steuer-ROM (Mikrobefehle), ebenfalls eigenes Bauteil.
  const ctrl = new Array(256).fill(0);
  ctrl[0x01] = ctrlWord({ m: 6, e: 1 });
  ctrl[0x02] = ctrlWord({ m: 6, e: 1, mem: 1 });
  ctrl[0x03] = ctrlWord({ we: 1 });
  ctrl[0x04] = ctrlWord({ m: 1, e: 1 });
  ctrl[0x05] = ctrlWord({ m: 1, e: 1, mem: 1 });
  ctrl[0x06] = ctrlWord({ m: 2, e: 1 });
  ctrl[0x07] = ctrlWord({ m: 2, e: 1, mem: 1 });
  ctrl[0x08] = ctrlWord({ m: 3, e: 1 });
  ctrl[0x09] = ctrlWord({ m: 3, e: 1, mem: 1 });
  ctrl[0x0a] = ctrlWord({ m: 4, e: 1 });
  ctrl[0x0b] = ctrlWord({ m: 4, e: 1, mem: 1 });
  ctrl[0x0c] = ctrlWord({ m: 5, e: 1 });
  ctrl[0x0d] = ctrlWord({ m: 5, e: 1, mem: 1 });
  ctrl[0x10] = ctrlWord({ out: 1 });
  ctrl[0x20] = ctrlWord({ jmp: 1 });
  ctrl[0x21] = ctrlWord({ jz: 1 });
  ctrl[0x22] = ctrlWord({ jnz: 1 });
  ctrl[0xff] = ctrlWord({ halt: 1 });
  const ctrlRom = b.add("rom", 16, 12, { addrWidth: 8, dataWidth: 16, data: ctrl, label: "STEUER-ROM" });
  b.wire(opcodeSrc, ctrlRom, 0);
  const ctrlSplit = b.add("splitter", 22, 12, { width: 16 });
  b.wire({ comp: ctrlRom, port: 0 }, ctrlSplit, 0);
  const cbit = (i: number): Source => bitOf(ctrlSplit, 16, i);

  // Datenspeicher (RAM) – steckt nicht im CPU-Modul
  const ram = b.add("ram", 28, 12, {
    addrWidth: 8,
    dataWidth: bits,
    data: new Array(size).fill(0),
    label: "DATEN-RAM",
  });
  b.wire(addrSrc, ram, 0);
  b.wire({ comp: acc.Q, port: 0 }, ram, 1);
  b.wire(cbit(5), ram, 2);
  b.wire({ comp: clk, port: 0 }, ram, 3);

  // CPU-Eingänge verdrahten
  const modeJoin = joinSources(b, 16, 30, [cbit(0), cbit(1), cbit(2)]);
  b.wire({ comp: modeJoin, port: 0 }, alu.M, 0);
  b.wire(cbit(3), alu.E, 0);

  const notMem = b.add("not", 22, 30);
  b.wire(cbit(4), notMem, 0);
  const maskMem = joinSources(b, 26, 30, range(bits).map(() => cbit(4)));
  const maskImm = joinSources(b, 30, 30, range(bits).map(() => ({ comp: notMem, port: 0 })));
  const andMem = b.add("and", 26, 41, { width: bits });
  b.wire({ comp: ram, port: 0 }, andMem, 0);
  b.wire({ comp: maskMem, port: 0 }, andMem, 1);
  const andImm = b.add("and", 26, 45, { width: bits });
  b.wire(operandSrc, andImm, 0);
  b.wire({ comp: maskImm, port: 0 }, andImm, 1);
  const bBus = b.add("or", 32, 41, { width: bits });
  b.wire({ comp: andMem, port: 0 }, bBus, 0);
  b.wire({ comp: andImm, port: 0 }, bBus, 1);
  b.wire({ comp: bBus, port: 0 }, alu.B, 0);

  b.wire({ comp: acc.Q, port: 0 }, alu.A, 0);
  b.wire({ comp: alu.F, port: 0 }, acc.D, 0);

  // Null-Flag + Sprunglogik
  const accSplit = b.add("splitter", 36, 30, { width: bits });
  b.wire({ comp: acc.Q, port: 0 }, accSplit, 0);
  const zeroOr = orSources(b, 40, 30, range(bits).map((i) => bitOf(accSplit, bits, i)));
  const zeroNot: Source = { comp: b.add("not", 40, 34), port: 0 };
  b.wire(zeroOr, zeroNot.comp, 0);
  const jumpZero = b.add("and", 45, 30);
  b.wire(cbit(8), jumpZero, 0);
  b.wire(zeroNot, jumpZero, 1);
  const jumpNotZero = b.add("and", 45, 34);
  b.wire(cbit(9), jumpNotZero, 0);
  b.wire(zeroOr, jumpNotZero, 1);
  const condJump = b.add("or", 50, 30);
  b.wire({ comp: jumpZero, port: 0 }, condJump, 0);
  b.wire({ comp: jumpNotZero, port: 0 }, condJump, 1);
  const doJump: Source = { comp: b.add("or", 50, 34), port: 0 };
  b.wire(cbit(7), doJump.comp, 0);
  b.wire({ comp: condJump, port: 0 }, doJump.comp, 1);

  b.wire(doJump, pc.Sprung, 0);
  b.wire(cbit(10), pc.Halt, 0);
  b.wire(addrSrc, pc.Ziel, 0);
  b.wire({ comp: clk, port: 0 }, pc.CLK, 0);
  b.wire({ comp: rst, port: 0 }, pc.RST, 0);
  b.wire({ comp: pc.PC, port: 0 }, progRom, 0);

  b.wire({ comp: clk, port: 0 }, acc.CLK, 0);
  b.wire({ comp: rst, port: 0 }, acc.RST, 0);

  b.wire({ comp: acc.Q, port: 0 }, outReg.D, 0);
  b.wire(cbit(6), outReg.Laden, 0);
  b.wire({ comp: clk, port: 0 }, outReg.CLK, 0);
  b.wire({ comp: rst, port: 0 }, outReg.RST, 0);

  // Anzeigen (außerhalb der Module)
  const pcLamp = b.add("output", 0, 33, { width: 8, label: "PC", format: "dec" });
  b.wire({ comp: pc.PC, port: 0 }, pcLamp, 0);
  const accLamp = b.add("output", 0, 37, { width: bits, label: "AKKU", format: bits === 8 ? "dec" : "hex" });
  b.wire({ comp: acc.Q, port: 0 }, accLamp, 0);
  const outLamp = b.add("output", 0, 41, { width: bits, label: "AUSGABE", format: bits === 8 ? "dec" : "hex" });
  b.wire({ comp: outReg.Q, port: 0 }, outLamp, 0);

  // Eigene Bearbeitungen der CPU-Module haben Vorrang: Instanzen werden aus
  // der Bibliothek aufgebaut, damit die example-eigene Verdrahtung die vom
  // Nutzer gespeicherte Version benutzt – sofern die Pins dazu passen.
  for (const group of [...c.groups.values()]) {
    const def = getModule(group.moduleId);
    if (!def || (def.version ?? 1) <= 1) continue;
    const pinsMatch =
      def.inputs.length === group.inputs.length &&
      def.outputs.length === group.outputs.length &&
      def.inputs.every((p, i) => p.width === group.inputs[i].width) &&
      def.outputs.every((p, i) => p.width === group.outputs[i].width);
    if (pinsMatch) replaceGroupInternals(c, group.id, def);
  }

  // Die CPU-Module stehen als bearbeitbare Module in der Seitenleiste.
  for (const group of [...c.groups.values()]) {
    if (getModule(group.moduleId)) continue;
    const snapshot = editableCircuitForGroup(c, group.id);
    if (!snapshot) continue;
    const work = new Circuit();
    work.load(snapshot);
    const def = buildModuleDef(
      work,
      [...work.comps.keys()],
      group.name,
      { cols: group.cols, rows: group.rows },
      { id: group.moduleId, version: 1 }
    );
    if (def) addModule(def);
  }
}
