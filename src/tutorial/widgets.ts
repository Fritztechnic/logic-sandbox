import { assemble } from "../assembler";
import { INSTRUCTIONS, MODE_NAMES, CTRL_LINES, activeLines, hex } from "./isa";
import { h } from "./live";
import { WidgetName } from "./types";

const bin = (v: number, w: number): string => (v >>> 0).toString(2).padStart(w, "0");

function field(label: string, input: HTMLElement): HTMLElement {
  const l = h("label", "wd-field");
  l.append(h("span", "", label), input);
  return l;
}

/* ---------- Ripple-Carry-Animation (Kap. 4) ---------- */

function ripple(): HTMLElement {
  const root = h("div", "wd");
  root.append(h("h4", "", "Animation: Übertrag läuft durch 8 Volladdierer"));
  const a = h("input");
  const b = h("input");
  a.type = b.type = "number";
  a.min = b.min = "0";
  a.max = b.max = "255";
  a.value = "200";
  b.value = "100";
  const go = h("button", "btn primary", "Animieren");
  go.type = "button";
  const ctl = h("div", "wd-row");
  ctl.append(field("A (0–255)", a), field("B (0–255)", b), go);
  const grid = h("div", "rc-grid");
  const msg = h("p", "wd-msg");
  root.append(ctl, grid, msg);
  let timer = 0;

  const cols = (stage: number, av: number, bv: number): void => {
    grid.textContent = "";
    const rows = ["Bit", "A", "B", "Cin", "Summe", "Cout"];
    const data: string[][] = rows.map(() => []);
    let carry = 0;
    for (let i = 7; i >= 0; i--) data[0].push(String(i));
    const sums: number[] = [];
    const couts: number[] = [];
    const cins: number[] = [];
    for (let i = 0; i < 8; i++) {
      const x = (av >> i) & 1;
      const y = (bv >> i) & 1;
      const t = x + y + carry;
      cins[i] = carry;
      sums[i] = t & 1;
      couts[i] = t >> 1;
      carry = couts[i];
    }
    for (let i = 7; i >= 0; i--) {
      data[1].push(String((av >> i) & 1));
      data[2].push(String((bv >> i) & 1));
      const done = i < stage;
      data[3].push(i <= stage ? String(cins[i]) : "·");
      data[4].push(done ? String(sums[i]) : "·");
      data[5].push(done ? String(couts[i]) : "·");
    }
    rows.forEach((name, r) => {
      grid.append(h("div", "rc-h", name));
      data[r].forEach((v, k) => {
        const bit = 7 - k;
        const c = h("div", "rc-c", v);
        if (bit === stage) c.classList.add("act");
        if (v === "1") c.classList.add("one");
        grid.append(c);
      });
    });
    const total = av + bv;
    if (stage >= 8) {
      const res = sums.reduceRight((s, v) => s * 2 + v, 0);
      msg.textContent =
        total > 255
          ? `${av} + ${bv} = ${total} passt nicht in 8 Bit: Summe = ${res} (= ${total} − 256), Cout = 1 → Überlauf!`
          : `${av} + ${bv} = ${res}, Cout = 0 – kein Überlauf.`;
      msg.classList.toggle("warn", total > 255);
    } else {
      msg.textContent = stage < 0 ? "Gib zwei Zahlen ein und starte die Animation." : `Volladdierer ${stage} rechnet: ${(av >> stage) & 1} + ${(bv >> stage) & 1} + Übertrag ${cins[stage]}.`;
      msg.classList.remove("warn");
    }
  };
  const read = (): [number, number] => [Math.max(0, Math.min(255, Math.floor(Number(a.value) || 0))), Math.max(0, Math.min(255, Math.floor(Number(b.value) || 0)))];
  const run = (): void => {
    window.clearInterval(timer);
    const [av, bv] = read();
    let st = 0;
    cols(st, av, bv);
    timer = window.setInterval(() => {
      st++;
      cols(st, av, bv);
      if (st >= 8) window.clearInterval(timer);
    }, 550);
  };
  go.addEventListener("click", run);
  const idle = (): void => {
    window.clearInterval(timer);
    const [av, bv] = read();
    cols(-1, av, bv);
  };
  a.addEventListener("input", idle);
  b.addEventListener("input", idle);
  idle();
  (root as HTMLElement & { destroy?: () => void }).destroy = () => window.clearInterval(timer);
  return root;
}

/* ---------- SR-Latch aus zwei NOR (Kap. 7) ---------- */

