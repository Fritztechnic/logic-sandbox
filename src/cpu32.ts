import { Circuit, makeComp } from "./circuit";
import { layoutOf, newId, portWidths } from "./logic";
import { addModule, buildModuleDef, getModule, instantiateModule, ModuleDef } from "./modules";
import { Comp, CompKind, GroupInstance } from "./types";
import { assemble32 } from "./assembler32";
import { CPU32_DEFAULT_PROGRAM } from "./cpu32-programs";
import { CTRL_BITS, RAM_WORDS, ROM_WORDS, controlTable } from "./cpu32-ref";
import { placeStd } from "./stdlib";

/**
 * RISC-32 als Beispielschaltung. Die oberste Ebene besteht nur aus Standardmodulen
 * (std-…), den CPU-Modulen (cpu32r-…) und den Speichern (Programm-ROM, Steuer-ROM,
 * Daten-RAM). Alle Datenleitungen sind 32 Bit breit; die Bit-Arbeit steckt in den Modulen.
 * Befehlssatz und Referenzmodell: cpu32-ref.ts.
 */

interface Src {
  comp: Comp;
  port: number;
}

const bitOf = (sp: Comp, n: number, i: number): Src => ({ comp: sp, port: n - 1 - i });

/** Kleiner Schaltplan-Baukasten für die CPU-Module (Platzierung mit Überlappungsprüfung). */
class MB {
  readonly c = new Circuit();
  private rects: { x: number; y: number; w: number; h: number }[] = [];
  private pinIn = 0;
  private pinOut = 0;

  add(kind: CompKind, x: number, y: number, opts: Partial<Comp> = {}): Comp {
    const comp = makeComp(kind, x, y);
    Object.assign(comp, opts);
    const l = layoutOf(comp);
    for (const r of this.rects) {
      if (x < r.x + r.w && x + l.cols > r.x && y < r.y + r.h && y + l.rows > r.y) {
        throw new Error(`CPU-Modul: Überlappung bei ${kind} (${x},${y})`);
      }
    }
    this.rects.push({ x, y, w: l.cols, h: l.rows });
    this.c.comps.set(comp.id, comp);
    return comp;
  }

  wire(from: Src, to: Comp, port: number): void {
    const sw = portWidths(from.comp).out[from.port];
    const dw = portWidths(to).in[port];
    if (sw === undefined || dw === undefined || sw !== dw) {
      throw new Error(`CPU-Modul: Busbreite passt nicht (${from.comp.kind}[${from.port}] ${sw} → ${to.kind}[${port}] ${dw})`);
    }
    this.c.wires.push({ id: newId("w"), from: from.comp.id, fromPort: from.port, to: to.id, toPort: port });
  }

  gate(kind: CompKind, x: number, y: number, a: Src, b?: Src): Src {
    const comp = this.add(kind, x, y, { width: portWidths(a.comp).out[a.port] });
    this.wire(a, comp, 0);
    if (b) this.wire(b, comp, 1);
    return { comp, port: 0 };
  }

  split(x: number, y: number, bus: Src): Comp {
    const sp = this.add("splitter", x, y, { width: portWidths(bus.comp).out[bus.port] });
    this.wire(bus, sp, 0);
    return sp;
  }

  /** Verbindet Bits (LSB zuerst) zu einem Bus. */
  join(x: number, y: number, bits: Src[]): Src {
    const j = this.add("joiner", x, y, { width: bits.length });
    bits.forEach((s, i) => this.wire(s, j, bits.length - 1 - i));
    return { comp: j, port: 0 };
  }

  zero(x: number, y: number): Src {
    return { comp: this.add("const", x, y, { width: 1, value: 0 }), port: 0 };
  }

  input(name: string, width: number): Src {
    const comp = this.add("input", -10, this.pinIn++ * 3, { width, label: name });
    return { comp, port: 0 };
  }

  output(name: string, width: number, src: Src): void {
    const comp = this.add("output", 1000, this.pinOut++ * 3, { width, label: name });
    this.wire(src, comp, 0);
  }
}

/* ---------- CPU-Module ---------- */

interface ModSpec {
  id: string;
  name: string;
  description: string;
  pinDocs: Record<string, string>;
  build: (b: MB) => void;
}

