import { Circuit, makeComp } from "./circuit";
import { layoutOf, portWidths, newId } from "./logic";
import { addModule, buildModuleDef, getModule, instantiateModule, ModuleDef } from "./modules";
import { Comp, CompKind, GroupInstance, maskOf } from "./types";

/**
 * Standard-Modul-Bibliothek: Alle Module sind echte Schaltpläne aus Gattern,
 * Flip-Flops, Latches, Splittern und Joinern. Das Innenleben ist im
 * Modul-Editor sichtbar. Kombinatorische Schleifen unterstützt der Simulator
 * nicht – Speicherzellen stützen sich daher auf die Bauteile D-Flip-Flop
 * und D-Latch.
 */

interface Src {
  comp: Comp;
  port: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Extent {
  w: number;
  h: number;
}

const rowsOf = (n: number): number => Math.max(2, n + 1);

/** Baut Schaltpläne kollisionsfrei und mit geprüften Busbreiten. */
class B {
  readonly c = new Circuit();
  private rects: Box[] = [];
  private pinIn = 0;
  private pinOut = 0;

  reserve(kind: CompKind, opts: Partial<Comp> = {}): Comp {
    const comp = makeComp(kind, 0, 0);
    Object.assign(comp, opts);
    if (kind === "dff" || kind === "latch") comp.outs = [0, maskOf(comp.width)];
    this.c.comps.set(comp.id, comp);
    return comp;
  }

  place(comp: Comp, x: number, y: number): Comp {
    comp.x = x;
    comp.y = y;
    const l = layoutOf(comp);
    const box = { x, y, w: l.cols, h: l.rows };
    for (const r of this.rects) {
      if (box.x < r.x + r.w && box.x + box.w > r.x && box.y < r.y + r.h && box.y + box.h > r.y) {
        throw new Error(`Standardmodul: Überlappung bei ${comp.kind} (${x},${y})`);
      }
    }
    this.rects.push(box);
    return comp;
  }

  add(kind: CompKind, x: number, y: number, opts: Partial<Comp> = {}): Comp {
    return this.place(this.reserve(kind, opts), x, y);
  }

  mark(): number {
    return this.rects.length;
  }

  /** Ausdehnung aller seit `mark` platzierten Bauteile ab (x, y). */
  extent(mark: number, x: number, y: number): Extent {
    let w = 0;
    let h = 0;
    for (const r of this.rects.slice(mark)) {
      w = Math.max(w, r.x + r.w - x);
      h = Math.max(h, r.y + r.h - y);
    }
    return { w, h };
  }

  widthOf(s: Src): number {
    return portWidths(s.comp).out[s.port];
  }

  wire(from: Src, to: Comp, port: number): void {
    const sw = portWidths(from.comp).out[from.port];
    const dw = portWidths(to).in[port];
    if (sw === undefined || dw === undefined || sw !== dw) {
      throw new Error(`Standardmodul: Busbreite passt nicht (${from.comp.kind}[${from.port}] ${sw} → ${to.kind}[${port}] ${dw})`);
    }
    this.c.wires.push({ id: newId("w"), from: from.comp.id, fromPort: from.port, to: to.id, toPort: port });
  }

  gate(kind: CompKind, x: number, y: number, a: Src, b?: Src): Src {
    const comp = this.add(kind, x, y, { width: this.widthOf(a) });
    this.wire(a, comp, 0);
    if (b) this.wire(b, comp, 1);
    return { comp, port: 0 };
  }

  split(x: number, y: number, bus: Src): Comp {
    const sp = this.add("splitter", x, y, { width: this.widthOf(bus) });
    this.wire(bus, sp, 0);
    return sp;
  }

  /** Verbindet Bits (LSB zuerst) zu einem Bus. */
  join(x: number, y: number, bits: Src[]): Src {
    const j = this.add("joiner", x, y, { width: bits.length });
    bits.forEach((s, i) => this.wire(s, j, bits.length - 1 - i));
    return { comp: j, port: 0 };
  }

  constant(x: number, y: number, value: number, width = 1): Src {
    return { comp: this.add("const", x, y, { width, value }), port: 0 };
  }

  /** Ein Bit auf n Bit replizieren (n = 1: das Bit selbst). */
  repl(x: number, y: number, bit: Src, n: number): Src {
    if (n === 1) return bit;
    return this.join(x, y, new Array(n).fill(bit));
  }

  input(name: string, width: number): Src {
    const comp = this.reserve("input", { width, label: name });
    comp.x = -10;
    comp.y = this.pinIn++;
    return { comp, port: 0 };
  }

  output(name: string, width: number, src: Src): void {
    const comp = this.reserve("output", { width, label: name });
    comp.x = 1000;
    comp.y = this.pinOut++;
    this.wire(src, comp, 0);
  }
}

const bitOf = (sp: Comp, n: number, i: number): Src => ({ comp: sp, port: n - 1 - i });

/** Bits eines Busses als Einzelquellen (LSB zuerst); bei Breite 1 der Bus selbst. */
function selBits(b: B, x: number, y: number, bus: Src, k: number): Src[] {
  if (k === 1) return [bus];
  const sp = b.split(x, y, bus);
  return Array.from({ length: k }, (_, i) => bitOf(sp, k, i));
}

function reduce(b: B, kind: CompKind, x: number, y: number, list: Src[]): Src {
  let cur = list;
  let lvl = 0;
  while (cur.length > 1) {
    const next: Src[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 >= cur.length) {
        next.push(cur[i]);
        continue;
      }
      next.push(b.gate(kind, x + lvl * 6, y + (i / 2) * 4 * 2 ** lvl, cur[i], cur[i + 1]));
    }
    cur = next;
    lvl++;
  }
  return cur[0];
}

