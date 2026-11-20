import { Circuit } from "./circuit";
import { Renderer } from "./render";
import { CELL, Comp, CompKind, EditorState, Point } from "./types";
import { EXAMPLES } from "./examples";
import { assemble } from "./assembler";
import {
  addModule,
  buildModuleDef,
  createModuleFromSelection,
  editableCircuitForDef,
  editableCircuitForGroup,
  findModuleSpot,
  getModule,
  importModuleDefs,
  instantiateModule,
  listModules,
  moduleBlockDefaults,
  removeModule,
  replaceGroupInternals,
  replaceModuleInstances,
} from "./modules";
import { buildCpu, CPU_MODULE_IDS, cpuModuleIds, ensureCpuModules } from "./cpu";
import { getWireRoutes } from "./route";
import { layoutOf } from "./logic";
import { computeExpandedLayout, savedExpandedLayout } from "./expand";
import { Editor } from "./editor";
import { parseCircuit } from "./persistence";

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

function add(c: Circuit, kind: CompKind, x = 0, y = 0, opts: Partial<Comp> = {}): Comp {
  const comp = c.addComp(kind, x, y);
  Object.assign(comp, opts);
  return comp;
}

function link(c: Circuit, a: Comp, ap: number, b: Comp, bp: number): void {
  const w = c.addWire(a.id, ap, b.id, bp);
  if (!w) throw new Error(`wire ${a.kind}->${b.kind} failed`);
}

function out(comp: Comp, port = 0): number {
  return comp.outs[port] ?? 0;
}

function inputValue(c: Circuit, comp: Comp, v: number): void {
  c.setInputValue(comp, v);
}

console.log("Logikgatter & Kombination");

{
  const c = new Circuit();
  const a = add(c, "input");
  const b = add(c, "input");
  const and = add(c, "and", 5, 0);
  const or = add(c, "or", 5, 3);
  const xor = add(c, "xor", 5, 6);
  const nand = add(c, "nand", 10, 0);
  const not = add(c, "not", 10, 3);
  const buf = add(c, "buf", 10, 5);
  link(c, a, 0, and, 0);
  link(c, b, 0, and, 1);
  link(c, a, 0, or, 0);
  link(c, b, 0, or, 1);
  link(c, a, 0, xor, 0);
  link(c, b, 0, xor, 1);
  link(c, a, 0, nand, 0);
  link(c, b, 0, nand, 1);
  link(c, a, 0, not, 0);
  link(c, a, 0, buf, 0);
  c.rebuild();

  for (const [x, y, eand, eor, exor, enand, enot] of [
    [0, 0, 0, 0, 0, 1, 1],
    [0, 1, 0, 1, 1, 1, 1],
    [1, 0, 0, 1, 1, 1, 0],
    [1, 1, 1, 1, 0, 0, 0],
  ] as const) {
    inputValue(c, a, x);
    inputValue(c, b, y);
    c.evalComb();
    check(`AND(${x},${y})=${eand}`, out(and) === eand);
    check(`OR(${x},${y})=${eor}`, out(or) === eor);
    check(`XOR(${x},${y})=${exor}`, out(xor) === exor);
    check(`NAND(${x},${y})=${enand}`, out(nand) === enand);
    check(`NOT(${x})=${enot}`, out(not) === enot);
    check(`BUF(${x})=${x}`, out(buf) === x);
  }
}

console.log("Busse (Splitter/Joiner) & breite Gatter");

{
  const c = new Circuit();
  const src = add(c, "input", 0, 0, { width: 4, value: 0b1101 });
  const sp = add(c, "splitter", 4, 0, { width: 4 });
  link(c, src, 0, sp, 0);
  c.rebuild();
  c.evalComb();
  check("Splitter b3=1", out(sp, 0) === 1);
  check("Splitter b2=1", out(sp, 1) === 1);
  check("Splitter b1=0", out(sp, 2) === 0);
  check("Splitter b0=1", out(sp, 3) === 1);

  const jn = add(c, "joiner", 10, 0, { width: 4 });
  for (let i = 0; i < 4; i++) link(c, sp, i, jn, i);
  const lamp = add(c, "output", 16, 0, { width: 4 });
  link(c, jn, 0, lamp, 0);
  c.rebuild();
  c.evalComb();
  check("Splitter→Joiner Roundtrip = 0b1101", out(jn) === 0b1101);

  const notWide = add(c, "not", 10, 4, { width: 8 });
  const in8 = add(c, "input", 0, 4, { width: 8, value: 0b00001111 });
  link(c, in8, 0, notWide, 0);
  c.rebuild();
  c.evalComb();
  check("NOT 8-bit = 0xF0", out(notWide) === 0xf0);
}

console.log("Halbaddierer (aus Beispielen)");

{
  const build = EXAMPLES.find((e) => e.name.startsWith("Halbaddierer"))!.build;
  const c = new Circuit();
  build(c);
  c.rebuild();
  c.reset();
  const inputs = [...c.comps.values()].filter((x) => x.kind === "input");
  const outputs = [...c.comps.values()].filter((x) => x.kind === "output");
  check("2 Eingänge, 2 Ausgänge", inputs.length === 2 && outputs.length === 2);
  const [a, b] = inputs;
  const sumLamp = outputs[0];
  const carryLamp = outputs[1];
  for (const [x, y] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const) {
    c.setInputValue(a, x);
    c.setInputValue(b, y);
    c.evalComb();
    check(`Halbaddierer ${x}+${y} Summe=${x ^ y}`, c.inputValues(sumLamp)[0] === (x ^ y));
    check(`Halbaddierer ${x}+${y} Übertrag=${x & y}`, c.inputValues(carryLamp)[0] === (x & y));
  }
}

console.log("Volladdierer (aus Beispielen)");

