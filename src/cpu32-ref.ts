/**
 * RISC-32: Befehlssatz, Steuer-Tabelle und Referenz-Emulator.
 *
 * Befehlswort (32 Bit):  [31:24] Opcode | [23:20] rd | [19:16] rs1 | [15:12] rs2 | [15:0] imm16
 * R-Typ nutzt rs2, I-Typ nutzt imm16 (überlappt rs2). 16 Register R0..R15 (alle frei
 * verwendbar, R0 ist nicht fest null), Programmspeicher 1024 Wörter, Datenspeicher
 * 1024 Wörter. Ein Takt = ein Befehl.
 *
 * Besonderheiten der Hardware (der Emulator bildet sie exakt nach):
 *  - Branches vergleichen zwei Register über die ALU-Subtraktion A − B mit A = rs1 und
 *    B = Register im rd-Feld. BEQ a,b,Z: Felder rs1=a, rd=b. BLT/BGE sind vorzeichenbehaftet
 *    (LT = Negativ-Flag XOR Überlauf-Flag der Subtraktion).
 *  - ST/Branch lesen ihr zweites Register aus dem rd-Feld; ST schreibt rd nach [rs1 + imm].
 *  - Sprungziele sind 16 Bit (imm16); der Programmspeicher sieht nur die unteren 10 Bit.
 *  - ADDI/SUBI/LDI/LD/ST/XORS erweitern imm16 vorzeichenrichtig, ANDI/ORI/XORI mit Nullen,
 *    LUI schiebt imm16 nach oben (imm << 16). Schiebebefehle nutzen die unteren 5 Bit von B.
 */

export const REG_COUNT = 16;
export const ROM_WORDS = 1024;
export const RAM_WORDS = 1024;

export const OP = {
  NOP: 0x00,
  ADD: 0x01,
  SUB: 0x02,
  AND: 0x03,
  OR: 0x04,
  XOR: 0x05,
  SHL: 0x06,
  SHR: 0x07,
  ADDI: 0x11,
  SUBI: 0x12,
  ANDI: 0x13,
  ORI: 0x14,
  XORI: 0x15,
  SHLI: 0x16,
  SHRI: 0x17,
  XORS: 0x18,
  LDI: 0x20,
  LUI: 0x21,
  LD: 0x30,
  ST: 0x31,
  BEQ: 0x40,
  BNE: 0x41,
  BLT: 0x42,
  BGE: 0x43,
  JMP: 0x50,
  JAL: 0x51,
  JR: 0x52,
  OUT: 0x60,
  HLT: 0xff,
} as const;

export type Mnemonic = keyof typeof OP;

/** ALU-Operationen (wie std-alu-32). */
export const ALU = { ADD: 0, SUB: 1, AND: 2, OR: 3, XOR: 4, SHL: 5, SHR: 6, PASSB: 7 } as const;
/** B-Quelle: 0 Register, 1 imm16 vorzeichenerweitert, 2 imm16 nullerweitert, 3 imm16 << 16. */
export const BSEL = { REG: 0, SEXT: 1, ZEXT: 2, HI: 3 } as const;
/** Schreibquelle des Registerfelds: 0 ALU, 1 RAM, 2 PC+1. */
export const WSRC = { ALU: 0, RAM: 1, PC1: 2 } as const;

export interface Control {
  alu: number;
  bsel: number;
  /** 1: zweiter Registerlese-Port adressiert rd statt rs2. */
  rbRd: number;
  regWrite: number;
  wsrc: number;
  memWrite: number;
  out: number;
  jmp: number;
  jr: number;
  beq: number;
  bne: number;
  blt: number;
  bge: number;
  halt: number;
}

/** Bitposition der Steuersignale im Steuerwort (Steuer-ROM, 32 Bit breit, Bits 18–31 frei). */
export const CTRL_BITS = {
  alu: 0, // 3 Bit
  bsel: 3, // 2 Bit
  rbRd: 5,
  regWrite: 6,
  wsrc: 7, // 2 Bit
  memWrite: 9,
  out: 10,
  jmp: 11,
  jr: 12,
  beq: 13,
  bne: 14,
  blt: 15,
  bge: 16,
  halt: 17,
} as const;

export function ctrlWord(c: Partial<Control>): number {
  let w = 0;
  for (const [key, shift] of Object.entries(CTRL_BITS)) {
    const v = (c as Record<string, number | undefined>)[key] ?? 0;
    const width = key === "alu" ? 3 : key === "bsel" || key === "wsrc" ? 2 : 1;
    w |= (v & ((1 << width) - 1)) << shift;
  }
  return w >>> 0;
}

