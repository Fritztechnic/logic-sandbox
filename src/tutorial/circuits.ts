import { Comp } from "../types";
import { Rig, Src, o } from "./rig";

/* Alle Schaltungen des Tutorials. Gebaut wird ausschließlich mit den echten Bauteilen
   der Sandbox (Gatter, Splitter, Joiner, D-Flip-Flop, ROM/RAM …) – nichts ist gefälscht. */

type S = Src | Comp;
const src = (s: S): Src => ("c" in s ? s : o(s));

/** Bits eines Splitters, niederwertigstes Bit zuerst. */
export function bitsOf(split: Comp, n: number): Src[] {
  return Array.from({ length: n }, (_, i) => o(split, n - 1 - i));
}

/** Fügt Einzelbits (LSB zuerst) zu einem Bus zusammen. */
export function joinBits(r: Rig, x: number, y: number, bits: S[], opts: Partial<Comp> & { name?: string } = {}): Comp {
  const n = bits.length;
  const j = r.add("joiner", x, y, { width: n, ...opts });
  bits.forEach((b, i) => r.link(src(b), j, n - 1 - i));
  return j;
}

/** Ein Bit auf n Leitungen vervielfachen (Maske für Busbreite). */
export function mask(r: Rig, x: number, y: number, bit: S, n: number): Comp {
  return joinBits(r, x, y, new Array(n).fill(bit));
}

export function halfAdder(r: Rig, x: number, y: number, a: S, b: S) {
  const xr = r.gate("xor", x, y, a, b);
  const an = r.gate("and", x, y + 3, a, b);
  return { sum: o(xr), carry: o(an), xor: xr, and: an };
}

/** Kompakter 1-Bit-Volladdierer (16 × 6 Zellen) aus 5 Gattern. */
export function fullAdder(r: Rig, bx: number, by: number, a: S, b: S, cin: S) {
  const x1 = r.gate("xor", bx, by, a, b);
  const a1 = r.gate("and", bx, by + 3, a, b);
  const x2 = r.gate("xor", bx + 6, by, x1, cin);
  const a2 = r.gate("and", bx + 6, by + 3, x1, cin);
  const o1 = r.gate("or", bx + 12, by + 3, a1, a2);
  return { sum: o(x2), cout: o(o1) };
}

/** Ripple-Carry-Addierer; die Volladdierer laufen im Zickzack (perRow pro Zeile). */
export function ripple(r: Rig, x0: number, y0: number, a: S[], b: S[], cin: S, perRow = 2, dx = 20, dy = 10) {
  const sums: Src[] = [];
  let carry = src(cin);
  for (let i = 0; i < a.length; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const bx = x0 + (row % 2 === 0 ? col : perRow - 1 - col) * dx;
    const fa = fullAdder(r, bx, y0 + row * dy, a[i], b[i], carry);
    sums.push(fa.sum);
    carry = fa.cout;
  }
  return { sums, cout: carry };
}

/* ---------- Kapitel 0 ---------- */

export function lampDemo(): Rig {
  const r = new Rig();
  const a = r.add("input", 0, 0, { name: "A", label: "A" });
  const b = r.add("input", 0, 4, { name: "B", label: "B" });
  const g = r.gate("and", 8, 1, a, b);
  const l = r.add("output", 16, 1, { name: "L", label: "Lampe" });
  r.link(g, l, 0);
  return r.done();
}

export function numberDemo(): Rig {
  const r = new Rig();
  const z = r.add("input", 0, 0, { name: "ZAHL", label: "ZAHL", width: 8, value: 0 });
  const l = r.add("output", 8, 0, { name: "LEDS", label: "LEDs", width: 8, format: "bin" });
  r.link(z, l, 0);
  return r.done();
}

/* ---------- Kapitel 1: Gatter ---------- */

export const GATE_KINDS = ["and", "or", "nand", "nor", "xor", "xnor"] as const;

export function gateLab(): Rig {
  const r = new Rig();
  const a = r.add("input", 0, 6, { name: "A", label: "A" });
  const b = r.add("input", 0, 10, { name: "B", label: "B" });
  GATE_KINDS.forEach((k, i) => {
    const g = r.gate(k, 10, i * 4, a, b);
    const out = r.add("output", 18, i * 4, { name: k.toUpperCase(), label: k.toUpperCase() });
    r.link(g, out, 0);
  });
  return r.done();
}