const field = (b: MB, sp: Comp, n: number, lo: number, width: number, x: number, y: number): Src =>
  b.join(x, y, Array.from({ length: width }, (_, i) => bitOf(sp, n, lo + i)));

const MODULES: ModSpec[] = [
  {
    id: "cpu32r-decode",
    name: "Befehls-Decoder",
    description:
      "Zerlegt das 32-Bit-Befehlswort in seine Felder: [31:24] Opcode, [23:20] rd, [19:16] rs1, [15:12] rs2, [15:0] imm16. RB ist die Adresse des zweiten Leseports: rs2 (R-Typ) oder rd (RBRD=1: ST und Branches lesen ihr zweites Register aus dem rd-Feld).",
    pinDocs: {
      INSTR: "Befehlswort",
      RBRD: "1: zweiter Leseport adressiert rd statt rs2",
      OP: "Opcode (für das Steuer-ROM)",
      RA: "Adresse Leseport A (rs1)",
      RB: "Adresse Leseport B (rs2 oder rd)",
      WA: "Schreibadresse (rd)",
      IMM: "Konstante imm16",
    },
    build: (b) => {
      const instr = b.input("INSTR", 32);
      const rbrd = b.input("RBRD", 1);
      const sp = b.split(0, 0, instr);
      const op = field(b, sp, 32, 24, 8, 10, 0);
      const rd = field(b, sp, 32, 20, 4, 10, 10);
      const rs1 = field(b, sp, 32, 16, 4, 10, 16);
      const imm = field(b, sp, 32, 0, 16, 10, 22);
      const nsel = b.gate("not", 10, 41, rbrd);
      const cells: Src[] = [];
      for (let j = 0; j < 4; j++) {
        const y = 34 + j * 8;
        const t0 = b.gate("and", 18, y, bitOf(sp, 32, 12 + j), nsel);
        const t1 = b.gate("and", 18, y + 3, bitOf(sp, 32, 20 + j), rbrd);
        cells.push(b.gate("or", 24, y + 1, t0, t1));
      }
      const rb = b.join(30, 34, cells);
      b.output("OP", 8, op);
      b.output("RA", 4, rs1);
      b.output("RB", 4, rb);
      b.output("WA", 4, rd);
      b.output("IMM", 16, imm);
    },
  },
  {
    id: "cpu32r-imm",
    name: "Konstanten-Erzeugung",
    description:
      "Erweitert die 16-Bit-Konstante des Befehls auf 32 Bit: SEXT mit Vorzeichen (Bit 15 wird nach oben kopiert), ZEXT mit Nullen, HI als imm16 << 16 (für LUI).",
    pinDocs: {
      IMM: "Konstante imm16",
      SEXT: "vorzeichenerweitert",
      ZEXT: "nullerweitert",
      HI: "imm16 << 16",
    },
    build: (b) => {
      const imm = b.input("IMM", 16);
      const sp = b.split(0, 0, imm);
      const zero = b.zero(0, 19);
      const low = Array.from({ length: 16 }, (_, i) => bitOf(sp, 16, i));
      const sign = bitOf(sp, 16, 15);
      b.output("SEXT", 32, b.join(10, 0, [...low, ...new Array(16).fill(sign)]));
      b.output("ZEXT", 32, b.join(16, 0, [...low, ...new Array(16).fill(zero)]));
      b.output("HI", 32, b.join(22, 0, [...new Array(16).fill(zero), ...low]));
    },
  },
  {
    id: "cpu32r-ctrl",
    name: "Steuersignale",
    description:
      "Zerlegt das Steuerwort aus dem Steuer-ROM in einzelne Steuersignale. Bits: 0–2 ALU-Op, 3–4 B-Quelle, 5 RBRD, 6 RegSchreiben, 7–8 Schreibquelle, 9 RAM schreiben, 10 OUT laden, 11 JMP, 12 JR, 13–16 BEQ/BNE/BLT/BGE, 17 HLT. RUN = nicht HLT.",
    pinDocs: {
      CW: "Steuerwort",
      ALUOP: "ALU-Operation (0 ADD, 1 SUB, 2 AND, 3 OR, 4 XOR, 5 SHL, 6 SHR, 7 PASSB)",
      BSEL: "B-Quelle: 0 Register, 1 imm sext, 2 imm zext, 3 imm<<16",
      RBRD: "zweiter Leseport liest rd",
      RW: "Register schreiben",
      WSRC: "Schreibquelle: 0 ALU, 1 RAM, 2 PC+1",
      MW: "RAM schreiben",
      OUT: "Ausgabe-Register laden",
      BR: "Branch-Typ: Bit0 BEQ, Bit1 BNE, Bit2 BLT, Bit3 BGE",
      JMP: "unbedingter Sprung (JMP, JAL, JR)",
      JR: "Sprungziel aus Register",
      RUN: "1 = PC läuft, 0 = HLT",
    },
    build: (b) => {
      const cw = b.input("CW", 32);
      const sp = b.split(0, 0, cw);
      const range = (lo: number, n: number) => Array.from({ length: n }, (_, i) => bitOf(sp, 32, lo + i));
      const bit = (k: number) => bitOf(sp, 32, k);
      b.output("ALUOP", 3, b.join(10, 0, range(CTRL_BITS.alu, 3)));
      b.output("BSEL", 2, b.join(10, 5, range(CTRL_BITS.bsel, 2)));
      b.output("RBRD", 1, bit(CTRL_BITS.rbRd));
      b.output("RW", 1, bit(CTRL_BITS.regWrite));
      b.output("WSRC", 2, b.join(10, 9, range(CTRL_BITS.wsrc, 2)));
      b.output("MW", 1, bit(CTRL_BITS.memWrite));
      b.output("OUT", 1, bit(CTRL_BITS.out));
      b.output("BR", 4, b.join(10, 13, range(CTRL_BITS.beq, 4)));
      b.output("JMP", 1, bit(CTRL_BITS.jmp));
      b.output("JR", 1, bit(CTRL_BITS.jr));
      b.output("RUN", 1, b.gate("not", 10, 20, bit(CTRL_BITS.halt)));
    },
  },
  {
    id: "cpu32r-branch",
    name: "Branch-Logik",
    description:
      "Entscheidet über den nächsten PC. Flags der Subtraktion A−B: Z (Ergebnis 0), NEG (Vorzeichenbit), V = Überlauf = (A31≠B31) ∧ (A31≠NEG). Vorzeichenbehaftet kleiner: LT = NEG ⊕ V (korrekt auch bei Überlauf). TAKE = BEQ∧Z ∨ BNE∧¬Z ∨ BLT∧LT ∨ BGE∧¬LT ∨ JMP. PCSEL: 0 = PC+1, 1 = Sprungziel (imm), 2 = Register (JR).",
    pinDocs: {
      Z: "ALU-Ergebnis ist 0",
      NEG: "Vorzeichenbit des ALU-Ergebnisses",
      A: "ALU-Operand A",
      B: "ALU-Operand B",
      BR: "Branch-Typ (BEQ, BNE, BLT, BGE)",
      JMP: "unbedingter Sprung",
      JR: "Sprung zu Register",
      PCSEL: "Auswahl des nächsten PC",
      V: "Überlauf-Flag der Subtraktion",
    },
    build: (b) => {
      const z = b.input("Z", 1);
      const neg = b.input("NEG", 1);
      const a = b.input("A", 32);
      const bb = b.input("B", 32);
      const br = b.input("BR", 4);
      const jmp = b.input("JMP", 1);
      const jr = b.input("JR", 1);
      const sa = b.split(0, 0, a);
      const sb = b.split(0, 35, bb);
      const a31 = bitOf(sa, 32, 31);
      const b31 = bitOf(sb, 32, 31);
      const diff = b.gate("xor", 10, 0, a31, b31);
      const flip = b.gate("xor", 10, 4, a31, neg);
      const v = b.gate("and", 16, 2, diff, flip);
      const lt = b.gate("xor", 22, 2, neg, v);
      const sbr = b.split(0, 72, br);
      const nz = b.gate("not", 10, 10, z);
      const nlt = b.gate("not", 28, 2, lt);
      const t0 = b.gate("and", 10, 14, bitOf(sbr, 4, 0), z);
      const t1 = b.gate("and", 10, 18, bitOf(sbr, 4, 1), nz);
      const t2 = b.gate("and", 34, 2, bitOf(sbr, 4, 2), lt);
      const t3 = b.gate("and", 34, 6, bitOf(sbr, 4, 3), nlt);
      const o1 = b.gate("or", 16, 14, t0, t1);
      const o2 = b.gate("or", 40, 2, t2, t3);
      const o3 = b.gate("or", 46, 8, o1, o2);
      const take = b.gate("or", 52, 8, o3, jmp);
      const njr = b.gate("not", 52, 14, jr);
      const take0 = b.gate("and", 58, 8, take, njr);
      b.output("PCSEL", 2, b.join(64, 8, [take0, jr]));
      b.output("V", 1, v);
    },
  },
  {
    id: "cpu32r-addr",
    name: "Adresse (untere 10 Bit)",
    description: "Schneidet aus einem 32-Bit-Wert die unteren 10 Bit als Speicheradresse (0…1023) aus.",
    pinDocs: { A: "32-Bit-Wert", ADDR: "untere 10 Bit" },
    build: (b) => {
      const a = b.input("A", 32);
      const sp = b.split(0, 0, a);
      b.output("ADDR", 10, b.join(10, 0, Array.from({ length: 10 }, (_, i) => bitOf(sp, 32, i))));
    },
  },
];