/** Auswahl-Leitungen: sel = Select-Bus (n Bit breit), nsel = invertiert. */
function replSel(b: B, x: number, y: number, sel: Src, n: number): { sel: Src; nsel: Src } {
  if (n === 1) return { sel, nsel: b.gate("not", x, y, sel) };
  const s = b.repl(x, y, sel, n);
  return { sel: s, nsel: b.gate("not", x + 5, y, s) };
}

function muxCell(b: B, x: number, y: number, a: Src, bb: Src, sel: Src, nsel: Src): Src {
  const t0 = b.gate("and", x, y, a, nsel);
  const t1 = b.gate("and", x, y + 4, bb, sel);
  return b.gate("or", x + 6, y + 2, t0, t1);
}

/** 2:1-Multiplexer mit eigener Select-Aufbereitung (S=0 → a, S=1 → bb). */
function mux2(b: B, x: number, y: number, a: Src, bb: Src, s: Src): { out: Src } & Extent {
  const m = b.mark();
  const n = b.widthOf(a);
  const r = replSel(b, x, y, s, n);
  const out = muxCell(b, x + 10, y, a, bb, r.sel, r.nsel);
  return { out, ...b.extent(m, x, y) };
}

/** Multiplexer-Baum; leaves.length === 2^sel.length. */
function muxTree(b: B, x: number, y: number, leaves: Src[], sel: Src[]): { out: Src } & Extent {
  const m = b.mark();
  const n = b.widthOf(leaves[0]);
  const stripH = n > 1 ? rowsOf(n) + 1 : 4;
  let cur = leaves;
  sel.forEach((s, l) => {
    const xl = x + l * 13;
    const r = replSel(b, xl, y, s, n);
    const next: Src[] = [];
    for (let i = 0; i < cur.length / 2; i++) {
      next.push(muxCell(b, xl, y + stripH + i * 9 * 2 ** l, cur[2 * i], cur[2 * i + 1], r.sel, r.nsel));
    }
    cur = next;
  });
  return { out: cur[0], ...b.extent(m, x, y) };
}

function rippleAdder(b: B, x: number, y: number, a: Src, bb: Src, ci: Src, n: number) {
  const m = b.mark();
  const sa = b.split(x, y, a);
  const sb = b.split(x, y + rowsOf(n) + 1, bb);
  const per = Math.min(n, 4);
  const sums: Src[] = [];
  let carry = ci;
  for (let i = 0; i < n; i++) {
    const sx = x + 8 + (i % per) * 18;
    const sy = y + Math.floor(i / per) * 9;
    const ai = bitOf(sa, n, i);
    const bi = bitOf(sb, n, i);
    const x1 = b.gate("xor", sx, sy, ai, bi);
    const a1 = b.gate("and", sx, sy + 4, ai, bi);
    sums.push(b.gate("xor", sx + 6, sy, x1, carry));
    const a2 = b.gate("and", sx + 6, sy + 4, x1, carry);
    carry = b.gate("or", sx + 12, sy + 4, a1, a2);
  }
  const sum = b.join(x + 8 + per * 18 + 1, y, sums);
  return { sum, co: carry, aBit: (i: number) => bitOf(sa, n, i), bBit: (i: number) => bitOf(sb, n, i), ...b.extent(m, x, y) };
}

function incCore(b: B, x: number, y: number, a: Src, ci: Src, n: number) {
  const m = b.mark();
  const sa = b.split(x, y, a);
  const per = Math.min(n, 8);
  const sums: Src[] = [];
  let carry = ci;
  for (let i = 0; i < n; i++) {
    const sx = x + 8 + (i % per) * 12;
    const sy = y + Math.floor(i / per) * 5;
    const ai = bitOf(sa, n, i);
    sums.push(b.gate("xor", sx, sy, ai, carry));
    carry = b.gate("and", sx + 6, sy, ai, carry);
  }
  const sum = b.join(x + 8 + per * 12 + 1, y, sums);
  return { sum, co: carry, ...b.extent(m, x, y) };
}

function zeroCore(b: B, x: number, y: number, a: Src, n: number) {
  const m = b.mark();
  const bits = selBits(b, x, y, a, n);
  const levels = Math.ceil(Math.log2(Math.max(1, n)));
  const any = reduce(b, "or", x + 8, y, bits);
  const z = b.gate("not", x + 8 + levels * 6, y, any);
  return { z, bit: (i: number) => bits[i], ...b.extent(m, x, y) };
}

function decodeCore(b: B, x: number, y: number, bits: Src[], en: Src | null) {
  const m = b.mark();
  const k = bits.length;
  const nots = bits.map((s, i) => b.gate("not", x, y + i * 4, s));
  const outs: Src[] = [];
  for (let i = 0; i < 1 << k; i++) {
    const lits = bits.map((s, j) => ((i >> j) & 1 ? s : nots[j]));
    if (en) lits.push(en);
    let acc = lits[0];
    for (let j = 1; j < lits.length; j++) acc = b.gate("and", x + 6 + (j - 1) * 5, y + i * 4, acc, lits[j]);
    outs.push(acc);
  }
  return { outs, ...b.extent(m, x, y) };
}