{
  const build = EXAMPLES.find((e) => e.name.startsWith("Volladdierer"))!.build;
  const c = new Circuit();
  build(c);
  c.rebuild();
  c.reset();
  const inputs = [...c.comps.values()].filter((x) => x.kind === "input");
  const outputs = [...c.comps.values()].filter((x) => x.kind === "output");
  const sumLamp = outputs[0];
  const carryLamp = outputs[1];
  for (const [x, y, z] of [
    [0, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
    [0, 1, 1],
    [1, 0, 0],
    [1, 0, 1],
    [1, 1, 0],
    [1, 1, 1],
  ] as const) {
    c.setInputValue(inputs[0], x);
    c.setInputValue(inputs[1], y);
    c.setInputValue(inputs[2], z);
    c.evalComb();
    const total = x + y + z;
    check(
      `Volladdierer ${x}+${y}+${z}=${total}`,
      c.inputValues(sumLamp)[0] === (total & 1) && c.inputValues(carryLamp)[0] === (total >> 1)
    );
  }
}

console.log("4-Bit-Addierer (aus Beispielen)");

{
  const build = EXAMPLES.find((e) => e.name.startsWith("4-Bit"))!.build;
  const c = new Circuit();
  build(c);
  c.rebuild();
  c.reset();
  const inputs = [...c.comps.values()].filter((x) => x.kind === "input");
  const outputs = [...c.comps.values()].filter((x) => x.kind === "output");
  const sumLamp = outputs.find((o) => o.width === 4)!;
  const carryLamp = outputs.find((o) => o.width === 1)!;
  for (const [x, y] of [
    [0, 0],
    [5, 3],
    [10, 6],
    [15, 1],
    [15, 15],
    [7, 9],
  ] as const) {
    c.setInputValue(inputs[0], x);
    c.setInputValue(inputs[1], y);
    c.evalComb();
    const total = x + y;
    const sum = c.inputValues(sumLamp)[0];
    const carry = c.inputValues(carryLamp)[0];
    check(`4-Bit ${x}+${y}=${total}`, sum === (total & 0xf) && carry === (total >> 4));
  }
}

console.log("D-Flip-Flop (Taktflanke) & Reset");

{
  const c = new Circuit();
  const clk = add(c, "clock", 0, 0, { div: 1 });
  const d = add(c, "input", 0, 3);
  const dff = add(c, "dff", 6, 0, { width: 1 });
  const rst = add(c, "input", 0, 6);
  link(c, clk, 0, dff, 1);
  link(c, d, 0, dff, 0);
  link(c, rst, 0, dff, 2);
  c.rebuild();
  c.reset();

  c.setInputValue(d, 1);
  c.halfStep(); // Takt 0 -> 1: Flanke
  check("DFF übernimmt D=1 bei steigender Flanke", out(dff) === 1);

  c.setInputValue(d, 0);
  c.halfStep(); // Takt 1 -> 0
  check("DFF hält Wert bei fallender Flanke", out(dff) === 1);
  c.halfStep(); // Takt 0 -> 1
  check("DFF übernimmt D=0", out(dff) === 0);

  c.setInputValue(d, 1);
  c.setInputValue(rst, 1);
  c.halfStep();
  check("Reset setzt Q=0", out(dff) === 0);
  c.setInputValue(rst, 0);

  const qbar = dff.outs[1];
  check("Q̄ ist invertiert", qbar === 1 - (out(dff) & 1));
}

console.log("D-Latch (transparent bei EN=1)");

{
  const c = new Circuit();
  const d = add(c, "input", 0, 0);
  const en = add(c, "input", 0, 3);
  const l = add(c, "latch", 6, 0, { width: 1 });
  link(c, d, 0, l, 0);
  link(c, en, 0, l, 1);
  c.rebuild();
  c.reset();

  c.setInputValue(en, 1);
  c.setInputValue(d, 1);
  c.evalComb();
  check("Latch folgt D bei EN=1", out(l) === 1);
  c.setInputValue(d, 0);
  c.evalComb();
  check("Latch folgt D erneut", out(l) === 0);
  c.setInputValue(en, 0);
  c.setInputValue(d, 1);
  c.evalComb();
  check("Latch hält Wert bei EN=0", out(l) === 0);
}

console.log("ROM & RAM");

{
  const c = new Circuit();
  const addr = add(c, "input", 0, 0, { width: 4, value: 3 });
  const rom = add(c, "rom", 6, 0, { addrWidth: 4, dataWidth: 8 });
  rom.data[3] = 0x2a;
  rom.data[1] = 0x99;
  link(c, addr, 0, rom, 0);
  c.rebuild();
  c.reset();
  c.setInputValue(addr, 3);
  c.evalComb();
  check("ROM liest Adresse 3 = 0x2A", out(rom) === 0x2a);
  c.setInputValue(addr, 1);
  c.evalComb();
  check("ROM liest Adresse 1 = 0x99", out(rom) === 0x99);

  const raddr = add(c, "input", 0, 6, { width: 4, value: 2 });
  const din = add(c, "input", 0, 9, { width: 8, value: 0x55 });
  const we = add(c, "input", 0, 12, { width: 1, value: 1 });
  const clk = add(c, "clock", 0, 15, { div: 1 });
  const ram = add(c, "ram", 6, 6, { addrWidth: 4, dataWidth: 8 });
  link(c, raddr, 0, ram, 0);
  link(c, din, 0, ram, 1);
  link(c, we, 0, ram, 2);
  link(c, clk, 0, ram, 3);
  c.rebuild();
  c.reset();
  c.step(); // Flanke mit WE=1 -> schreiben
  check("RAM schreibt 0x55 nach Adresse 2", ram.data[2] === 0x55);
  c.setInputValue(we, 0);
  c.setInputValue(din, 0x11);
  c.step();
  c.step();
  check("RAM schreibt nicht bei WE=0", ram.data[2] === 0x55);
  c.setInputValue(raddr, 2);
  c.evalComb();
  check("RAM liest 0x55", out(ram) === 0x55);
}

console.log("Fehlererkennung: Schleife & Breitenkonflikt");

{
  const c = new Circuit();
  const n1 = add(c, "not", 0, 0);
  const n2 = add(c, "not", 6, 0);
  link(c, n1, 0, n2, 0);
  link(c, n2, 0, n1, 0);
  c.rebuild();
  check("kombinatorische Schleife erkannt", c.loopComps.size >= 2);

  const c2 = new Circuit();
  const wide = add(c2, "input", 0, 0, { width: 4 });
  const narrow = add(c2, "not", 6, 0, { width: 1 });
  const wire = c2.addWire(wide.id, 0, narrow.id, 0);
  c2.rebuild();
  check("Breitenkonflikt blockiert Verbindung", wire === null);

  const mismatch = add(c2, "and", 6, 3, { width: 1 });
  c2.wires.push({ id: "bad", from: wide.id, fromPort: 0, to: mismatch.id, toPort: 0 });
  c2.rebuild();
  check("inkompatibles Kabel markiert", c2.invalidWires.size === 1);
}

console.log("4-Bit-Zähler zählt binär");

{
  const build = EXAMPLES.find((e) => e.name.startsWith("4-Bit-Zähler"))!.build;
  const c = new Circuit();
  build(c);
  c.rebuild();
  c.reset();
  const dffs = [...c.comps.values()].filter((x) => x.kind === "dff");
  check("4 D-Flip-Flops", dffs.length === 4);
  const value = () =>
    dffs.reduce((acc, d, i) => acc | ((d.outs[0] & 1) << i), 0) & 0xf;
  const seen: number[] = [];
  for (let i = 0; i < 18; i++) {
    seen.push(value());
    c.step();
  }
  const expected = Array.from({ length: 18 }, (_, i) => i & 0xf);
  check(
    "Zählerfolge 0..15, 0, 1",
    seen.join(",") === expected.join(","),
    `erhalten: ${seen.join(",")}`
  );
}

console.log("16-Bit-Addierer (aus Beispielen)");

{
  const build = EXAMPLES.find((e) => e.name.startsWith("16-Bit-Addierer"))!.build;
  const c = new Circuit();
  build(c);
  c.rebuild();
  c.reset();
  const inputs = [...c.comps.values()].filter((x) => x.kind === "input");
  const outputs = [...c.comps.values()].filter((x) => x.kind === "output");
  const sumLamp = outputs.find((o) => o.width === 16)!;
  const carryLamp = outputs.find((o) => o.width === 1)!;
  for (const [x, y] of [
    [0, 0],
    [0x1234, 0x0fed],
    [0xffff, 1],
    [0xffff, 0xffff],
    [0x8000, 0x8000],
    [0x00ff, 0xff00],
  ] as const) {
    c.setInputValue(inputs[0], x);
    c.setInputValue(inputs[1], y);
    c.evalComb();
    const total = x + y;
    const sum = c.inputValues(sumLamp)[0] & 0xffff;
    const carry = c.inputValues(carryLamp)[0] & 1;
    check(
      `16-Bit ${x}+${y}=${total}`,
      sum === (total & 0xffff) && carry === (total >> 16),
      `Summe=${sum.toString(16)} Übertrag=${carry}`
    );
  }
}

console.log("32-Bit-Addierer (aus Beispielen)");

{
  const build = EXAMPLES.find((e) => e.name.startsWith("32-Bit-Addierer"))!.build;
  const c = new Circuit();
  build(c);
  c.rebuild();
  c.reset();
  const inputs = [...c.comps.values()].filter((x) => x.kind === "input");
  const outputs = [...c.comps.values()].filter((x) => x.kind === "output");
  const sumLamp = outputs.find((o) => o.width === 32)!;
  const carryLamp = outputs.find((o) => o.width === 1)!;
  for (const [x, y] of [
    [0, 0],
    [0x12345678, 0x0fedcba9],
    [0xffffffff, 1],
    [0xffffffff, 0xffffffff],
    [0x80000000, 0x80000000],
    [0xdeadbeef, 0x00000001],
  ] as const) {
    c.setInputValue(inputs[0], x);
    c.setInputValue(inputs[1], y);
    c.evalComb();
    const total = x + y;
    const expectedSum = total % 0x100000000;
    const expectedCarry = total >= 0x100000000 ? 1 : 0;
    const sum = c.inputValues(sumLamp)[0] >>> 0;
    const carry = c.inputValues(carryLamp)[0] & 1;
    check(
      `32-Bit ${x.toString(16)}+${y.toString(16)}`,
      sum === expectedSum && carry === expectedCarry,
      `Summe=0x${sum.toString(16)} Übertrag=${carry}`
    );
  }
}

console.log("16-Bit-Zähler zählt und läuft über");

{
  const build = EXAMPLES.find((e) => e.name.startsWith("16-Bit-Zähler"))!.build;
  const c = new Circuit();
  build(c);
  c.rebuild();
  c.reset();
  const dffs = [...c.comps.values()].filter((x) => x.kind === "dff");
  check("16 D-Flip-Flops", dffs.length === 16);
  const outComp = [...c.comps.values()].find((x) => x.kind === "output" && x.width === 16)!;
  const read = () => c.inputValues(outComp)[0] >>> 0;

  check("Startwert 0", read() === 0);
  c.step();
  c.step();
  c.step();
  check("nach 3 Schritten 3", read() === 3, `erhalten: ${read()}`);

  const preload = (value: number) => {
    dffs.forEach((d, i) => {
      d.outs[0] = (value >>> i) & 1;
      d.outs[1] = (~(value >>> i)) & 1;
    });
    c.evalComb();
  };
  preload(0xfffe);
  c.step();
  check("0xFFFE + 1 = 0xFFFF", read() === 0xffff, `erhalten: 0x${read().toString(16)}`);
  c.step();
  check("0xFFFF + 1 = 0x0000", read() === 0, `erhalten: 0x${read().toString(16)}`);
}

console.log("32-Bit-Zähler zählt und läuft über");

{
  const build = EXAMPLES.find((e) => e.name.startsWith("32-Bit-Zähler"))!.build;
  const c = new Circuit();
  build(c);
  c.rebuild();
  c.reset();
  const dffs = [...c.comps.values()].filter((x) => x.kind === "dff");
  check("32 D-Flip-Flops", dffs.length === 32);
  const outComp = [...c.comps.values()].find((x) => x.kind === "output" && x.width === 32)!;
  const read = () => c.inputValues(outComp)[0] >>> 0;

  check("Startwert 0", read() === 0);
  c.step();
  c.step();
  check("nach 2 Schritten 2", read() === 2, `erhalten: ${read()}`);

  const preload = (value: number) => {
    dffs.forEach((d, i) => {
      d.outs[0] = (value >>> i) & 1;
      d.outs[1] = (~(value >>> i)) & 1;
    });
    c.evalComb();
  };
  preload(0xfffffffe);
  c.step();
  check("0xFFFFFFFE + 1 = 0xFFFFFFFF", read() === 0xffffffff, `erhalten: 0x${read().toString(16)}`);
  c.step();
  check("0xFFFFFFFF + 1 = 0x00000000", read() === 0, `erhalten: 0x${read().toString(16)}`);
}

console.log("Mini-CPU (8 Bit, Module + externes ROM/RAM)");

{
  const ex = EXAMPLES.find((e) => e.name.startsWith("Mini-CPU"))!;
  const c = new Circuit();
  ex.build(c);
  c.rebuild();
  c.reset();

  const compByLabel = (label: string, kind?: CompKind) =>
    [...c.comps.values()].find((x) => x.label === label && (!kind || x.kind === kind));
  const lampOf = (label: string) => compByLabel(label, "output")!;
  const read = (comp: Comp) => c.inputValues(comp)[0] ?? 0;
  const pc = lampOf("PC");
  const acc = lampOf("AKKU");
  const outLamp = lampOf("AUSGABE");
  const progRom = compByLabel("PROGRAMM", "rom")!;
  const ctrlRom = compByLabel("STEUER-ROM", "rom")!;
  const ram = compByLabel("DATEN-RAM", "ram")!;

  check(
    "Programm-ROM vorhanden",
    !!progRom && progRom.dataWidth === 16 && progRom.data.length === 256 && progRom.addrWidth === 8
  );
  check("Steuer-ROM vorhanden", !!ctrlRom && ctrlRom.dataWidth === 16 && ctrlRom.data.length === 256);
  check("Daten-RAM vorhanden", !!ram && ram.dataWidth === 8 && ram.data.length === 256 && ram.addrWidth === 8);
  const inGroup = (id: string) => [...c.groups.values()].some((g) => g.members.includes(id));
  check(
    "ROM und RAM stecken nicht im CPU-Modul",
    !inGroup(progRom.id) && !inGroup(ctrlRom.id) && !inGroup(ram.id)
  );
  check("CPU besteht aus 4 Modulblöcken", c.groups.size === 4, String(c.groups.size));
  check(
    "CPU-Module sind maximal 4 × 4 Zellen",
    [...c.groups.values()].every((g) => g.cols <= 4 && g.rows <= 4),
    [...c.groups.values()].map((g) => `${g.name} ${g.cols}×${g.rows}`).join(", ")
  );
  check(
    "CPU-Module haben eigene Modul-IDs",
    new Set([...c.groups.values()].map((g) => g.moduleId)).size === 4
  );
  check(
    "Block-Pins liegen am Blockrand",
    [...c.groups.values()].every((g) => {
      const left = g.x * CELL;
      const right = (g.x + g.cols) * CELL;
      const top = g.y * CELL;
      const bottom = (g.y + g.rows) * CELL;
      const inside = (p: { x: number; y: number }) => p.y > top && p.y < bottom;
      return (
        g.inputs.every((pin) => {
          const comp = c.get(pin.compId)!;
          const pos = c.pinPos(comp, "in", 0);
          return Math.abs(pos.x - left) < 0.01 && inside(pos);
        }) &&
        g.outputs.every((pin) => {
          const comp = c.get(pin.compId)!;
          const pos = c.pinPos(comp, "out", 0);
          return Math.abs(pos.x - right) < 0.01 && inside(pos);
        })
      );
    })
  );
  const groupByName = (name: string) => [...c.groups.values()].find((g) => g.name === name)!;
  check(
    "Module haben eigene Pins",
    groupByName("ALU 8 Bit").inputs.length === 4 &&
      groupByName("ALU 8 Bit").outputs.length === 1 &&
      groupByName("Programmzähler").outputs[0].width === 8 &&
      groupByName("Akkumulator").outputs[0].width === 8
  );
  check("Start: PC 0, Akku 0, Ausgabe 0", read(pc) === 0 && read(acc) === 0 && read(outLamp) === 0);
  check("Keine Schleifen oder Breitenfehler", c.loopComps.size === 0 && c.invalidWires.size === 0);

  // Die CPU-Module stehen als bearbeitbare Module in der Bibliothek.
  const cpuDefs = ["mini-cpu-alu", "mini-cpu-acc", "mini-cpu-pc", "mini-cpu-out"].map((id) => getModule(id));
  check(
    "CPU-Module stehen in der Bibliothek",
    cpuDefs.every((d) => !!d && d.block.cols <= 4 && d.block.rows <= 4),
    cpuDefs.map((d) => d?.name ?? "fehlt").join(", ")
  );
  check(
    "CPU-Module sind bearbeitbar",
    !!cpuDefs[0] && cpuDefs[0].inputs.length === 4 && cpuDefs[0].outputs.length === 1
  );
  const exported = parseCircuit(
    JSON.stringify({ version: 1, comps: [], wires: [], groups: [], modules: cpuDefs })
  );
  check("Export enthält die Modulbibliothek", !!exported && Array.isArray(exported.modules) && exported.modules.length === 4);
  const imported = importModuleDefs(exported!.modules);
  check("Import lädt die Module wieder", imported === 4 && !!getModule("mini-cpu-alu"), String(imported));
  check("Import ignoriert kaputte Einträge", importModuleDefs([{ foo: 1 }, null]) === 0);

  // Die CPU-Module werden auch ohne geladenes Beispiel angelegt (App-Start).
  for (const id of CPU_MODULE_IDS) removeModule(id);
  check("CPU-Module lassen sich entfernen", CPU_MODULE_IDS.every((id) => !getModule(id)));
  ensureCpuModules();
  const fresh = CPU_MODULE_IDS.map((id) => getModule(id));
  check(
    "CPU-Module werden beim Start automatisch angelegt",
    fresh.every((d) => !!d && d.block.cols <= 4 && d.block.rows <= 4 && d.circuit.comps.length > 0),
    fresh.map((d) => d?.name ?? "fehlt").join(", ")
  );
  ensureCpuModules();
  check(
    "Erneutes Anlegen erzeugt keine Duplikate",
    listModules().filter((m) => CPU_MODULE_IDS.includes(m.id)).length === 4,
    String(listModules().length)
  );

  // Mitgeliefertes Programm: 5 + 7 rechnen, ablegen, wieder laden und ausgeben.
  c.step();
  check("LDA #5 lädt den Akku", read(acc) === 5, `Akku ${read(acc)}`);
  c.step();
  check("ADD #7 ergibt 12", read(acc) === 12, `Akku ${read(acc)}`);
  c.step();
  check("STA 32 schreibt ins externe RAM", ram.data[32] === 12, `RAM[32] ${ram.data[32]}`);
  c.step();
  check("LDA #0 leert den Akku", read(acc) === 0, `Akku ${read(acc)}`);
  c.step();
  check("ADD 32 liest aus dem RAM", read(acc) === 12, `Akku ${read(acc)}`);
  c.step();
  check("OUT gibt 12 aus", read(outLamp) === 12, `Ausgabe ${read(outLamp)}`);
  c.step();
  const haltedPc = read(pc);
  c.step();
  c.step();
  check(
    "HLT hält dauerhaft an",
    read(pc) === haltedPc && read(acc) === 12 && read(outLamp) === 12,
    `PC ${read(pc)}, Akku ${read(acc)}, Ausgabe ${read(outLamp)}`
  );

  // Eigenes Programm in das externe ROM laden.
  const load = (src: string) => {
    const asm = assemble(src);
    check(`Assembler-Programm ohne Fehler`, asm.errors.length === 0, JSON.stringify(asm.errors));
    progRom.data = new Array(256).fill(0);
    asm.words.forEach((w, i) => {
      progRom.data[i] = w;
    });
    c.reset();
  };
  const runSteps = (n: number) => {
    for (let i = 0; i < n; i++) c.step();
  };
  c.reset();
  check("Reset setzt PC und Akku zurück", read(pc) === 0 && read(acc) === 0);

  load(`LDA #5\nADD #7\nOUT\nHLT`);
  runSteps(3);
  check("Assembler-Programm 5 + 7 = 12", read(outLamp) === 12, `Ausgabe ${read(outLamp)}`);

  load(`LDA #20\nSUB #7\nOUT\nHLT`);
  runSteps(3);
  check("SUB rechnet 20 - 7", read(outLamp) === 13, `Ausgabe ${read(outLamp)}`);

  load(`LDA #0b1100\nAND #0b1010\nOUT\nLDA #0b1100\nOR #0b0011\nOUT\nLDA #0b1100\nXOR #0b1111\nOUT\nHLT`);
  runSteps(3);
  check("AND verknüpft", read(outLamp) === 0b1000, `Ausgabe ${read(outLamp)}`);
  runSteps(3);
  check("OR verknüpft", read(outLamp) === 0b1111, `Ausgabe ${read(outLamp)}`);
  runSteps(3);
  check("XOR verknüpft", read(outLamp) === 0b0011, `Ausgabe ${read(outLamp)}`);

  load(`LDA #3\nloop: OUT\nSUB #1\nJNZ loop\nOUT\nHLT`);
  const seen: number[] = [];
  for (let i = 0; i < 22; i++) {
    c.step();
    const v = read(outLamp);
    if (seen[seen.length - 1] !== v) seen.push(v);
  }
  check("JNZ-Schleife zählt 3, 2, 1, 0", seen.join(",") === "0,3,2,1,0", seen.join(","));

  load(`LDA #0\nJZ ziel\nLDA #99\nziel: OR #5\nOUT\nHLT`);
  runSteps(4);
  check("JZ überspringt den Block", read(outLamp) === 5, `Ausgabe ${read(outLamp)}`);

  load(`LDA #250\nADD #10\nSTA 7\nLDA #0\nADD 7\nOUT\nJMP ende\nLDA #1\nOUT\nende: HLT`);
  runSteps(6);
  check("8-Bit-Überlauf 250 + 10 = 4", read(outLamp) === 4, `Ausgabe ${read(outLamp)}`);
  runSteps(4);
  check("JMP überspringt die Ausgabe", read(outLamp) === 4, `Ausgabe ${read(outLamp)}`);

  // Modulblöcke dürfen keine anderen Bauteile verdecken und sich nicht überschneiden.
  const rectOf = (comp: Comp) => {
    const l = layoutOf(comp);
    return { x: comp.x, y: comp.y, w: l.cols, h: l.rows };
  };
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  let stray = 0;
  const groups = [...c.groups.values()];
  for (const g of groups) {
    const block = { x: g.x, y: g.y, w: g.cols, h: g.rows };
    for (const comp of c.comps.values()) {
      if (g.members.includes(comp.id)) continue;
      if (overlaps(block, rectOf(comp))) stray++;
    }
  }
  check("Modulblöcke verdecken keine anderen Bauteile", stray === 0, `${stray} Überdeckungen`);
  let groupHits = 0;
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      if (overlaps({ x: a.x, y: a.y, w: a.cols, h: a.rows }, { x: b.x, y: b.y, w: b.cols, h: b.rows })) groupHits++;
    }
  }
  check("Modulblöcke überschneiden sich nicht", groupHits === 0, `${groupHits} Überschneidungen`);
}