export const CPU32_MODULE_IDS = MODULES.map((m) => m.id);
const CPU32_CATEGORY = "RISC-32-CPU";

function buildModuleSpec(spec: ModSpec): ModuleDef {
  const b = new MB();
  spec.build(b);
  b.c.rebuild();
  const def = buildModuleDef(b.c, [...b.c.comps.keys()], spec.name, { cols: 6 }, { id: spec.id });
  if (!def) throw new Error(`CPU-Modul ${spec.id}: leer`);
  def.description = spec.description;
  def.category = CPU32_CATEGORY;
  def.builtin = true;
  def.pinDocs = spec.pinDocs;
  return def;
}

/** Legt die CPU-Module in die Bibliothek (bearbeitete Versionen bleiben erhalten). */
export function ensureCpu32Modules(): void {
  for (const spec of MODULES) {
    const existing = getModule(spec.id);
    if (existing && (existing.builtin || (existing.version ?? 1) > 1)) continue;
    addModule(buildModuleSpec(spec));
  }
}

/* ---------- Beispielschaltung ---------- */

interface Placed {
  group: GroupInstance;
  inp(name: string): Src;
  out(name: string): Src;
}

function placeCpu(c: Circuit, id: string, x: number, y: number): Placed {
  const def = getModule(id);
  if (!def) throw new Error(`CPU-Modul ${id} fehlt`);
  const group = instantiateModule(c, def, x, y);
  const pin = (list: GroupInstance["inputs"], name: string): Src => {
    const p = list.find((q) => q.name === name);
    const comp = p && c.comps.get(p.compId);
    if (!comp) throw new Error(`CPU-Modul ${id}: Pin ${name} unbekannt`);
    return { comp, port: 0 };
  };
  return { group, inp: (n) => pin(group.inputs, n), out: (n) => pin(group.outputs, n) };
}

