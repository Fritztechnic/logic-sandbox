import * as C from "./tutorial/circuits";
import { Rig, truthTable } from "./tutorial/rig";
import { chapters } from "./tutorial/content";
import { buildCpuMachine, controlRomContents, INSTRUCTIONS, runProgram } from "./tutorial/isa";
import { assemble } from "./assembler";
import { EX_ADD, EX_COUNT, EX_FIB, EX_LOGIC, EX_LOOP, EX_MUL, PROG_TASKS } from "./tutorial/content3";

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

console.log("Kapitel-Schaltungen bauen");
const builders: Record<string, () => Rig> = {
  lampDemo: C.lampDemo, numberDemo: C.numberDemo, gateLab: C.gateLab, nandUniversal: C.nandUniversal,
  halfAdderDemo: C.halfAdderDemo, fullAdderDemo: C.fullAdderDemo, adder4: C.adder4, addSub4: C.addSub4,
  mux1: C.mux1, mux4: C.mux4, logicUnit: C.logicUnit, alu4: C.alu4, latchDemo: C.latchDemo,
  flipFlopDemo: C.flipFlopDemo, register8: C.register8, counter4: C.counter4, pc4: C.pc4,
  decoder2: C.decoder2, romDemo: C.romDemo, ramDemo: C.ramDemo,
};
for (const [name, build] of Object.entries(builders)) {
  let r: Rig | null = null;
  try {
    r = build();
  } catch (e) {
    check(`${name} baut`, false, String(e));
    continue;
  }
  const ov = r.overlaps();
  check(`${name}: keine überlappenden Bauteile`, ov.length === 0, ov.slice(0, 3).join("; "));
  check(`${name}: keine Schleifen/ungültigen Kabel`, r.c.loopComps.size === 0 && r.c.invalidWires.size === 0);
}


const tt = (r: Rig, ins: string[], outs: string[]) => truthTable(r, ins, outs).map((x) => [...x.ins, ...x.outs].join(""));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

console.log("Gatter und Addierer");
const rows2 = (f: (a: number, b: number) => number[]): string[] => [0, 1, 2, 3].map((k) => [k >> 1, k & 1, ...f(k >> 1, k & 1)].join(""));
check("gateLab", same(tt(C.gateLab(), ["A", "B"], ["AND", "OR", "NAND", "NOR", "XOR", "XNOR"]), rows2((a, b) => [a & b, a | b, 1 - (a & b), 1 - (a | b), a ^ b, 1 - (a ^ b)])));
check("nandUniversal", same(tt(C.nandUniversal(), ["A", "B"], ["NOT", "AND", "OR"]), rows2((a, b) => [1 - a, a & b, a | b])));
check("Halbaddierer", same(tt(C.halfAdderDemo(), ["A", "B"], ["S", "C"]), ["0000", "0110", "1010", "1101"]));
{
  const r = C.fullAdderDemo();
  let ok = true;
  for (let k = 0; k < 8; k++) {
    r.set("A", k >> 2);
    r.set("B", (k >> 1) & 1);
    r.set("CIN", k & 1);
    const t = (k >> 2) + ((k >> 1) & 1) + (k & 1);
    ok &&= r.get("S") === (t & 1) && r.get("COUT") === t >> 1;
  }
  check("Volladdierer: alle 8 Fälle", ok);
}
{
  const r = C.adder4();
  let ok = true;
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (let c = 0; c < 2; c++) {
    r.set("A", a); r.set("B", b); r.set("CIN", c);
    const t = a + b + c;
    ok &&= r.get("SUM") === (t & 15) && r.get("COUT") === t >> 4;
  }
  check("adder4: alle 512 Kombinationen", ok);
}
{
  const r = C.addSub4();
  let ok = true;
  let bad = "";
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (let sub = 0; sub < 2; sub++) {
    r.set("A", a); r.set("B", b); r.set("SUB", sub);
    const t = sub ? a + ((~b) & 15) + 1 : a + b;
    const e = t & 15;
    const good = r.get("ERG") === e && r.get("C") === t >> 4 && r.get("N") === e >> 3 && r.get("Z") === (e === 0 ? 1 : 0);
    if (!good && ok) bad = `${a} ${sub ? "-" : "+"} ${b}`;
    ok &&= good;
  }
  check("addSub4: Ergebnis und Flags", ok, bad);
}