/** Barrel-Shifter: Stufe k schiebt um 2^k, DIR=0 links, DIR=1 logisch rechts. */
function bshiftCore(b: B, x: number, y: number, a: Src, shs: Src[], dir: Src, n: number) {
  const m = b.mark();
  const zero = b.constant(x, y, 0);
  const ndir = b.gate("not", x + 5, y, dir);
  const per = 3;
  const stageH = rowsOf(n) + 4;
  let prev = a;
  shs.forEach((sh, k) => {
    const amt = 1 << k;
    const gx = x + (k % per) * 50;
    const gy = y + 5 + Math.floor(k / per) * (stageH + 2);
    const y2 = gy + rowsOf(n) + 1;
    const sp = b.split(gx, gy, prev);
    const shifted = (dirRight: boolean) => {
      const bits: Src[] = [];
      for (let j = 0; j < n; j++) {
        const from = dirRight ? j + amt : j - amt;
        bits.push(from >= 0 && from < n ? bitOf(sp, n, from) : zero);
      }
      return bits;
    };
    const jl = b.join(gx + 6, gy, shifted(false));
    const jr = b.join(gx + 12, gy, shifted(true));
    const sl = b.gate("and", gx, y2, sh, ndir);
    const sr = b.gate("and", gx + 6, y2, sh, dir);
    const rl = b.repl(gx + 18, gy, sl, n);
    const rr = b.repl(gx + 24, gy, sr, n);
    const hold = b.gate("nor", gx + 12, y2, rl, rr);
    const th = b.gate("and", gx + 18, y2, prev, hold);
    const tl = b.gate("and", gx + 24, y2, jl, rl);
    const tr = b.gate("and", gx + 30, y2, jr, rr);
    const o1 = b.gate("or", gx + 36, y2, th, tl);
    prev = b.gate("or", gx + 42, y2, o1, tr);
  });
  return { out: prev, ...b.extent(m, x, y) };
}

/* ---------- Beschreibung der Module ---------- */

interface PinSpec {
  name: string;
  dir: "in" | "out";
  width: string;
  doc: string;
}

interface Spec {
  name: string;
  bits?: number[];
  category: string;
  title: string;
  description: string;
  pins: PinSpec[];
  /** Kurzbezeichnung im Block; Standard: NAME + Breite. */
  label?: (bits: number | undefined) => string;
  build: (b: B, I: Record<string, Src>, bits: number) => Record<string, Src>;
}

const ALL = [1, 2, 4, 8, 16, 32];
const i = (name: string, width: string, doc: string): PinSpec => ({ name, dir: "in", width, doc });
const o = (name: string, width: string, doc: string): PinSpec => ({ name, dir: "out", width, doc });

const CAT_MUX = "Auswahl & Verteiler";
const CAT_ARITH = "Arithmetik";
const CAT_MEM = "Speicher & Register";
const CAT_SHIFT = "Schieben";
const CAT_BUS = "Bus & Breite";
const CAT_TEACH = "Lehrmodule";
const CAT_DISP = "Anzeige";

const SEG7: Record<string, number[]> = {
  a: [0, 2, 3, 5, 6, 7, 8, 9, 10, 12, 14, 15],
  b: [0, 1, 2, 3, 4, 7, 8, 9, 10, 13],
  c: [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13],
  d: [0, 2, 3, 5, 6, 8, 9, 11, 12, 13, 14],
  e: [0, 2, 6, 8, 10, 11, 12, 13, 14, 15],
  f: [0, 4, 5, 6, 8, 9, 10, 11, 12, 14, 15],
  g: [2, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14, 15],
};

