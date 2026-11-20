import { assemble } from "../assembler";
import { loadModuleLibrary } from "../modules";
import { aluRef } from "./circuits";
import { buildCpuMachine, CpuMachine, accOf, ctrlAt, disassemble, hex, instrByOpcode, isHalted, loadWords, outOf, pcOf, runProgram, wordAt, activeLines, MODE_NAMES } from "./isa";
import { h, LiveCircuit } from "./live";
import { openInSandbox } from "./sandbox";
import { Rig } from "./rig";
import { CpuBlock, ProgTask } from "./types";

const PHASES = ["Fetch", "Decode", "Execute", "Write-back"];

interface Step {
  fetch: string;
  decode: string;
  execute: string;
  write: string;
}

/** Erklärt den nächsten Befehl der Maschine phasenweise (aus dem echten Zustand). */
function describe(m: CpuMachine): Step {
  const pc = pcOf(m);
  const acc = accOf(m);
  const w = wordAt(m, pc);
  const op = w >> 8;
  const operand = w & 255;
  const ctrl = ctrlAt(m, pc);
  const ins = instrByOpcode(op);
  const mode = ctrl & 7;
  const en = (ctrl >> 3) & 1;
  const mem = (ctrl >> 4) & 1;
  const we = (ctrl >> 5) & 1;
  const out = (ctrl >> 6) & 1;
  const jmp = (ctrl >> 7) & 1;
  const jz = (ctrl >> 8) & 1;
  const jnz = (ctrl >> 9) & 1;
  const halt = (ctrl >> 10) & 1;
  const b = mem ? m.ram.data[operand] ?? 0 : operand;
  const res = aluRef(8, mode, en, acc, b);
  const taken = jmp || (jz && acc === 0) || (jnz && acc !== 0);

  const fetch = `Der PC liegt auf Adresse ${pc}. Das Programm-ROM liefert dort das Wort ${hex(w, 4)} = ${disassemble(w)}. Der Splitter trennt es in Opcode ${hex(op)} und Operand ${operand} (${hex(operand)}).`;
  const decode = `Der Opcode ${hex(op)} adressiert das Steuer-ROM${ins ? "" : " (nicht belegt → Steuerwort 0 = NOP)"}: Steuerwort ${hex(ctrl, 3)}. Aktive Leitungen: ${activeLines(ctrl).join(", ") || "keine"}.`;
  let execute: string;
  if (jmp || jz || jnz) {
    execute = jmp
      ? `Unbedingter Sprung: Der Sprungzweig ist freigegeben, das Ziel ist der Operand ${operand}.`
      : `Die Schaltung prüft den Akku (${acc}): ${acc === 0 ? "Zero-Flag = 1" : "Zero-Flag = 0"}. ${jz ? "JZ" : "JNZ"} ${taken ? `springt → PC' = ${operand}` : `springt nicht → PC' = ${pc + 1}`}.`;
  } else if (halt) {
    execute = "HLT: Das Halt-Signal sperrt das „+1“ am PC; die ALU rechnet nichts Neues.";
  } else if (en) {
    execute = `B = ${mem ? `RAM[${operand}] = ${b}` : `Operand = ${b}`} (Mux-Wahl MEM = ${mem}). Die ALU rechnet im Modus ${MODE_NAMES[mode].split(" ")[0]} mit A = ${acc}: Ergebnis ${res}.`;
  } else if (we) {
    execute = `Die ALU rechnet nicht; der Akku (${acc}) liegt am Dateneingang des RAMs, die Adresse ist der Operand ${operand}.`;
  } else if (out) {
    execute = `Der Akku (${acc}) liegt am Eingang des Ausgaberegisters.`;
  } else {
    execute = "Keine Steuerleitung aktiv – nichts zu berechnen.";
  }
  const parts: string[] = [];
  if (en) parts.push(`Akku ← ${res}`);
  if (we) parts.push(`RAM[${operand}] ← ${acc}`);
  if (out) parts.push(`Ausgabe ← ${acc}`);
  parts.push(halt ? `PC bleibt ${pc}` : `PC ← ${taken ? operand : pc + 1}`);
  const write = `Steigende Taktflanke: alle Register übernehmen gleichzeitig: ${parts.join("; ")}.`;
  return { fetch, decode, execute, write };
}

export interface CpuLab {
  el: HTMLElement;
  destroy(): void;
}