console.log("Mux, Logikeinheit, ALU");
check("mux1", same(tt(C.mux1(), ["A", "B", "S"], ["Y"]), [0, 1, 2, 3, 4, 5, 6, 7].map((i) => { const a = i >> 2, b = (i >> 1) & 1, sel = i & 1; return `${a}${b}${sel}${sel ? b : a}`; })));
{
  const r = C.mux4();
  let ok = true;
  for (const [a, b] of [[10, 6], [3, 12], [0, 15]]) for (const s of [0, 1]) {
    r.set("A", a); r.set("B", b); r.set("S", s);
    ok &&= r.get("Y") === (s ? b : a);
  }
  check("mux4", ok);
}
{
  const r = C.logicUnit();
  let ok = true;
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (let sel = 0; sel < 4; sel++) {
    r.set("A", a); r.set("B", b); r.set("SEL", sel);
    const e = [a & b, a | b, a ^ b, ~a & 15][sel];
    ok &&= r.get("Y") === e;
  }
  check("logicUnit: alle Kombinationen", ok);
}
{
  const r = C.alu4();
  let ok = true;
  let bad = "";
  for (let mode = 0; mode < 8; mode++) for (let en = 0; en < 2; en++) for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
    r.set("MODE", mode); r.set("EN", en); r.set("A", a); r.set("B", b);
    const good = r.get("F") === C.aluRef(4, mode, en, a, b);
    if (!good && ok) bad = `mode ${mode} en ${en} a ${a} b ${b} → ${r.get("F")}`;
    ok &&= good;
  }
  check("alu4 = aluRef (alle Modi, EN, A, B)", ok, bad);
}

console.log("Speicher und Zähler");
{
  const r = C.latchDemo();
  r.set("EN", 1); r.set("D", 1);
  const t1 = r.get("Q") === 1;
  r.set("EN", 0); r.set("D", 0);
  check("D-Latch hält", t1 && r.get("Q") === 1);
  r.set("EN", 1);
  check("D-Latch transparent", r.get("Q") === 0);
}
{
  const r = C.flipFlopDemo();
  r.set("D", 1);
  const before = r.get("Q");
  r.step();
  const after = r.get("Q");
  r.set("D", 0);
  check("Flip-Flop übernimmt bei Flanke", before === 0 && after === 1 && r.get("Q") === 1);
}
{
  const r = C.register8();
  r.set("DATA", 0x42); r.set("LOAD", 1); r.step();
  r.set("LOAD", 0); r.set("DATA", 7); r.step(3);
  check("Register 8 Bit hält ohne LADEN", r.get("Q") === 0x42);
  r.set("LOAD", 1); r.step();
  check("Register lädt neuen Wert", r.get("Q") === 7);
}
{
  const r = C.counter4();
  const seq: number[] = [];
  for (let i = 0; i < 18; i++) { r.step(); seq.push(r.get("Q")); }
  check("counter4 zählt 1…15, 0, 1, 2", same(seq, [...Array.from({ length: 15 }, (_, i) => i + 1), 0, 1, 2]), seq.join(","));
  r.set("RST", 1); r.step();
  check("counter4 Reset", r.get("Q") === 0);
}
{
  const r = C.pc4();
  r.step(5);
  check("pc4 zählt", r.get("OUT") === 5);
  r.set("ZIEL", 12); r.set("JUMP", 1); r.step(); r.set("JUMP", 0);
  check("pc4 Sprung", r.get("OUT") === 12);
  r.set("HALT", 1); r.step(3);
  check("pc4 Halt", r.get("OUT") === 12);
  r.set("HALT", 0); r.step(5);
  check("pc4 läuft über (4 Bit)", r.get("OUT") === 1);
}
check("decoder2", same(tt(C.decoder2(), ["A1", "A0"], ["W0", "W1", "W2", "W3"]), [0, 1, 2, 3].map((k) => `${k >> 1}${k & 1}${[0, 1, 2, 3].map((w) => (w === k ? 1 : 0)).join("")}`)));
{
  const r = C.romDemo();
  let ok = true;
  C.ROM_DEMO_DATA.forEach((v, i) => { r.set("ADR", i); ok &&= r.get("DATA") === v; });
  check("ROM liefert den Inhalt", ok);
}
{
  const r = C.ramDemo();
  r.set("ADR", 5); r.set("DIN", 0x2a); r.set("WE", 1); r.step(); r.set("WE", 0);
  r.set("ADR", 6);
  const other = r.get("DOUT");
  r.set("ADR", 5);
  check("RAM schreiben/lesen", r.get("DOUT") === 0x2a && other === 0);
}