function srlatch(): HTMLElement {
  const root = h("div", "wd");
  root.append(h("h4", "", "Interaktiv: SR-Latch aus zwei NOR-Gattern"));
  let s = 0;
  let r = 0;
  let q = 0;
  let qn = 1;
  let unstable = false;
  const mkT = (name: string, get: () => number, set: (v: number) => void): HTMLButtonElement => {
    const b = h("button", "btn", `${name} = 0`);
    b.type = "button";
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      set(get() ^ 1);
      settle();
      paint();
    });
    return b;
  };
  const bs = mkT("S (Set)", () => s, (v) => (s = v));
  const br = mkT("R (Reset)", () => r, (v) => (r = v));
  const row = h("div", "wd-row");
  row.append(bs, br);
  const diag = h("pre", "sr-diag");
  const msg = h("p", "wd-msg");
  root.append(row, diag, msg);

  const settle = (): void => {
    unstable = false;
    for (let i = 0; i < 8; i++) {
      const nq = r | qn ? 0 : 1;
      const nqn = s | q ? 0 : 1;
      if (nq === q && nqn === qn) return;
      q = nq;
      qn = nqn;
    }
    unstable = true;
  };
  const paint = (): void => {
    bs.textContent = `S (Set) = ${s}`;
    br.textContent = `R (Reset) = ${r}`;
    bs.classList.toggle("primary", s === 1);
    br.classList.toggle("primary", r === 1);
    bs.setAttribute("aria-pressed", String(s === 1));
    br.setAttribute("aria-pressed", String(r === 1));
    diag.textContent = `        ┌───────┐\n R=${r} ──┤ NOR   ├──┬── Q  = ${q}\n   ┌────┤       │  │\n   │    └───────┘  │\n   │      ╲ ╱      │\n   │      ╱ ╲      │\n   │    ┌───────┐  │\n   └────┤ NOR   ├──┴── Q̄ = ${qn}\n S=${s} ──┤       │\n        └───────┘`;
    msg.classList.toggle("warn", unstable || (s && r) === 1);
    if (unstable) msg.textContent = "S = R = 1 war verboten, und jetzt wurden beide losgelassen: Beide Gatter schalten gleichzeitig um und schwingen – der Zustand ist unbestimmt!";
    else if (s && r) msg.textContent = "Verbotene Kombination: Beide Ausgänge sind 0, Q und Q̄ sind nicht mehr gegensätzlich.";
    else if (s) msg.textContent = "Set: Q wird 1.";
    else if (r) msg.textContent = "Reset: Q wird 0.";
    else msg.textContent = `S = R = 0: Das Latch hält seinen Zustand (Q = ${q}). Genau das ist ein Speicher.`;
  };
  settle();
  paint();
  return root;
}

/* ---------- Befehlswort zerlegen (Kap. 10) ---------- */

function instr(): HTMLElement {
  const root = h("div", "wd");
  root.append(h("h4", "", "Probiere es aus: Assembler-Zeile → Befehlswort → Steuerwort"));
  const inp = h("input", "wd-wide");
  inp.type = "text";
  inp.value = "ADD #25";
  inp.setAttribute("aria-label", "Assembler-Zeile");
  inp.spellcheck = false;
  const out = h("div", "wd-out");
  root.append(field("Befehl (z. B. LDA #7, STA 0x40, JNZ 3, OUT, HLT)", inp), out);
  const upd = (): void => {
    out.textContent = "";
    const res = assemble(inp.value);
    if (res.errors.length) {
      out.append(h("p", "wd-msg warn", res.errors[0].message));
      return;
    }
    const w = res.words[0];
    if (w === undefined) {
      out.append(h("p", "wd-msg", "Leere Zeile."));
      return;
    }
    const op = w >> 8;
    const operand = w & 255;
    const ins = INSTRUCTIONS.find((i) => i.opcode === op);
    const ctrl = ins?.ctrl ?? 0;
    const t = h("table", "plain");
    const rows: [string, string][] = [
      ["Befehlswort (16 Bit)", `${bin(op, 8)} ${bin(operand, 8)} = ${hex(w, 4)}`],
      ["Opcode (obere 8 Bit)", `${bin(op, 8)} = ${hex(op)} → ${ins ? ins.text : "unbekannt"}`],
      ["Operand (untere 8 Bit)", `${bin(operand, 8)} = ${operand} = ${hex(operand)}`],
      ["Steuerwort aus dem Steuer-ROM", `${bin(ctrl, 11)} = ${hex(ctrl, 3)}`],
      ["Aktive Steuerleitungen", activeLines(ctrl).join(", ") || "keine (NOP)"],
      ["Bitaufteilung", CTRL_LINES.map((l) => `${l.name}${l.width > 1 ? " (Bit " + l.bit + "–" + (l.bit + l.width - 1) + ")" : " (Bit " + l.bit + ")"} = ${l.width === 1 ? (ctrl >> l.bit) & 1 : MODE_NAMES[(ctrl >> l.bit) & 7].split(" ")[0]}`).join(" · ")],
    ];
    for (const [k, v] of rows) {
      const tr = h("tr");
      tr.append(h("th", "", k), h("td", "", v));
      t.append(tr);
    }
    out.append(t);
  };
  inp.addEventListener("input", upd);
  upd();
  return root;
}

