import { Circuit } from "../circuit";
import { buildCpu } from "../cpu";
import { assemble, AsmResult } from "../assembler";
import { Comp } from "../types";

/* ---------- Befehlssatz der 8-Bit-Mini-CPU ---------- */

export type OperandKind = "none" | "imm" | "addr";

export interface Instr {
  mnemonic: string;
  opcode: number;
  operand: OperandKind;
  /** Steuerwort (siehe CTRL_LINES) */
  ctrl: number;
  /** Kurzbeschreibung in Worten */
  text: string;
}

export const MODE_NAMES = ["HALTEN (F = A)", "ADD", "SUB", "AND", "OR", "XOR", "DURCHLEITEN (F = B)", "NULL"];

/** Bit-Zuordnung des Steuerworts (wie ctrlWord() in cpu.ts). */
export const CTRL_LINES: { bit: number; width: number; name: string; text: string }[] = [
  { bit: 0, width: 3, name: "Modus", text: "Rechenart der ALU (3 Bit)" },
  { bit: 3, width: 1, name: "EN", text: "ALU-Ergebnis darf in den Akku" },
  { bit: 4, width: 1, name: "MEM", text: "zweiter Operand aus dem RAM statt aus dem Befehl" },
  { bit: 5, width: 1, name: "WE", text: "Akku in den RAM schreiben" },
  { bit: 6, width: 1, name: "OUT", text: "Akku ins Ausgaberegister laden" },
  { bit: 7, width: 1, name: "JMP", text: "unbedingter Sprung" },
  { bit: 8, width: 1, name: "JZ", text: "Sprung, wenn Akku = 0" },
  { bit: 9, width: 1, name: "JNZ", text: "Sprung, wenn Akku ≠ 0" },
  { bit: 10, width: 1, name: "HLT", text: "Programmzähler anhalten" },
];

export function ctrlWord(o: { m?: number; e?: number; mem?: number; we?: number; out?: number; jmp?: number; jz?: number; jnz?: number; halt?: number }): number {
  return (
    ((o.m ?? 0) & 7) |
    ((o.e ?? 0) << 3) |
    ((o.mem ?? 0) << 4) |
    ((o.we ?? 0) << 5) |
    ((o.out ?? 0) << 6) |
    ((o.jmp ?? 0) << 7) |
    ((o.jz ?? 0) << 8) |
    ((o.jnz ?? 0) << 9) |
    ((o.halt ?? 0) << 10)
  );
}

