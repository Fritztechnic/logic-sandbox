import { Circuit } from "./circuit";
import { STD_CATALOG, ensureStdModules, placeStd, stdModule } from "./stdlib";
import { layoutOf } from "./logic";
import { maskOf } from "./types";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  \u2717 ${name} ${detail}`);
  }
}

type Std = ReturnType<typeof placeStd>;
interface Rig {
  c: Circuit;
  m: Std;
  set(pin: string, v: number): void;
  get(pin: string): number;
  clock(): void;
}

function rig(name: string, bits?: number): Rig {
  const c = new Circuit();
  const m = placeStd(c, name, bits, 0, 0);
  const def = stdModule(name, bits);
  const ins = new Map<string, ReturnType<Circuit["addComp"]>>();
  def.inputs.forEach((p, i) => {
    const inp = c.addComp("input", -10, i * 3);
    inp.width = p.width;
    c.addWire(inp.id, 0, m.inp(p.name).comp.id, 0);
    ins.set(p.name, inp);
  });
  const outs = new Map<string, ReturnType<Circuit["addComp"]>>();
  def.outputs.forEach((p, i) => {
    const out = c.addComp("output", 40, i * 3);
    out.width = p.width;
    c.addWire(m.out(p.name).comp.id, 0, out.id, 0);
    outs.set(p.name, out);
  });
  c.rebuild();
  c.reset();
  return {
    c,
    m,
    set: (pin, v) => c.setInputValue(ins.get(pin)!, v),
    get: (pin) => (m.out(pin).comp.outs[0] >>> 0),
    clock: () => {
      const clk = ins.get("CLK")!;
      c.setInputValue(clk, 1);
      c.halfStep();
      c.setInputValue(clk, 0);
      c.halfStep();
    },
  };
}

const u = (v: number, n: number) => (n >= 32 ? v >>> 0 : v & maskOf(n));
const samples = (n: number) => {
  const m = maskOf(n) >>> 0;
  const s = [0, 1, m, (m >>> 1) >>> 0, (m ^ (m >>> 1)) >>> 0, 0x5a5a5a5a & m, 0xa5a5a5a5 & m, 7 & m, 2 & m, 3 & m, 5 & m];
  return [...new Set(s.map((v) => v >>> 0))];
};
const sgn = (v: number, n: number) => (n >= 32 ? v | 0 : v >= 1 << (n - 1) ? v - (1 << n) : v);

const t0 = Date.now();
ensureStdModules();
console.log(`  Aufbau aller Standardmodule: ${Date.now() - t0} ms`);

// Alle Module: Pins stimmen mit dem Katalog überein, Innenschaltung überlappungsfrei
for (const e of STD_CATALOG) {
  for (const n of e.bits ?? [undefined]) {
    const def = stdModule(e.name, n);
    check(`${def.id}: Pins`, def.inputs.map((p) => p.name).join() === e.pins.filter((p) => p.dir === "in").map((p) => p.name).join() &&
      def.outputs.map((p) => p.name).join() === e.pins.filter((p) => p.dir === "out").map((p) => p.name).join());
    check(`${def.id}: Metadaten`, !!def.description && !!def.category && def.builtin === true && !!def.pinDocs);
    const comps = def.circuit.comps.filter((c) => !def.inputs.concat(def.outputs).some((p) => p.templateId === c.id));
    check(`${def.id}: nicht leer`, comps.length > 0);
  }
}

// mux
for (const n of [1, 8, 32]) {
  const r = rig("mux2", n);
  for (const a of samples(n)) for (const b of samples(n)) for (const s of [0, 1]) {
    r.set("A", a); r.set("B", b); r.set("S", s);
    check(`mux2/${n}`, r.get("Y") === (s ? b : a));
  }
}
for (const n of [4, 32]) {
  const r = rig("mux4", n);
  const d = samples(n);
  d.slice(0, 4).forEach((v, i) => r.set(`D${i}`, v));
  for (let s = 0; s < 4; s++) { r.set("S", s); check(`mux4/${n} s=${s}`, r.get("Y") === d[s]); }
}
for (const n of [1, 8, 32]) {
  const r = rig("mux8", n);
  const sm = samples(n);
  const d = Array.from({ length: 8 }, (_, i) => u(sm[i % sm.length] ^ i, n));
  d.forEach((v, i) => r.set(`D${i}`, v));
  for (let s = 0; s < 8; s++) { r.set("S", s); check(`mux8/${n} s=${s}`, r.get("Y") === d[s]); }
}
for (const k of [2, 3, 4]) {
  const r = rig("decoder", k);
  for (let a = 0; a < 1 << k; a++) for (const en of [0, 1]) {
    r.set("A", a); r.set("EN", en);
    check(`decoder ${k} a=${a} en=${en}`, r.get("Y") === (en ? 1 << a : 0));
  }
}

// Arithmetik
for (const n of [1, 4, 8, 32]) {
  const m = maskOf(n) >>> 0;
  const add = rig("adder", n), sub = rig("sub", n), cmp = rig("cmp", n), inc = rig("inc", n), z = rig("zero", n), rp = rig("repl", n);
  for (const a of samples(n)) {
    inc.set("A", a); check(`inc/${n} ${a}`, inc.get("Y") === u(a + 1, n));
    z.set("A", a); check(`zero/${n} ${a}`, z.get("Z") === (a === 0 ? 1 : 0));
    for (const b of samples(n)) {
      for (const ci of [0, 1]) {
        add.set("A", a); add.set("B", b); add.set("CI", ci);
        const s = a + b + ci;
        check(`adder/${n} ${a}+${b}+${ci}`, add.get("S") === u(s, n) && add.get("CO") === (s > m ? 1 : 0));
      }
      sub.set("A", a); sub.set("B", b);
      check(`sub/${n} ${a}-${b}`, sub.get("D") === u(a - b, n) && sub.get("CO") === (a >= b ? 1 : 0));
      cmp.set("A", a); cmp.set("B", b);
      check(`cmp/${n} ${a},${b}`, cmp.get("EQ") === (a === b ? 1 : 0) && cmp.get("LT") === (a < b ? 1 : 0) && cmp.get("LTS") === (sgn(a, n) < sgn(b, n) ? 1 : 0),
        `${cmp.get("EQ")}${cmp.get("LT")}${cmp.get("LTS")}`);
    }
  }
  for (const bit of [0, 1]) { rp.set("A", bit); check(`repl/${n} ${bit}`, rp.get("Y") === (bit ? m : 0)); }
}

// sext/zext/shl1/shr1/bshift
{
  const s = rig("sext", 32), z = rig("zext", 32);
  for (const v of [0, 1, 0x7fff, 0x8000, 0xffff, 0x1234]) {
    s.set("A", v); z.set("A", v);
    check(`sext ${v}`, s.get("Y") === ((v << 16) >> 16) >>> 0);
    check(`zext ${v}`, z.get("Y") === v);
  }
  for (const n of [4, 32]) {
    const l = rig("shl1", n), r = rig("shr1", n);
    for (const a of samples(n)) {
      l.set("A", a); r.set("A", a);
      check(`shl1/${n} ${a}`, l.get("Y") === u(a << 1, n));
      check(`shr1/${n} ${a}`, r.get("Y") === (a >>> 1));
    }
  }
  for (const n of [8, 32]) {
    const b = rig("bshift", n);
    for (const a of samples(n)) for (let sh = 0; sh < n; sh += n === 8 ? 1 : 3) for (const dir of [0, 1]) {
      b.set("A", a); b.set("SH", sh); b.set("DIR", dir);
      check(`bshift/${n} ${a} ${dir ? ">>" : "<<"} ${sh}`, b.get("Y") === (dir ? a >>> sh : u(a << sh, n)));
    }
  }
}

// ALU
for (const n of [8, 32]) {
  const r = rig("alu", n);
  const m = maskOf(n) >>> 0;
  for (const a of samples(n)) for (const b of samples(n)) {
    for (let op = 0; op < 8; op++) {
      r.set("A", a); r.set("B", b); r.set("OP", op);
      const sh = b & 31;
      let y = 0;
      let co: number | null = null;
      switch (op) {
        case 0: y = u(a + b, n); co = a + b > m ? 1 : 0; break;
        case 1: y = u(a - b, n); co = a >= b ? 1 : 0; break;
        case 2: y = u(a & b, n); break;
        case 3: y = u(a | b, n); break;
        case 4: y = u(a ^ b, n); break;
        case 5: y = sh >= n ? 0 : u(a << sh, n); break;
        case 6: y = sh >= n ? 0 : u(a >>> sh, n); break;
        default: y = b;
      }
      const ok = r.get("Y") === y && r.get("Z") === (y === 0 ? 1 : 0) && r.get("NEG") === ((y >>> (n - 1)) & 1) && (co === null || r.get("CO") === co);
      check(`alu/${n} op${op} ${a},${b}`, ok, `Y=${r.get("Y")} erwartet ${y}`);
    }
  }
}

// sequenziell
for (const n of [1, 8, 32]) {
  const r = rig("reg", n);
  const v = samples(n)[samples(n).length - 1];
  r.set("D", v); r.set("LD", 1); r.clock();
  check(`reg/${n} laden`, r.get("Q") === v);
  r.set("D", 1); r.set("LD", 0); r.clock();
  check(`reg/${n} halten`, r.get("Q") === v);
  r.set("RST", 1); r.clock(); r.set("RST", 0);
  check(`reg/${n} reset`, r.get("Q") === 0);
}
{
  const r = rig("counter", 8);
  r.set("EN", 1);
  for (let i = 1; i <= 5; i++) { r.clock(); check(`counter zählt ${i}`, r.get("Q") === i); }
  r.set("EN", 0); r.clock();
  check("counter hält", r.get("Q") === 5);
  r.set("D", 250); r.set("LD", 1); r.set("EN", 1); r.clock();
  check("counter LD Vorrang", r.get("Q") === 250);
  r.set("LD", 0);
  for (let i = 0; i < 7; i++) r.clock();
  check("counter Überlauf", r.get("Q") === 1);
  r.set("RST", 1); r.clock();
  check("counter reset", r.get("Q") === 0);
  const w = rig("counter", 32);
  w.set("D", 0xfffffffe); w.set("LD", 1); w.clock(); w.set("LD", 0); w.set("EN", 1); w.clock();
  check("counter32", w.get("Q") === 0xffffffff);
  w.clock();
  check("counter32 Überlauf", w.get("Q") === 0);
}
{
  const r = rig("shreg", 4);
  r.set("EN", 1);
  for (const bit of [1, 0, 1, 1]) { r.set("SI", bit); r.clock(); }
  check("shreg Q", r.get("Q") === 0b1011);
  r.set("SI", 0); r.clock();
  check("shreg SO", r.get("Q") === 0b0110 && r.get("SO") === 0);
  r.set("EN", 0); r.clock();
  check("shreg hält", r.get("Q") === 0b0110);
}
for (const n of [8, 32]) {
  const r = rig("regfile", n);
  const vals = samples(n);
  for (let i = 0; i < 16; i++) { r.set("WA", i); r.set("WD", u(vals[i % vals.length] ^ i, n)); r.set("WE", 1); r.clock(); }
  let ok = true;
  for (let i = 0; i < 16; i++) {
    r.set("RA", i); r.set("RB", 15 - i);
    ok = ok && r.get("QA") === u(vals[i % vals.length] ^ i, n) && r.get("QB") === u(vals[(15 - i) % vals.length] ^ (15 - i), n);
  }
  check(`regfile/${n} Schreiben + 2 Leseports`, ok);
  // WE=0 schreibt nicht; gleichzeitiges Lesen/Schreiben: alt bis zur Flanke, dann neu
  r.set("WA", 3); r.set("RA", 3); r.set("WE", 0); r.set("WD", 99); r.clock();
  check(`regfile/${n} WE=0`, r.get("QA") !== 99);
  const old = r.get("QA");
  r.set("WE", 1);
  check(`regfile/${n} vor Flanke alt`, r.get("QA") === old);
  r.clock();
  check(`regfile/${n} nach Flanke neu`, r.get("QA") === 99);
}

// Lehrmodule
{
  const r = rig("srlatch");
  r.set("S", 1); check("sr set", r.get("Q") === 1 && r.get("QN") === 0);
  r.set("S", 0); check("sr hält 1", r.get("Q") === 1);
  r.set("R", 1); check("sr reset", r.get("Q") === 0 && r.get("QN") === 1);
  r.set("R", 0); check("sr hält 0", r.get("Q") === 0);
  const d = rig("dlatch_g");
  d.set("D", 1); check("dlatch zu", d.get("Q") === 0);
  d.set("EN", 1); check("dlatch transparent", d.get("Q") === 1);
  d.set("EN", 0); d.set("D", 0); check("dlatch hält", d.get("Q") === 1 && d.get("QN") === 0);
  const f = rig("dff_ms");
  f.set("D", 1); check("ms vor Flanke", f.get("Q") === 0);
  f.clock(); check("ms Flanke", f.get("Q") === 1 && f.get("QN") === 0);
  f.set("D", 0); check("ms hält", f.get("Q") === 1);
  f.clock(); check("ms 0", f.get("Q") === 0);
  const t = rig("tff");
  const seq: number[] = [];
  for (let i = 0; i < 4; i++) { t.clock(); seq.push(t.get("Q")); }
  check("tff teilt", seq.join() === "1,0,1,0");
  t.set("RST", 1); t.clock();
  check("tff reset", t.get("Q") === 0);
}
{
  const r = rig("seg7");
  const want = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "acdefg", "abc", "abcdefg", "abcdfg", "abcefg", "cdefg", "adef", "bcdeg", "adefg", "aefg"];
  for (let v = 0; v < 16; v++) {
    r.set("A", v);
    const got = "abcdefg".split("").filter((s) => r.get(s) === 1).join("");
    check(`seg7 ${v.toString(16)}`, got === want[v], got);
  }
}

// Leistung: 32-Bit-ALU
{
  const r = rig("alu", 32);
  const count = r.c.comps.size;
  const t = Date.now();
  for (let i = 0; i < 200; i++) { r.set("A", i * 12345); r.set("B", i); r.set("OP", i & 7); }
  const ms = (Date.now() - t) / 200;
  console.log(`  alu32: ${count} Bauteile, ${ms.toFixed(2)} ms je Auswertung`);
  check("alu32 schnell", ms < 5);
}
void layoutOf;

console.log(`${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exit(1);