const SPECS: Spec[] = [
  {
    name: "mux2",
    bits: ALL,
    category: CAT_MUX,
    title: "Multiplexer 2:1",
    description: "Wählt einen von zwei N-Bit-Werten aus: S=0 liefert A, S=1 liefert B. Aufgebaut aus UND-/ODER-Gattern mit repliziertem Select-Signal.",
    pins: [i("A", "N", "Wert bei S=0"), i("B", "N", "Wert bei S=1"), i("S", "1", "Auswahl"), o("Y", "N", "Gewählter Wert")],
    build: (b, I) => ({ Y: mux2(b, 0, 0, I.A, I.B, I.S).out }),
  },
  {
    name: "mux4",
    bits: ALL,
    category: CAT_MUX,
    title: "Multiplexer 4:1",
    description: "Wählt einen von vier N-Bit-Werten: Y = D[S]. Zwei Stufen aus 2:1-Multiplexern.",
    pins: [
      i("D0", "N", "Wert bei S=0"),
      i("D1", "N", "Wert bei S=1"),
      i("D2", "N", "Wert bei S=2"),
      i("D3", "N", "Wert bei S=3"),
      i("S", "2", "Auswahl 0..3"),
      o("Y", "N", "Gewählter Wert"),
    ],
    build: (b, I) => {
      const sp = selBits(b, 0, 0, I.S, 2);
      const t = muxTree(b, 8, 0, [I.D0, I.D1, I.D2, I.D3], sp);
      return { Y: t.out };
    },
  },
  {
    name: "mux8",
    bits: [1, 8, 32],
    category: CAT_MUX,
    title: "Multiplexer 8:1",
    description: "Wählt einen von acht N-Bit-Werten: Y = D[S]. Drei Stufen aus 2:1-Multiplexern.",
    pins: [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => i(`D${k}`, "N", `Wert bei S=${k}`)),
      i("S", "3", "Auswahl 0..7"),
      o("Y", "N", "Gewählter Wert"),
    ],
    build: (b, I) => {
      const sp = selBits(b, 0, 0, I.S, 3);
      const t = muxTree(b, 8, 0, [0, 1, 2, 3, 4, 5, 6, 7].map((k) => I[`D${k}`]), sp);
      return { Y: t.out };
    },
  },
  {
    name: "decoder",
    bits: [2, 3, 4],
    category: CAT_MUX,
    title: "Dekoder (1-aus-n)",
    description: "Setzt genau den Ausgang Y[A] auf 1 (One-Hot), wenn EN=1; bei EN=0 sind alle Ausgänge 0. Dient z. B. zum Auswählen von Registern oder Speicherzeilen.",
    pins: [i("A", "k", "Adresse (k Bit)"), i("EN", "1", "Freigabe"), o("Y", "2^k", "One-Hot-Ausgang: Bit i = (A==i) und EN")],
    label: (k) => `DEC ${k}→${1 << k!}`,
    build: (b, I, k) => {
      const sp = selBits(b, 0, 0, I.A, k);
      const d = decodeCore(b, 8, 0, sp, I.EN);
      return { Y: b.join(8 + d.w + 3, 0, d.outs) };
    },
  },
  {
    name: "adder",
    bits: ALL,
    category: CAT_ARITH,
    title: "Addierer (Ripple-Carry)",
    description: "Addiert A + B + CI. S ist die Summe (N Bit), CO der Übertrag nach dem höchsten Bit (Überlauf bei vorzeichenloser Rechnung). Kette aus Volladdierern (XOR/AND/OR).",
    pins: [i("A", "N", "Summand A"), i("B", "N", "Summand B"), i("CI", "1", "Übertrag-Eingang"), o("S", "N", "Summe"), o("CO", "1", "Übertrag-Ausgang")],
    build: (b, I, n) => {
      const r = rippleAdder(b, 0, 0, I.A, I.B, I.CI, n);
      return { S: r.sum, CO: r.co };
    },
  },
  {
    name: "sub",
    bits: ALL,
    category: CAT_ARITH,
    title: "Subtrahierer",
    description: "Berechnet D = A − B (Zweierkomplement: A + ¬B + 1). CO=1, wenn kein Borrow auftritt, also A ≥ B vorzeichenlos.",
    pins: [i("A", "N", "Minuend"), i("B", "N", "Subtrahend"), o("D", "N", "Differenz A−B"), o("CO", "1", "1 = kein Borrow (A ≥ B unsigned)")],
    build: (b, I, n) => {
      const nb = b.gate("not", 0, 0, I.B);
      const one = b.constant(0, 4, 1);
      const r = rippleAdder(b, 8, 0, I.A, nb, one, n);
      return { D: r.sum, CO: r.co };
    },
  },
  {
    name: "inc",
    bits: ALL,
    category: CAT_ARITH,
    title: "Inkrementierer",
    description: "Liefert Y = A + 1 (mit Überlauf auf 0). Kette aus Halbaddierern (XOR/AND).",
    pins: [i("A", "N", "Eingangswert"), o("Y", "N", "A + 1")],
    build: (b, I, n) => {
      const one = b.constant(0, 0, 1);
      const r = incCore(b, 6, 0, I.A, one, n);
      return { Y: r.sum };
    },
  },
  {
    name: "cmp",
    bits: ALL,
    category: CAT_ARITH,
    title: "Vergleicher",
    description: "Vergleicht A mit B: EQ (gleich), LT (A < B vorzeichenlos), LTS (A < B vorzeichenbehaftet, Zweierkomplement).",
    pins: [i("A", "N", "Wert A"), i("B", "N", "Wert B"), o("EQ", "1", "A = B"), o("LT", "1", "A < B (unsigned)"), o("LTS", "1", "A < B (signed)")],
    build: (b, I, n) => {
      const nb = b.gate("not", 0, 0, I.B);
      const one = b.constant(0, 4, 1);
      const r = rippleAdder(b, 8, 0, I.A, nb, one, n);
      const y = r.h + 3;
      const lt = b.gate("not", 8, y, r.co);
      const diff = b.gate("xnor", 14, y + 4, r.aBit(n - 1), r.bBit(n - 1));
      const lts = b.gate("xor", 20, y, lt, diff);
      const x = b.gate("xor", 0, y + 10, I.A, I.B);
      const z = zeroCore(b, 8, y + 10, x, n);
      return { EQ: z.z, LT: lt, LTS: lts };
    },
  },
  {
    name: "zero",
    bits: ALL,
    category: CAT_ARITH,
    title: "Null-Detektor",
    description: "Z=1, wenn alle Bits von A gleich 0 sind (ODER-Baum mit Negation).",
    pins: [i("A", "N", "Eingangswert"), o("Z", "1", "1 wenn A = 0")],
    build: (b, I, n) => ({ Z: zeroCore(b, 0, 0, I.A, n).z }),
  },
  {
    name: "alu",
    bits: [8, 32],
    category: CAT_ARITH,
    title: "ALU",
    description:
      "Arithmetisch-logische Einheit. OP: 0 ADD, 1 SUB, 2 AND, 3 OR, 4 XOR, 5 SHL (A << B[4:0]), 6 SHR (A >> B[4:0], logisch), 7 PASSB (Y = B). Z=1 wenn Y=0, NEG = oberstes Bit von Y, CO = Übertrag (Not-Borrow bei SUB) des Addierers/Subtrahierers.",
    pins: [
      i("A", "N", "Operand A"),
      i("B", "N", "Operand B (bei Schiebebefehlen: Schiebeweite in B[4:0])"),
      i("OP", "3", "Operation 0..7"),
      o("Y", "N", "Ergebnis"),
      o("Z", "1", "1 wenn Ergebnis 0"),
      o("NEG", "1", "Oberstes Bit des Ergebnisses"),
      o("CO", "1", "Carry bzw. Not-Borrow (ADD/SUB)"),
    ],
    build: (b, I, n) => {
      const op = selBits(b, 0, 0, I.OP, 3);
      const n1 = b.gate("not", 8, 0, op[1]);
      const n2 = b.gate("not", 8, 4, op[2]);
      const a1 = b.gate("and", 14, 0, op[0], n1);
      const isSub = b.gate("and", 20, 0, a1, n2);

      let y = 14;
      const rsub = b.repl(0, y, isSub, n);
      const xb = b.gate("xor", 6, y, I.B, rsub);
      const add = rippleAdder(b, 12, y, I.A, xb, isSub, n);
      y += Math.max(add.h, rowsOf(n)) + 3;

      const gAnd = b.gate("and", 0, y, I.A, I.B);
      const gOr = b.gate("or", 6, y, I.A, I.B);
      const gXor = b.gate("xor", 12, y, I.A, I.B);
      y += 6;

      const bsp = b.split(0, y, I.B);
      const shs = [0, 1, 2, 3, 4].map((k) => bitOf(bsp, n, k));
      const sh = bshiftCore(b, 8, y, I.A, shs, op[1], n);
      y += Math.max(sh.h, rowsOf(n)) + 3;

      const leaves = [add.sum, add.sum, gAnd, gOr, gXor, sh.out, sh.out, I.B];
      const sel = op;
      const mux = muxTree(b, 0, y, leaves, sel);
      const z = zeroCore(b, mux.w + 4, y, mux.out, n);
      return { Y: mux.out, Z: z.z, NEG: z.bit(n - 1), CO: add.co };
    },
  },
  {
    name: "repl",
    bits: ALL,
    category: CAT_BUS,
    title: "Bit replizieren",
    description: "Kopiert das 1-Bit-Signal A auf alle N Bit des Ausgangs Y (z. B. als Maske für UND-Gatter).",
    pins: [i("A", "1", "Einzelbit"), o("Y", "N", "Alle Bits = A")],
    build: (b, I, n) => ({ Y: n === 1 ? b.gate("buf", 0, 0, I.A) : b.repl(0, 0, I.A, n) }),
  },
  {
    name: "sext",
    bits: [32],
    category: CAT_BUS,
    title: "Vorzeichenerweiterung 16 → 32",
    description: "Erweitert einen 16-Bit-Wert vorzeichenrichtig auf 32 Bit: Die oberen 16 Bit sind Kopien von A[15].",
    pins: [i("A", "16", "16-Bit-Wert"), o("Y", "N", "32-Bit-Wert (vorzeichenerweitert)")],
    build: (b, I, n) => {
      const sp = b.split(0, 0, I.A);
      const bits = Array.from({ length: n }, (_, k) => bitOf(sp, 16, Math.min(k, 15)));
      return { Y: b.join(8, 0, bits) };
    },
  },
  {
    name: "zext",
    bits: [32],
    category: CAT_BUS,
    title: "Nullerweiterung 16 → 32",
    description: "Erweitert einen 16-Bit-Wert mit Nullen auf 32 Bit.",
    pins: [i("A", "16", "16-Bit-Wert"), o("Y", "N", "32-Bit-Wert (obere Hälfte 0)")],
    build: (b, I, n) => {
      const sp = b.split(0, 0, I.A);
      const zero = b.constant(0, 20, 0);
      const bits = Array.from({ length: n }, (_, k) => (k < 16 ? bitOf(sp, 16, k) : zero));
      return { Y: b.join(8, 0, bits) };
    },
  },
  {
    name: "shl1",
    bits: ALL,
    category: CAT_SHIFT,
    title: "Schieben links um 1",
    description: "Y = A << 1: Das oberste Bit fällt weg, unten wird 0 nachgeschoben (entspricht Multiplikation mit 2).",
    pins: [i("A", "N", "Eingangswert"), o("Y", "N", "A um 1 nach links")],
    build: (b, I, n) => {
      const sp = b.split(0, 0, I.A);
      const zero = b.constant(0, rowsOf(n) + 1, 0);
      const bits = Array.from({ length: n }, (_, k) => (k === 0 ? zero : bitOf(sp, n, k - 1)));
      return { Y: b.join(8, 0, bits) };
    },
  },
  {
    name: "shr1",
    bits: ALL,
    category: CAT_SHIFT,
    title: "Schieben rechts um 1",
    description: "Y = A >> 1 (logisch): Das unterste Bit fällt weg, oben wird 0 nachgeschoben.",
    pins: [i("A", "N", "Eingangswert"), o("Y", "N", "A um 1 nach rechts")],
    build: (b, I, n) => {
      const sp = b.split(0, 0, I.A);
      const zero = b.constant(0, rowsOf(n) + 1, 0);
      const bits = Array.from({ length: n }, (_, k) => (k === n - 1 ? zero : bitOf(sp, n, k + 1)));
      return { Y: b.join(8, 0, bits) };
    },
  },
  {
    name: "bshift",
    bits: [8, 32],
    category: CAT_SHIFT,
    title: "Barrel-Shifter",
    description: "Schiebt A in einem Schritt um SH Stellen: DIR=0 nach links, DIR=1 logisch nach rechts. Eine Stufe je Bit von SH (Schiebeweite 1, 2, 4, …).",
    pins: [i("A", "N", "Eingangswert"), i("SH", "log2 N", "Schiebeweite"), i("DIR", "1", "0 = links, 1 = rechts"), o("Y", "N", "Geschobener Wert")],
    build: (b, I, n) => {
      const k = Math.log2(n);
      const sh = selBits(b, 0, 0, I.SH, k);
      const r = bshiftCore(b, 8, 0, I.A, sh, I.DIR, n);
      return { Y: r.out };
    },
  },
  {
    name: "reg",
    bits: ALL,
    category: CAT_MEM,
    title: "Register",
    description: "Speichert D bei steigender Taktflanke, wenn LD=1; sonst bleibt der Wert erhalten. RST=1 löscht das Register. Aufgebaut aus D-Flip-Flop und Multiplexer.",
    pins: [i("D", "N", "Daten"), i("LD", "1", "Laden erlauben"), i("CLK", "1", "Takt"), i("RST", "1", "Reset (löscht)"), o("Q", "N", "Gespeicherter Wert")],
    build: (b, I, n) => {
      const ff = b.reserve("dff", { width: n });
      const q = { comp: ff, port: 0 };
      const cell = mux2(b, 0, 0, q, I.D, I.LD);
      b.place(ff, cell.w + 3, 0);
      b.wire(cell.out, ff, 0);
      b.wire(I.CLK, ff, 1);
      b.wire(I.RST, ff, 2);
      return { Q: q };
    },
  },
  {
    name: "counter",
    bits: ALL,
    category: CAT_MEM,
    title: "Zähler",
    description: "Vorwärtszähler: Bei steigender Taktflanke lädt LD=1 den Wert D (Vorrang), sonst zählt EN=1 um 1 hoch. RST=1 setzt auf 0.",
    pins: [
      i("D", "N", "Ladewert"),
      i("LD", "1", "Parallel laden (Vorrang)"),
      i("EN", "1", "Zählen erlauben"),
      i("CLK", "1", "Takt"),
      i("RST", "1", "Reset (löscht)"),
      o("Q", "N", "Zählerstand"),
    ],
    build: (b, I, n) => {
      const ff = b.reserve("dff", { width: n });
      const q = { comp: ff, port: 0 };
      const one = b.constant(0, 0, 1);
      const inc = incCore(b, 6, 0, q, one, n);
      let x = 6 + inc.w + 3;
      const en = mux2(b, x, 0, q, inc.sum, I.EN);
      x += en.w + 3;
      const ld = mux2(b, x, 0, en.out, I.D, I.LD);
      b.place(ff, x + ld.w + 3, 0);
      b.wire(ld.out, ff, 0);
      b.wire(I.CLK, ff, 1);
      b.wire(I.RST, ff, 2);
      return { Q: q };
    },
  },
  {
    name: "shreg",
    bits: [4, 8],
    category: CAT_MEM,
    title: "Schieberegister",
    description: "Bei steigender Taktflanke und EN=1 wird um eine Stelle nach links geschoben: SI kommt unten hinein, das oberste Bit erscheint an SO. RST=1 löscht.",
    pins: [i("SI", "1", "Serieller Eingang"), i("EN", "1", "Schieben erlauben"), i("CLK", "1", "Takt"), i("RST", "1", "Reset (löscht)"), o("Q", "N", "Parallelausgang"), o("SO", "1", "Serieller Ausgang (höchstes Bit)")],
    build: (b, I, n) => {
      const ff = b.reserve("dff", { width: n });
      const q = { comp: ff, port: 0 };
      const sp = b.split(0, 0, q);
      const shifted = b.join(8, 0, [I.SI, ...Array.from({ length: n - 1 }, (_, k) => bitOf(sp, n, k))]);
      const cell = mux2(b, 14, 0, q, shifted, I.EN);
      b.place(ff, 14 + cell.w + 3, 0);
      b.wire(cell.out, ff, 0);
      b.wire(I.CLK, ff, 1);
      b.wire(I.RST, ff, 2);
      return { Q: q, SO: bitOf(sp, n, n - 1) };
    },
  },
  {
    name: "regfile",
    bits: [8, 32],
    category: CAT_MEM,
    title: "Registerdatei (16 Register)",
    description:
      "16 Register mit zwei unabhängigen, asynchronen Leseports (RA→QA, RB→QB) und einem Schreibport: Bei steigender Taktflanke und WE=1 wird WD in Register WA geschrieben. Gleichzeitiges Lesen desselben Registers liefert bis zur Flanke den alten, danach den neuen Wert.",
    pins: [
      i("RA", "4", "Leseadresse A"),
      i("RB", "4", "Leseadresse B"),
      i("WA", "4", "Schreibadresse"),
      i("WD", "N", "Schreibdaten"),
      i("WE", "1", "Schreiben erlauben"),
      i("CLK", "1", "Takt"),
      o("QA", "N", "Inhalt von Register RA"),
      o("QB", "N", "Inhalt von Register RB"),
    ],
    build: (b, I, n) => {
      const wa = selBits(b, 0, 0, I.WA, 4);
      const dec = decodeCore(b, 8, 0, wa, I.WE);
      const gx = 8 + dec.w + 4;
      const cellH = Math.max(rowsOf(n), 8) + 2;
      const regs: Src[] = [];
      for (let r = 0; r < 16; r++) {
        const x = gx + (r % 4) * 30;
        const y = Math.floor(r / 4) * cellH;
        const ff = b.reserve("dff", { width: n });
        const q = { comp: ff, port: 0 };
        const cell = mux2(b, x, y, q, I.WD, dec.outs[r]);
        b.place(ff, x + cell.w + 2, y);
        b.wire(cell.out, ff, 0);
        b.wire(I.CLK, ff, 1);
        regs.push(q);
      }
      const tx = gx + 4 * 30 + 4;
      const ra = selBits(b, tx, 0, I.RA, 4);
      const ta = muxTree(b, tx + 8, 0, regs, ra);
      const y2 = ta.h + 4;
      const rb = selBits(b, tx, y2, I.RB, 4);
      const tb = muxTree(b, tx + 8, y2, regs, rb);
      return { QA: ta.out, QB: tb.out };
    },
  },
  {
    name: "srlatch",
    category: CAT_TEACH,
    title: "SR-Latch",
    description:
      "Setzt (S=1) oder löscht (R=1) einen gespeicherten Wert; ohne Eingabe bleibt er erhalten. S und R gleichzeitig: Setzen hat Vorrang. Der Simulator erlaubt keine rückgekoppelten NOR-Gatter, daher steckt ein D-Latch (Freigabe = S oder R) darin.",
    pins: [i("S", "1", "Set"), i("R", "1", "Reset"), o("Q", "1", "Gespeicherter Wert"), o("QN", "1", "Invertierter Wert")],
    build: (b, I) => {
      const en = b.gate("or", 0, 0, I.S, I.R);
      const l = b.add("latch", 6, 0);
      b.wire(I.S, l, 0);
      b.wire(en, l, 1);
      return { Q: { comp: l, port: 0 }, QN: { comp: l, port: 1 } };
    },
  },
  {
    name: "dlatch_g",
    category: CAT_TEACH,
    title: "Gated D-Latch",
    description: "Transparent, solange EN=1: Q folgt D. Bei EN=0 bleibt der letzte Wert gespeichert. Die Steuerung D/EN wird zuerst über NAND-Gatter in Set-/Reset-Signale umgesetzt.",
    pins: [i("D", "1", "Daten"), i("EN", "1", "Freigabe"), o("Q", "1", "Gespeicherter Wert"), o("QN", "1", "Invertierter Wert")],
    build: (b, I) => {
      const nd = b.gate("not", 0, 0, I.D);
      const sn = b.gate("nand", 6, 0, I.D, I.EN);
      const rn = b.gate("nand", 6, 4, nd, I.EN);
      const s = b.gate("not", 12, 0, sn);
      const en = b.gate("nand", 12, 4, sn, rn);
      const l = b.add("latch", 18, 0);
      b.wire(s, l, 0);
      b.wire(en, l, 1);
      return { Q: { comp: l, port: 0 }, QN: { comp: l, port: 1 } };
    },
  },
  {
    name: "dff_ms",
    category: CAT_TEACH,
    title: "Master-Slave-Flip-Flop",
    description: "Zwei D-Latches hintereinander: Der Master ist bei CLK=0 offen, der Slave bei CLK=1. Dadurch übernimmt Q den Wert D nur an der steigenden Taktflanke.",
    pins: [i("D", "1", "Daten"), i("CLK", "1", "Takt"), o("Q", "1", "Gespeicherter Wert"), o("QN", "1", "Invertierter Wert")],
    build: (b, I) => {
      const nclk = b.gate("not", 0, 0, I.CLK);
      const m = b.add("latch", 8, 0);
      b.wire(I.D, m, 0);
      b.wire(nclk, m, 1);
      const s = b.add("latch", 16, 0);
      b.wire({ comp: m, port: 0 }, s, 0);
      b.wire(I.CLK, s, 1);
      return { Q: { comp: s, port: 0 }, QN: { comp: s, port: 1 } };
    },
  },
  {
    name: "tff",
    category: CAT_TEACH,
    title: "T-Flip-Flop (Taktteiler)",
    description: "Kippt bei jeder steigenden Taktflanke seinen Ausgang: Q hat die halbe Taktfrequenz. RST=1 setzt Q auf 0. Ein D-Flip-Flop, dessen invertierter Ausgang auf D zurückgeführt ist.",
    pins: [i("CLK", "1", "Takt"), i("RST", "1", "Reset (löscht)"), o("Q", "1", "Ausgang (halbe Frequenz)")],
    build: (b, I) => {
      const ff = b.add("dff", 0, 0);
      b.wire({ comp: ff, port: 1 }, ff, 0);
      b.wire(I.CLK, ff, 1);
      b.wire(I.RST, ff, 2);
      return { Q: { comp: ff, port: 0 } };
    },
  },
  {
    name: "seg7",
    category: CAT_DISP,
    title: "7-Segment-Dekoder",
    description: "Wandelt eine Hex-Ziffer A (0..F) in die sieben Segmentsignale a–g um (1 = Segment leuchtet).",
    pins: [
      i("A", "4", "Hex-Ziffer 0..15"),
      ...["a", "b", "c", "d", "e", "f", "g"].map((s) => o(s, "1", `Segment ${s}`)),
    ],
    build: (b, I) => {
      const bits = selBits(b, 0, 0, I.A, 4);
      const d = decodeCore(b, 8, 0, bits, null);
      const out: Record<string, Src> = {};
      let y = 0;
      for (const [seg, list] of Object.entries(SEG7)) {
        out[seg] = reduce(b, "or", d.w + 12, y, list.map((v) => d.outs[v]));
        y += list.length * 4 + 2;
      }
      return out;
    },
  },
];

