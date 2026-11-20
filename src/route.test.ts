import { Circuit } from "./circuit";
import { EXAMPLES } from "./examples";
import { buildCpu } from "./cpu";
import { getWireRoutes } from "./route";
import { computeExpandedLayout } from "./expand";
import { measure, type Metrics } from "./routeMetrics";

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

// Messwerte des alten Mustersuch-Routers (vor dem Umbau, eingeklappte Ansicht)
const BASELINE: Record<string, { crossings: number; through: number }> = {
  "16-Bit-Addierer (Ripple-Carry)": { crossings: 1836, through: 196 },
  "32-Bit-Addierer (Ripple-Carry)": { crossings: 6294, through: 1181 },
  "Akku-CPU (32 Bit)": { crossings: 2060, through: 259 },
};
const OVERLAP_MAX: Record<string, number> = {
  "16-Bit-Addierer (Ripple-Carry)": 500,
  "32-Bit-Addierer (Ripple-Carry)": 3200,
  "16-Bit-Zähler (sequenziell)": 90,
  "32-Bit-Zähler (sequenziell)": 600,
  "Mini-CPU (8 Bit, Module + externes ROM/RAM)": 70,
  "Mini-CPU (16 Bit, Module + externes ROM/RAM)": 320,
  "CPU 32 Bit (RISC, Registerfeld, 1024 Wörter)": 15,
  "Akku-CPU (32 Bit)": 600,
  "Akku-CPU (32 Bit) entpackt": 12000,
};

const results: { name: string; m: Metrics; ms: number }[] = [];

console.log("Kabelrouting – Qualitätsmetriken");
const cases: { name: string; expanded: boolean; build: (c: Circuit) => void }[] = [];
for (const ex of EXAMPLES) cases.push({ name: ex.name, expanded: false, build: ex.build });
cases.push({ name: "Akku-CPU (32 Bit)", expanded: false, build: (c) => buildCpu(c, 32) });
cases.push({ name: "Akku-CPU (32 Bit) entpackt", expanded: true, build: (c) => buildCpu(c, 32) });
for (const ex of cases) {
  const c = new Circuit();
  ex.build(c);
  c.rebuild();
  c.reset();
  if (ex.expanded) {
    const l = computeExpandedLayout(c);
    c.setExpandedLayout(l.positions, l.frames);
  }
  const t0 = performance.now();
  const routes = getWireRoutes(c, "ortho");
  const ms = performance.now() - t0;
  const m = measure(c, routes);
  results.push({ name: ex.name, m, ms });
  console.log(`  ${ex.name}: ${JSON.stringify(m)} ${ms.toFixed(0)} ms`);
  check(`${ex.name}: jedes Kabel hat eine Trasse`, m.wires === c.wires.filter((w) => !c.isWireHidden(w)).length);
  check(`${ex.name}: Pins getroffen, nur rechtwinklig`, m.endsOff === 0 && m.diagonal === 0);
  const base = BASELINE[ex.name];
  if (!ex.expanded) {
    check(`${ex.name}: keine Kabel durch Bauteile/Module`, m.throughComp === 0 && m.throughBlock === 0, `${m.throughComp}/${m.throughBlock}`);
  } else {
    check(`${ex.name}: Kabel durch Bauteile deutlich unter altem Router (2448)`, m.throughComp < 1500, `${m.throughComp}`);
    check(`${ex.name}: Berechnung unter 1,5 s`, ms < 1500, `${ms.toFixed(0)} ms`);
  }
  if (base) {
    check(`${ex.name}: weniger Kreuzungen als alter Router (${base.crossings})`, m.crossings < base.crossings, `${m.crossings}`);
    check(`${ex.name}: Kabel durch Bauteile besser als alt (${base.through})`, m.throughComp < base.through);
  }
  // Rest-Überlappungen stammen aus 1-Zellen-Korridoren der Beispiel-Layouts
  check(`${ex.name}: Überlappungen unter Grenzwert`, m.overlaps <= (OVERLAP_MAX[ex.name] ?? 0), `${m.overlaps}`);
  const t1 = performance.now();
  check(`${ex.name}: Cache liefert identische Routen`, getWireRoutes(c, "ortho") === routes && performance.now() - t1 < 20);
}

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exit(1);