console.log("Mini-CPU mit 16 und 32 Bit (breite Datenpfade, getrennte ROMs)");

for (const bits of [16, 32] as const) {
  const ex = { build: (c: Circuit) => buildCpu(c, bits) };
  const c = new Circuit();
  ex.build(c);
  c.rebuild();
  c.reset();
  const lamp = (label: string) =>
    [...c.comps.values()].find((x) => x.kind === "output" && x.label === label)!;
  const read = (label: string) => c.inputValues(lamp(label))[0] ?? 0;
  const rom = (label: string) => [...c.comps.values()].find((x) => x.kind === "rom" && x.label === label);
  const ram = [...c.comps.values()].find((x) => x.kind === "ram")!;
  const alu = [...c.groups.values()].find((g) => g.name === `ALU ${bits} Bit`)!;
  const acc = [...c.groups.values()].find((g) => g.name === "Akkumulator")!;

  check(`${bits}-Bit: ALU-Ausgang ist ${bits} Bit breit`, alu?.outputs[0]?.width === bits, String(alu?.outputs[0]?.width));
  check(`${bits}-Bit: Akkumulator ist ${bits} Bit breit`, acc?.outputs[0]?.width === bits, String(acc?.outputs[0]?.width));
  check(
    `${bits}-Bit: Programm 8b, Operand ${bits}b`,
    rom("PROGRAMM")?.dataWidth === 8 && rom("OPERAND")?.dataWidth === bits,
    `${rom("PROGRAMM")?.dataWidth} / ${rom("OPERAND")?.dataWidth}`
  );
  check(
    `${bits}-Bit: Daten-RAM ist ${bits} Bit breit`,
    ram.dataWidth === bits && ram.addrWidth === 8,
    `${ram.addrWidth} / ${ram.dataWidth}`
  );
  check(
    `${bits}-Bit: keine Breitenfehler oder Schleifen`,
    c.invalidWires.size === 0 && c.loopComps.size === 0,
    `${c.invalidWires.size} Breiten, ${c.loopComps.size} Schleifen`
  );
  check(
    `${bits}-Bit: ROM und RAM stecken nicht im CPU-Modul`,
    ![...c.groups.values()].some((g) => g.members.includes(ram.id))
  );
  const defs = cpuModuleIds(bits).map((id) => getModule(id));
  check(
    `${bits}-Bit-Module liegen in der Bibliothek`,
    defs.every((d) => !!d),
    defs.map((d) => d?.name ?? "fehlt").join(", ")
  );
  check(
    `${bits}-Bit-Modulvorlagen haben passende Pins`,
    defs[0]?.outputs[0]?.width === bits &&
      defs[1]?.outputs[0]?.width === bits &&
      defs[2]?.outputs[0]?.width === 8 &&
      defs[3]?.outputs[0]?.width === bits,
    defs.map((d) => d?.outputs[0]?.width).join("/")
  );

  const expected = bits === 16 ? 0x2345 : 0x23456789;
  for (let i = 0; i < 6; i++) c.step();
  check(
    `${bits}-Bit: 0x${(bits === 16 ? 0x1234 : 0x12345678).toString(16)} + 0x${(bits === 16 ? 0x1111 : 0x11111111).toString(16)} = 0x${expected.toString(16)}`,
    read("AKKU") === expected && read("AUSGABE") === expected,
    `AKKU 0x${read("AKKU").toString(16)}, Ausgabe 0x${read("AUSGABE").toString(16)}`
  );
  check(
    `${bits}-Bit: STA schreibt den vollen Wert ins RAM`,
    ram.data[32] === expected,
    `RAM[32] 0x${(ram.data[32] ?? 0).toString(16)}`
  );
}