console.log("Steuerwerk und CPU");
const real = buildCpuMachine();
check("Steuer-ROM der Tabelle = echtes Steuer-ROM", same(controlRomContents(), real.ctrl.data.slice(0, 256)));
{
  let ok = true;
  let bad = "";
  for (const ins of INSTRUCTIONS) {
    const line = ins.operand === "none" ? ins.mnemonic : ins.operand === "imm" ? `${ins.mnemonic} #3` : `${ins.mnemonic} 0x10`;
    const a = assemble(line);
    const good = a.errors.length === 0 && a.words[0] >> 8 === ins.opcode;
    if (!good) bad = line;
    ok &&= good;
  }
  check("Befehlstabelle = Assembler", ok, bad);
}
{
  const r = C.ctrlDemo(controlRomContents());
  r.set("OP", 0x03);
  check("ctrlDemo: STA setzt WE", r.get("WE") === 1 && r.get("EN") === 0);
  r.set("OP", 0x04);
  check("ctrlDemo: ADD #n", r.get("EN") === 1 && r.get("MODE") === 1 && r.get("MEM") === 0);
}
const m = buildCpuMachine();
const run = (src: string) => runProgram(m, src);
check("Programm 17+25", same(run(EX_ADD).outputs, [42]) && run(EX_ADD).halted);
check("Programm Maskieren", same(run(EX_LOGIC).outputs, [0x0b, 0xf4]));
check("Programm Zählen 1…10", same(run(EX_COUNT).outputs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
check("Programm Abwärts", same(run(EX_LOOP).outputs, [5, 4, 3, 2, 1]));
check("Programm 6×7", same(run(EX_MUL).outputs, [42]));
check("Programm Fibonacci", same(run(EX_FIB).outputs, [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]));
check("Fehler werden gemeldet", assemble("FOO 1").errors.length > 0);

console.log("Kapitel und Aufgaben");
check("Kapitel 0…13 lückenlos", same(chapters.map((c) => c.num), Array.from({ length: 14 }, (_, i) => i)));
const ids = new Set<string>();
let dup = "";
const reg = (id: string): void => { if (ids.has(id)) dup = id; ids.add(id); };
for (const c of chapters) {
  reg("ch:" + c.id);
  for (const b of c.blocks) {
    if (b.t === "demo") {
      const d = b.demo;
      const fresh = d.build();
      check(`${c.id}/${d.id}: baut, ohne Überlappung/Schleifen`, fresh.overlaps().length === 0 && fresh.c.loopComps.size === 0 && fresh.c.invalidWires.size === 0);
      check(`${c.id}/${d.id}: hat Selbst-bauen-Schritte`, d.steps.length > 0);
      if (d.readout) check(`${c.id}/${d.id}: Readout funktioniert`, typeof d.readout(fresh) === "string");
      for (const t of d.tasks ?? []) {
        reg(t.id);
        const r0 = d.build();
        const startOk = t.check(r0);
        const r1 = d.build();
        t.solve(r1);
        check(`Aufgabe ${t.id}: Ausgang ✗, Lösung ✓`, !startOk && t.check(r1), `start=${startOk}`);
      }
    }
    if (b.t === "cpu") {
      for (const t of b.cpu.tasks ?? []) {
        reg(t.id);
        check(`Programmaufgabe ${t.id}: leeres Programm ✗`, !t.check(run("HLT")));
        const res = run(t.solution);
        check(`Programmaufgabe ${t.id}: Musterlösung ✓`, res.asm.errors.length === 0 && t.check(res), `Ausgabe ${res.outputs.join(",")}`);
      }
      check(`${c.id}: Beispiele assemblieren`, (b.cpu.examples ?? []).every((e) => assemble(e.src).errors.length === 0));
    }
  }
}
check("IDs eindeutig", dup === "", dup);
check("PROG_TASKS sind in Kapitel 12", PROG_TASKS.every((t) => ids.has(t.id)));

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exit(1);