export function nandUniversal(): Rig {
  const r = new Rig();
  const a = r.add("input", 0, 4, { name: "A", label: "A" });
  const b = r.add("input", 0, 12, { name: "B", label: "B" });

  const not = r.gate("nand", 8, 0, a, a, { label: "NAND" });
  r.link(not, r.add("output", 16, 0, { name: "NOT", label: "NOT A" }), 0);
  r.region(7, -1, 12, 5, "NOT aus 1 NAND");

  const n1 = r.gate("nand", 8, 7, a, b);
  const and = r.gate("nand", 14, 7, n1, n1);
  r.link(and, r.add("output", 22, 7, { name: "AND", label: "A AND B" }), 0);
  r.region(7, 6, 18, 5, "AND aus 2 NAND");

  const na = r.gate("nand", 8, 14, a, a);
  const nb = r.gate("nand", 8, 18, b, b);
  const or = r.gate("nand", 14, 16, na, nb);
  r.link(or, r.add("output", 22, 16, { name: "OR", label: "A OR B" }), 0);
  r.region(7, 13, 18, 9, "OR aus 3 NAND");
  return r.done();
}

/* ---------- Kapitel 2 + 3: Addierer ---------- */

export function halfAdderDemo(): Rig {
  const r = new Rig();
  const a = r.add("input", 0, 0, { name: "A", label: "A" });
  const b = r.add("input", 0, 5, { name: "B", label: "B" });
  const ha = halfAdder(r, 10, 1, a, b);
  r.link(ha.sum, r.add("output", 18, 1, { name: "S", label: "Summe S" }), 0);
  r.link(ha.carry, r.add("output", 18, 4, { name: "C", label: "Übertrag" }), 0);
  return r.done();
}

export function fullAdderDemo(): Rig {
  const r = new Rig();
  const a = r.add("input", 0, 0, { name: "A", label: "A" });
  const b = r.add("input", 0, 4, { name: "B", label: "B" });
  const cin = r.add("input", 0, 8, { name: "CIN", label: "Cin" });
  const fa = fullAdder(r, 8, 0, a, b, cin);
  r.link(fa.sum, r.add("output", 26, 0, { name: "S", label: "Summe S" }), 0);
  r.link(fa.cout, r.add("output", 26, 4, { name: "COUT", label: "Cout" }), 0);
  r.region(7, -1, 18, 8, "Volladdierer = 2 Halbaddierer + OR");
  return r.done();
}

/** 4-Bit-Ripple-Carry-Addierer. */
export function adder4(): Rig {
  const r = new Rig();
  const A = r.add("input", 0, 0, { name: "A", label: "A", width: 4, value: 0b0101 });
  const B = r.add("input", 0, 7, { name: "B", label: "B", width: 4, value: 0b0011 });
  const cin = r.add("input", 0, 14, { name: "CIN", label: "Cin" });
  const sa = r.add("splitter", 5, 0, { width: 4 });
  const sb = r.add("splitter", 5, 7, { width: 4 });
  r.link(A, sa, 0);
  r.link(B, sb, 0);
  const add = ripple(r, 12, 0, bitsOf(sa, 4), bitsOf(sb, 4), cin);
  const j = joinBits(r, 54, 0, add.sums);
  r.link(j, r.add("output", 59, 0, { name: "SUM", label: "SUMME", width: 4, format: "dec" }), 0);
  r.link(add.cout, r.add("output", 59, 8, { name: "COUT", label: "Cout" }), 0);
  r.region(11, -1, 40, 5.5, "Bit 0 → Bit 1");
  r.region(11, 9, 40, 5.5, "Bit 2 ← Bit 3 (Übertrag läuft zurück)");
  return r.done();
}

/* ---------- Kapitel 5: Subtrahieren ---------- */

