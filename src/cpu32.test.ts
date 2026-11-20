import { Circuit } from "./circuit";
import { assemble32, formatListing } from "./assembler32";
import { buildCpu32, findCpu32ProgramRom, loadCpu32Program } from "./cpu32";
import { EXAMPLES } from "./examples";
import type { Comp } from "./types";
import { CPU32_PROGRAMS } from "./cpu32-programs";
import { Cpu32Ref, OP, controlTable, decodeWord, disassemble, encodeI, encodeR } from "./cpu32-ref";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.error(`  \u2717 ${name} ${detail}`);
  }
}

const hex = (v: number) => "0x" + (v >>> 0).toString(16);

function runRef(src: string, max = 100000): Cpu32Ref {
  const r = assemble32(src);
  if (r.errors.length) throw new Error(r.errors.map((e) => `Z${e.line}: ${e.message}`).join("; "));
  const cpu = new Cpu32Ref(r.words);
  cpu.run(max);
  return cpu;
}

console.log("RISC-32: Befehlscodierung und Steuer-Tabelle");
{
  const w = encodeR(OP.ADD, 3, 5, 7);
  const f = decodeWord(w);
  check("R-Typ-Felder", f.op === OP.ADD && f.rd === 3 && f.rs1 === 5 && f.rs2 === 7 && w === 0x01357000);
  check("I-Typ imm16", decodeWord(encodeI(OP.ADDI, 1, 2, -1)).imm === 0xffff);
  const t = controlTable();
  check("Steuer-ROM: 256 Einträge, NOP = 0", t.length === 256 && t[0] === 0);
  check("Disassembler", disassemble(encodeR(OP.SUB, 1, 2, 3)) === "SUB R1, R2, R3");
}

console.log("RISC-32: Assembler");
{
  const a = assemble32(`
.equ BASE, 0x10
start: LDI R1, BASE+2     ; Kommentar
       LI R2, 0xDEADBEEF
       LI R3, 0x20000
       LI R4, -7
       LI R5, 'A'
       LD R6, [R1+4]
       ST R6, [R1-1]
       BEQ R1, R2, start
       CALL fn
       HLT
fn:    PUSH R1
       POP R1
       RET
`);
  check("Assembler ohne Fehler", a.errors.length === 0, a.errors.map((e) => e.message).join("; "));
  check("Label start/fn", a.labels.start === 0 && a.labels.fn === 11, JSON.stringify(a.labels));
  check("LDI mit .equ-Ausdruck", a.words[0] === encodeI(OP.LDI, 1, 0, 0x12));
  check("LI 32 Bit = LUI+ORI", a.words[1] === encodeI(OP.LUI, 2, 0, 0xdead) && a.words[2] === encodeI(OP.ORI, 2, 2, 0xbeef));
  check("LI mit niedrigem Teil 0 = LUI", a.words[3] === encodeI(OP.LUI, 3, 0, 2));
  check("LI negativ = LDI", a.words[4] === encodeI(OP.LDI, 4, 0, 0xfff9));
  check("Zeichenkonstante", a.words[5] === encodeI(OP.LDI, 5, 0, 65));
  check("LD/ST mit Offset", a.words[6] === encodeI(OP.LD, 6, 1, 4) && a.words[7] === encodeI(OP.ST, 6, 1, 0xffff));
  check("BEQ: zweites Register im rd-Feld", a.words[8] === encodeI(OP.BEQ, 2, 1, 0));
  check("CALL = JAL R14", a.words[9] === encodeI(OP.JAL, 14, 0, 11));
  check("Listing enthält Zeilen", formatListing(a).split("\n").length === a.words.length);

  const e1 = assemble32("NOP\nFOO R1\nADD R1, R2\nLDI R16, 3\nLDI R1, 40000\nANDI R1, R1, -1\nSHLI R1, R1, 32\nJMP 5000\nJMP nowhere\nx: NOP\nx: NOP\n.org 2000\n.bogus\nLD R1, R2\nLI R1\n");
  const msgs = e1.errors.map((e) => `${e.line}:${e.message}`).join("\n");
  const lines = e1.errors.map((e) => e.line);
  check("Fehler mit Zeilennummern", [2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 14, 15].every((l) => lines.includes(l)), msgs);
  check("Fehlertexte deutsch", /Unbekannter Befehl/.test(msgs) && /erwartet/.test(msgs) && /doppelt/.test(msgs), msgs);
  check("Fehler in Zeile 1 gibt es nicht", !lines.includes(1));

  const over = assemble32(".org 1023\nNOP\nNOP\n");
  check("Programm > 1024 Wörter", over.errors.length > 0 && /zu groß|belegt|Adresse/.test(over.errors[0].message), JSON.stringify(over.errors));
  const ov = assemble32("NOP\n.org 0\nHLT\n");
  check("Überlappendes .org", ov.errors.length === 1 && ov.errors[0].line === 3, JSON.stringify(ov.errors));
  const dw = assemble32(".word 0xFFFFFFFF, 1, 'c'\n");
  check(".word mit Liste", dw.words.length === 3 && dw.words[0] === 0xffffffff && dw.words[2] === 99);
  const bg = assemble32("BGT R1, R2, 0\nBLE R3, R4, 0\nNOT R5\nINC R1\nDEC R1\nCLR R2\nMOV R3, R4\nRET\n");
  check("Pseudobefehle BGT/BLE/NOT/INC/DEC/CLR/MOV/RET", bg.errors.length === 0 && bg.words[0] === encodeI(OP.BLT, 1, 2, 0) && bg.words[1] === encodeI(OP.BGE, 3, 4, 0) && bg.words[2] === encodeI(OP.XORS, 5, 5, 0xffff) && bg.words[7] === encodeI(OP.JR, 0, 14, 0), JSON.stringify(bg.errors));
}

