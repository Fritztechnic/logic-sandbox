import { Circuit } from "./circuit";
import { createModuleFromSelection, instantiateModule } from "./modules";
import {
  addBitSelect,
  addFanOut,
  addReplicate,
  applyPlan,
  Box,
  findCollisions,
  planAlign,
  planAutoConnect,
  planConnect,
  planDistribute,
  unitPins,
} from "./connect";

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

function mk(c: Circuit, kind: "input" | "output" | "and" | "buf", x: number, y: number, width = 1, label = "") {
  const comp = c.addComp(kind, x, y);
  comp.width = width;
  comp.label = label;
  return comp;
}

console.log("Massen-Verbindung (Bauteile)");
{
  const c = new Circuit();
  const lowA = mk(c, "input", 0, 10);
  const topA = mk(c, "input", 0, 0);
  const wide = mk(c, "input", 0, -5, 8);
  const gate = mk(c, "and", 10, 0); // Eingänge A, B (1 Bit)
  c.rebuild();
  const plan = planConnect(c, [lowA.id, topA.id, wide.id], gate.id);
  check("Zwei Paare, 1 Bit je Eingang", plan.pairs.length === 2);
  check("Reihenfolge oben→unten", plan.pairs[0].from.comp === topA.id && plan.pairs[1].from.comp === lowA.id);
  check("Eingang A vor B", plan.pairs[0].to.port === 0 && plan.pairs[1].to.port === 1);
  check("8-Bit-Quelle wird mit Grund übersprungen", plan.skipped.length === 1 && plan.skipped[0].reason.includes("8 Bit"));
  check("applyPlan legt Kabel an", applyPlan(c, plan) === 2 && c.wires.length === 2);

  const again = planConnect(c, [topA.id], gate.id);
  check("Belegte Eingänge bleiben unangetastet", again.pairs.length === 0 && again.occupiedInputs === 2);
  const used = planConnect(c, [topA.id], mk(c, "and", 20, 0).id);
  check("Verbundener Ausgang wird übersprungen", used.pairs.length === 0 && used.skipped[0].reason.includes("schon verbunden"));
}

console.log("Massen-Verbindung (Module, Namen)");
{
  const build = (ins: string[], outs: string[]) => {
    const src = new Circuit();
    const g = mk(src, "and", 6, 0);
    ins.forEach((n, i) => src.addWire(mk(src, "input", 0, i * 4, 1, n).id, 0, g.id, i));
    outs.forEach((n, i) => src.addWire(g.id, 0, mk(src, "output", 12, i * 4, 1, n).id, 0));
    src.rebuild();
    return createModuleFromSelection(src, [...src.comps.keys()], `T${ins}${outs}`);
  };
  const defA = build(["p", "q"], ["B", "A"]);
  const def = build(["A", "B"], ["Z"]);
  check("Module erstellt", !!defA && !!def);

  const c = new Circuit();
  const a = instantiateModule(c, defA!, 0, 0);
  const b = instantiateModule(c, def!, 20, 0);
  c.rebuild();
  const outNames = unitPins(c, a.id, "out").map((p) => p.name);
  const inNames = unitPins(c, b.id, "in").map((p) => p.name);
  check("Modul-Pins haben Namen", outNames.join() === "B,A" && inNames.join() === "A,B", `${outNames}/${inNames}`);
  const plan = planConnect(c, [a.id], b.id);
  check("Modul→Modul: 2 Paare", plan.pairs.length === 2);
  check(
    "Gleiche Namen haben Vorrang",
    plan.pairs.every((p) => p.from.name.toLowerCase() === p.to.name.toLowerCase()),
    plan.pairs.map((p) => `${p.from.name}->${p.to.name}`).join(",")
  );
  check("Kabel gehen an die Pin-Puffer", plan.pairs.every((p) => a.outputs.some((o) => o.compId === p.from.comp) && b.inputs.some((i) => i.compId === p.to.comp)));
  check("Anlegen klappt", applyPlan(c, plan) === 2);
  const ext = c.wires.filter((w) => a.outputs.some((o) => o.compId === w.from) && b.inputs.some((i) => i.compId === w.to));
  check("Kreuzweise nach Namen: B→B, A→A", ext.length === 2 && ext.every((w) => a.outputs.find((o) => o.compId === w.from)!.name === b.inputs.find((i) => i.compId === w.to)!.name));
  const rev = planAutoConnect(c, a.id, b.id);
  check("Auto-Verbinden: A→B ausgeschöpft, probiert B→A", rev.from === b.id && rev.pairs.length === 1);
}

