import { OP, ROM_WORDS, encodeI, encodeR } from "./cpu32-ref";

export interface Asm32Error {
  line: number;
  message: string;
}

export interface Asm32Listing {
  addr: number;
  word: number;
  /** 1-basierte Quellzeile */
  line: number;
  text: string;
}

export interface Asm32Result {
  /** Programmwörter ab Adresse 0 (vorzeichenlos, Lücken = 0). */
  words: number[];
  errors: Asm32Error[];
  labels: Record<string, number>;
  listing: Asm32Listing[];
  instructionCount: number;
}

export const ASM32_REFERENCE: { code: string; text: string }[] = [
  { code: "ADD/SUB/AND/OR/XOR/SHL/SHR rd, rs1, rs2", text: "rd = rs1 ∘ rs2 (SHL/SHR: Schiebeweite = untere 5 Bit)" },
  { code: "ADDI/SUBI rd, rs1, n", text: "n = −32768…32767, vorzeichenerweitert" },
  { code: "ANDI/ORI/XORI rd, rs1, n", text: "n = 0…65535, mit Nullen erweitert" },
  { code: "SHLI/SHRI rd, rs1, n", text: "Schieben um n = 0…31 Bit (SHR logisch)" },
  { code: "XORS rd, rs1, n", text: "XOR mit vorzeichenerweitertem n" },
  { code: "LDI rd, n", text: "rd = n (−32768…32767, vorzeichenerweitert)" },
  { code: "LUI rd, n", text: "rd = n << 16 (n = 0…65535)" },
  { code: "LD rd, [rs1+n]", text: "rd = RAM[(rs1+n) & 1023]" },
  { code: "ST rd, [rs1+n]", text: "RAM[(rs1+n) & 1023] = rd" },
  { code: "BEQ/BNE/BLT/BGE a, b, ziel", text: "springt bei a=b / a≠b / a<b / a≥b (BLT/BGE vorzeichenbehaftet)" },
  { code: "JMP ziel · JAL rd, ziel · JR rs1", text: "Sprung · Sprung mit rd = PC+1 · Sprung zu Register" },
  { code: "OUT rs1 · NOP · HLT", text: "Ausgabe-Register laden · nichts tun · anhalten" },
  { code: "LI rd, n32", text: "beliebige 32-Bit-Konstante (LDI oder LUI+ORI)" },
  { code: "MOV · CLR · INC · DEC · NOT", text: "MOV rd,rs · CLR rd · INC rd · DEC rd · NOT rd[,rs]" },
  { code: "CALL ziel · RET", text: "JAL R14,ziel · JR R14" },
  { code: "PUSH rs · POP rd", text: "Stapel über SP = R15 (wächst nach unten)" },
  { code: "BGT/BLE a, b, ziel", text: "a>b / a≤b (Operanden getauscht)" },
  { code: ".org n · .word n,… · .equ NAME, n", text: "Adresse · Rohwörter · Konstante; Zahlen: 42 0x2A 0b101 'c'" },
  { code: "R0…R15 · SP=R15 · LR=R14", text: "Register (Aliase SP, LR)" },
];

const REGISTERS: Record<string, number> = { SP: 15, LR: 14 };
for (let i = 0; i < 16; i++) REGISTERS[`R${i}`] = i;

type Shape = "rrr" | "rri" | "rrz" | "ri" | "mem" | "br" | "j" | "jal" | "jr" | "out" | "none";
type Imm = "s16" | "u16";