export function mountCpu(block: CpuBlock, onTask: (id: string, ok: boolean, withSolution: boolean) => void, solved: (id: string) => boolean): CpuLab {
  loadModuleLibrary();
  const m = buildCpuMachine();
  const rig = new Rig(m.c);
  const root = h("div", "cpulab");
  let phase = -1;
  let last: Step | null = null;
  let phasing = false;
  let asmCount = 0;
  const outLog: number[] = [];

  /* Anzeige */
  const stat = h("div", "cl-stat");
  const mkChip = (label: string): { box: HTMLElement; val: HTMLElement } => {
    const box = h("div", "cl-chip");
    const val = h("b", "");
    box.append(h("span", "", label), val);
    stat.append(box);
    return { box, val };
  };
  const pcChip = mkChip("PC");
  const accChip = mkChip("Akku");
  const outChip = mkChip("Ausgabe");
  const nextChip = mkChip("nächster Befehl");
  const logEl = h("div", "cl-log");
  const phaseBar = h("ol", "cl-phases");
  PHASES.forEach((p) => phaseBar.append(h("li", "", p)));
  const explain = h("div", "cl-explain");
  const listing = h("div", "cl-listing");
  const ramEl = h("div", "cl-ram");
  const errEl = h("div", "wd-msg warn");
  errEl.hidden = true;

  const highlightIds = (): string[] => {
    if (!block.phases || phase < 0) return [];
    const g = m.groups;
    const pick = (...xs: (string | undefined)[]): string[] => xs.filter((x): x is string => !!x);
    switch (phase) {
      case 0:
        return pick(g.pc, m.prog.id);
      case 1:
        return pick(m.ctrl.id);
      case 2:
        return pick(g.alu, m.ram.id);
      default:
        return pick(g.acc, g.out, g.pc, m.ram.id);
    }
  };

  const live = new LiveCircuit(rig, {
    height: 460,
    hidePanels: true,
    isDone: () => isHalted(m),
    highlight: highlightIds,
    onUpdate: () => paint(),
    beforeStep: () => {
      if ((ctrlAt(m, pcOf(m)) >> 6) & 1) outLog.push(accOf(m));
      if (!phasing) phase = -1;
    },
    onReset: () => {
      outLog.length = 0;
      phase = -1;
    },
  });

  function paint(): void {
    const pc = pcOf(m);
    pcChip.val.textContent = `${pc}`;
    accChip.val.textContent = `${accOf(m)} · ${hex(accOf(m))}`;
    outChip.val.textContent = `${outOf(m)} · ${hex(outOf(m))}`;
    const halted = isHalted(m);
    nextChip.val.textContent = halted ? "HLT – angehalten" : disassemble(wordAt(m, pc));
    nextChip.box.classList.toggle("halt", halted);
    logEl.textContent = outLog.length ? `OUT-Folge: ${outLog.join(", ")}` : "OUT-Folge: (noch nichts ausgegeben)";
    [...phaseBar.children].forEach((li, i) => li.classList.toggle("act", block.phases && i === phase));
    if (block.phases) {
      const d = phase >= 0 ? last : null;
      if (halted && phase < 0) explain.textContent = "Die CPU steht auf HLT. Mit „Reset“ beginnt das Programm von vorn.";
      else if (!d) explain.textContent = `Nächster Befehl: ${disassemble(wordAt(m, pc))}. Drücke „Phase ▶“, um ihn Phase für Phase zu verfolgen, oder „Schritt“ für den ganzen Befehl.`;
      else explain.textContent = `${PHASES[phase]}: ${[d.fetch, d.decode, d.execute, d.write][phase]}`;
    }
    listing.textContent = "";
    const total = Math.max(1, asmCount);
    for (let a = 0; a < Math.min(256, total + 1); a++) {
      const row = h("div", "cl-line" + (a === pc ? " pc" : ""));
      row.append(h("span", "a", String(a).padStart(2, "0")), h("span", "w", hex(wordAt(m, a), 4)), h("span", "t", disassemble(wordAt(m, a))));
      listing.append(row);
    }
    const used: string[] = [];
    m.ram.data.forEach((v, i) => {
      if (v) used.push(`${hex(i)} = ${v}`);
    });
    ramEl.textContent = `RAM (belegte Zellen): ${used.length ? used.join(" · ") : "alle 0"}`;
  }

  /* Bedienung: Phase / Befehl */
  const phaseBtn = h("button", "btn", "Phase ▶");
  phaseBtn.type = "button";
  phaseBtn.title = "Den nächsten Befehl phasenweise verfolgen";
  phaseBtn.addEventListener("click", () => {
    live.pause();
    if (isHalted(m)) {
      live.refresh();
      return;
    }
    phase = phase >= 3 || phase < 0 ? 0 : phase + 1;
    if (phase === 0) last = describe(m);
    if (phase === 3) {
      phasing = true;
      live.stepOnce();
      phasing = false;
    }
    live.refresh();
  });

  /* Programm-Editor */
  const ta = h("textarea", "cl-src");
  ta.spellcheck = false;
  ta.rows = 12;
  ta.value = block.program;
  ta.setAttribute("aria-label", "Assembler-Programm");
  const load = (): boolean => {
    live.pause();
    const res = assemble(ta.value);
    errEl.hidden = res.errors.length === 0;
    if (res.errors.length) {
      errEl.textContent = res.errors.map((e) => `Zeile ${e.line}: ${e.message}`).join(" · ");
      return false;
    }
    asmCount = res.instructionCount;
    loadWords(m, res.words);
    live.reset();
    last = null;
    live.refresh();
    return true;
  };
  const loadBtn = h("button", "btn primary", "Programm laden");
  loadBtn.type = "button";
  loadBtn.addEventListener("click", load);
  const resetBtn = h("button", "btn", "Ausgabe löschen");
  resetBtn.type = "button";
  resetBtn.addEventListener("click", () => {
    live.reset();
  });

  const exSel = h("select", "lc-speed");
  exSel.setAttribute("aria-label", "Beispielprogramm wählen");
  exSel.append(new Option("Beispiel wählen …", ""));
  (block.examples ?? []).forEach((e, i) => exSel.append(new Option(e.text, String(i))));
  exSel.addEventListener("change", () => {
    const e = (block.examples ?? [])[Number(exSel.value)];
    if (exSel.value === "" || !e) return;
    ta.value = e.src;
    load();
    scheduleCheck();
  });

  const sandboxBtn = h("button", "btn", "In der Sandbox öffnen");
  sandboxBtn.type = "button";
  sandboxBtn.addEventListener("click", () => {
    if (!load()) return;
    openInSandbox(m.c);
  });

  const ctl = h("div", "cl-ctl");
  ctl.append(loadBtn, phaseBtn, exSel, resetBtn, sandboxBtn);
  const left = h("div", "cl-left");
  left.append(h("h4", "", "Programm (Assembler)"), ta, ctl, errEl);
  const right = h("div", "cl-right");
  right.append(h("h4", "", "Im ROM (Adresse · Wort · Befehl)"), listing, ramEl);
  const cols = h("div", "cl-cols");
  cols.append(left, right);

  root.append(live.el, stat);
  if (block.phases) root.append(phaseBar, explain);
  root.append(logEl, cols);

  /* Aufgaben */
  let headless: CpuMachine | null = null;
  let timer = 0;
  const taskEls = new Map<string, { li: HTMLElement; mark: HTMLElement }>();
  const evaluate = (): void => {
    if (!block.tasks) return;
    const res = assemble(ta.value);
    if (res.errors.length) return;
    headless ??= buildCpuMachine();
    const r = runProgram(headless, ta.value, 5000);
    for (const t of block.tasks) {
      const ok = t.check(r);
      const e = taskEls.get(t.id);
      if (e) {
        e.mark.textContent = ok || solved(t.id) ? "✓" : "○";
        e.li.classList.toggle("ok", ok || solved(t.id));
      }
      if (ok) onTask(t.id, true, usedSolution.has(t.id));
    }
  };
  const usedSolution = new Set<string>();
  const scheduleCheck = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(evaluate, 500);
  };
  ta.addEventListener("input", scheduleCheck);

  if (block.tasks) {
    const box = h("div", "tasks");
    box.append(h("h4", "", "Aufgaben (werden automatisch geprüft, sobald du tippst)"));
    const ul = h("ul", "task-list");
    for (const t of block.tasks) ul.append(taskItem(t));
    box.append(ul);
    root.append(box);
  }
  function taskItem(t: ProgTask): HTMLElement {
    const li = h("li", "task");
    const mark = h("span", "mark", solved(t.id) ? "✓" : "○");
    if (solved(t.id)) li.classList.add("ok");
    const txt = h("div", "txt");
    txt.innerHTML = t.text;
    const btns = h("div", "tbtn");
    const hint = t.hint ? h("p", "hint") : null;
    if (hint) {
      hint.hidden = true;
      hint.textContent = "Tipp: " + t.hint;
      const hb = h("button", "btn small", "Tipp");
      hb.type = "button";
      hb.addEventListener("click", () => (hint.hidden = !hint.hidden));
      btns.append(hb);
    }
    const sol = h("div", "sol");
    sol.hidden = true;
    const pre = h("pre", "", t.solution);
    const use = h("button", "btn small", "In den Editor übernehmen");
    use.type = "button";
    use.addEventListener("click", () => {
      usedSolution.add(t.id);
      ta.value = t.solution;
      load();
      evaluate();
    });
    sol.append(pre, use);
    const sb = h("button", "btn small", "Lösung ansehen");
    sb.type = "button";
    sb.addEventListener("click", () => {
      sol.hidden = !sol.hidden;
      if (!sol.hidden) usedSolution.add(t.id);
    });
    btns.append(sb);
    txt.append(btns);
    if (hint) txt.append(hint);
    txt.append(sol);
    li.append(mark, txt);
    taskEls.set(t.id, { li, mark });
    return li;
  }

  load();
  evaluate();
  return {
    el: root,
    destroy: () => {
      window.clearTimeout(timer);
      live.destroy();
    },
  };
}