/** 4-Bit-Addierer/Subtrahierer mit Flags. */
export function addSub4(): Rig {
  const r = new Rig();
  const A = r.add("input", 0, 0, { name: "A", label: "A", width: 4, value: 7 });
  const B = r.add("input", 0, 7, { name: "B", label: "B", width: 4, value: 3 });
  const sub = r.add("input", 0, 14, { name: "SUB", label: "SUB" });
  const sa = r.add("splitter", 5, 0, { width: 4 });
  const sb = r.add("splitter", 5, 7, { width: 4 });
  r.link(A, sa, 0);
  r.link(B, sb, 0);
  const bs = bitsOf(sb, 4);
  const bx = bs.map((b, i) => o(r.gate("xor", 12, i * 4, b, sub, { label: "XOR" })));
  r.region(11, -1, 6, 17, "B ⊕ SUB");
  const add = ripple(r, 20, 0, bitsOf(sa, 4), bx, sub);
  const j = joinBits(r, 62, 0, add.sums);
  r.link(j, r.add("output", 67, 0, { name: "ERG", label: "ERGEBNIS", width: 4, format: "dec" }), 0);
  r.link(add.cout, r.add("output", 67, 8, { name: "C", label: "Carry" }), 0);

  const sr = r.add("splitter", 62, 10, { width: 4 });
  r.link(j, sr, 0);
  const rb = bitsOf(sr, 4);
  r.link(rb[3], r.add("output", 67, 12, { name: "N", label: "Negativ" }), 0);
  const o01 = r.gate("or", 70, 10, rb[0], rb[1]);
  const o23 = r.gate("or", 70, 14, rb[2], rb[3]);
  const oAll = r.gate("or", 76, 12, o01, o23);
  const z = r.gate("not", 82, 12, oAll);
  r.link(z, r.add("output", 88, 12, { name: "Z", label: "Zero" }), 0);
  r.region(19, -1, 40, 17, "Addierer (Cin = SUB)");
  r.region(69, 9, 24, 9, "Zero = NOR aller Bits");
  return r.done();
}

/* ---------- Kapitel 6: Multiplexer + ALU ---------- */

export function mux1(): Rig {
  const r = new Rig();
  const a = r.add("input", 0, 0, { name: "A", label: "A" });
  const b = r.add("input", 0, 5, { name: "B", label: "B" });
  const s = r.add("input", 0, 10, { name: "S", label: "S" });
  const ns = r.gate("not", 8, 10, s);
  const a1 = r.gate("and", 16, 0, a, ns);
  const a2 = r.gate("and", 16, 5, b, s);
  const y = r.gate("or", 24, 2, a1, a2);
  r.link(y, r.add("output", 32, 2, { name: "Y", label: "Y" }), 0);
  return r.done();
}

/** 4-Bit-Multiplexer mit Masken-Trick: ein Wahlbit wird auf alle Bitleitungen verteilt. */
export function mux4(): Rig {
  const r = new Rig();
  const A = r.add("input", 0, 0, { name: "A", label: "A", width: 4, value: 0b1010 });
  const B = r.add("input", 0, 6, { name: "B", label: "B", width: 4, value: 0b0110 });
  const s = r.add("input", 0, 12, { name: "S", label: "S" });
  const ns = r.gate("not", 8, 12, s);
  const mB = mask(r, 14, 8, s, 4);
  const mA = mask(r, 14, 15, ns, 4);
  const andA = r.gate("and", 22, 0, A, mA, { width: 4 });
  const andB = r.gate("and", 22, 6, B, mB, { width: 4 });
  const y = r.gate("or", 30, 3, andA, andB, { width: 4 });
  r.link(y, r.add("output", 38, 3, { name: "Y", label: "Y", width: 4, format: "dec" }), 0);
  return r.done();
}