const REAL: Record<string, { op: number; shape: Shape; imm?: Imm }> = {
  NOP: { op: OP.NOP, shape: "none" },
  HLT: { op: OP.HLT, shape: "none" },
  HALT: { op: OP.HLT, shape: "none" },
  ADD: { op: OP.ADD, shape: "rrr" },
  SUB: { op: OP.SUB, shape: "rrr" },
  AND: { op: OP.AND, shape: "rrr" },
  OR: { op: OP.OR, shape: "rrr" },
  XOR: { op: OP.XOR, shape: "rrr" },
  SHL: { op: OP.SHL, shape: "rrr" },
  SHR: { op: OP.SHR, shape: "rrr" },
  ADDI: { op: OP.ADDI, shape: "rri", imm: "s16" },
  SUBI: { op: OP.SUBI, shape: "rri", imm: "s16" },
  XORS: { op: OP.XORS, shape: "rri", imm: "s16" },
  ANDI: { op: OP.ANDI, shape: "rri", imm: "u16" },
  ORI: { op: OP.ORI, shape: "rri", imm: "u16" },
  XORI: { op: OP.XORI, shape: "rri", imm: "u16" },
  LDI: { op: OP.LDI, shape: "ri", imm: "s16" },
  LUI: { op: OP.LUI, shape: "ri", imm: "u16" },
  LD: { op: OP.LD, shape: "mem" },
  ST: { op: OP.ST, shape: "mem" },
  BEQ: { op: OP.BEQ, shape: "br" },
  BNE: { op: OP.BNE, shape: "br" },
  BLT: { op: OP.BLT, shape: "br" },
  BGE: { op: OP.BGE, shape: "br" },
  JMP: { op: OP.JMP, shape: "j" },
  JAL: { op: OP.JAL, shape: "jal" },
  JR: { op: OP.JR, shape: "jr" },
  OUT: { op: OP.OUT, shape: "out" },
};
// Schiebebefehle mit Konstante: Weite 0…31
const SHIFT_IMM = new Set(["SHLI", "SHRI"]);
REAL.SHLI = { op: OP.SHLI, shape: "rri", imm: "u16" };
REAL.SHRI = { op: OP.SHRI, shape: "rri", imm: "u16" };

const PSEUDO = new Set([
  "LI", "MOV", "CLR", "INC", "DEC", "NOT", "CALL", "RET", "PUSH", "POP", "BGT", "BLE",
]);

interface Item {
  line: number;
  at: number;
  text: string;
  /** Rohwort (.word) oder Befehl mit Operanden */
  raw?: number;
  mnemonic?: string;
  args?: string[];
  /** Entscheidung für LI aus dem ersten Durchlauf */
  liForm?: "ldi" | "lui" | "luiori";
  liExpr?: string;
  /** Teil einer Pseudo-Expansion (0 = erstes Wort) */
  part?: number;
}

class AsmFail extends Error {}

function splitArgs(s: string): string[] {
  const t = s.trim();
  return t === "" ? [] : t.split(",").map((x) => x.trim());
}

/** Wertet Terme aus Zahlen, Zeichen, Labels und Konstanten mit + und − aus. null = Label unbekannt. */
function evalExpr(expr: string, symbols: Map<string, number>): number | null {
  const src = expr.trim();
  if (!src) throw new AsmFail("Ausdruck fehlt.");
  const re = /\s*([+-])?\s*('(?:[^'\\]|\\.)'|0x[0-9a-f]+|0b[01]+|\d+|[A-Za-z_.][\w.$]*)/iy;
  let pos = 0;
  let total = 0;
  let unknown = false;
  let first = true;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || (!first && !m[1])) throw new AsmFail(`Ungültiger Ausdruck „${src}“.`);
    const sign = m[1] === "-" ? -1 : 1;
    const tok = m[2];
    let v: number | undefined;
    if (tok.startsWith("'")) {
      const body = tok.slice(1, -1);
      v = body.startsWith("\\") ? ({ n: 10, t: 9, r: 13, "0": 0, "\\": 92, "'": 39 } as Record<string, number>)[body[1]] : body.charCodeAt(0);
      if (v === undefined) throw new AsmFail(`Unbekanntes Zeichen ${tok}.`);
    } else if (/^0x/i.test(tok)) v = parseInt(tok.slice(2), 16);
    else if (/^0b/i.test(tok)) v = parseInt(tok.slice(2), 2);
    else if (/^\d/.test(tok)) v = parseInt(tok, 10);
    else {
      v = symbols.get(tok.toLowerCase());
      if (v === undefined) unknown = true;
    }
    if (v !== undefined) total += sign * v;
    pos = re.lastIndex;
    first = false;
  }
  return unknown ? null : total;
}

/**
 * Übersetzt RISC-32-Assembler in Befehlswörter.
 * Zeilenformat: `[label:] BEFEHL operanden ; Kommentar`
 */