/* ---------- Befehlstabelle (Kap. 10) ---------- */

function ops(): HTMLElement {
  const root = h("div", "wd");
  root.append(h("h4", "", "Alle Befehle der Mini-CPU"));
  const t = h("table", "plain ops");
  const head = h("tr");
  for (const x of ["Assembler", "Opcode", "Operand", "Steuerwort", "Wirkung"]) head.append(h("th", "", x));
  t.append(head);
  for (const i of INSTRUCTIONS) {
    const tr = h("tr");
    const form = i.operand === "none" ? i.mnemonic : i.operand === "imm" ? `${i.mnemonic} #n` : `${i.mnemonic} adr`;
    tr.append(h("td", "mono", form), h("td", "mono", hex(i.opcode)), h("td", "", i.operand === "none" ? "–" : i.operand === "imm" ? "Konstante" : "RAM-/Sprungadresse"), h("td", "mono", hex(i.ctrl, 3)), h("td", "", i.text));
    t.append(tr);
  }
  root.append(t, h("p", "wd-msg", "Opcodes, die nicht in der Tabelle stehen, haben das Steuerwort 0 und verhalten sich wie NOP."));
  return root;
}

/* ---------- Pipeline (Kap. 13) ---------- */

function pipeline(): HTMLElement {
  const root = h("div", "wd");
  root.append(h("h4", "", "Pipeline: vier Befehle, vier Stufen"));
  const stages = ["F", "D", "E", "W"];
  const names = ["Fetch", "Decode", "Execute", "Write-back"];
  const n = 4;
  const mode = h("button", "btn primary", "Mit Pipeline");
  mode.type = "button";
  let piped = true;
  const box = h("div", "pl-box");
  root.append(mode, box);
  const draw = (): void => {
    box.textContent = "";
    const cycles = piped ? n + 3 : n * 4;
    const t = h("table", "pl");
    const head = h("tr");
    head.append(h("th", "", "Takt"));
    for (let c = 1; c <= cycles; c++) head.append(h("th", "", String(c)));
    t.append(head);
    for (let i = 0; i < n; i++) {
      const tr = h("tr");
      tr.append(h("th", "", `Befehl ${i + 1}`));
      for (let c = 0; c < cycles; c++) {
        const s = piped ? c - i : c - i * 4;
        const td = h("td", s >= 0 && s < 4 ? `st st${s}` : "", s >= 0 && s < 4 ? stages[s] : "");
        if (s >= 0 && s < 4) td.title = names[s];
        tr.append(td);
      }
      t.append(tr);
    }
    box.append(t, h("p", "wd-msg", piped ? `Mit Pipeline: ${cycles} Takte für ${n} Befehle – ab dem 4. Takt ist jede Stufe beschäftigt, danach kommt pro Takt ein Befehl heraus.` : `Ohne Pipeline: ${cycles} Takte für ${n} Befehle – jede Stufe wartet auf die anderen drei. (Eine Einzyklus-CPU wie unsere braucht nur einen langen Takt je Befehl.)`));
  };
  mode.addEventListener("click", () => {
    piped = !piped;
    mode.textContent = piped ? "Mit Pipeline" : "Ohne Pipeline";
    mode.classList.toggle("primary", piped);
    draw();
  });
  draw();
  return root;
}

export function mountWidget(name: WidgetName): HTMLElement {
  switch (name) {
    case "ripple":
      return ripple();
    case "srlatch":
      return srlatch();
    case "instr":
      return instr();
    case "ops":
      return ops();
    case "pipeline":
      return pipeline();
  }
}