{
  const wide = assemble("LDA #0x12345678\nADD #0x11111111", 32);
  check(
    "Assembler erlaubt 32-Bit-Operanden",
    wide.errors.length === 0 && wide.operands[0] === 0x12345678 && wide.opcodes[0] === 0x01,
    JSON.stringify(wide.errors)
  );
  const narrow = assemble("LDA #300");
  check("Assembler meldet weiterhin die 8-Bit-Grenze", narrow.errors.length === 1);
  const badAddr = assemble("ADD 300", 32);
  check(
    "Assembler lehnt zu große Adressen ab",
    badAddr.errors.length === 1 && badAddr.errors[0].message.includes("Adresse"),
    JSON.stringify(badAddr.errors)
  );
}

console.log("Entpackte Anordnung wird dauerhaft gesichert");

{
  const c = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Mini-CPU (8 Bit"))!.build(c);
  c.rebuild();
  const layout = computeExpandedLayout(c);
  c.setExpandedLayout(
    layout.positions,
    layout.frames.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, groupId: f.group.id }))
  );
  const group = [...c.groups.values()][0];
  const member = group.members[0];
  const before = c.posOf(c.get(member)!);
  c.setExpandedPos(member, before.x + 6, before.y + 4);
  c.setExpandedFramePos(group.id, 77, 55);

  const data = JSON.parse(JSON.stringify(c.serialize())) as ReturnType<Circuit["serialize"]>;
  check(
    "Anordnung landet in der gespeicherten Schaltung",
    Array.isArray(data.expanded?.positions) && data.expanded.positions.length > 0 && data.expanded.frames.length > 0,
    `${data.expanded?.positions.length} Positionen`
  );
  const loaded = new Circuit();
  loaded.load(data);
  const restored = savedExpandedLayout(loaded);
  check("Gespeicherte Anordnung wird wiedergefunden", !!restored);
  check(
    "Verschobenes Bauteil behält seine Position",
    restored?.positions.get(member)?.x === before.x + 6 && restored?.positions.get(member)?.y === before.y + 4,
    JSON.stringify(restored?.positions.get(member))
  );
  check(
    "Verschobenes Modulfeld behält seine Position",
    restored?.frames.find((f) => f.group.id === group.id)?.x === 77 &&
      restored?.frames.find((f) => f.group.id === group.id)?.y === 55
  );
  const plain = new Circuit();
  plain.load({ version: 1, comps: [], wires: [], groups: [] });
  check("Ohne gespeicherte Anordnung keine falsche Übernahme", savedExpandedLayout(plain) === null);

  // Ansicht verlassen: die Anordnung bleibt in der Schaltung erhalten.
  c.setExpandedLayout(null);
  const closed = JSON.parse(JSON.stringify(c.serialize())) as ReturnType<Circuit["serialize"]>;
  const reloaded = new Circuit();
  reloaded.load(closed);
  const again = savedExpandedLayout(reloaded);
  check(
    "Anordnung bleibt nach Verlassen der Ansicht gesichert",
    !!closed.expanded?.positions.length && !!again && again.positions.get(member)?.x === before.x + 6,
    `${closed.expanded?.positions.length} Positionen`
  );
}

console.log("CPU-Module im Modul-Editor bearbeiten");

{
  const c = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Mini-CPU"))!.build(c);
  const lamp = (label: string) =>
    [...c.comps.values()].find((x) => x.kind === "output" && x.label === label)!;
  const readLamp = (label: string) => c.inputValues(lamp(label))[0] ?? 0;

  // Jedes Modul einmal durch den Editor schicken (wie „Speichern“).
  let ok = true;
  for (const group of [...c.groups.values()]) {
    const snapshot = editableCircuitForGroup(c, group.id)!;
    const work = new Circuit();
    work.load(snapshot);
    const def = buildModuleDef(
      work,
      [...work.comps.keys()],
      group.name,
      { cols: group.cols, rows: group.rows },
      { id: group.moduleId, version: 2 }
    )!;
    const next = replaceGroupInternals(c, group.id, def);
    ok =
      ok &&
      !!next &&
      next.inputs.length === group.inputs.length &&
      next.outputs.length === group.outputs.length &&
      next.cols <= 4 &&
      next.rows <= 4;
  }
  check("Alle CPU-Module bleiben nach Bearbeitung kompakt", ok);
  c.rebuild();
  c.reset();
  check(
    "Keine Breitenfehler nach Modul-Bearbeitung",
    c.invalidWires.size === 0 && c.loopComps.size === 0,
    `${c.invalidWires.size} Breiten, ${c.loopComps.size} Schleifen`
  );
  for (let i = 0; i < 7; i++) c.step();
  check(
    "CPU rechnet nach Modul-Bearbeitung weiter",
    readLamp("AKKU") === 12 && readLamp("AUSGABE") === 12 && readLamp("PC") === 6,
    `AKKU ${readLamp("AKKU")}, Ausgabe ${readLamp("AUSGABE")}, PC ${readLamp("PC")}`
  );
}

console.log("Eigene CPU-Modul-Version wird vom Beispiel benutzt");

{
  const base = getModule("mini-cpu-alu")!;
  const work = new Circuit();
  work.load(editableCircuitForDef(base));
  add(work, "not", 60, 60); // zusätzliches Bauteil, wie im Modul-Editor
  work.rebuild();
  const edited = buildModuleDef(
    work,
    [...work.comps.keys()],
    base.name,
    { cols: base.block.cols, rows: base.block.rows },
    { id: base.id, version: 7 }
  )!;
  addModule(edited);

  const c = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Mini-CPU"))!.build(c);
  c.rebuild();
  c.reset();
  const alu = [...c.groups.values()].find((g) => g.moduleId === base.id)!;
  check(
    "Beispiel baut die bearbeitete ALU ein",
    !!alu && alu.members.length === edited.circuit.comps.length,
    `${alu?.members.length} statt ${edited.circuit.comps.length}`
  );
  check("Bearbeitete ALU bleibt kompakt", !!alu && alu.cols <= 4 && alu.rows <= 4);
  check(
    "Pins der bearbeiteten ALU bleiben erhalten",
    !!alu && alu.inputs.length === 4 && alu.outputs.length === 1
  );
  for (let i = 0; i < 7; i++) c.step();
  const lamp = (label: string) =>
    [...c.comps.values()].find((x) => x.kind === "output" && x.label === label)!;
  check(
    "CPU rechnet mit der bearbeiteten ALU",
    c.inputValues(lamp("AKKU"))[0] === 12 && c.inputValues(lamp("AUSGABE"))[0] === 12
  );
  check(
    "Keine Breitenfehler mit bearbeiteter ALU",
    c.invalidWires.size === 0 && c.loopComps.size === 0,
    `${c.invalidWires.size} Breiten, ${c.loopComps.size} Schleifen`
  );

  // Ausgangszustand wiederherstellen, damit spätere Tests die Grundversion sehen.
  removeModule(base.id);
  addModule(base);
}

console.log("Eigene Module aus Auswahl");