export function assemble32(source: string): Asm32Result {
  const errors: Asm32Error[] = [];
  const symbols = new Map<string, number>();
  const labelNames = new Map<string, number>();
  const items: Item[] = [];
  let pc = 0;
  const lines = source.split(/\r?\n/);

  const fail = (line: number, message: string) => errors.push({ line, message });
  const reg = (tok: string | undefined, what = "Register"): number => {
    const r = tok === undefined ? undefined : REGISTERS[tok.trim().toUpperCase()];
    if (r === undefined) throw new AsmFail(`${what} erwartet (R0…R15), gefunden: „${tok ?? ""}“.`);
    return r;
  };
  const need = (args: string[], n: number, mnem: string, form: string) => {
    if (args.length !== n) throw new AsmFail(`${mnem} erwartet ${form}.`);
  };

  /* ---- Durchlauf 1: Labels, Konstanten, Größen ---- */
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    let text = raw.replace(/;.*$/, "").replace(/\/\/.*$/, "").trim();
    try {
      for (;;) {
        const lm = text.match(/^([A-Za-z_][\w.$]*)\s*:\s*(.*)$/);
        if (!lm) break;
        const name = lm[1].toLowerCase();
        if (symbols.has(name)) fail(line, `Name „${lm[1]}“ ist doppelt vergeben.`);
        else {
          symbols.set(name, pc);
          labelNames.set(name, pc);
        }
        text = lm[2].trim();
      }
      if (!text) return;
      const m = text.match(/^(\S+)\s*(.*)$/)!;
      const head = m[1];
      const rest = m[2];

      if (head.startsWith(".")) {
        const d = head.toLowerCase();
        if (d === ".org") {
          const v = evalExpr(rest, symbols);
          if (v === null || v < 0 || v >= ROM_WORDS) throw new AsmFail(`.org erwartet eine bekannte Adresse 0…${ROM_WORDS - 1}.`);
          pc = v;
        } else if (d === ".word") {
          const parts = splitArgs(rest);
          if (parts.length === 0) throw new AsmFail(".word erwartet mindestens einen Wert.");
          for (const p of parts) {
            items.push({ line, at: pc, text: `.word ${p}`, mnemonic: ".word", args: [p] });
            pc++;
          }
        } else if (d === ".equ") {
          const parts = splitArgs(rest);
          if (parts.length !== 2 || !/^[A-Za-z_][\w.$]*$/.test(parts[0])) throw new AsmFail(".equ erwartet: .equ NAME, wert");
          const v = evalExpr(parts[1], symbols);
          if (v === null) throw new AsmFail(`Wert von „${parts[0]}“ nutzt einen noch unbekannten Namen.`);
          if (symbols.has(parts[0].toLowerCase())) throw new AsmFail(`Name „${parts[0]}“ ist doppelt vergeben.`);
          symbols.set(parts[0].toLowerCase(), v);
        } else throw new AsmFail(`Unbekannte Direktive ${head}.`);
        return;
      }

      const mnem = head.toUpperCase();
      const args = splitArgs(rest);
      if (!REAL[mnem] && !PSEUDO.has(mnem)) throw new AsmFail(`Unbekannter Befehl „${head}“.`);
      let count = 1;
      const item: Item = { line, at: pc, text: `${mnem}${rest ? " " + rest : ""}`, mnemonic: mnem, args };
      if (mnem === "LI") {
        need(args, 2, "LI", "Register und Wert (LI rd, n)");
        const v = evalExpr(args[1], symbols);
        if (v === null) item.liForm = "ldi";
        else {
          if (v < -0x80000000 || v > 0xffffffff) throw new AsmFail(`Wert ${v} passt nicht in 32 Bit.`);
          const u = v >>> 0;
          const lo = u & 0xffff;
          if ((((u << 16) >> 16) >>> 0) === u) item.liForm = "ldi";
          else if (lo === 0) item.liForm = "lui";
          else item.liForm = "luiori";
          item.liExpr = String(u);
        }
        count = item.liForm === "luiori" ? 2 : 1;
      } else if (mnem === "PUSH" || mnem === "POP") count = 2;
      items.push(item);
      pc += count;
    } catch (e) {
      if (e instanceof AsmFail) fail(line, e.message);
      else throw e;
    }
  });

  /* ---- Durchlauf 2: Wörter erzeugen ---- */
  const words: number[] = [];
  const used = new Set<number>();
  const listing: Asm32Listing[] = [];
  let instructionCount = 0;

  const imm = (expr: string, kind: Imm | "shift" | "addr"): number => {
    const v = evalExpr(expr, symbols);
    if (v === null) throw new AsmFail(`Unbekannter Name in „${expr}“.`);
    if (kind === "s16" && (v < -32768 || v > 32767)) throw new AsmFail(`Wert ${v} passt nicht in 16 Bit mit Vorzeichen (−32768…32767).`);
    if (kind === "u16" && (v < 0 || v > 65535)) throw new AsmFail(`Wert ${v} passt nicht in 16 Bit ohne Vorzeichen (0…65535).`);
    if (kind === "shift" && (v < 0 || v > 31)) throw new AsmFail(`Schiebeweite ${v} muss 0…31 sein.`);
    if (kind === "addr" && (v < 0 || v >= ROM_WORDS)) throw new AsmFail(`Sprungziel ${v} liegt außerhalb des Programmspeichers (0…${ROM_WORDS - 1}).`);
    return v & 0xffff;
  };
  const mem = (tok: string): { base: number; off: number } => {
    const m = tok.trim().match(/^\[\s*([A-Za-z]\w*)\s*(?:([+-].*))?\]$/);
    if (!m) throw new AsmFail(`Speicheroperand „${tok}“ erwartet die Form [Rn], [Rn+n] oder [Rn-n].`);
    return { base: reg(m[1]), off: m[2] ? imm(m[2], "s16") : 0 };
  };

  const emit = (it: Item, word: number) => {
    const addr = it.at + (it.part ?? 0);
    it.part = (it.part ?? 0) + 1;
    if (used.has(addr)) {
      fail(it.line, `Adresse ${addr} ist schon belegt (.org überlappt).`);
      return;
    }
    if (addr >= ROM_WORDS) {
      fail(it.line, `Programm ist zu groß: Adresse ${addr} (maximal ${ROM_WORDS} Wörter).`);
      return;
    }
    used.add(addr);
    words[addr] = word >>> 0;
    listing.push({ addr, word: word >>> 0, line: it.line, text: it.text });
  };

  for (const it of items) {
    try {
      if (it.mnemonic === ".word") {
        const v = evalExpr(it.args![0], symbols);
        if (v === null) throw new AsmFail(`Unbekannter Name in „${it.args![0]}“.`);
        if (v < -0x80000000 || v > 0xffffffff) throw new AsmFail(`Wert ${v} passt nicht in 32 Bit.`);
        emit(it, v >>> 0);
        continue;
      }
      instructionCount++;
      const mnem = it.mnemonic!;
      const a = it.args!;
      const I = (op: number, rd: number, rs1: number, i: number) => emit(it, encodeI(op, rd, rs1, i));
      switch (mnem) {
        case "LI": {
          const rd = reg(a[0]);
          const v = it.liExpr !== undefined ? Number(it.liExpr) : evalExpr(a[1], symbols);
          if (v === null) throw new AsmFail(`Unbekannter Name in „${a[1]}“.`);
          if (v < -0x80000000 || v > 0xffffffff) throw new AsmFail(`Wert ${v} passt nicht in 32 Bit.`);
          const u = v >>> 0;
          if (it.liForm === "ldi") {
            if ((((u << 16) >> 16) >>> 0) !== u) throw new AsmFail(`Wert ${v} passt nicht in LDI – Name bei LI vor der Verwendung definieren.`);
            I(OP.LDI, rd, 0, u & 0xffff);
          } else {
            I(OP.LUI, rd, 0, u >>> 16);
            if (it.liForm === "luiori") I(OP.ORI, rd, rd, u & 0xffff);
          }
          break;
        }
        case "MOV":
          need(a, 2, mnem, "zwei Register (MOV rd, rs)");
          I(OP.ADDI, reg(a[0]), reg(a[1]), 0);
          break;
        case "CLR":
          need(a, 1, mnem, "ein Register");
          I(OP.LDI, reg(a[0]), 0, 0);
          break;
        case "INC":
        case "DEC": {
          need(a, 1, mnem, "ein Register");
          const r = reg(a[0]);
          I(OP.ADDI, r, r, mnem === "INC" ? 1 : 0xffff);
          break;
        }
        case "NOT": {
          if (a.length < 1 || a.length > 2) throw new AsmFail("NOT erwartet NOT rd oder NOT rd, rs.");
          const rd = reg(a[0]);
          I(OP.XORS, rd, a.length === 2 ? reg(a[1]) : rd, 0xffff);
          break;
        }
        case "CALL":
          need(a, 1, mnem, "ein Ziel");
          I(OP.JAL, 14, 0, imm(a[0], "addr"));
          break;
        case "RET":
          need(a, 0, mnem, "keine Operanden");
          I(OP.JR, 0, 14, 0);
          break;
        case "PUSH": {
          need(a, 1, mnem, "ein Register");
          const r = reg(a[0]);
          I(OP.ADDI, 15, 15, 0xffff);
          I(OP.ST, r, 15, 0);
          break;
        }
        case "POP": {
          need(a, 1, mnem, "ein Register");
          const r = reg(a[0]);
          I(OP.LD, r, 15, 0);
          I(OP.ADDI, 15, 15, 1);
          break;
        }
        case "BGT":
        case "BLE": {
          need(a, 3, mnem, "zwei Register und ein Ziel");
          const x = reg(a[0]);
          const y = reg(a[1]);
          // a>b ⇔ b<a ; a≤b ⇔ b≥a
          I(mnem === "BGT" ? OP.BLT : OP.BGE, x, y, imm(a[2], "addr"));
          break;
        }
        default: {
          const spec = REAL[mnem];
          switch (spec.shape) {
            case "none":
              need(a, 0, mnem, "keine Operanden");
              I(spec.op, 0, 0, 0);
              break;
            case "rrr":
              need(a, 3, mnem, "drei Register (rd, rs1, rs2)");
              emit(it, encodeR(spec.op, reg(a[0]), reg(a[1]), reg(a[2])));
              break;
            case "rri":
              need(a, 3, mnem, "zwei Register und eine Konstante");
              I(spec.op, reg(a[0]), reg(a[1]), imm(a[2], SHIFT_IMM.has(mnem) ? "shift" : spec.imm!));
              break;
            case "ri":
              need(a, 2, mnem, "Register und Konstante");
              I(spec.op, reg(a[0]), 0, imm(a[1], spec.imm!));
              break;
            case "mem": {
              need(a, 2, mnem, "Register und [Register+Offset]");
              const { base, off } = mem(a[1]);
              I(spec.op, reg(a[0]), base, off);
              break;
            }
            case "br":
              need(a, 3, mnem, "zwei Register und ein Ziel");
              // zweites Register steht im rd-Feld (siehe cpu32-ref.ts)
              I(spec.op, reg(a[1]), reg(a[0]), imm(a[2], "addr"));
              break;
            case "j":
              need(a, 1, mnem, "ein Ziel");
              I(spec.op, 0, 0, imm(a[0], "addr"));
              break;
            case "jal":
              need(a, 2, mnem, "Register und Ziel");
              I(spec.op, reg(a[0]), 0, imm(a[1], "addr"));
              break;
            case "jr":
            case "out":
              need(a, 1, mnem, "ein Register");
              I(spec.op, 0, reg(a[0]), 0);
              break;
          }
        }
      }
    } catch (e) {
      if (e instanceof AsmFail) fail(it.line, e.message);
      else throw e;
    }
  }

  const size = words.length;
  for (let i = 0; i < size; i++) words[i] = words[i] ?? 0;
  listing.sort((x, y) => x.addr - y.addr);
  errors.sort((x, y) => x.line - y.line);
  return { words, errors, labels: Object.fromEntries(labelNames), listing, instructionCount };
}

export function formatListing(r: Asm32Result): string {
  return r.listing
    .map(
      (l) =>
        `${l.addr.toString(16).toUpperCase().padStart(3, "0")}: ${l.word.toString(16).toUpperCase().padStart(8, "0")}  ${l.text}`
    )
    .join("\n");
}