/* ---------- API ---------- */

export interface StdCatalogEntry {
  name: string;
  bits?: number[];
  category: string;
  title: string;
  description: string;
  pins: PinSpec[];
}

export const STD_CATALOG: StdCatalogEntry[] = SPECS.map((s) => ({
  name: s.name,
  bits: s.bits,
  category: s.category,
  title: s.title,
  description: s.description,
  pins: s.pins,
}));

export function stdModuleId(name: string, bits?: number): string {
  return bits === undefined ? `std-${name}` : `std-${name}-${bits}`;
}

function specFor(name: string, bits?: number): Spec {
  const spec = SPECS.find((s) => s.name === name);
  if (!spec) throw new Error(`Unbekanntes Standardmodul: ${name}`);
  if (spec.bits ? bits === undefined || !spec.bits.includes(bits) : bits !== undefined) {
    throw new Error(`Standardmodul ${name}: Breite ${bits} nicht verfügbar`);
  }
  return spec;
}

function pinWidth(w: string, bits: number): number {
  if (w === "N" || w === "k") return bits;
  if (w === "2^k") return 1 << bits;
  if (w === "log2 N") return Math.log2(bits);
  return Number(w);
}

function buildStd(spec: Spec, bits?: number): ModuleDef {
  const n = bits ?? 1;
  const b = new B();
  const I: Record<string, Src> = {};
  for (const p of spec.pins.filter((p) => p.dir === "in")) I[p.name] = b.input(p.name, pinWidth(p.width, n));
  const outs = spec.build(b, I, n);
  for (const p of spec.pins.filter((p) => p.dir === "out")) {
    if (!outs[p.name]) throw new Error(`Standardmodul ${spec.name}: Ausgang ${p.name} fehlt`);
    b.output(p.name, pinWidth(p.width, n), outs[p.name]);
  }
  b.c.rebuild();
  const base = spec.label ? spec.label(bits) : spec.name.toUpperCase();
  const name = spec.label || bits === undefined ? base : `${base} ${bits}`;
  const def = buildModuleDef(b.c, [...b.c.comps.keys()], name, { cols: 8 }, { id: stdModuleId(spec.name, bits) });
  if (!def) throw new Error(`Standardmodul ${spec.name}: leer`);
  def.description = spec.description;
  def.category = spec.category;
  def.builtin = true;
  def.pinDocs = Object.fromEntries(spec.pins.map((p) => [p.name, p.doc]));
  return def;
}