const R_OPS: [Mnemonic, number][] = [
  ["ADD", ALU.ADD],
  ["SUB", ALU.SUB],
  ["AND", ALU.AND],
  ["OR", ALU.OR],
  ["XOR", ALU.XOR],
  ["SHL", ALU.SHL],
  ["SHR", ALU.SHR],
];
const I_OPS: [Mnemonic, number, number][] = [
  ["ADDI", ALU.ADD, BSEL.SEXT],
  ["SUBI", ALU.SUB, BSEL.SEXT],
  ["ANDI", ALU.AND, BSEL.ZEXT],
  ["ORI", ALU.OR, BSEL.ZEXT],
  ["XORI", ALU.XOR, BSEL.ZEXT],
  ["SHLI", ALU.SHL, BSEL.ZEXT],
  ["SHRI", ALU.SHR, BSEL.ZEXT],
  ["XORS", ALU.XOR, BSEL.SEXT],
];

/** Inhalt des Steuer-ROMs: Opcode → Steuerwort (nicht belegte Opcodes wirken wie NOP). */
export function controlTable(): number[] {
  const t = new Array(256).fill(0);
  for (const [m, alu] of R_OPS) t[OP[m]] = ctrlWord({ alu, bsel: BSEL.REG, regWrite: 1 });
  for (const [m, alu, bsel] of I_OPS) t[OP[m]] = ctrlWord({ alu, bsel, regWrite: 1 });
  t[OP.LDI] = ctrlWord({ alu: ALU.PASSB, bsel: BSEL.SEXT, regWrite: 1 });
  t[OP.LUI] = ctrlWord({ alu: ALU.PASSB, bsel: BSEL.HI, regWrite: 1 });
  t[OP.LD] = ctrlWord({ alu: ALU.ADD, bsel: BSEL.SEXT, regWrite: 1, wsrc: WSRC.RAM });
  t[OP.ST] = ctrlWord({ alu: ALU.ADD, bsel: BSEL.SEXT, rbRd: 1, memWrite: 1 });
  const br = { alu: ALU.SUB, bsel: BSEL.REG, rbRd: 1 };
  t[OP.BEQ] = ctrlWord({ ...br, beq: 1 });
  t[OP.BNE] = ctrlWord({ ...br, bne: 1 });
  t[OP.BLT] = ctrlWord({ ...br, blt: 1 });
  t[OP.BGE] = ctrlWord({ ...br, bge: 1 });
  t[OP.JMP] = ctrlWord({ jmp: 1 });
  t[OP.JAL] = ctrlWord({ jmp: 1, regWrite: 1, wsrc: WSRC.PC1 });
  t[OP.JR] = ctrlWord({ jr: 1, jmp: 1 });
  t[OP.OUT] = ctrlWord({ out: 1 });
  t[OP.HLT] = ctrlWord({ halt: 1 });
  return t;
}

/* ---------- Befehlswort ---------- */

export interface Fields {
  op: number;
  rd: number;
  rs1: number;
  rs2: number;
  imm: number;
}

export function decodeWord(word: number): Fields {
  const w = word >>> 0;
  return { op: w >>> 24, rd: (w >>> 20) & 15, rs1: (w >>> 16) & 15, rs2: (w >>> 12) & 15, imm: w & 0xffff };
}

export function encodeR(op: number, rd: number, rs1: number, rs2: number): number {
  return (((op & 255) << 24) | ((rd & 15) << 20) | ((rs1 & 15) << 16) | ((rs2 & 15) << 12)) >>> 0;
}

export function encodeI(op: number, rd: number, rs1: number, imm: number): number {
  return (((op & 255) << 24) | ((rd & 15) << 20) | ((rs1 & 15) << 16) | (imm & 0xffff)) >>> 0;
}

const sext16 = (v: number): number => ((v << 16) >> 16) >>> 0;

/** Kurzschreibweise eines Befehlswortes (für Listing und Anzeige). */
export function disassemble(word: number): string {
  const { op, rd, rs1, rs2, imm } = decodeWord(word);
  const r = (n: number) => `R${n}`;
  const s = (v: number) => String((v << 16) >> 16);
  const name = (Object.keys(OP) as Mnemonic[]).find((k) => OP[k] === op);
  if (!name) return `.word 0x${(word >>> 0).toString(16).padStart(8, "0")}`;
  if (R_OPS.some(([m]) => m === name)) return `${name} ${r(rd)}, ${r(rs1)}, ${r(rs2)}`;
  if (name === "SHLI" || name === "SHRI" || name === "ANDI" || name === "ORI" || name === "XORI")
    return `${name} ${r(rd)}, ${r(rs1)}, ${imm}`;
  if (name === "ADDI" || name === "SUBI" || name === "XORS") return `${name} ${r(rd)}, ${r(rs1)}, ${s(imm)}`;
  switch (name) {
    case "NOP":
    case "HLT":
      return name;
    case "LDI":
      return `LDI ${r(rd)}, ${s(imm)}`;
    case "LUI":
      return `LUI ${r(rd)}, 0x${imm.toString(16)}`;
    case "LD":
      return `LD ${r(rd)}, [${r(rs1)}${(imm << 16) >> 16 >= 0 ? "+" : ""}${s(imm)}]`;
    case "ST":
      return `ST ${r(rd)}, [${r(rs1)}${(imm << 16) >> 16 >= 0 ? "+" : ""}${s(imm)}]`;
    case "BEQ":
    case "BNE":
    case "BLT":
    case "BGE":
      return `${name} ${r(rs1)}, ${r(rd)}, ${imm}`;
    case "JMP":
      return `JMP ${imm}`;
    case "JAL":
      return `JAL ${r(rd)}, ${imm}`;
    case "JR":
      return `JR ${r(rs1)}`;
    case "OUT":
      return `OUT ${r(rs1)}`;
  }
  return name;
}