export const INSTRUCTIONS: Instr[] = [
  { mnemonic: "NOP", opcode: 0x00, operand: "none", ctrl: 0, text: "tut nichts (der Akku bleibt, der PC zählt weiter)" },
  { mnemonic: "LDA", opcode: 0x01, operand: "imm", ctrl: ctrlWord({ m: 6, e: 1 }), text: "Akku ← Konstante n" },
  { mnemonic: "LDA", opcode: 0x02, operand: "addr", ctrl: ctrlWord({ m: 6, e: 1, mem: 1 }), text: "Akku ← RAM[adr]" },
  { mnemonic: "STA", opcode: 0x03, operand: "addr", ctrl: ctrlWord({ we: 1 }), text: "RAM[adr] ← Akku" },
  { mnemonic: "ADD", opcode: 0x04, operand: "imm", ctrl: ctrlWord({ m: 1, e: 1 }), text: "Akku ← Akku + n" },
  { mnemonic: "ADD", opcode: 0x05, operand: "addr", ctrl: ctrlWord({ m: 1, e: 1, mem: 1 }), text: "Akku ← Akku + RAM[adr]" },
  { mnemonic: "SUB", opcode: 0x06, operand: "imm", ctrl: ctrlWord({ m: 2, e: 1 }), text: "Akku ← Akku − n" },
  { mnemonic: "SUB", opcode: 0x07, operand: "addr", ctrl: ctrlWord({ m: 2, e: 1, mem: 1 }), text: "Akku ← Akku − RAM[adr]" },
  { mnemonic: "AND", opcode: 0x08, operand: "imm", ctrl: ctrlWord({ m: 3, e: 1 }), text: "Akku ← Akku AND n" },
  { mnemonic: "AND", opcode: 0x09, operand: "addr", ctrl: ctrlWord({ m: 3, e: 1, mem: 1 }), text: "Akku ← Akku AND RAM[adr]" },
  { mnemonic: "OR", opcode: 0x0a, operand: "imm", ctrl: ctrlWord({ m: 4, e: 1 }), text: "Akku ← Akku OR n" },
  { mnemonic: "OR", opcode: 0x0b, operand: "addr", ctrl: ctrlWord({ m: 4, e: 1, mem: 1 }), text: "Akku ← Akku OR RAM[adr]" },
  { mnemonic: "XOR", opcode: 0x0c, operand: "imm", ctrl: ctrlWord({ m: 5, e: 1 }), text: "Akku ← Akku XOR n" },
  { mnemonic: "XOR", opcode: 0x0d, operand: "addr", ctrl: ctrlWord({ m: 5, e: 1, mem: 1 }), text: "Akku ← Akku XOR RAM[adr]" },
  { mnemonic: "OUT", opcode: 0x10, operand: "none", ctrl: ctrlWord({ out: 1 }), text: "Ausgabe ← Akku" },
  { mnemonic: "JMP", opcode: 0x20, operand: "addr", ctrl: ctrlWord({ jmp: 1 }), text: "PC ← adr" },
  { mnemonic: "JZ", opcode: 0x21, operand: "addr", ctrl: ctrlWord({ jz: 1 }), text: "wenn Akku = 0: PC ← adr" },
  { mnemonic: "JNZ", opcode: 0x22, operand: "addr", ctrl: ctrlWord({ jnz: 1 }), text: "wenn Akku ≠ 0: PC ← adr" },
  { mnemonic: "HLT", opcode: 0xff, operand: "none", ctrl: ctrlWord({ halt: 1 }), text: "Programmzähler anhalten" },
];

export function instrByOpcode(opcode: number): Instr | undefined {
  return INSTRUCTIONS.find((i) => i.opcode === opcode);
}

/** Das gewünschte Steuer-ROM (256 Wörter) aus der Tabelle. */
export function controlRomContents(): number[] {
  const rom = new Array(256).fill(0);
  for (const i of INSTRUCTIONS) rom[i.opcode] = i.ctrl;
  return rom;
}

export function hex(v: number, digits = 2): string {
  return "0x" + (v >>> 0).toString(16).toUpperCase().padStart(digits, "0");
}

export function disassemble(word: number): string {
  const opcode = (word >> 8) & 0xff;
  const operand = word & 0xff;
  const ins = instrByOpcode(opcode);
  if (!ins) return `??? (${hex(opcode)})`;
  if (ins.operand === "none") return ins.mnemonic;
  return ins.operand === "imm" ? `${ins.mnemonic} #${operand}` : `${ins.mnemonic} ${hex(operand)}`;
}

/** Aktive Steuerleitungen eines Steuerworts als lesbare Liste. */
export function activeLines(ctrl: number): string[] {
  const out: string[] = [];
  if ((ctrl >> 3) & 1) out.push("EN", `Modus = ${MODE_NAMES[ctrl & 7]}`);
  for (const l of CTRL_LINES) if (l.width === 1 && l.bit !== 3 && (ctrl >> l.bit) & 1) out.push(l.name);
  return out;
}

/* ---------- Die echte CPU als Maschine ---------- */

export interface CpuMachine {
  c: Circuit;
  prog: Comp;
  ctrl: Comp;
  ram: Comp;
  pcLamp: Comp;
  accLamp: Comp;
  outLamp: Comp;
  aluF: Comp | undefined;
  groups: { alu?: string; acc?: string; pc?: string; out?: string };
}