const PROGRAM_LABEL = "PROGRAMM";

/** Schaltung enthält ein RISC-32-Programm-ROM (32 Bit breit, Beschriftung PROGRAMM)? */
export function findCpu32ProgramRom(c: Circuit): Comp | undefined {
  for (const comp of c.comps.values()) {
    if (comp.kind === "rom" && comp.dataWidth === 32 && comp.label === PROGRAM_LABEL) return comp;
  }
  return undefined;
}

/** Schreibt Programmwörter ins Programm-ROM (Rest wird NOP) und setzt die Schaltung zurück. */
export function loadCpu32Program(c: Circuit, rom: Comp, words: number[]): void {
  rom.data = new Array(1 << rom.addrWidth).fill(0);
  words.forEach((w, i) => {
    if (i < rom.data.length) rom.data[i] = w >>> 0;
  });
  c.rebuild();
  c.reset();
}

/** Baut die RISC-32-CPU mit Programm (Standard: Fibonacci). */
export function buildCpu32(c: Circuit, source: string = CPU32_DEFAULT_PROGRAM): void {
  ensureCpu32Modules();
  const program = assemble32(source);
  if (program.errors.length) throw new Error(`Programm fehlerhaft: ${program.errors[0].message}`);

  const blocks: { x: number; y: number; w: number; h: number }[] = [];
  const fit = (x: number, y: number, w: number, h: number) => {
    for (let r = 0; r < 60; r++) {
      for (let dy = 0; dy <= r; dy++) {
        const py = y + dy;
        if (!blocks.some((b) => x < b.x + b.w + 2 && x + w + 2 > b.x && py < b.y + b.h + 2 && py + h + 2 > b.y)) {
          blocks.push({ x, y: py, w, h });
          return py;
        }
      }
    }
    return y;
  };
  const std = (name: string, bits: number | undefined, x: number, y: number) => {
    const def = getModule(`std-${name}${bits ? "-" + bits : ""}`);
    const py = fit(x, y, def?.block.cols ?? 8, def?.block.rows ?? 6);
    const p = placeStd(c, name, bits, x, py);
    return p;
  };
  const cpu = (id: string, x: number, y: number) => {
    const def = getModule(id)!;
    const py = fit(x, y, def.block.cols, def.block.rows);
    return placeCpu(c, id, x, py);
  };
  const part = (kind: CompKind, x: number, y: number, w: number, h: number, opts: Partial<Comp>) => {
    const py = fit(x, y, w, h);
    const comp = c.addComp(kind, x, py);
    Object.assign(comp, opts);
    return comp;
  };
  const wire = (a: Src, b: Src) => {
    if (!c.addWire(a.comp.id, a.port, b.comp.id, 0)) throw new Error("CPU32-Verdrahtung fehlgeschlagen");
  };
  const pin = (comp: Comp): Src => ({ comp, port: 0 });

  const clk = part("clock", 0, 0, 3, 2, { div: 1, label: "TAKT" });
  const rst = part("input", 0, 4, 3, 2, { label: "RESET", value: 0 });

  // Befehlsabruf: PC → Programm-ROM
  const pcReg = std("reg", 32, 8, 0);
  const pcAddr = cpu("cpu32r-addr", 22, 0);
  const prom = part("rom", 34, 2, 5, 3, {
    addrWidth: 10,
    dataWidth: 32,
    data: new Array(ROM_WORDS).fill(0),
    label: PROGRAM_LABEL,
  });
  program.words.forEach((w, i) => (prom.data[i] = w >>> 0));

  // Decoder und Steuerwerk
  const dec = cpu("cpu32r-decode", 46, 0);
  const crom = part("rom", 46, 16, 5, 3, {
    addrWidth: 8,
    dataWidth: 32,
    data: [...controlTable()],
    label: "STEUER-ROM",
  });
  const ctrl = cpu("cpu32r-ctrl", 60, 16);
  const imm = cpu("cpu32r-imm", 60, 0);

  // Registerfeld, B-Quelle, ALU, Verzweigung
  const rf = std("regfile", 32, 76, 0);
  const bmux = std("mux4", 32, 90, 6);
  const alu = std("alu", 32, 104, 0);
  const branch = cpu("cpu32r-branch", 104, 16);

  // Datenspeicher und Rückschreiben
  const ramAddr = cpu("cpu32r-addr", 118, 0);
  const ram = part("ram", 132, 0, 5, 4, {
    addrWidth: 10,
    dataWidth: 32,
    data: new Array(RAM_WORDS).fill(0),
    label: "DATEN-RAM",
  });
  const wb = std("mux4", 32, 142, 0);
  const outReg = std("reg", 32, 118, 16);

  // PC-Logik unten: PC+1 und Sprungauswahl
  const inc = std("inc", 32, 22, 24);
  const pcMux = std("mux4", 32, 46, 30);

  // Anzeigen
  const lampY = 40;
  const lamp = (label: string, width: number, x: number, y: number, format: "hex" | "dec" | "bin", src: Src) => {
    const l = part("output", x, y, 3, 2, { label, width, format });
    wire(src, pin(l));
  };

  // Verdrahtung: Befehlsabruf
  wire(pin(clk), pcReg.inp("CLK"));
  wire(pin(rst), pcReg.inp("RST"));
  wire(ctrl.out("RUN"), pcReg.inp("LD"));
  wire(pcMux.out("Y"), pcReg.inp("D"));
  wire(pcReg.out("Q"), pcAddr.inp("A"));
  wire(pcAddr.out("ADDR"), pin(prom));
  wire(pcReg.out("Q"), inc.inp("A"));

  // Decoder / Steuerwerk
  wire(pin(prom), dec.inp("INSTR"));
  wire(ctrl.out("RBRD"), dec.inp("RBRD"));
  wire(dec.out("OP"), pin(crom));
  wire(pin(crom), ctrl.inp("CW"));
  wire(dec.out("IMM"), imm.inp("IMM"));

  // Registerfeld
  wire(dec.out("RA"), rf.inp("RA"));
  wire(dec.out("RB"), rf.inp("RB"));
  wire(dec.out("WA"), rf.inp("WA"));
  wire(wb.out("Y"), rf.inp("WD"));
  wire(ctrl.out("RW"), rf.inp("WE"));
  wire(pin(clk), rf.inp("CLK"));

  // B-Quelle und ALU
  wire(rf.out("QB"), bmux.inp("D0"));
  wire(imm.out("SEXT"), bmux.inp("D1"));
  wire(imm.out("ZEXT"), bmux.inp("D2"));
  wire(imm.out("HI"), bmux.inp("D3"));
  wire(ctrl.out("BSEL"), bmux.inp("S"));
  wire(rf.out("QA"), alu.inp("A"));
  wire(bmux.out("Y"), alu.inp("B"));
  wire(ctrl.out("ALUOP"), alu.inp("OP"));

  // Verzweigung und PC-Auswahl
  wire(alu.out("Z"), branch.inp("Z"));
  wire(alu.out("NEG"), branch.inp("NEG"));
  wire(rf.out("QA"), branch.inp("A"));
  wire(bmux.out("Y"), branch.inp("B"));
  wire(ctrl.out("BR"), branch.inp("BR"));
  wire(ctrl.out("JMP"), branch.inp("JMP"));
  wire(ctrl.out("JR"), branch.inp("JR"));
  wire(inc.out("Y"), pcMux.inp("D0"));
  wire(imm.out("ZEXT"), pcMux.inp("D1"));
  wire(rf.out("QA"), pcMux.inp("D2"));
  wire(rf.out("QA"), pcMux.inp("D3"));
  wire(branch.out("PCSEL"), pcMux.inp("S"));

  // Datenspeicher und Rückschreiben
  wire(alu.out("Y"), ramAddr.inp("A"));
  wire(ramAddr.out("ADDR"), pin(ram));
  if (!c.addWire(rf.out("QB").comp.id, 0, ram.id, 1)) throw new Error("CPU32-Verdrahtung: RAM-Daten");
  if (!c.addWire(ctrl.out("MW").comp.id, 0, ram.id, 2)) throw new Error("CPU32-Verdrahtung: RAM-Schreiben");
  if (!c.addWire(clk.id, 0, ram.id, 3)) throw new Error("CPU32-Verdrahtung: RAM-Takt");
  wire(alu.out("Y"), wb.inp("D0"));
  wire(pin(ram), wb.inp("D1"));
  wire(inc.out("Y"), wb.inp("D2"));
  wire(alu.out("Y"), wb.inp("D3"));
  wire(ctrl.out("WSRC"), wb.inp("S"));

  // Ausgabe-Register
  wire(rf.out("QA"), outReg.inp("D"));
  wire(ctrl.out("OUT"), outReg.inp("LD"));
  wire(pin(clk), outReg.inp("CLK"));
  wire(pin(rst), outReg.inp("RST"));

  // Anzeigen
  lamp("PC", 10, 0, lampY, "dec", pcAddr.out("ADDR"));
  lamp("BEFEHL", 32, 6, lampY, "hex", pin(prom));
  lamp("ALU", 32, 12, lampY, "hex", alu.out("Y"));
  lamp("Z", 1, 18, lampY, "bin", alu.out("Z"));
  lamp("N", 1, 22, lampY, "bin", alu.out("NEG"));
  lamp("V", 1, 26, lampY, "bin", branch.out("V"));
  lamp("OUT", 32, 30, lampY, "hex", outReg.out("Q"));

  c.rebuild();
  c.reset();
}