{
  const source = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Halbaddierer"))!.build(source);
  source.rebuild();
  source.reset();
  const def = createModuleFromSelection(source, [...source.comps.keys()], "Halbaddierer");
  check("Modul aus Auswahl erstellt", !!def);
  check("Modul hat 2 Ein- und 2 Ausgänge", def!.inputs.length === 2 && def!.outputs.length === 2);

  const c = new Circuit();
  const group = instantiateModule(c, def!, 4, 4);
  check("Instanz gekapselt", group.collapsed && group.members.length === 6);
  const a = add(c, "input", 0, 0);
  const b = add(c, "input", 0, 3);
  const sum = add(c, "output", 24, 0);
  const carry = add(c, "output", 24, 3);
  link(c, a, 0, c.get(group.inputs[0].compId)!, 0);
  link(c, b, 0, c.get(group.inputs[1].compId)!, 0);
  link(c, c.get(group.outputs[0].compId)!, 0, sum, 0);
  link(c, c.get(group.outputs[1].compId)!, 0, carry, 0);
  c.rebuild();
  c.reset();
  const externalWire = c.wires.find((w) => w.to === group.inputs[0].compId);
  check("Interna versteckt", c.isCompHidden(group.members[0]));
  check("Schnittstellen-Kabel sichtbar", !!externalWire && !c.isWireHidden(externalWire));
  for (const [x, y] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const) {
    c.setInputValue(a, x);
    c.setInputValue(b, y);
    c.evalComb();
    check(`Modul ${x}+${y}`, c.inputValues(sum)[0] === (x ^ y) && c.inputValues(carry)[0] === (x & y));
  }
  group.collapsed = false;
  c.rebuild();
  c.setInputValue(a, 1);
  c.setInputValue(b, 1);
  c.evalComb();
  check("Aufgeklappt rechnet weiter", c.inputValues(sum)[0] === 0 && c.inputValues(carry)[0] === 1);

  // Module lassen sich aus bereits platzierten Modulen zusammensetzen.
  const mid = new Circuit();
  const ga = instantiateModule(mid, def!, 0, 0);
  mid.rebuild();
  mid.reset();
  const composed = createModuleFromSelection(mid, [ga.id], "Halbaddierer 2");
  check("Komposition hat 2 Ein- und 2 Ausgänge", !!composed && composed.inputs.length === 2 && composed.outputs.length === 2);
  check("Pin-Namen bleiben erhalten", composed!.inputs[0].name === "IN1");
  const cc = new Circuit();
  const cg = instantiateModule(cc, composed!, 0, 0);
  const ca = add(cc, "input", 0, 0);
  const cb = add(cc, "input", 0, 3);
  const cs = add(cc, "output", 24, 0);
  const cco = add(cc, "output", 24, 3);
  link(cc, ca, 0, cc.get(cg.inputs[0].compId)!, 0);
  link(cc, cb, 0, cc.get(cg.inputs[1].compId)!, 0);
  link(cc, cc.get(cg.outputs[0].compId)!, 0, cs, 0);
  link(cc, cc.get(cg.outputs[1].compId)!, 0, cco, 0);
  cc.rebuild();
  cc.reset();
  cc.setInputValue(ca, 1);
  cc.setInputValue(cb, 1);
  cc.evalComb();
  check("Komposition rechnet", cc.inputValues(cs)[0] === 0 && cc.inputValues(cco)[0] === 1);

  const wide = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("4-Bit-Addierer"))!.build(wide);
  wide.rebuild();
  wide.reset();
  const busDef = createModuleFromSelection(wide, [...wide.comps.keys()], "Addierer");
  check("Bus-Modul erstellt", !!busDef);
  check("Bus-Pins sind 4 Bit", busDef!.inputs[0].width === 4 && busDef!.outputs[0].width === 4);
  const wc = new Circuit();
  const wg = instantiateModule(wc, busDef!, 0, 0);
  const wa = add(wc, "input", 0, 0, { width: 4 });
  const wb = add(wc, "input", 0, 6, { width: 4 });
  const wsum = add(wc, "output", 30, 0, { width: 4 });
  const wcarry = add(wc, "output", 30, 4, { width: 1 });
  link(wc, wa, 0, wc.get(wg.inputs[0].compId)!, 0);
  link(wc, wb, 0, wc.get(wg.inputs[1].compId)!, 0);
  link(wc, wc.get(wg.outputs[0].compId)!, 0, wsum, 0);
  link(wc, wc.get(wg.outputs[1].compId)!, 0, wcarry, 0);
  wc.rebuild();
  wc.reset();
  for (const [x, y] of [
    [3, 4],
    [15, 1],
    [15, 15],
  ] as const) {
    wc.setInputValue(wa, x);
    wc.setInputValue(wb, y);
    wc.evalComb();
    const total = x + y;
    check(
      `Bus-Modul ${x}+${y}`,
      wc.inputValues(wsum)[0] === (total & 0xf) && wc.inputValues(wcarry)[0] === (total >> 4)
    );
  }

  // Ein zugeklapptes Modul belegt nur seinen Block – daneben ist wieder Platz.
  const pc = new Circuit();
  const pg = instantiateModule(pc, def!, 10, 10);
  const beside = findModuleSpot(pc, def!, 10, 0);
  check("Neben zugeklapptem Modul ist Platz", !!beside && beside.x === 10 && beside.y === 0);
  const onTop = findModuleSpot(pc, def!, pg.x, pg.y);
  check("Modul wird nicht über ein anderes gesetzt", !onTop || onTop.x !== pg.x || onTop.y !== pg.y);

  // Auch ganze Modul-Instanzen lassen sich kopieren.
  const gc = new Circuit();
  const g1 = instantiateModule(gc, def!, 0, 0);
  const copyIds = gc.duplicateUnits([g1.id], 12, 0);
  const g2 = gc.groups.get(copyIds[0]);
  check("Modul-Duplikat erzeugt neue Instanz", copyIds.length === 1 && copyIds[0] !== g1.id && !!g2);
  check("Modul-Duplikat behält Pins", !!g2 && g2.inputs.length === 2 && g2.outputs.length === 2);
  check(
    "Modul-Duplikat hat eigene Bauteile",
    !!g2 && g2.members.length === g1.members.length && g2.members.every((m) => !g1.members.includes(m))
  );
  check(
    "Modul-Duplikat enthält eigene Kabel",
    !!g2 && gc.wires.some((w) => g2.members.includes(w.from) && g2.members.includes(w.to))
  );
  check("Modul-Duplikat ist zugeklappt", !!g2 && g2.collapsed);
}

console.log("Modulgröße bei der Erstellung");

{
  const source = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Halbaddierer"))!.build(source);
  source.rebuild();
  source.reset();

  const min = moduleBlockDefaults(source, [...source.comps.keys()])!;
  check("Mindestgröße passt zu den Pins", min.minCols >= 4 && min.minRows === 3, `${min.minCols} × ${min.minRows}`);

  const def = createModuleFromSelection(source, [...source.comps.keys()], "Groß", { cols: 16, rows: 14 })!;
  check("Modul übernimmt die Wunschgröße", def.block.cols === 16 && def.block.rows === 14);
  check(
    "Endgröße entspricht der Wunschgröße",
    def.footprint.cols === 16 && def.footprint.rows === 14
  );

  const c = new Circuit();
  const g = instantiateModule(c, def, 5, 7);
  check("Instanz hat die Endgröße", g.cols === 16 && g.rows === 14);

  const pinPos = (compId: string, dir: "in" | "out") => c.pinPos(c.get(compId)!, dir, 0);
  const inPins = g.inputs.map((p) => pinPos(p.compId, "in"));
  const outPins = g.outputs.map((p) => pinPos(p.compId, "out"));
  const left = g.x * CELL;
  const right = (g.x + g.cols) * CELL;
  const top = (g.y + 2) * CELL;
  const bottom = (g.y + g.rows) * CELL;
  check(
    "Eingangspins liegen am linken Rand",
    inPins.every((p) => Math.abs(p.x - left) < 0.01 && p.y > top && p.y < bottom)
  );
  check(
    "Ausgangspins liegen am rechten Rand",
    outPins.every((p) => Math.abs(p.x - right) < 0.01 && p.y > top && p.y < bottom)
  );
  check(
    "Pins verteilen sich über die Blockhöhe",
    inPins[1].y - inPins[0].y > 3 * CELL && outPins[1].y - outPins[0].y > 3 * CELL
  );

  const pinComps = [...g.inputs, ...g.outputs].map((p) => c.get(p.compId)!);
  let pinOverlaps = 0;
  for (let i = 0; i < pinComps.length; i++) {
    for (let j = i + 1; j < pinComps.length; j++) {
      const a = layoutOf(pinComps[i]);
      const b = layoutOf(pinComps[j]);
      const ca = pinComps[i];
      const cb = pinComps[j];
      if (ca.x < cb.x + b.cols && ca.x + a.cols > cb.x && ca.y < cb.y + b.rows && ca.y + a.rows > cb.y) {
        pinOverlaps++;
      }
    }
  }
  check("Pin-Puffer überlappen nicht", pinOverlaps === 0, `${pinOverlaps} Überlappungen`);

  // Alte Vorlagen mit Pin-Puffern mitten im Block werden beim Einsetzen korrigiert.
  const legacyDef = structuredClone(def);
  for (const p of legacyDef.outputs) {
    const comp = legacyDef.circuit.comps.find((c) => c.id === p.templateId);
    if (comp) comp.x = 2;
  }
  const legacyCircuit = new Circuit();
  const legacyGroup = instantiateModule(legacyCircuit, legacyDef, 4, 4);
  const legacyOutPins = legacyGroup.outputs.map((p) => legacyCircuit.pinPos(legacyCircuit.get(p.compId)!, "out", 0));
  check(
    "Alte Vorlagen bekommen Pins am rechten Rand",
    legacyOutPins.every((p) => Math.abs(p.x - (4 + 16) * CELL) < 0.01)
  );

  const tiny = createModuleFromSelection(source, [...source.comps.keys()], "Mini", { cols: 1, rows: 1 })!;
  check(
    "Zu kleine Eingaben werden angehoben",
    tiny.block.cols >= min.minCols && tiny.block.rows >= min.minRows,
    `${tiny.block.cols} × ${tiny.block.rows}`
  );
  const huge = createModuleFromSelection(source, [...source.comps.keys()], "Riesig", { cols: 999, rows: 999 })!;
  check("Zu große Eingaben werden begrenzt", huge.block.cols === 64 && huge.block.rows === 64);
}

console.log("Entpackte Gesamtansicht");

{
  const c = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Mini-CPU"))!.build(c);
  c.rebuild();
  c.reset();

  const memberIds = new Set([...c.groups.values()].flatMap((g) => g.members));
  const before = new Map([...c.comps.values()].map((x) => [x.id, { x: x.x, y: x.y }]));
  const layout = computeExpandedLayout(c);
  check("Entpackte Ansicht hat alle Module", layout.frames.length === c.groups.size, String(layout.frames.length));
  check(
    "Entpackte Ansicht positioniert alle Innenteile",
    [...memberIds].every((id) => layout.positions.has(id)),
    `${layout.positions.size} von ${memberIds.size}`
  );

  // Rahmen dürfen sich nicht überschneiden und müssen Platz zum Titel haben.
  let frameHits = 0;
  for (let i = 0; i < layout.frames.length; i++) {
    for (let j = i + 1; j < layout.frames.length; j++) {
      const a = layout.frames[i];
      const b = layout.frames[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) frameHits++;
    }
  }
  check("Modulfelder überlappen nicht", frameHits === 0, `${frameHits} Überdeckungen`);

  // Innenteile liegen innerhalb ihres Rahmens.
  let outside = 0;
  for (const frame of layout.frames) {
    for (const id of frame.group.members) {
      const pos = layout.positions.get(id)!;
      const comp = c.get(id)!;
      const l = layoutOf(comp);
      if (pos.x < frame.x || pos.y < frame.y || pos.x + l.cols > frame.x + frame.w || pos.y + l.rows > frame.y + frame.h) {
        outside++;
      }
    }
  }
  check("Innenteile bleiben in ihrem Feld", outside === 0, `${outside} außerhalb`);

  // Positionen nur fürs Zeichnen – die Schaltung selbst bleibt unverändert.
  c.setExpandedLayout(layout.positions);
  check("Entpackt: Innenteile sichtbar", c.groups.size > 0 && !c.isCompHidden([...memberIds][0]));
  check("Entpackt: Innenkabel sichtbar", c.wires.some((w) => !c.isWireHidden(w)));
  const pinGroup = [...c.groups.values()][0];
  const pinComp = c.get(pinGroup.inputs[0].compId)!;
  const pin = c.pinPos(pinComp, "in", 0);
  const placed = layout.positions.get(pinComp.id)!;
  check(
    "Entpackt: Pins sitzen am Innenteil",
    Math.abs(pin.x - placed.x * CELL) < CELL && Math.abs(pin.y - placed.y * CELL) < CELL * 4
  );
  check(
    "Entpackt: gespeicherte Positionen unverändert",
    [...c.comps.values()].every((x) => x.x === before.get(x.id)!.x && x.y === before.get(x.id)!.y)
  );
  const wire = c.wires[0];
  const wireBefore = c.pinPos(c.get(wire.from)!, "out", wire.fromPort);
  c.setExpandedLayout(null);
  const wireAfter = c.pinPos(c.get(wire.from)!, "out", wire.fromPort);
  check("Blockansicht stellt Positionen wieder her", "x" in wireBefore && "x" in wireAfter);
  check("Blockansicht: Innenteile wieder verborgen", c.isCompHidden([...memberIds][0]));
}