/** Liefert (und registriert) ein Standardmodul; vom Nutzer bearbeitete Versionen bleiben erhalten. */
export function stdModule(name: string, bits?: number): ModuleDef {
  const spec = specFor(name, bits);
  const existing = getModule(stdModuleId(name, bits));
  if (existing && (existing.builtin || (existing.version ?? 1) > 1)) return existing;
  const def = buildStd(spec, bits);
  addModule(def);
  return def;
}

/** Legt alle Standardmodule in der Bibliothek an (idempotent). */
export function ensureStdModules(): void {
  for (const s of SPECS) {
    if (s.bits) s.bits.forEach((n) => stdModule(s.name, n));
    else stdModule(s.name);
  }
}

export function placeStd(
  c: Circuit,
  name: string,
  bits: number | undefined,
  gx: number,
  gy: number
): {
  group: GroupInstance;
  inp(name: string): { comp: Comp; port: 0 };
  out(name: string): { comp: Comp; port: 0 };
} {
  const group = instantiateModule(c, stdModule(name, bits), gx, gy);
  const pin = (list: GroupInstance["inputs"], pinName: string) => {
    const p = list.find((q) => q.name === pinName);
    const comp = p && c.comps.get(p.compId);
    if (!comp) throw new Error(`Standardmodul ${name}: Pin ${pinName} unbekannt`);
    return { comp, port: 0 as const };
  };
  return { group, inp: (n) => pin(group.inputs, n), out: (n) => pin(group.outputs, n) };
}