/** Logikeinheit: Auswahl per 2-Bit-Code über Masken (AND / OR / XOR / NOT A). */
export function logicUnit(): Rig {
  const r = new Rig();
  const A = r.add("input", 0, 0, { name: "A", label: "A", width: 4, value: 0b1100 });
  const B = r.add("input", 0, 6, { name: "B", label: "B", width: 4, value: 0b1010 });
  const sel = r.add("input", 0, 14, { name: "SEL", label: "SEL", width: 2 });
  const ss = r.add("splitter", 5, 14, { width: 2 });
  r.link(sel, ss, 0);
  const s1 = o(ss, 0);
  const s0 = o(ss, 1);
  const n1 = o(r.gate("not", 12, 14, s1));
  const n0 = o(r.gate("not", 12, 18, s0));
  const lit = [
    [n1, n0],
    [n1, s0],
    [s1, n0],
    [s1, s0],
  ];
  const res = [
    r.gate("and", 18, 0, A, B, { width: 4 }),
    r.gate("or", 18, 6, A, B, { width: 4 }),
    r.gate("xor", 18, 12, A, B, { width: 4 }),
    r.gate("not", 18, 18, A, undefined, { width: 4 }),
  ];
  const picks = res.map((g, k) => {
    const sel1 = r.gate("and", 24, 0 + k * 7 + 5, lit[k][0], lit[k][1]);
    const m = mask(r, 30, k * 7, sel1, 4);
    return r.gate("and", 36, k * 7, g, m, { width: 4 });
  });
  const o1 = r.gate("or", 42, 2, picks[0], picks[1], { width: 4 });
  const o2 = r.gate("or", 42, 16, picks[2], picks[3], { width: 4 });
  const o3 = r.gate("or", 48, 10, o1, o2, { width: 4 });
  r.link(o3, r.add("output", 54, 10, { name: "Y", label: "Y", width: 4, format: "dec" }), 0);
  r.region(23, -1, 6, 31, "Decoder");
  r.region(29, -1, 5, 31, "Masken");
  r.region(35, -1, 5, 31, "Auswahl");
  return r.done();
}

export const ALU_MODES = ["HALTEN (F = A)", "ADD", "SUB", "AND", "OR", "XOR", "DURCH (F = B)", "NULL"];

/** Referenzfunktion der ALU (n Bit) – gleich zu buildAlu() in cpu.ts. */
export function aluRef(n: number, mode: number, en: number, a: number, b: number): number {
  const m = (1 << n) - 1;
  if (!en || mode === 0) return a & m;
  switch (mode) {
    case 1:
      return (a + b) & m;
    case 2:
      return (a - b) & m;
    case 3:
      return a & b & m;
    case 4:
      return (a | b) & m;
    case 5:
      return (a ^ b) & m;
    case 6:
      return b & m;
    default:
      return 0;
  }
}

/**
 * ALU mit derselben Struktur wie buildAlu() in cpu.ts, hier mit 4 Bit:
 * Moduscode → Decoder (NOT + 2 AND je Modus) → Freigabe mit EN → Addierer mit
 * XOR-Invertierung von B → Logikgatter auf dem ganzen Bus → Masken → ODER-Sammler.
 */