function find(c: Circuit, kind: string, label: string): Comp {
  for (const comp of c.comps.values()) if (comp.kind === kind && comp.label === label) return comp;
  throw new Error(`CPU-Bauteil ${kind} "${label}" nicht gefunden`);
}

/** Baut die komplette 8-Bit-CPU aus cpu.ts und sucht ihre wichtigen Bauteile heraus. */
export function buildCpuMachine(): CpuMachine {
  const c = new Circuit();
  buildCpu(c, 8);
  const groups: CpuMachine["groups"] = {};
  for (const g of c.groups.values()) {
    if (g.moduleId.endsWith("-alu")) groups.alu = g.id;
    else if (g.moduleId.endsWith("-acc")) groups.acc = g.id;
    else if (g.moduleId.endsWith("-pc")) groups.pc = g.id;
    else if (g.moduleId.endsWith("-out")) groups.out = g.id;
  }
  let aluF: Comp | undefined;
  for (const comp of c.comps.values()) if (comp.kind === "buf" && comp.label === "F") aluF = comp;
  return {
    c,
    prog: find(c, "rom", "PROGRAMM"),
    ctrl: find(c, "rom", "STEUER-ROM"),
    ram: find(c, "ram", "DATEN-RAM"),
    pcLamp: find(c, "output", "PC"),
    accLamp: find(c, "output", "AKKU"),
    outLamp: find(c, "output", "AUSGABE"),
    aluF,
    groups,
  };
}

export const pcOf = (m: CpuMachine): number => m.c.inputValues(m.pcLamp)[0] & 0xff;
export const accOf = (m: CpuMachine): number => m.c.inputValues(m.accLamp)[0] & 0xff;
export const outOf = (m: CpuMachine): number => m.c.inputValues(m.outLamp)[0] & 0xff;
export const wordAt = (m: CpuMachine, pc: number): number => (m.prog.data[pc] ?? 0) & 0xffff;
export const ctrlAt = (m: CpuMachine, pc: number): number => (m.ctrl.data[wordAt(m, pc) >> 8] ?? 0) & 0xffff;
export const isHalted = (m: CpuMachine): boolean => ((ctrlAt(m, pcOf(m)) >> 10) & 1) === 1;

/** Programm ins ROM laden (Rest = 0 = NOP), RAM leeren, CPU zurücksetzen. */
export function loadWords(m: CpuMachine, words: number[]): void {
  m.prog.data = new Array(256).fill(0).map((_, i) => words[i] ?? 0);
  m.ram.data = new Array(256).fill(0);
  m.c.reset();
}

export interface RunResult {
  asm: AsmResult;
  /** Alle Werte, die per OUT ausgegeben wurden. */
  outputs: number[];
  steps: number;
  halted: boolean;
  acc: number;
  ram: number[];
}

/** Ein Befehl = ein Takt. Liefert den per OUT ausgegebenen Wert (oder null). */
export function stepInstruction(m: CpuMachine): number | null {
  const ctrl = ctrlAt(m, pcOf(m));
  const emitted = (ctrl >> 6) & 1 ? accOf(m) : null;
  m.c.step();
  return emitted;
}

/** Programm übersetzen und in der Schleife laufen lassen, bis HLT oder Schrittgrenze. */
export function runProgram(m: CpuMachine, source: string, maxSteps = 5000): RunResult {
  const asm = assemble(source);
  const result: RunResult = { asm, outputs: [], steps: 0, halted: false, acc: 0, ram: [] };
  if (asm.errors.length > 0) return result;
  loadWords(m, asm.words);
  while (result.steps < maxSteps && !isHalted(m)) {
    const v = stepInstruction(m);
    if (v !== null) result.outputs.push(v);
    result.steps++;
  }
  result.halted = isHalted(m);
  result.acc = accOf(m);
  result.ram = [...m.ram.data];
  return result;
}