console.log("Entpackte Ansicht: Beschriftungen sitzen auf den Bauteilen");

{
  // Canvas-Stub: sammelt alle gezeichneten Texte samt (Welt-)Position.
  const texts: { text: string; x: number; y: number }[] = [];
  const noop = () => {};
  const ctx = {
    save: noop,
    restore: noop,
    setTransform: noop,
    fillRect: noop,
    beginPath: noop,
    roundRect: noop,
    fill: noop,
    stroke: noop,
    moveTo: noop,
    lineTo: noop,
    bezierCurveTo: noop,
    arcTo: noop,
    arc: noop,
    rect: noop,
    closePath: noop,
    setLineDash: noop,
    createPattern: () => null,
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: (t: string, x: number, y: number) => {
      texts.push({ text: t, x, y });
    },
    globalAlpha: 1,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    lineCap: "butt",
  } as unknown as CanvasRenderingContext2D;
  const canvasStub = {
    width: 0,
    height: 0,
    clientWidth: 1400,
    clientHeight: 800,
    getContext: () => ctx,
  };
  const globals = globalThis as unknown as { window?: unknown; document?: unknown };
  const prevWindow = globals.window;
  const prevDocument = globals.document;
  globals.window = { devicePixelRatio: 1 };
  globals.document = { createElement: () => canvasStub };

  const c = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Mini-CPU"))!.build(c);
  c.rebuild();
  c.reset();
  const layout = computeExpandedLayout(c);
  c.setExpandedLayout(layout.positions);
  const state: EditorState = {
    tool: "select",
    selection: null,
    selected: [],
    box: null,
    ghost: null,
    wireDrag: null,
    hovered: null,
  };
  const renderer = new Renderer(canvasStub as unknown as HTMLCanvasElement);
  renderer.draw(c, { panX: 0, panY: 0, zoom: 0.5 }, state, { frames: layout.frames });

  const hasText = (text: string, x: number, y: number) =>
    texts.some((t) => t.text === text && Math.abs(t.x - x) <= 2 && Math.abs(t.y - y) <= 2);

  let misplaced = 0;
  for (const group of c.groups.values()) {
    const pins: { compId: string; dir: "in" | "out" }[] = [
      { compId: group.inputs[0].compId, dir: "in" },
      { compId: group.outputs[0].compId, dir: "out" },
    ];
    for (const { compId, dir } of pins) {
      const comp = c.get(compId);
      if (!comp) continue;
      const pos = c.posOf(comp);
      const l = layoutOf(comp);
      const x = pos.x * CELL;
      const y = pos.y * CELL;
      const w = l.cols * CELL;
      const h = l.rows * CELL;
      const port = dir === "in" ? l.ins[0] : l.outs[0];
      const wantX = dir === "in" ? x + 8 : x + w - 8;
      const wantY = y + port.fy * h;
      if (hasText(port.name, wantX, wantY)) continue;
      misplaced++;
    }
  }
  check("Renderer zeichnet Beschriftungen", texts.length > 100, String(texts.length));
  check(
    "Pin-Beschriftungen sitzen in der entpackten Ansicht am Bauteil",
    misplaced === 0,
    `${misplaced} verrutscht`
  );

  c.setExpandedLayout(null);
  globals.window = prevWindow;
  globals.document = prevDocument;
}

console.log("Renderer zeichnet die gewählte Kabelführung");

{
  const segments: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const strokes: string[] = [];
  let recordStroke = () => {};
  let beziers = 0;
  const noop = () => {};
  let cur = { x: 0, y: 0 };
  const ctx = {
    save: noop,
    restore: noop,
    setTransform: noop,
    fillRect: noop,
    beginPath: noop,
    roundRect: noop,
    fill: noop,
    stroke: () => recordStroke(),
    moveTo: (x: number, y: number) => {
      cur = { x, y };
    },
    lineTo: (x: number, y: number) => {
      segments.push({ x0: cur.x, y0: cur.y, x1: x, y1: y });
      cur = { x, y };
    },
    arcTo: (x: number, y: number) => {
      segments.push({ x0: cur.x, y0: cur.y, x1: x, y1: y });
      cur = { x, y };
    },
    bezierCurveTo: () => {
      beziers++;
    },
    arc: noop,
    rect: noop,
    closePath: noop,
    setLineDash: noop,
    createPattern: () => null,
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: noop,
    globalAlpha: 1,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    lineCap: "butt",
    lineJoin: "round",
  } as unknown as CanvasRenderingContext2D;
  recordStroke = () => strokes.push(String((ctx as unknown as { strokeStyle: string }).strokeStyle));
  const canvasStub = { width: 0, height: 0, clientWidth: 1400, clientHeight: 800, getContext: () => ctx };
  const globals = globalThis as unknown as { window?: unknown; document?: unknown };
  const prevWindow = globals.window;
  const prevDocument = globals.document;
  globals.window = { devicePixelRatio: 1 };
  globals.document = { createElement: () => canvasStub };

  const c = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Halbaddierer"))!.build(c);
  c.rebuild();
  c.reset();
  const state: EditorState = {
    tool: "select",
    selection: null,
    selected: [],
    box: null,
    ghost: null,
    wireDrag: null,
    hovered: null,
  };
  const renderer = new Renderer(canvasStub as unknown as HTMLCanvasElement);

  renderer.draw(c, { panX: 0, panY: 0, zoom: 1 }, state, { wireStyle: "curved" });
  check("Kurven-Modus zeichnet Bézier-Kabel", beziers > 0, String(beziers));

  segments.length = 0;
  beziers = 0;
  renderer.draw(c, { panX: 0, panY: 0, zoom: 1 }, state, { wireStyle: "ortho" });
  const diagonal = segments.filter((s) => Math.abs(s.x1 - s.x0) > 0.01 && Math.abs(s.y1 - s.y0) > 0.01);
  check("Ortho-Modus zeichnet keine Bézier-Kabel", beziers === 0, String(beziers));
  check(
    "Ortho-Modus zeichnet nur waagerechte/senkrechte Linien",
    diagonal.length === 0,
    `${diagonal.length} schräge Linien`
  );
  check("Ortho-Modus zeichnet die Kabel", segments.length >= c.wires.length, `${segments.length} Linien`);

  // Taktnetz: beim Laufen wird sichtbar gepulst statt des echten (flackernden) Werts.
  const cpu = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Mini-CPU"))!.build(cpu);
  cpu.rebuild();
  cpu.reset();
  const clock = [...cpu.comps.values()].find((x) => x.kind === "clock")!;
  const net = cpu.clockNet();
  check("Taktnetz enthält den Taktgeber", net.has(clock.id));
  check(
    "Taktnetz reicht bis in die Module (CLK-Puffer)",
    net.size > 1 && [...net].some((id) => cpu.groupForComp(id) !== null),
    `${net.size} Bauteile im Taktnetz`
  );
  check("Taktnetz wird zwischengespeichert", cpu.clockNet() === net);

  strokes.length = 0;
  renderer.draw(cpu, { panX: 0, panY: 0, zoom: 1 }, state, { wireStyle: "curved", clockPulse: true });
  const onStrokes = [...strokes];
  strokes.length = 0;
  renderer.draw(cpu, { panX: 0, panY: 0, zoom: 1 }, state, { wireStyle: "curved", clockPulse: false });
  const offStrokes = [...strokes];
  check(
    "Taktleitung blinkt sichtbar (Puls on/off unterschiedlich)",
    onStrokes.join("|") !== offStrokes.join("|")
  );
  check("Taktleitung ist beim Puls an", onStrokes.includes("#b8f04a"), onStrokes.slice(0, 3).join(" "))
  check("Taktleitung ist beim Puls aus", offStrokes.includes("#36484d"), offStrokes.slice(0, 3).join(" "));

  globals.window = prevWindow;
  globals.document = prevDocument;
}

console.log("Rechtwinklige Leiterbahnen (umschaltbar)");