/* ---------- Referenz-Emulator ---------- */

export interface RefState {
  pc: number;
  regs: number[];
  ram: number[];
  out: number;
  halted: boolean;
}

/** Referenzmodell der Schaltung in reinem TypeScript (alle Werte als vorzeichenlose 32 Bit). */
export class Cpu32Ref {
  pc = 0;
  regs: number[] = new Array(REG_COUNT).fill(0);
  ram: number[] = new Array(RAM_WORDS).fill(0);
  rom: number[] = new Array(ROM_WORDS).fill(0);
  out = 0;
  halted = false;
  steps = 0;
  /** Jeder OUT-Befehl hängt seinen Wert an (nur im Emulator, die Schaltung zeigt den letzten). */
  outputs: number[] = [];

  constructor(program: number[] = []) {
    this.load(program);
  }

  load(program: number[]): void {
    this.rom = new Array(ROM_WORDS).fill(0);
    program.forEach((w, i) => {
      if (i < ROM_WORDS) this.rom[i] = w >>> 0;
    });
    this.reset();
  }

  /** Wie RESET der Schaltung: PC und Ausgabe löschen. Register und RAM bleiben erhalten. */
  reset(): void {
    this.pc = 0;
    this.out = 0;
    this.halted = false;
    this.steps = 0;
    this.outputs = [];
  }

  snapshot(): RefState {
    return { pc: this.pc, regs: [...this.regs], ram: [...this.ram], out: this.out, halted: this.halted };
  }

  /** Ein Takt. */
  step(): void {
    const word = this.rom[this.pc & (ROM_WORDS - 1)] ?? 0;
    const { op, rd, rs1, rs2, imm } = decodeWord(word);
    const a = this.regs[rs1];
    const bReg = this.regs[rs2];
    const bRd = this.regs[rd];
    const sx = sext16(imm);
    const next = (this.pc + 1) >>> 0;
    let pc = next;
    this.steps++;
    const write = (v: number) => {
      this.regs[rd] = v >>> 0;
    };
    const addr = (v: number) => v & (RAM_WORDS - 1);

    switch (op) {
      case OP.ADD: write(a + bReg); break;
      case OP.SUB: write(a - bReg); break;
      case OP.AND: write(a & bReg); break;
      case OP.OR: write(a | bReg); break;
      case OP.XOR: write(a ^ bReg); break;
      case OP.SHL: write(a << (bReg & 31)); break;
      case OP.SHR: write(a >>> (bReg & 31)); break;
      case OP.ADDI: write(a + sx); break;
      case OP.SUBI: write(a - sx); break;
      case OP.ANDI: write(a & imm); break;
      case OP.ORI: write(a | imm); break;
      case OP.XORI: write(a ^ imm); break;
      case OP.SHLI: write(a << (imm & 31)); break;
      case OP.SHRI: write(a >>> (imm & 31)); break;
      case OP.XORS: write(a ^ sx); break;
      case OP.LDI: write(sx); break;
      case OP.LUI: write(imm << 16); break;
      case OP.LD: write(this.ram[addr(a + sx)]); break;
      case OP.ST: this.ram[addr(a + sx)] = bRd >>> 0; break;
      case OP.BEQ: if (a === bRd) pc = imm; break;
      case OP.BNE: if (a !== bRd) pc = imm; break;
      case OP.BLT: if ((a | 0) < (bRd | 0)) pc = imm; break;
      case OP.BGE: if (!((a | 0) < (bRd | 0))) pc = imm; break;
      case OP.JMP: pc = imm; break;
      case OP.JAL: write(next); pc = imm; break;
      case OP.JR: pc = a; break;
      case OP.OUT: this.out = a; this.outputs.push(a); break;
      case OP.HLT: this.halted = true; pc = this.pc; break;
      default: break;
    }
    this.pc = pc >>> 0;
  }

  /** Läuft bis HLT oder bis maxSteps erreicht sind. */
  run(maxSteps = 100000): number {
    let n = 0;
    while (!this.halted && n < maxSteps) {
      this.step();
      n++;
    }
    return n;
  }
}