export function alu4(): Rig {
  const n = 4;
  const r = new Rig();
  const A = r.add("input", 0, 0, { name: "A", label: "A", width: n, value: 7 });
  const B = r.add("input", 0, 8, { name: "B", label: "B", width: n, value: 3 });
  const M = r.add("input", 0, 24, { name: "MODE", label: "MODUS", width: 3, value: 1 });
  const E = r.add("input", 0, 30, { name: "EN", label: "EN", value: 1 });
  const aS = r.add("splitter", 6, 0, { width: n });
  const bS = r.add("splitter", 6, 8, { width: n });
  const mS = r.add("splitter", 6, 22, { width: 3 });
  r.link(A, aS, 0);
  r.link(B, bS, 0);
  r.link(M, mS, 0);
  const m = [o(mS, 2), o(mS, 1), o(mS, 0)];
  const nm = [0, 1, 2].map((i) => o(r.gate("not", 12, 20 + i * 3, m[i])));
  const term = (op: number): Src => {
    const lit = (i: number) => ((op >> i) & 1 ? m[i] : nm[i]);
    const g1 = r.gate("and", 18, 18 + op * 4, lit(0), lit(1));
    return o(r.gate("and", 24, 18 + op * 4, g1, lit(2)));
  };
  const tHold = term(0);
  const tAdd = term(1);
  const tSub = term(2);
  const tAnd = term(3);
  const tOr = term(4);
  const tXor = term(5);
  const tPass = term(6);
  r.region(11, 17, 18, 30, "① Decoder: Modus → eine Leitung");

  const notE = r.gate("not", 32, 12, E);
  const gate = (s: Src, k: number) => o(r.gate("and", 32, 18 + k * 4, s, E));
  const mHold = o(r.gate("or", 32, 18, tHold, notE));
  const gAdd = gate(tAdd, 1);
  const gSub = gate(tSub, 2);
  const gAnd = gate(tAnd, 3);
  const gOr = gate(tOr, 4);
  const gXor = gate(tXor, 5);
  const gPass = gate(tPass, 6);
  const sumOp = o(r.gate("or", 38, 22, gAdd, gSub));
  r.region(31, 11, 11, 36, "② Freigabe (EN)");

  const bs = bitsOf(bS, n);
  const bx = bs.map((b, i) => o(r.gate("xor", 46, i * 4, b, gSub)));
  r.region(45, -1, 6, 17, "③ B ⊕ SUB");
  const add = ripple(r, 54, 0, bitsOf(aS, n), bx, gSub);
  const sumJoin = joinBits(r, 96, 0, add.sums);
  r.region(53, -1, 40, 17, "③ Addierer (Cin = SUB)");

  const andRes = r.gate("and", 62, 20, A, B, { width: n });
  const orRes = r.gate("or", 62, 24, A, B, { width: n });
  const xorRes = r.gate("xor", 62, 28, A, B, { width: n });
  r.region(61, 19, 7, 13, "④ Logik");

  const masks = [mHold, gPass, sumOp, gAnd, gOr, gXor].map((s, k) =>
    mask(r, 72 + (k % 2) * 5, 20 + k * 3, s, n)
  );
  r.region(71, 19, 11, 21, "⑤ Masken");
  const data: S[] = [A, B, sumJoin, andRes, orRes, xorRes];
  const contrib = data.map((d, k) => o(r.gate("and", 100, 20 + k * 4, d, masks[k], { width: n })));
  const l1a = r.gate("or", 106, 20, contrib[0], contrib[1], { width: n });
  const l1b = r.gate("or", 106, 28, contrib[2], contrib[3], { width: n });
  const l1c = r.gate("or", 106, 36, contrib[4], contrib[5], { width: n });
  const l2 = r.gate("or", 112, 24, l1a, l1b, { width: n });
  const l3 = r.gate("or", 118, 30, l2, l1c, { width: n });
  r.link(l3, r.add("output", 124, 30, { name: "F", label: "F", width: n, format: "dec" }), 0);
  r.region(99, 19, 24, 22, "⑥ ODER-Sammler");
  return r.done();
}

/* ---------- Kapitel 7: Speichern ---------- */

export function latchDemo(): Rig {
  const r = new Rig();
  const d = r.add("input", 0, 0, { name: "D", label: "D" });
  const en = r.add("input", 0, 4, { name: "EN", label: "EN" });
  const l = r.add("latch", 8, 1);
  r.link(d, l, 0);
  r.link(en, l, 1);
  r.link(o(l, 0), r.add("output", 16, 1, { name: "Q", label: "Q" }), 0);
  r.link(o(l, 1), r.add("output", 16, 4, { name: "QN", label: "Q̄" }), 0);
  return r.done();
}

export function flipFlopDemo(): Rig {
  const r = new Rig();
  const d = r.add("input", 0, 0, { name: "D", label: "D" });
  const clk = r.add("clock", 0, 6, { name: "CLK", label: "TAKT", div: 1 });
  const f = r.add("dff", 8, 1, { name: "FF" });
  r.link(d, f, 0);
  r.link(clk, f, 1);
  r.link(o(f, 0), r.add("output", 16, 1, { name: "Q", label: "Q" }), 0);
  r.link(o(f, 1), r.add("output", 16, 4, { name: "QN", label: "Q̄" }), 0);
  return r.done();
}