{
  const c = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Mini-CPU"))!.build(c);
  c.rebuild();
  c.reset();

  check("Kurven-Modus liefert keine Trassen", getWireRoutes(c, "curved").size === 0);
  const routes = getWireRoutes(c, "ortho");
  const visible = c.wires.filter((w) => !c.isWireHidden(w));
  check(
    "Jedes sichtbare Kabel hat eine Trasse",
    routes.size === visible.length,
    `${routes.size} von ${visible.length}`
  );

  const hitRect = (a: Point, b: Point, r: { x: number; y: number; w: number; h: number }) => {
    const eps = 1;
    if (Math.abs(a.y - b.y) < 0.5) {
      if (a.y <= r.y + eps || a.y >= r.y + r.h - eps) return false;
      return Math.max(a.x, b.x) > r.x + eps && Math.min(a.x, b.x) < r.x + r.w - eps;
    }
    if (a.x <= r.x + eps || a.x >= r.x + r.w - eps) return false;
    return Math.max(a.y, b.y) > r.y + eps && Math.min(a.y, b.y) < r.y + r.h - eps;
  };

  const blocks = [...c.groups.values()].map((g) => ({
    id: g.id,
    x: g.x * CELL,
    y: g.y * CELL,
    w: g.cols * CELL,
    h: g.rows * CELL,
  }));
  let endsOff = 0;
  let diagonal = 0;
  let through = 0;
  const verticals: { x: number; y0: number; y1: number; id: string }[] = [];
  for (const w of visible) {
    const pts = routes.get(w.id)!;
    const src = c.get(w.from)!;
    const dst = c.get(w.to)!;
    const p0 = c.pinPos(src, "out", w.fromPort);
    const p1 = c.pinPos(dst, "in", w.toPort);
    const last = pts[pts.length - 1];
    if (Math.hypot(pts[0].x - p0.x, pts[0].y - p0.y) > 0.01 || Math.hypot(last.x - p1.x, last.y - p1.y) > 0.01) {
      endsOff++;
    }
    const own = new Set([c.groupForComp(w.from)?.id, c.groupForComp(w.to)?.id]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      if (dx > 0.01 && dy > 0.01) diagonal++;
      if (dx < 0.5) verticals.push({ x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), id: w.from + ":" + w.fromPort });
      if (dx + dy < 20) continue; // kurze Stutzen am Pin zählen nicht
      for (const r of blocks) {
        if (own.has(r.id)) continue;
        if (hitRect(a, b, r)) through++;
      }
    }
  }
  check("Trassen beginnen und enden an den Pins", endsOff === 0, `${endsOff} Abweichungen`);
  check("Alle Segmente sind waagerecht oder senkrecht", diagonal === 0, `${diagonal} schräge Segmente`);
  check("Keine Leiterbahn geht durch ein Modul", through === 0, `${through} Segmente`);

  let vOverlap = 0;
  let vClose = 0;
  for (let i = 0; i < verticals.length; i++) {
    for (let j = i + 1; j < verticals.length; j++) {
      if (verticals[i].id === verticals[j].id) continue;
      const shared = Math.min(verticals[i].y1, verticals[j].y1) - Math.max(verticals[i].y0, verticals[j].y0);
      if (shared <= 0.5) continue;
      const dist = Math.abs(verticals[i].x - verticals[j].x);
      if (dist < 0.5) vOverlap++;
      if (dist < 8) vClose++;
    }
  }
  check(
    "Senkrechte Leiterbahnen überlagern sich kaum (Rest: 1-Zellen-Korridore)",
    vOverlap <= 40,
    `${vOverlap} Überlappungen bei ${verticals.length} Segmenten`
  );
  check(
    "Senkrechte Leiterbahnen halten Abstand (keine Scheinkreuzung an Ecken)",
    vClose <= 40,
    `${vClose} Bahnen näher als 8 px`
  );

  const horizontals: { y: number; x0: number; x1: number; id: string }[] = [];
  for (const w of visible) {
    const pts = routes.get(w.id)!;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (Math.abs(a.y - b.y) >= 0.5) continue;
      horizontals.push({ y: a.y, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), id: w.from + ":" + w.fromPort });
    }
  }
  let longOverlap = 0;
  for (let i = 0; i < horizontals.length; i++) {
    for (let j = i + 1; j < horizontals.length; j++) {
      const a = horizontals[i];
      const b = horizontals[j];
      if (a.id === b.id) continue;
      if (Math.abs(a.y - b.y) >= 4) continue;
      const shared = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      if (shared <= 0.5) continue;
      // Kurze Stutzen am selben Pin dürfen sich treffen (sie enden dort).
      if (Math.min(a.x1 - a.x0, b.x1 - b.x0) > 40) longOverlap++;
    }
  }
  check(
    "Lange waagerechte Leiterbahnen überlagern sich kaum",
    longOverlap <= 8,
    `${longOverlap} Überlappungen bei ${horizontals.length} Segmenten`
  );
  check("Trassen werden zwischengespeichert", getWireRoutes(c, "ortho") === routes);
}

console.log("Leiterbahnen in der entpackten Ansicht");

{
  const c = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Mini-CPU"))!.build(c);
  c.rebuild();
  c.reset();
  const layout = computeExpandedLayout(c);
  c.setExpandedLayout(layout.positions, layout.frames);
  const routes = getWireRoutes(c, "ortho");

  const frames = layout.frames.map((f) => ({
    id: f.group.id,
    x: f.x * CELL,
    y: f.y * CELL,
    w: f.w * CELL,
    h: f.h * CELL,
  }));
  const inFrame = (f: { x: number; y: number; w: number; h: number }, p: Point) =>
    p.x >= f.x - 6 && p.x <= f.x + f.w + 6 && p.y >= f.y - 6 && p.y <= f.y + f.h + 6;
  const hitsFrame = (a: Point, b: Point, f: { x: number; y: number; w: number; h: number }) => {
    if (Math.abs(a.y - b.y) < 0.5) {
      if (a.y <= f.y + 0.5 || a.y >= f.y + f.h - 0.5) return false;
      return Math.max(a.x, b.x) > f.x + 0.5 && Math.min(a.x, b.x) < f.x + f.w - 0.5;
    }
    if (a.x <= f.x + 0.5 || a.x >= f.x + f.w - 0.5) return false;
    return Math.max(a.y, b.y) > f.y + 0.5 && Math.min(a.y, b.y) < f.y + f.h - 0.5;
  };

  let behind = 0;
  const verticals: { x: number; y0: number; y1: number; id: string }[] = [];
  for (const wire of c.wires) {
    if (c.isWireHidden(wire)) continue;
    const pts = routes.get(wire.id)!;
    const own = frames.filter((f) => inFrame(f, pts[0]) || inFrame(f, pts[pts.length - 1])).map((f) => f.id);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (Math.abs(a.x - b.x) < 0.5) {
        verticals.push({ x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), id: wire.from + ":" + wire.fromPort });
      }
      for (const f of frames) {
        if (own.includes(f.id)) continue;
        if (hitsFrame(a, b, f)) behind++;
      }
    }
  }
  check("Keine Leiterbahn läuft hinter einem Modulfeld", behind === 0, `${behind} Segmente`);

  let vOverlap = 0;
  let vClose = 0;
  for (let i = 0; i < verticals.length; i++) {
    for (let j = i + 1; j < verticals.length; j++) {
      if (verticals[i].id === verticals[j].id) continue;
      const shared = Math.min(verticals[i].y1, verticals[j].y1) - Math.max(verticals[i].y0, verticals[j].y0);
      if (shared <= 0.5) continue;
      const dist = Math.abs(verticals[i].x - verticals[j].x);
      if (dist < 0.5) vOverlap++;
      if (dist < 8) vClose++;
    }
  }
  check(
    "Senkrechte Trassen in der entpackten Ansicht überlagern sich nicht",
    vOverlap <= 150,
    `${vOverlap} Überlappungen bei ${verticals.length} Segmenten`
  );
  check("Auch entpackt halten senkrechte Trassen Abstand", vClose <= 150, `${vClose} näher als 8 px`);

  c.setExpandedLayout(null);
}

console.log("Entpackte Ansicht: Klicken, Mehrfachauswahl und Verschieben");

{
  const c = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Mini-CPU"))!.build(c);
  c.rebuild();
  c.reset();
  const layout = computeExpandedLayout(c);
  c.setExpandedLayout(
    layout.positions,
    layout.frames.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, groupId: f.group.id }))
  );

  type Handler = (e: { button?: number; clientX: number; clientY: number; shiftKey?: boolean }) => void;
  const handlers: Record<string, Handler> = {};
  const canvas = {
    clientWidth: 1400,
    clientHeight: 800,
    width: 0,
    height: 0,
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  let opened = 0;
  let structuralCalls = 0;
  let movedCalls = 0;
  const editor = new Editor(canvas as unknown as HTMLCanvasElement, c, {
    structural: () => {
      structuralCalls++;
    },
    moved: () => {
      movedCalls++;
    },
    valueChange: () => {},
    selectionChange: () => {},
    invalidate: () => {},
    status: () => {},
    placeModule: () => null,
    openGroupModule: () => {
      opened++;
    },
  });
  editor.readOnly = true;
  editor.setFrames(layout.frames);
  editor.view = { panX: 0, panY: 0, zoom: 1 };

  const press = (x: number, y: number, shiftKey = false) =>
    handlers.mousedown({ button: 0, clientX: x, clientY: y, shiftKey });
  const move = (x: number, y: number) => handlers.mousemove({ clientX: x, clientY: y });
  const release = (x: number, y: number) => handlers.mouseup({ button: 0, clientX: x, clientY: y });

  const frame = layout.frames.find((f) => f.group.members.length > 2)!;
  const compId = frame.group.members.find((id) => !!c.get(id))!;
  const comp = c.get(compId)!;
  const pos = c.posOf(comp);
  const l = layoutOf(comp);
  const cx = (pos.x + l.cols / 2) * CELL;
  const cy = (pos.y + l.rows / 2) * CELL;

  press(cx, cy);
  const selComp = editor.state.selection;
  check(
    "Klick auf ein Bauteil der entpackten Ansicht wählt es aus",
    selComp?.type === "comp" && selComp.id === compId,
    JSON.stringify(selComp)
  );

  // Ziehen verschiebt jetzt (in Zellen), ohne die echte Schaltung zu ändern
  const before = c.posOf(comp);
  const realBefore = { x: comp.x, y: comp.y };
  move(cx + 48, cy + 72);
  release(cx + 48, cy + 72);
  const after = c.posOf(comp);
  check(
    "Ziehen verschiebt ein Bauteil in der entpackten Ansicht",
    Math.round(after.x - before.x) === 2 && Math.round(after.y - before.y) === 3,
    `${after.x - before.x},${after.y - before.y}`
  );
  check("Verschieben zählt nicht als Strukturänderung", structuralCalls === 0 && movedCalls === 1, `${structuralCalls}/${movedCalls}`);
  check(
    "Die echte Schaltung bleibt dabei unverändert",
    comp.x === realBefore.x && comp.y === realBefore.y,
    `${comp.x},${comp.y}`
  );

  // Mehrfachauswahl per Shift und gemeinsames Verschieben per Pfeiltaste
  const otherId = frame.group.members.filter((id) => id !== compId && !!c.get(id)).pop()!;
  const other = c.get(otherId)!;
  const op = c.posOf(other);
  const ol = layoutOf(other);
  press((op.x + ol.cols / 2) * CELL, (op.y + ol.rows / 2) * CELL, true);
  check("Shift-Klick ergänzt die Auswahl", editor.state.selected.length === 2, editor.state.selected.join(","));
  const otherBefore = c.posOf(other);
  const movedComps = [...editor.state.selected].map((id) => (c.get(id) ? c.posOf(c.get(id)!) : null));
  check("Mehrfachauswahl verschiebt alle mit Pfeiltaste", editor.nudgeSelection(1, 0));
  const otherAfter = c.posOf(other);
  check(
    "Pfeiltaste verschiebt auch das zweite Bauteil",
    Math.round(otherAfter.x - otherBefore.x) === 1,
    `${otherAfter.x - otherBefore.x}`
  );
  const stillThere = movedComps.every((p, i) => {
    const id = [...editor.state.selected][i];
    const now = c.posOf(c.get(id)!);
    return p ? Math.round(now.x - p.x) === 1 : true;
  });
  check("Alle ausgewählten Bauteile wandern gemeinsam", stillThere);

  // Mehrfachauswahl mit der Maus ziehen: beide wandern gemeinsam
  const dragStart = c.posOf(comp);
  const dragStart2 = c.posOf(other);
  const dcx = (dragStart.x + l.cols / 2) * CELL;
  const dcy = (dragStart.y + l.rows / 2) * CELL;
  press(dcx, dcy);
  move(dcx + 24, dcy + 24);
  release(dcx + 24, dcy + 24);
  const dragEnd = c.posOf(comp);
  const dragEnd2 = c.posOf(other);
  check(
    "Ziehen verschiebt die ganze Mehrfachauswahl",
    Math.round(dragEnd.x - dragStart.x) === 1 &&
      Math.round(dragEnd.y - dragStart.y) === 1 &&
      Math.round(dragEnd2.x - dragStart2.x) === 1 &&
      Math.round(dragEnd2.y - dragStart2.y) === 1,
    `${dragEnd.x - dragStart.x},${dragEnd.y - dragStart.y} / ${dragEnd2.x - dragStart2.x},${dragEnd2.y - dragStart2.y}`
  );

  const titleX = frame.x * CELL + 14;
  const titleY = frame.y * CELL - 8;
  press(titleX, titleY);
  const selGroup = editor.state.selection;
  check(
    "Klick auf ein Modulfeld wählt das Modul aus",
    selGroup?.type === "group" && selGroup.id === frame.group.id,
    JSON.stringify(selGroup)
  );

  // Modul am Titel ziehen: Rahmen und Innenleben wandern zusammen
  const frameBefore = { x: frame.x, y: frame.y };
  move(titleX + 48, titleY + 24);
  release(titleX + 48, titleY + 24);
  const frameAfter = editor.frames.find((f) => f.group.id === frame.group.id)!;
  check(
    "Ziehen verschiebt ein Modulfeld samt Innenleben",
    Math.round(frameAfter.x - frameBefore.x) === 2 && Math.round(frameAfter.y - frameBefore.y) === 1,
    `${frameAfter.x - frameBefore.x},${frameAfter.y - frameBefore.y}`
  );
  const circuitFrame = c.expandedFrames.find((f) => f.groupId === frame.group.id)!;
  check(
    "Auch die Kabelführung kennt die neue Modulposition",
    circuitFrame.x === frameAfter.x && circuitFrame.y === frameAfter.y,
    `${circuitFrame.x},${circuitFrame.y}`
  );

  handlers.dblclick({ clientX: titleX + 48, clientY: titleY + 24 });
  check("Doppelklick öffnet das Modul im Editor", opened === 1, String(opened));

  press(-1800, -1800);
  release(-1800, -1800);
  check("Klick ins Leere hebt die Auswahl auf", editor.state.selection === null);

  c.setExpandedLayout(null);
}