console.log("RISC-32: Referenz-Emulator mit Beispielprogrammen");
{
  const expected: Record<string, number[]> = {
    Fibonacci: [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
    "Summe 1..N": [5050],
    "Multiplikation (Shift-Add)": [7006652],
    "Array sortieren (RAM)": [-5 >>> 0, 0, 3, 7, 19, 42, 77, 100],
    "Unterprogramm (CALL/RET)": [55],
    "32-Bit-Konstanten und Schieben": [0xf0e21567 >>> 0, 0xcc99e897 >>> 0, 0x23456780, 0xd, 1, 0xffffffff],
  };
  for (const p of CPU32_PROGRAMS) {
    const asm = assemble32(p.source);
    check(`${p.name}: assembliert`, asm.errors.length === 0, asm.errors.map((e) => `${e.line}:${e.message}`).join("; "));
    const cpu = new Cpu32Ref(asm.words);
    cpu.run(100000);
    const want = expected[p.name];
    check(`${p.name}: Ausgabe`, JSON.stringify(cpu.outputs) === JSON.stringify(want), cpu.outputs.map(hex).join(",") + " ≠ " + want?.map(hex).join(","));
    check(`${p.name}: angehalten`, cpu.halted);
  }
}

console.log("RISC-32: Emulator-Randfälle");
{
  const c = runRef(`
    CLR R0
    LI R1, 0x7FFFFFFF
    LI R2, 1
    ADD R3, R1, R2      ; Überlauf → 0x80000000
    SUB R4, R0, R2      ; -1
    LI R5, 36
    SHL R6, R2, R5      ; Weite 36&31 = 4
    SHR R7, R4, R5
    BLT R3, R1, a       ; 0x80000000 < 0x7FFFFFFF signed → springt
    LDI R8, 0
    JMP b
a:  LDI R8, 1
b:  BLT R1, R3, c       ; 0x7FFFFFFF < 0x80000000? nein
    LDI R9, 1
    JMP d
c:  LDI R9, 0
d:  HLT
`);
  check("Überlauf ADD", c.regs[3] === 0x80000000);
  check("SUB negativ", c.regs[4] === 0xffffffff);
  check("Schiebeweite nutzt 5 Bit", c.regs[6] === 16 && c.regs[7] === 0x0fffffff);
  check("BLT signed mit Überlauf (min < max)", c.regs[8] === 1);
  check("BLT signed (max < min = falsch)", c.regs[9] === 1);
}

/* ---------- echte Schaltung gegen Referenzmodell ---------- */

interface Rig {
  c: Circuit;
  ref: Cpu32Ref;
  lamp: (label: string) => number;
  regs: () => number[];
  ram: Comp;
  rom: Comp;
}

function rig(src: string): Rig {
  const c = new Circuit();
  buildCpu32(c, src);
  const asm = assemble32(src);
  const comps = [...c.comps.values()];
  const rf = [...c.groups.values()].find((g) => g.moduleId === "std-regfile-32")!;
  const dffs = rf.members.map((id) => c.comps.get(id)!).filter((m) => m.kind === "dff" && m.width === 32);
  const lamps = new Map(comps.filter((m) => m.kind === "output").map((m) => [m.label, m]));
  return {
    c,
    ref: new Cpu32Ref(asm.words),
    lamp: (label) => c.inputValues(lamps.get(label)!)[0] >>> 0,
    regs: () => dffs.map((d) => d.outs[0] >>> 0),
    ram: comps.find((m) => m.kind === "ram")!,
    rom: comps.find((m) => m.kind === "rom" && m.label === "PROGRAMM")!,
  };
}

/** Führt Schaltung und Referenzmodell im Gleichschritt aus; gibt den ersten Unterschied zurück. */
function lockstep(r: Rig, steps: number): string {
  for (let i = 0; i < steps; i++) {
    r.c.step();
    r.ref.step();
    const regs = r.regs();
    const rr = r.ref.regs;
    if (r.lamp("PC") !== (r.ref.pc & 1023)) return `Schritt ${i}: PC ${r.lamp("PC")} ≠ ${r.ref.pc & 1023}`;
    if (r.lamp("OUT") !== r.ref.out) return `Schritt ${i}: OUT ${hex(r.lamp("OUT"))} ≠ ${hex(r.ref.out)}`;
    for (let k = 0; k < 16; k++) if (regs[k] !== rr[k]) return `Schritt ${i}: R${k} ${hex(regs[k])} ≠ ${hex(rr[k])} (PC ${r.ref.pc})`;
  }
  for (let a = 0; a < 1024; a++) {
    if (((r.ram.data[a] ?? 0) >>> 0) !== r.ref.ram[a]) return `RAM[${a}] ${hex(r.ram.data[a])} ≠ ${hex(r.ref.ram[a])}`;
  }
  return "";
}

console.log("RISC-32: Schaltung gegen Referenzmodell (Beispielprogramme)");
{
  const ex = EXAMPLES.find((e) => e.name.startsWith("CPU 32 Bit (RISC"));
  check("Beispieleintrag vorhanden", !!ex);
  const c0 = new Circuit();
  ex?.build(c0);
  const top = [...c0.comps.values()].filter((m) => !c0.groupForComp(m.id)).length + c0.groups.size;
  check("Oberste Ebene hat ≤ 30 Blöcke/Bauteile", top <= 30, String(top));
  check("Programm-ROM wird erkannt", !!findCpu32ProgramRom(c0));
  check("keine ungültigen Kabel/Schleifen", c0.invalidWires.size === 0 && c0.loopComps.size === 0, `${c0.invalidWires.size}/${c0.loopComps.size}`);

  for (const p of CPU32_PROGRAMS) {
    const r = rig(p.source);
    const diff = lockstep(r, new Cpu32Ref(assemble32(p.source).words).run(100000) + 3);
    check(`${p.name}: Schaltung = Referenz`, diff === "", diff);
    const ref = new Cpu32Ref(assemble32(p.source).words);
    ref.run(100000);
    check(`${p.name}: Endwert OUT`, r.lamp("OUT") === ref.out, hex(r.lamp("OUT")));
  }
}

console.log("RISC-32: Schaltung gegen Referenzmodell (alle Befehle, Randfälle)");
{
  const vals = ["0", "1", "-1", "0x7FFFFFFF", "0x80000000", "0x12345678", "0xDEADBEEF", "33"];
  let src = "CLR R0\n";
  for (const a of vals) {
    for (const b of vals) {
      src += `LI R1, ${a}\nLI R2, ${b}\n`;
      for (const op of ["ADD", "SUB", "AND", "OR", "XOR", "SHL", "SHR"]) src += `${op} R3, R1, R2\n`;
    }
  }
  src += "HLT\n";
  const asm = assemble32(src);
  check("R-Typ-Programm passt in den Programmspeicher", asm.errors.length === 0 && asm.words.length <= 1024, asm.errors[0]?.message + " " + asm.words.length);
  const r = rig(src);
  const diff = lockstep(r, asm.words.length + 2);
  check("ADD/SUB/AND/OR/XOR/SHL/SHR über Randwerte", diff === "", diff);
}
{
  let src = "CLR R0\nLI R1, 0x89ABCDEF\n";
  const imms = ["0", "1", "5", "31", "0x7FFF", "-1", "-32768", "32767"];
  for (const m of ["ADDI", "SUBI", "XORS"]) for (const i of imms) src += `${m} R2, R1, ${i}\n`;
  for (const m of ["ANDI", "ORI", "XORI"]) for (const i of ["0", "1", "0x7FFF", "0x8000", "0xFFFF"]) src += `${m} R3, R1, ${i}\n`;
  for (const m of ["SHLI", "SHRI"]) for (const i of ["0", "1", "8", "9", "16", "24", "31"]) src += `${m} R4, R1, ${i}\n`;
  for (const i of ["0", "1", "-1", "0x7FFF", "-32768"]) src += `LDI R5, ${i}\n`;
  for (const i of ["0", "1", "0x7FFF", "0x8000", "0xFFFF"]) src += `LUI R6, ${i}\n`;
  src += "LI R7, 0x80000000\nNOT R8, R7\nNOT R9, R0\nMOV R10, R7\nINC R10\nDEC R10\nDEC R0\nINC R0\nNOP\nHLT\n";
  const asm = assemble32(src);
  check("I-Typ-Programm assembliert", asm.errors.length === 0, asm.errors[0]?.message);
  const diff = lockstep(rig(src), asm.words.length + 2);
  check("ADDI/SUBI/XORS/ANDI/ORI/XORI/SHLI/SHRI/LDI/LUI/NOT/MOV/INC/DEC", diff === "", diff);
}
{
  const vals = ["0", "1", "-1", "0x7FFFFFFF", "0x80000000", "-5"];
  let src = "CLR R0\nCLR R5\n";
  let n = 0;
  for (const a of vals) {
    for (const b of vals) {
      src += `LI R1, ${a}\nLI R2, ${b}\n`;
      for (const br of ["BEQ", "BNE", "BLT", "BGE", "BGT", "BLE"]) {
        src += `${br} R1, R2, L${n}\nADDI R5, R5, 1\nL${n}: ADDI R6, R6, 1\n`;
        n++;
      }
    }
  }
  src += "OUT R5\nHLT\n";
  const asm = assemble32(src);
  check("Branch-Programm assembliert", asm.errors.length === 0 && asm.words.length <= 1024, asm.errors[0]?.message + " " + asm.words.length);
  const r = rig(src);
  const diff = lockstep(r, 1000);
  check("BEQ/BNE/BLT/BGE (auch signed/Überlauf) über Randwerte", diff === "", diff);
  const ref = new Cpu32Ref(asm.words);
  ref.run(5000);
  check("Branch: mindestens 100 nicht genommene und genommene Sprünge", ref.regs[5] > 100 && ref.regs[6] > 200, `${ref.regs[5]}/${ref.regs[6]}`);
}
{
  const src = `
    CLR R0
    LI R1, 0xCAFEBABE
    LI R2, 1023
    LI R3, 1024        ; Adresse 1024 → 0 (nur untere 10 Bit)
    ST R1, [R0+0]
    ST R1, [R2+0]
    ST R2, [R3+5]
    LD R4, [R0+0]
    LD R5, [R2+0]
    LD R6, [R3+5]
    LD R7, [R2+2]      ; 1025 → 1
    LI R8, 3
    ST R8, [R2+2]
    LD R9, [R0+1]
    LDI R10, -1
    ST R1, [R10+0]     ; -1 → 1023
    LD R11, [R10+0]
    JAL R12, sub
    OUT R12
    LDI R13, back
    JR R13
    LDI R14, 99
back: JMP end
    LDI R14, 77
sub: ADDI R15, R12, 100
    LI R7, 0x12345
    JR R12
end: HLT
    LDI R1, 1
`;
  const asm = assemble32(src);
  check("Speicher-/Sprung-Programm assembliert", asm.errors.length === 0, asm.errors[0]?.message);
  const r = rig(src);
  const n = new Cpu32Ref(asm.words).run(1000);
  const diff = lockstep(r, n + 20);
  check("LD/ST/JAL/JR/HLT: Schaltung = Referenz", diff === "", diff);
  check("HLT hält den PC an", r.lamp("PC") === asm.labels.end);
}

console.log("RISC-32: Zufallsprogramme (alle Opcodes inkl. unbelegte)");
{
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) % n;
  };
  const ops = Object.values(OP).filter((o) => o !== OP.HLT);
  const interesting = [0, 1, 0xffff, 0x8000, 0x7fff, 31, 32, 1023, 1024];
  for (let t = 0; t < 4; t++) {
    const words: number[] = [];
    for (let i = 0; i < 1024; i++) {
      const op = rnd(12) === 0 ? rnd(256) : ops[rnd(ops.length)];
      const imm = rnd(3) === 0 ? interesting[rnd(interesting.length)] : rnd(1024);
      words.push(encodeI(op === OP.HLT ? 0 : op, rnd(16), rnd(16), op >= 0x40 && op < 0x50 ? rnd(1024) : imm));
    }
    const c = new Circuit();
    buildCpu32(c);
    const rom = findCpu32ProgramRom(c)!;
    loadCpu32Program(c, rom, words);
    const ref = new Cpu32Ref(words);
    const comps = [...c.comps.values()];
    const rf = [...c.groups.values()].find((g) => g.moduleId === "std-regfile-32")!;
    const dffs = rf.members.map((id) => c.comps.get(id)!).filter((m) => m.kind === "dff" && m.width === 32);
    const lamps = new Map(comps.filter((m) => m.kind === "output").map((m) => [m.label, m]));
    const ram = comps.find((m) => m.kind === "ram")!;
    let diff = "";
    for (let i = 0; i < 600 && !diff; i++) {
      c.step();
      ref.step();
      if ((c.inputValues(lamps.get("PC")!)[0] >>> 0) !== (ref.pc & 1023)) diff = `Schritt ${i}: PC`;
      for (let k = 0; k < 16 && !diff; k++) if (dffs[k].outs[0] >>> 0 !== ref.regs[k]) diff = `Schritt ${i}: R${k} ${hex(dffs[k].outs[0])} ≠ ${hex(ref.regs[k])}`;
      if (!diff && (c.inputValues(lamps.get("OUT")!)[0] >>> 0) !== ref.out) diff = `Schritt ${i}: OUT`;
    }
    for (let a = 0; a < 1024 && !diff; a++) if ((ram.data[a] >>> 0) !== ref.ram[a]) diff = `RAM[${a}]`;
    check(`Zufallsprogramm ${t + 1} (600 Takte)`, diff === "", diff);
  }
}

console.log("RISC-32: Neustart und Geschwindigkeit");
{
  const src = CPU32_PROGRAMS[0].source;
  const r = rig(src);
  for (let i = 0; i < 20; i++) r.c.step();
  const out1 = r.lamp("OUT");
  r.c.reset();
  check("RESET setzt PC und OUT zurück (Register bleiben)", r.lamp("PC") === 0 && r.lamp("OUT") === 0 && out1 !== 0);
  const t0 = performance.now();
  const N = 300;
  for (let i = 0; i < N; i++) r.c.step();
  const ms = performance.now() - t0;
  const rate = (N / ms) * 1000;
  console.log(`  Takte/s (Node): ${Math.round(rate)} (${(ms / N).toFixed(2)} ms je Takt)`);
  check("Mindestens 60 Takte/s", rate >= 60, rate.toFixed(0));
}

console.log(`\n${passed} Tests bestanden, ${failed} fehlgeschlagen.`);
if (failed > 0) process.exit(1);