/** 8-Bit-Register mit Load-Enable: D = LADEN ? DATEN : Q (Mux-Rückkopplung). */
export function register8(): Rig {
  const r = new Rig();
  const d = r.add("input", 0, 0, { name: "DATA", label: "DATEN", width: 8, value: 0 });
  const ld = r.add("input", 0, 6, { name: "LOAD", label: "LADEN" });
  const clk = r.add("clock", 0, 10, { name: "CLK", label: "TAKT", div: 1 });
  const nl = r.gate("not", 8, 6, ld);
  const mOn = mask(r, 14, 3, ld, 8);
  const mOff = mask(r, 14, 13, nl, 8);
  const reg = r.add("dff", 38, 6, { name: "REG", width: 8, label: "REGISTER", format: "dec" });
  const andOn = r.gate("and", 22, 0, d, mOn, { width: 8 });
  const andOff = r.gate("and", 22, 12, o(reg, 0), mOff, { width: 8 });
  const or = r.gate("or", 30, 6, andOn, andOff, { width: 8 });
  r.link(or, reg, 0);
  r.link(clk, reg, 1);
  r.link(o(reg, 0), r.add("output", 46, 6, { name: "Q", label: "Q", width: 8, format: "dec" }), 0);
  r.region(13, -1, 27, 24, "Mux: neu laden oder alten Wert behalten");
  return r.done();
}

/* ---------- Kapitel 8: Zähler und Programmzähler ---------- */

export function counter4(): Rig {
  const r = new Rig();
  const clk = r.add("clock", 0, 0, { name: "CLK", label: "TAKT", div: 1 });
  const rst = r.add("input", 0, 14, { name: "RST", label: "RESET" });
  const ffs: Comp[] = [];
  let carry: Src | null = null;
  for (let i = 0; i < 4; i++) {
    const ff = r.add("dff", 12 + i * 14, 8, { label: `Q${i}` });
    ffs.push(ff);
    r.link(clk, ff, 1);
    r.link(rst, ff, 2);
    if (i === 0) {
      r.link(o(ff, 1), ff, 0);
      carry = o(ff, 0);
      continue;
    }
    const x = r.gate("xor", 10 + i * 14, 0, o(ff, 0), carry!);
    r.link(x, ff, 0);
    if (i < 3) carry = o(r.gate("and", 10 + i * 14, 4, carry!, o(ff, 0)));
  }
  const j = joinBits(r, 70, 8, ffs.map((f) => o(f, 0)));
  r.link(j, r.add("output", 75, 8, { name: "Q", label: "ZÄHLER", width: 4, format: "dec" }), 0);
  return r.done();
}

/** Programmzähler (4 Bit) mit derselben Struktur wie buildPc() in cpu.ts. */
export function pc4(): Rig {
  const n = 4;
  const r = new Rig();
  const Z = r.add("input", 0, 0, { name: "ZIEL", label: "ZIEL", width: n, value: 3 });
  const J = r.add("input", 0, 6, { name: "JUMP", label: "SPRUNG" });
  const H = r.add("input", 0, 10, { name: "HALT", label: "HALT" });
  const clk = r.add("clock", 0, 14, { name: "CLK", label: "TAKT", div: 1 });
  const rst = r.add("input", 0, 18, { name: "RST", label: "RESET" });
  const zS = r.add("splitter", 6, 0, { width: n });
  r.link(Z, zS, 0);
  const nJ = r.gate("not", 8, 7, J);
  const nH = r.gate("not", 8, 11, H);

  const pc = r.add("dff", 90, 0, { name: "PC", width: n, label: "PC", format: "dec" });
  const pS = r.add("splitter", 90, 6, { width: n });
  r.link(o(pc, 0), pS, 0);
  const pb = bitsOf(pS, n);
  const zb = bitsOf(zS, n);

  const aBits = pb.map((b, i) => o(r.gate("and", 22, i * 4, b, nJ)));
  const b0a = r.gate("and", 30, 0, zb[0], J);
  const b0b = r.gate("and", 30, 4, nJ, nH);
  const bBits: Src[] = [o(r.gate("or", 36, 2, b0a, b0b))];
  for (let i = 1; i < n; i++) bBits.push(o(r.gate("and", 30, 4 + i * 4, zb[i], J)));
  const zero = r.add("const", 36, 10, { label: "0", value: 0 });
  const add = ripple(r, 44, 0, aBits, bBits, zero);
  const j = joinBits(r, 84, 0, add.sums);
  r.link(j, pc, 0);
  r.link(clk, pc, 1);
  r.link(rst, pc, 2);
  r.link(o(pc, 0), r.add("output", 98, 0, { name: "OUT", label: "PC", width: n, format: "dec" }), 0);
  r.region(21, -1, 6, 17, "pc AND ¬Sprung");
  r.region(29, -1, 12, 22, "Ziel AND Sprung · +1 wenn weder Sprung noch Halt");
  return r.done();
}