console.log("Modul-Editor und Instanz-Austausch");

{
  const source = new Circuit();
  EXAMPLES.find((e) => e.name.startsWith("Halbaddierer"))!.build(source);
  source.rebuild();
  source.reset();
  const def = createModuleFromSelection(source, [...source.comps.keys()], "Halbaddierer", {
    cols: 4,
    rows: 3,
  })!;

  // Vorlage im Editor öffnen: Pins werden zu Ein-/Ausgängen.
  const edit = new Circuit();
  edit.load(editableCircuitForDef(def));
  const editIn = [...edit.comps.values()].filter((c) => c.kind === "input");
  const editOut = [...edit.comps.values()].filter((c) => c.kind === "output");
  check("Editor zeigt zwei Eingänge", editIn.length === 2, String(editIn.length));
  check("Editor zeigt zwei Ausgänge", editOut.length === 2, String(editOut.length));
  check("Editor übernimmt alle Innenteile", edit.comps.size === def.circuit.comps.length);
  check("Editor übernimmt alle inneren Kabel", edit.wires.length === def.circuit.wires.length);

  // Instanz mit Außenverdrahtung
  const c = new Circuit();
  const g = instantiateModule(c, def, 4, 4);
  const a = add(c, "input", 0, 0);
  const b = add(c, "input", 0, 3);
  const sum = add(c, "output", 24, 0);
  const carry = add(c, "output", 24, 3);
  link(c, a, 0, c.get(g.inputs[0].compId)!, 0);
  link(c, b, 0, c.get(g.inputs[1].compId)!, 0);
  link(c, c.get(g.outputs[0].compId)!, 0, sum, 0);
  link(c, c.get(g.outputs[1].compId)!, 0, carry, 0);
  c.rebuild();
  c.reset();

  // Aus der Instanz heraus bearbeiten und unverändert zurückschreiben.
  const snapshot = editableCircuitForGroup(c, g.id)!;
  check(
    "Instanz-Editor hat Pins als Ein-/Ausgänge",
    snapshot.comps.filter((p) => p.kind === "input").length === 2 &&
      snapshot.comps.filter((p) => p.kind === "output").length === 2
  );
  const work = new Circuit();
  work.load(snapshot);
  const rebuilt = buildModuleDef(
    work,
    [...work.comps.keys()],
    "Halbaddierer",
    { cols: g.cols, rows: g.rows },
    { id: "mod_test", version: 2 }
  )!;
  check("Bearbeitete Vorlage behält Version", rebuilt.version === 2);
  check("Bearbeitete Vorlage behält Endgröße", rebuilt.block.cols === g.cols && rebuilt.block.rows === g.rows);
  check("Bearbeitete Vorlage behält 2 Ein- / 2 Ausgänge", rebuilt.inputs.length === 2 && rebuilt.outputs.length === 2);

  const replaced = replaceGroupInternals(c, g.id, rebuilt);
  check("Instanz wird ersetzt", !!replaced && replaced.id !== g.id);
  check(
    "Außenkabel werden übernommen",
    !!replaced &&
      c.wires.some((w) => w.from === a.id && w.to === replaced.inputs[0].compId) &&
      c.wires.some((w) => w.from === replaced.outputs[0].compId && w.to === sum.id)
  );
  c.rebuild();
  c.reset();
  c.setInputValue(a, 1);
  c.setInputValue(b, 1);
  c.evalComb();
  check(
    "Ersetzte Instanz rechnet weiter",
    c.inputValues(sum)[0] === 0 && c.inputValues(carry)[0] === 1
  );

  // Speichern soll alle Instanzen desselben Moduls ersetzen.
  const c2 = new Circuit();
  const g1 = instantiateModule(c2, def, 0, 0);
  const g2 = instantiateModule(c2, def, 20, 0);
  const count = replaceModuleInstances(c2, def.id, rebuilt);
  check("Alle Instanzen werden ersetzt", count === 2, String(count));
  check("Alte Instanzen sind weg", !c2.groups.has(g1.id) && !c2.groups.has(g2.id));
  check("Neue Instanzen nutzen die neue Vorlage", [...c2.groups.values()].every((x) => x.moduleId === "mod_test"));
}

console.log("Kopieren, Duplizieren und Einfügen");

{
  const c = new Circuit();
  const a = add(c, "input", 0, 0);
  const b = add(c, "input", 0, 4);
  const and = add(c, "and", 8, 0);
  const o = add(c, "output", 16, 0);
  link(c, a, 0, and, 0);
  link(c, b, 0, and, 1);
  link(c, and, 0, o, 0);
  c.rebuild();
  c.reset();

  const originalIds = [...c.comps.keys()];
  const copied = c.extractUnits(originalIds);
  check("Kopie enthält alle Bauteile", copied.comps.length === 4);
  check("Kopie enthält innere Kabel", copied.wires.length === 3);

  const dupIds = c.duplicateUnits(originalIds, 20, 0);
  check("Duplikat erzeugt neue IDs", dupIds.length === 4 && dupIds.every((id) => !originalIds.includes(id)));
  check("Duplikat hat eigene Kabel", c.wires.length === 6);
  const dupWires = c.wires.filter((w) => dupIds.includes(w.from));
  check("Duplikat-Kabel verbinden nur neue Bauteile", dupWires.every((w) => dupIds.includes(w.to)));
  check("Duplikat liegt nicht auf dem Original", dupIds.every((id) => {
    const comp = c.get(id)!;
    return comp.x >= 20;
  }));

  // Einfügen an besetzter Stelle weicht auf den nächsten freien Platz aus.
  const units = c.extractUnits(originalIds);
  check("Originalplatz ist belegt", !c.unitsFitAt(units, 0, 0));
  const spot = c.findFreeOffset(units, 0, 0);
  check("Einfügen findet freie Stelle", c.unitsFitAt(units, spot.dx, spot.dy));
  check("Einfügen weicht aus", spot.dx !== 0 || spot.dy !== 0);

  const before = c.comps.size;
  const pasted = c.insertUnits(units, spot.dx, spot.dy);
  check("Einfügen legt alle Teile an", c.comps.size === before + 4 && pasted.length === 4);
  check("Eingefügte Auswahl ist selektierbar", pasted.every((id) => !!c.get(id)));
}

console.log("Assembler");

{
  const r = assemble(`
; Beispiel
start:
  LDA #1
  ADD #2
  OUT
  JMP start
`);
  check("Assembler ohne Fehler", r.errors.length === 0, JSON.stringify(r.errors));
  check("vier Wörter", r.words.length === 4, String(r.words.length));
  check("LDA #1 = 0x0101", r.words[0] === 0x0101);
  check("ADD #2 = 0x0402", r.words[1] === 0x0402);
  check("OUT = 0x1000", r.words[2] === 0x1000);
  check("JMP start = 0x2000", r.words[3] === 0x2000);
  check("Label start = 0", r.labels.start === 0);

  const withOrg = assemble(`
  .org 4
loop:
  STA 200
  JNZ loop
  HLT
`);
  check("org-Programm ohne Fehler", withOrg.errors.length === 0, JSON.stringify(withOrg.errors));
  check("Padding auf 7 Wörter", withOrg.words.length === 7, String(withOrg.words.length));
  check("Lücke ist 0", withOrg.words[0] === 0 && withOrg.words[3] === 0);
  check("STA 200 = 0x03C8", withOrg.words[4] === 0x03c8);
  check("JNZ loop = 0x2204", withOrg.words[5] === 0x2204);
  check("HLT = 0xFF00", withOrg.words[6] === 0xff00);

  const data = assemble(`
  .word 0x1234
  .word 'A'
`);
  check("Datenwörter", data.errors.length === 0 && data.words[0] === 0x1234 && data.words[1] === 65);

  const bad = assemble("LDA\nFOO #1\nSTA\nADD #300\n");
  check("Fehler werden gemeldet", bad.errors.length >= 3, bad.errors.map((e) => e.message).join("; "));
  check(
    "8-Bit-Grenze erkannt",
    bad.errors.some((e) => e.message.includes("8 Bit")),
    bad.errors.map((e) => e.message).join("; ")
  );
}

console.log(`\n${passed} Tests bestanden, ${failed} fehlgeschlagen.`);
if (failed > 0) process.exit(1);