console.log("Bus-Helfer");
{
  const c = new Circuit();
  const bus = mk(c, "input", 0, 0, 4);
  const bit = mk(c, "output", 20, 0);
  const sp = addBitSelect(c, bus.id, 0, bit.id, 0, 2, { x: 240, y: 0 });
  check("Bit-Auswahl fügt Splitter ein", !!sp && sp.kind === "splitter" && sp.width === 4);
  bus.value = 0b0100;
  c.evalComb();
  check("Bit 2 kommt an", (c.inputValues(bit)[0] ?? 0) === 1);
  bus.value = 0b1011;
  c.evalComb();
  check("Andere Bits ignoriert", (c.inputValues(bit)[0] ?? 1) === 0);
  check("Falsche Breiten werden abgelehnt", addBitSelect(c, bit.id, 0, bit.id, 0, 0, { x: 0, y: 0 }) === null);

  const one = mk(c, "input", 0, 10);
  const wide = mk(c, "output", 20, 10, 4);
  const jo = addReplicate(c, one.id, 0, wide.id, 0, { x: 240, y: 240 });
  check("Replizieren fügt Joiner ein", !!jo && jo.kind === "joiner" && jo.width === 4);
  one.value = 1;
  c.evalComb();
  check("Alle vier Bits gesetzt", (c.inputValues(wide)[0] ?? 0) === 0b1111);

  const n = c.comps.size;
  const made = addFanOut(c, bus.id, 0, { x: 100, y: 100 });
  check("Bus auffächern: Splitter + 4 Lampen", !!made && made.length === 5 && c.comps.size === n + 5);
  check("Zu breite Busse werden abgelehnt", addFanOut(c, mk(c, "input", 0, 0, 32).id, 0, { x: 0, y: 0 }) === null);
}

console.log("Ausrichten und Verteilen");
{
  const boxes: Box[] = [
    { id: "a", x: 2, y: 0, w: 4, h: 3 },
    { id: "b", x: 10, y: 5, w: 2, h: 2 },
    { id: "c", x: 30, y: 9, w: 4, h: 3 },
  ];
  const left = planAlign(boxes, "left");
  check("Links: alle auf x=2", boxes.every((b) => b.x + (left.get(b.id)?.dx ?? 0) === 2));
  const right = planAlign(boxes, "right");
  check("Rechts: Kanten bei 34", boxes.every((b) => b.x + b.w + (right.get(b.id)?.dx ?? 0) === 34));
  const mid = planAlign(boxes, "centerY");
  check("Mitte vertikal: gleiche Mittellinie ±0,5", boxes.every((b) => Math.abs(b.y + b.h / 2 + (mid.get(b.id)?.dy ?? 0) - 6) <= 0.5));
  const dist = planDistribute(boxes, "x");
  check("Verteilen verschiebt nur das mittlere Objekt", dist.size === 1 && dist.has("b"));
  const bx = 10 + dist.get("b")!.dx;
  check("Gleiche Lücken (±1)", Math.abs(bx - 6 - (30 - (bx + 2))) <= 1, `${bx}`);
  check("Weniger als 3 Boxen: nichts zu verteilen", planDistribute(boxes.slice(0, 2), "x").size === 0);
  const hit = findCollisions(boxes, left, [{ id: "o", x: 2, y: 4, w: 3, h: 3 }]);
  check("Kollision mit fremdem Bauteil wird gemeldet", hit.includes("b"), hit.join());
}

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exit(1);