/* ---------- Kapitel 9: Speicher ---------- */

export function decoder2(): Rig {
  const r = new Rig();
  const a1 = r.add("input", 0, 0, { name: "A1", label: "A1" });
  const a0 = r.add("input", 0, 4, { name: "A0", label: "A0" });
  const n1 = o(r.gate("not", 8, 0, a1));
  const n0 = o(r.gate("not", 8, 4, a0));
  const lit = [
    [n1, n0],
    [n1, o(a0)],
    [o(a1), n0],
    [o(a1), o(a0)],
  ];
  lit.forEach((l, w) => {
    const g = r.gate("and", 18, w * 4, l[0], l[1]);
    r.link(g, r.add("output", 26, w * 4, { name: `W${w}`, label: `Wort ${w}` }), 0);
  });
  return r.done();
}

export const ROM_DEMO_DATA = [0x48, 0x41, 0x4c, 0x4c, 0x4f, 0x21, 0x2a, 0x00];

export function romDemo(): Rig {
  const r = new Rig();
  const a = r.add("input", 0, 0, { name: "ADR", label: "ADRESSE", width: 3, value: 0 });
  const rom = r.add("rom", 8, 0, { name: "ROM", label: "ROM", addrWidth: 3, dataWidth: 8, data: [...ROM_DEMO_DATA] });
  r.link(a, rom, 0);
  r.link(rom, r.add("output", 16, 0, { name: "DATA", label: "DATEN", width: 8, format: "hex" }), 0);
  return r.done();
}

export function ramDemo(): Rig {
  const r = new Rig();
  const a = r.add("input", 0, 0, { name: "ADR", label: "ADRESSE", width: 4, value: 0 });
  const d = r.add("input", 0, 4, { name: "DIN", label: "DIN", width: 8, value: 0 });
  const we = r.add("input", 0, 8, { name: "WE", label: "WE" });
  const clk = r.add("clock", 0, 12, { name: "CLK", label: "TAKT", div: 1 });
  const ram = r.add("ram", 8, 0, { name: "RAM", label: "RAM", addrWidth: 4, dataWidth: 8, data: new Array(16).fill(0) });
  r.link(a, ram, 0);
  r.link(d, ram, 1);
  r.link(we, ram, 2);
  r.link(clk, ram, 3);
  r.link(ram, r.add("output", 16, 0, { name: "DOUT", label: "DOUT", width: 8, format: "hex" }), 0);
  return r.done();
}

/* ---------- Kapitel 10: Steuerwerk ---------- */

export function ctrlDemo(ctrlRom: number[]): Rig {
  const r = new Rig();
  const op = r.add("input", 0, 0, { name: "OP", label: "OPCODE", width: 8, value: 0x04 });
  const rom = r.add("rom", 8, 0, { name: "ROM", label: "STEUER-ROM", addrWidth: 8, dataWidth: 16, data: [...ctrlRom] });
  r.link(op, rom, 0);
  const sp = r.add("splitter", 16, 0, { width: 16 });
  r.link(rom, sp, 0);
  const lines = [
    ["HLT", 10],
    ["JNZ", 9],
    ["JZ", 8],
    ["JMP", 7],
    ["OUT", 6],
    ["WE", 5],
    ["MEM", 4],
    ["EN", 3],
  ] as const;
  lines.forEach(([name, bit], i) => {
    r.link(o(sp, 15 - bit), r.add("output", 24, i * 2, { name, label: name }), 0);
  });
  const mode = joinBits(r, 24, 17, [o(sp, 15), o(sp, 14), o(sp, 13)]);
  r.link(mode, r.add("output", 30, 17, { name: "MODE", label: "MODUS", width: 3, format: "dec" }), 0);
  return r.done();
}
