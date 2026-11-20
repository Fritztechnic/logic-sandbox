import { Circuit } from "./circuit";
import { Comp, maskOf } from "./types";

// ---------- Reine Logik (ohne DOM, testbar) ----------

export type MemFormat = "hex" | "dec" | "bin";

export interface AddrDecode {
  addr: number;
  /** Adressbits, höchstwertiges zuerst (A(n-1)..A0) */
  bits: number[];
  /** Index der aktiven Wortleitung (One-Hot) */
  row: number;
  rows: number;
}

export function decodeAddress(raw: number, addrWidth: number): AddrDecode {
  const addr = (raw & maskOf(addrWidth)) >>> 0;
  const bits: number[] = [];
  for (let i = addrWidth - 1; i >= 0; i--) bits.push((addr >>> i) & 1);
  return { addr, bits, row: addr, rows: 2 ** addrWidth };
}

export function normWord(value: number, dataWidth: number): number {
  return (value & maskOf(dataWidth)) >>> 0;
}

/** Wort in Einzelbits zerlegen, höchstwertiges Bit zuerst. */
export function wordBits(value: number, dataWidth: number): number[] {
  const v = normWord(value, dataWidth);
  const bits: number[] = [];
  for (let i = dataWidth - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  return bits;
}

export function toggleWordBit(value: number, bit: number, dataWidth: number): number {
  return normWord(normWord(value, dataWidth) ^ (1 << bit), dataWidth);
}

export function formatWord(value: number, dataWidth: number, fmt: MemFormat): string {
  const v = normWord(value, dataWidth);
  if (fmt === "dec") return v.toString(10);
  if (fmt === "bin") return v.toString(2).padStart(dataWidth, "0");
  return "0x" + v.toString(16).toUpperCase().padStart(Math.max(1, Math.ceil(dataWidth / 4)), "0");
}

/** Liest eine Eingabe im gewählten Format; null bei ungültiger Eingabe oder Überlauf. */
export function parseWord(text: string, dataWidth: number, fmt: MemFormat): number | null {
  let t = text.trim().replace(/_/g, "");
  if (!t) return null;
  let radix = fmt === "hex" ? 16 : fmt === "bin" ? 2 : 10;
  if (/^0x/i.test(t)) {
    radix = 16;
    t = t.slice(2);
  } else if (/^0b/i.test(t)) {
    radix = 2;
    t = t.slice(2);
  }
  const digits = radix === 16 ? /^[0-9a-f]+$/i : radix === 2 ? /^[01]+$/ : /^[0-9]+$/;
  if (!digits.test(t)) return null;
  const n = parseInt(t, radix);
  if (!Number.isFinite(n) || n > maskOf(dataWidth)) return null;
  return n >>> 0;
}

/** Hex-Liste (Trenner beliebig) in ein Speicherabbild der festen Länge umwandeln. */
export function parseHexList(text: string, rows: number, dataWidth: number): { data: number[]; count: number } {
  const parsed = text
    .split(/[^0-9a-fA-FxX]+/)
    .filter(Boolean)
    .map((tok) => parseInt(tok.replace(/^0x/i, ""), 16))
    .filter((n) => !Number.isNaN(n));
  const data = new Array(rows).fill(0);
  parsed.forEach((v, i) => {
    if (i < rows) data[i] = normWord(v, dataWidth);
  });
  return { data, count: parsed.length };
}

export function capacityText(kind: "rom" | "ram", addrWidth: number, dataWidth: number): string {
  const rows = 2 ** addrWidth;
  const bits = rows * dataWidth;
  const bytes = bits / 8;
  const size = bytes >= 1024 ? `${+(bytes / 1024).toFixed(2)} KiB` : `${+bytes.toFixed(3)} Byte`;
  return `Dieses ${kind.toUpperCase()}: ${rows} Wörter × ${dataWidth} Bit = ${size} (${bits} Bit)`;
}

/** Eingänge: ROM [ADDR], RAM [ADDR, DIN, WE, CLK]. */
export function nextActionText(kind: "rom" | "ram", ins: number[], addrWidth: number, dataWidth: number): string {
  const addr = formatWord(ins[0] ?? 0, addrWidth, "hex");
  if (kind === "rom") return `ROM wird nur gelesen: Adresse ${addr} liegt an, das Wort erscheint sofort am Ausgang.`;
  const we = (ins[2] ?? 0) & 1;
  const clk = (ins[3] ?? 0) & 1;
  if (!we) return "Beim nächsten Takt wird nur gelesen (WE = 0, nichts wird geschrieben).";
  const din = formatWord(ins[1] ?? 0, dataWidth, "hex");
  const note = clk ? " (Takt ist gerade hoch – erst nach einer fallenden und der nächsten steigenden Flanke)" : "";
  return `Beim nächsten Takt wird ${din} nach Adresse ${addr} geschrieben${note}.`;
}

/** Sichtfenster der Wortleitungen im Diagramm (höchstens `count` Zeilen um die aktive). */
export function rowWindow(active: number, rows: number, count: number): number[] {
  const n = Math.min(count, rows);
  const start = Math.max(0, Math.min(active - Math.floor(n / 2), rows - n));
  return Array.from({ length: n }, (_, i) => start + i);
}

export interface AccessEntry {
  kind: "read" | "write";
  addr: number;
  value: number;
}

export interface AccessObserver {
  last: { addr: number; word: number } | null;
  log: AccessEntry[];
}

export function newObserver(): AccessObserver {
  return { last: null, log: [] };
}

/** Beobachtet pro Update nur den Zustand: Adresswechsel = Lesen, Inhaltswechsel bei gleicher Adresse = Schreiben. */
export function observeAccess(obs: AccessObserver, addr: number, word: number, max = 8): void {
  const prev = obs.last;
  obs.last = { addr, word };
  if (!prev) return;
  let entry: AccessEntry | null = null;
  if (prev.addr !== addr) entry = { kind: "read", addr, value: word };
  else if (prev.word !== word) entry = { kind: "write", addr, value: word };
  if (!entry) return;
  obs.log.unshift(entry);
  if (obs.log.length > max) obs.log.length = max;
}

// ---------- Lehr-Schaltung: 1-Bit-RAM-Zelle (echte Simulation) ----------

export interface CellModel {
  circuit: Circuit;
  d: Comp;
  wl: Comp;
  we: Comp;
  wr: Comp;
  latch: Comp;
  rd: Comp;
}

/** D, Wortleitung, WE → AND → D-Latch → AND(Q, Wortleitung) → Ausgang. */
export function buildCellCircuit(): CellModel {
  const c = new Circuit();
  const d = c.addComp("input", 0, 0);
  const wl = c.addComp("input", 0, 4);
  const we = c.addComp("input", 0, 8);
  const wr = c.addComp("and", 4, 6);
  const latch = c.addComp("latch", 8, 0);
  const rd = c.addComp("and", 12, 2);
  c.addWire(wl.id, 0, wr.id, 0);
  c.addWire(we.id, 0, wr.id, 1);
  c.addWire(d.id, 0, latch.id, 0);
  c.addWire(wr.id, 0, latch.id, 1);
  c.addWire(latch.id, 0, rd.id, 0);
  c.addWire(wl.id, 0, rd.id, 1);
  c.rebuild();
  c.reset();
  return { circuit: c, d, wl, we, wr, latch, rd };
}

export function cellState(m: CellModel): { d: number; wl: number; we: number; write: number; q: number; out: number } {
  return {
    d: m.d.value & 1,
    wl: m.wl.value & 1,
    we: m.we.value & 1,
    write: m.wr.outs[0] & 1,
    q: m.latch.outs[0] & 1,
    out: m.rd.outs[0] & 1,
  };
}

// ---------- DOM (erst beim Öffnen) ----------

export interface MemViewHooks {
  /** Inhalt wurde geändert (Simulation/Darstellung neu auswerten). */
  changed(): void;
}

interface Open {
  root: HTMLElement;
  circuit: Circuit;
  comp: Comp;
  hooks: MemViewHooks;
  fmt: MemFormat;
  obs: AccessObserver;
  cell: CellModel;
  els: Record<string, HTMLElement>;
  sig: { diagram: string; matrix: string; cell: string; log: string; text: string };
  onKey: (e: KeyboardEvent) => void;
}

let current: Open | null = null;
const ROW_H = 24;
const SVGNS = "http://www.w3.org/2000/svg";

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function closeMemView(): void {
  if (!current) return;
  document.removeEventListener("keydown", current.onKey, true);
  current.root.remove();
  current = null;
}

export function openMemView(circuit: Circuit, compId: string, hooks: MemViewHooks): void {
  const comp = circuit.comps.get(compId);
  if (!comp || (comp.kind !== "rom" && comp.kind !== "ram")) return;
  closeMemView();
  const isRam = comp.kind === "ram";
  const root = document.createElement("div");
  root.className = "mv-overlay";
  root.innerHTML = `
    <div class="mv-modal" role="dialog" aria-label="Speicher-Explorer">
      <header class="mv-head">
        <h2>${isRam ? "RAM" : "ROM"} – So funktioniert der Speicher</h2>
        <span class="mv-cap" data-mv="cap"></span>
        <button class="mv-close" data-mv="close" title="Schließen (Esc)">✕</button>
      </header>
      <div class="mv-body">
        <section class="mv-sec">
          <h3>1 · Datenpfad (live)</h3>
          <div class="mv-next" data-mv="next"></div>
          <div class="mv-diagram" data-mv="diagram"></div>
        </section>
        <section class="mv-sec">
          <h3>2 · Speicherinhalt ${isRam ? "(Startinhalt)" : "programmieren"}</h3>
          <div class="mv-tools">
            <label>Anzeige
              <select data-mv="fmt"><option value="hex">Hex</option><option value="dec">Dez</option><option value="bin">Bin</option></select>
            </label>
            <label>Gehe zu Adresse <input data-mv="goto" class="mv-in" placeholder="z. B. 0x2A" size="8"></label>
            <button class="mv-btn" data-mv="follow">Aktive Adresse</button>
            <button class="mv-btn" data-mv="import">Hex einfügen…</button>
            <button class="mv-btn" data-mv="clear">Alles 0</button>
          </div>
          <div class="mv-importbox" data-mv="importbox" hidden>
            <textarea class="mv-in" data-mv="importtext" rows="3" placeholder="Hex-Werte, durch Leerzeichen/Komma getrennt"></textarea>
            <button class="mv-btn" data-mv="importok">Übernehmen</button>
          </div>
          <div class="mv-matrix" data-mv="matrix"><div data-mv="spacer"><div data-mv="rows"></div></div></div>
          <div class="mv-hint">Klick auf ein Bit kippt es; das Wort rechts lässt sich direkt eintippen (Enter/Verlassen übernimmt).</div>
        </section>
        <section class="mv-sec">
          <h3>3 · So ist eine Speicherzelle aufgebaut</h3>
          <div class="mv-cellwrap">
            <div data-mv="cell" class="mv-cell"></div>
            <div class="mv-text" data-mv="lesson"></div>
          </div>
        </section>
        <section class="mv-sec">
          <h3>4 · Zugriffe (letzte 8)</h3>
          <div class="mv-log" data-mv="log"></div>
        </section>
      </div>
    </div>`;
  document.body.appendChild(root);
  const els: Record<string, HTMLElement> = {};
  root.querySelectorAll<HTMLElement>("[data-mv]").forEach((e) => (els[e.dataset.mv!] = e));

  const st: Open = {
    root,
    circuit,
    comp,
    hooks,
    fmt: "hex",
    obs: newObserver(),
    cell: buildCellCircuit(),
    els,
    sig: { diagram: "", matrix: "", cell: "", log: "", text: "" },
    onKey: (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeMemView();
      }
    },
  };
  current = st;
  document.addEventListener("keydown", st.onKey, true);
  wire(st);
  els.cap.textContent = capacityText(comp.kind as "rom" | "ram", comp.addrWidth, comp.dataWidth);
  els.lesson.innerHTML = lessonHtml(comp);
  updateMemView(true);
  goTo(st, activeAddr(st));
}

function activeAddr(st: Open): number {
  return decodeAddress(st.circuit.inputValues(st.comp)[0] ?? 0, st.comp.addrWidth).addr;
}

function setWord(st: Open, row: number, value: number): void {
  st.comp.data[row] = normWord(value, st.comp.dataWidth);
  st.circuit.evalComb();
  st.hooks.changed();
  updateMemView(true);
}

function goTo(st: Open, row: number): void {
  const m = st.els.matrix;
  const r = Math.max(0, Math.min(2 ** st.comp.addrWidth - 1, row));
  m.scrollTop = Math.max(0, r * ROW_H - m.clientHeight / 2 + ROW_H);
  renderMatrix(st, true);
}

function wire(st: Open): void {
  const { els, comp } = st;
  els.close.addEventListener("click", closeMemView);
  st.root.addEventListener("mousedown", (e) => {
    if (e.target === st.root) closeMemView();
  });
  (els.fmt as HTMLSelectElement).addEventListener("change", () => {
    st.fmt = (els.fmt as HTMLSelectElement).value as MemFormat;
    renderMatrix(st, true);
  });
  const go = (): void => {
    const v = parseWord((els.goto as HTMLInputElement).value, 32, st.fmt);
    if (v !== null) goTo(st, v);
  };
  els.goto.addEventListener("change", go);
  els.follow.addEventListener("click", () => goTo(st, activeAddr(st)));
  els.import.addEventListener("click", () => (els.importbox.hidden = !els.importbox.hidden));
  els.importok.addEventListener("click", () => {
    const { data } = parseHexList((els.importtext as HTMLTextAreaElement).value, 2 ** comp.addrWidth, comp.dataWidth);
    comp.data = data;
    st.circuit.evalComb();
    st.hooks.changed();
    els.importbox.hidden = true;
    updateMemView(true);
  });
  els.clear.addEventListener("click", () => {
    comp.data = new Array(2 ** comp.addrWidth).fill(0);
    st.circuit.evalComb();
    st.hooks.changed();
    updateMemView(true);
  });
  els.matrix.addEventListener("scroll", () => renderMatrix(st, false));
  els.rows.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-bit]");
    if (!b) return;
    const row = Number(b.dataset.row);
    setWord(st, row, toggleWordBit(comp.data[row] ?? 0, Number(b.dataset.bit), comp.dataWidth));
  });
  els.rows.addEventListener("change", (e) => {
    const inp = e.target as HTMLInputElement;
    if (!inp.dataset.word) return;
    const row = Number(inp.dataset.word);
    const v = parseWord(inp.value, comp.dataWidth, st.fmt);
    if (v === null) {
      inp.classList.add("mv-bad");
      return;
    }
    setWord(st, row, v);
  });
  els.cell.addEventListener("click", (e) => {
    const t = (e.target as Element).closest<SVGElement>("[data-in]");
    if (!t) return;
    const m = st.cell;
    const input = { d: m.d, wl: m.wl, we: m.we }[t.getAttribute("data-in") as "d" | "wl" | "we"];
    st.cell.circuit.toggleBit(input, 0);
    updateMemView(true);
  });
}

function renderMatrix(st: Open, force: boolean): void {
  const { comp, els } = st;
  const rows = 2 ** comp.addrWidth;
  (els.spacer as HTMLElement).style.height = rows * ROW_H + "px";
  const m = els.matrix;
  const first = Math.max(0, Math.floor(m.scrollTop / ROW_H) - 2);
  const last = Math.min(rows - 1, first + Math.ceil((m.clientHeight || 280) / ROW_H) + 4);
  const active = activeAddr(st);
  const aw = Math.max(1, Math.ceil(comp.addrWidth / 4));
  let html = "";
  for (let r = first; r <= last; r++) {
    const v = normWord(comp.data[r] ?? 0, comp.dataWidth);
    const cells = wordBits(v, comp.dataWidth)
      .map((b, i) => `<i class="mv-bit ${b ? "on" : ""}" data-row="${r}" data-bit="${comp.dataWidth - 1 - i}">${b}</i>`)
      .join("");
    html += `<div class="mv-row ${r === active ? "active" : ""}" style="top:${r * ROW_H}px">
      <span class="mv-addr">0x${r.toString(16).toUpperCase().padStart(aw, "0")}</span>
      <span class="mv-cells">${cells}</span>
      <input class="mv-in mv-word" data-word="${r}" value="${esc(formatWord(v, comp.dataWidth, st.fmt))}" size="${
        st.fmt === "bin" ? comp.dataWidth + 1 : 11
      }">
    </div>`;
  }
  const sig = `${first}|${last}|${active}|${st.fmt}|${html}`;
  if (!force && sig === st.sig.matrix) return;
  // Ein gerade bearbeitetes Eingabefeld nicht durch Neuzeichnen zerstören.
  if (!force && els.rows.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") return;
  st.sig.matrix = sig;
  els.rows.innerHTML = html;
  (els.rows as HTMLElement).style.position = "relative";
}

function svg(w: number, h: number, body: string): string {
  return `<svg xmlns="${SVGNS}" viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" font-family="JetBrains Mono Variable,ui-monospace,monospace" font-size="11">${body}</svg>`;
}

const HI = "#b8f04a";
const LO = "#3f565b";
const col = (v: number): string => (v ? HI : LO);

function diagramSvg(st: Open, ins: number[]): string {
  const { comp } = st;
  const isRam = comp.kind === "ram";
  const dec = decodeAddress(ins[0] ?? 0, comp.addrWidth);
  const win = rowWindow(dec.row, dec.rows, 7);
  const shownBits = Math.min(comp.dataWidth, 16);
  const cw = 13;
  const rowH = 24;
  const top = 40;
  const mx = 360;
  const mw = shownBits * cw + 16;
  const H = top + win.length * rowH + (isRam ? 90 : 50);
  const W = Math.max(760, mx + mw + 210);
  let s = "";
  const t = (x: number, y: number, txt: string, c = "#92a8a6", anchor = "start"): void => {
    s += `<text x="${x}" y="${y}" fill="${c}" text-anchor="${anchor}">${esc(txt)}</text>`;
  };
  // Adressleitungen
  t(10, 16, `ADDR (${comp.addrWidth} Bit)`, "#5ad1e6");
  const shownA = Math.min(comp.addrWidth, 8);
  for (let i = 0; i < shownA; i++) {
    const bi = dec.bits.length - shownA + i;
    const y = top + 6 + i * 14;
    const bitNo = comp.addrWidth - 1 - bi;
    s += `<line x1="64" y1="${y}" x2="150" y2="${y}" stroke="${col(dec.bits[bi])}" stroke-width="2"/>`;
    t(10, y + 4, `A${bitNo}`);
    t(50, y + 4, String(dec.bits[bi]), col(dec.bits[bi]), "end");
  }
  if (comp.addrWidth > shownA) t(10, top + 6 + shownA * 14 + 8, `… (+${comp.addrWidth - shownA} höhere Bits)`);
  // Decoder
  const dh = win.length * rowH;
  s += `<rect x="150" y="${top - 6}" width="110" height="${dh + 12}" rx="6" fill="#131c1f" stroke="#2e4249"/>`;
  t(205, top + 8, "Adress-", "#e6efec", "middle");
  t(205, top + 22, "Decoder", "#e6efec", "middle");
  t(205, top + 38, `1 aus ${dec.rows}`, "#92a8a6", "middle");
  // Wortleitungen + Zeilen
  s += `<rect x="${mx - 10}" y="${top - 6}" width="${mw}" height="${dh + 12}" rx="6" fill="#0e1517" stroke="#2e4249"/>`;
  win.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    const on = r === dec.row;
    s += `<line x1="260" y1="${y}" x2="${mx - 10}" y2="${y}" stroke="${on ? HI : LO}" stroke-width="${on ? 3 : 1.5}">${
      on ? '<animate attributeName="opacity" values="1;.55;1" dur="1.2s" repeatCount="indefinite"/>' : ""
    }</line>`;
    t(266, y - 4, `WL${r}`, on ? HI : "#6f8886");
    const v = normWord(comp.data[r] ?? 0, comp.dataWidth);
    const bits = wordBits(v, comp.dataWidth).slice(-shownBits);
    bits.forEach((b, j) => {
      s += `<rect x="${mx + j * cw}" y="${y - 9}" width="${cw - 2}" height="18" rx="2" fill="${
        on ? (b ? "#3b5a14" : "#19252a") : "#131c1f"
      }" stroke="${on ? HI : "#1f2d32"}"/>`;
      t(mx + j * cw + (cw - 2) / 2, y + 4, String(b), b ? (on ? HI : "#c6d6d3") : "#6f8886", "middle");
    });
  });
  t(mx - 4, top - 14, `Speichermatrix ${dec.rows} × ${comp.dataWidth}${comp.dataWidth > 16 ? " (rechte 16 Bit)" : ""}`, "#5ad1e6");
  // Ausgangstreiber → DOUT
  const dx = mx + mw + 20;
  const my = top + dh / 2;
  const dout = normWord(comp.data[dec.row] ?? 0, comp.dataWidth);
  s += `<line x1="${mx + shownBits * cw + 6}" y1="${my}" x2="${dx}" y2="${my}" stroke="${HI}" stroke-width="3"/>`;
  s += `<polygon points="${dx},${my - 22} ${dx + 40},${my - 10} ${dx + 40},${my + 10} ${dx},${my + 22}" fill="#131c1f" stroke="#2e4249"/>`;
  t(dx + 20, my + 4, "Mux", "#e6efec", "middle");
  t(dx, my - 28, "Ausgangstreiber", "#92a8a6");
  s += `<line x1="${dx + 40}" y1="${my}" x2="${dx + 90}" y2="${my}" stroke="${col(dout ? 1 : 0)}" stroke-width="3"/>`;
  t(dx + 94, my - 4, isRam ? "DOUT" : "DATA", "#5ad1e6");
  t(dx + 94, my + 12, formatWord(dout, comp.dataWidth, "hex"), HI);
  if (isRam) {
    const wy = top + dh + 26;
    const we = (ins[2] ?? 0) & 1;
    const clk = (ins[3] ?? 0) & 1;
    const din = normWord(ins[1] ?? 0, comp.dataWidth);
    s += `<rect x="150" y="${wy - 6}" width="${mx + mw - 160}" height="46" rx="6" fill="#131c1f" stroke="#2e4249"/>`;
    t(160, wy + 8, "Schreibpfad:", "#f0b44c");
    t(160, wy + 26, `DIN ${formatWord(din, comp.dataWidth, "hex")}`, "#e6efec");
    t(300, wy + 26, `WE=${we}`, col(we));
    t(360, wy + 26, `CLK=${clk}`, col(clk));
    t(440, wy + 26, we ? "↑ Flanke schreibt DIN in die aktive Zeile" : "WE=0: Zeile bleibt unverändert", "#92a8a6");
    s += `<line x1="${mx + 30}" y1="${wy - 6}" x2="${mx + 30}" y2="${top + dh + 6}" stroke="${we ? "#f0b44c" : LO}" stroke-width="2" stroke-dasharray="4 3"/>`;
  }
  return svg(W, H, s);
}

function lessonHtml(comp: Comp): string {
  const isRam = comp.kind === "ram";
  const common = `
    <p><b>Adresse</b> wählt ein <b>Wort</b> (m Bit breit). Der <b>Decoder</b> macht daraus ein One-Hot-Signal: genau eine <b>Wortleitung</b> ist aktiv.
    Deren Zeile legt ihre Bits auf die Bitleitungen; der Ausgangstreiber führt sie zum Datenbus.</p>
    <p><b>Lesen</b> ist asynchron: Ändert sich die Adresse, ändert sich der Ausgang sofort – kein Takt nötig.</p>
    <p><b>Kapazität</b> = 2<sup>n</sup> Wörter × m Bit. ${esc(capacityText(comp.kind as "rom" | "ram", comp.addrWidth, comp.dataWidth))}.</p>`;
  const ramText = `
    <p><b>Schreiben</b> ist synchron: Nur bei <b>steigender Taktflanke</b> und WE = 1 übernimmt die aktive Zeile DIN. Dazwischen hält jede Zelle ihr Bit.</p>
    <p><b>Volatil:</b> ohne Spannung (hier: Simulation zurücksetzen) geht der Inhalt verloren. Links: eine 1-Bit-Zelle – schalte D, Wortleitung (WL) und WE per Klick.
    Gespeichert wird nur, wenn WL <i>und</i> WE aktiv sind (AND); ein D-Latch (intern: zwei rückgekoppelte NAND) hält das Bit. Gelesen wird nur, wenn WL aktiv ist.</p>`;
  const romText = `
    <p><b>Nichtflüchtig:</b> der Inhalt ist fest verdrahtet und bleibt ohne Spannung erhalten; „Programmieren“ heißt, pro Kreuzung Leitung/Diode zu setzen oder wegzulassen. Es gibt keinen Schreibpfad.</p>
    <p>Links das Prinzip: Eine Diode an der Kreuzung Wortleitung × Bitleitung bedeutet <b>1</b>, keine Diode <b>0</b>. Die aktive Wortleitung zieht über ihre Dioden die Bitleitungen hoch; ein Widerstand hält die anderen auf 0.</p>`;
  return common + (isRam ? ramText : romText);
}

function cellSvg(st: Open): string {
  const s = cellState(st.cell);
  let g = "";
  const t = (x: number, y: number, txt: string, c = "#92a8a6", a = "start"): void => {
    g += `<text x="${x}" y="${y}" fill="${c}" text-anchor="${a}">${esc(txt)}</text>`;
  };
  const sw = (id: string, y: number, label: string, v: number): void => {
    g += `<g data-in="${id}" style="cursor:pointer"><rect x="6" y="${y - 12}" width="54" height="24" rx="5" fill="#131c1f" stroke="${col(v)}"/>`;
    g += `<text x="33" y="${y + 4}" fill="${col(v)}" text-anchor="middle">${label}=${v}</text></g>`;
    g += `<line x1="60" y1="${y}" x2="90" y2="${y}" stroke="${col(v)}" stroke-width="2"/>`;
  };
  sw("d", 40, "D", s.d);
  sw("wl", 100, "WL", s.wl);
  sw("we", 160, "WE", s.we);
  // AND (Schreibfreigabe)
  g += `<path d="M90 110 h22 a20 20 0 0 1 0 40 h-22 z" fill="#131c1f" stroke="#2e4249"/>`;
  t(104, 134, "&", "#e6efec", "middle");
  g += `<line x1="90" y1="100" x2="90" y2="118" stroke="${col(s.wl)}" stroke-width="2"/>`;
  g += `<line x1="90" y1="160" x2="90" y2="142" stroke="${col(s.we)}" stroke-width="2"/>`;
  g += `<line x1="132" y1="130" x2="190" y2="130" stroke="${col(s.write)}" stroke-width="2"/><line x1="190" y1="130" x2="190" y2="70" stroke="${col(s.write)}" stroke-width="2"/>`;
  t(140, 124, "schreiben", col(s.write));
  // Latch
  g += `<line x1="90" y1="40" x2="170" y2="40" stroke="${col(s.d)}" stroke-width="2"/>`;
  g += `<rect x="170" y="20" width="84" height="60" rx="6" fill="#131c1f" stroke="${col(s.q)}"/>`;
  t(212, 44, "D-Latch", "#e6efec", "middle");
  t(212, 62, `Q = ${s.q}`, col(s.q), "middle");
  t(176, 36, "D");
  t(176, 78, "EN");
  g += `<line x1="190" y1="70" x2="190" y2="80" stroke="${col(s.write)}" stroke-width="2"/>`;
  // Lese-UND
  g += `<line x1="254" y1="50" x2="290" y2="50" stroke="${col(s.q)}" stroke-width="2"/>`;
  g += `<path d="M290 40 h20 a20 20 0 0 1 0 40 h-20 z" fill="#131c1f" stroke="#2e4249"/>`;
  t(302, 64, "&", "#e6efec", "middle");
  g += `<line x1="90" y1="100" x2="270" y2="100" stroke="${col(s.wl)}" stroke-width="1.5" stroke-dasharray="3 3"/><line x1="270" y1="100" x2="270" y2="70" stroke="${col(s.wl)}" stroke-width="1.5" stroke-dasharray="3 3"/><line x1="270" y1="70" x2="290" y2="70" stroke="${col(s.wl)}" stroke-width="1.5"/>`;
  g += `<line x1="330" y1="60" x2="380" y2="60" stroke="${col(s.out)}" stroke-width="3"/>`;
  t(384, 64, `Bitleitung = ${s.out}`, col(s.out));
  t(330, 36, "lesen", "#92a8a6", "middle");
  return svg(560, 200, g);
}

function romDiodeSvg(st: Open, active: number): string {
  const { comp } = st;
  const win = rowWindow(active, 2 ** comp.addrWidth, 4);
  const nb = Math.min(comp.dataWidth, 8);
  const cw = 34;
  const rh = 36;
  let g = "";
  const bitsOf = (r: number): number[] => wordBits(comp.data[r] ?? 0, comp.dataWidth).slice(-nb);
  const act = bitsOf(active);
  win.forEach((r, i) => {
    const y = 30 + i * rh;
    const on = r === active;
    g += `<line x1="46" y1="${y}" x2="${60 + nb * cw}" y2="${y}" stroke="${on ? HI : LO}" stroke-width="${on ? 3 : 1.5}"/>`;
    g += `<text x="4" y="${y + 4}" fill="${on ? HI : "#6f8886"}">WL${r}</text>`;
    bitsOf(r).forEach((b, j) => {
      if (!b) return;
      const x = 70 + j * cw;
      g += `<path d="M${x - 6} ${y} h12 M${x - 4} ${y + 2} l4 8 l4 -8 z" fill="${on ? HI : "#6f8886"}" stroke="${on ? HI : "#6f8886"}"/>`;
    });
  });
  const bot = 30 + win.length * rh;
  act.forEach((b, j) => {
    const x = 70 + j * cw;
    g += `<line x1="${x}" y1="14" x2="${x}" y2="${bot}" stroke="${col(b)}" stroke-width="2"/>`;
    g += `<text x="${x}" y="${bot + 16}" fill="${col(b)}" text-anchor="middle">${b}</text>`;
    g += `<text x="${x}" y="${bot + 30}" fill="#6f8886" text-anchor="middle">D${nb - 1 - j}</text>`;
  });
  g += `<text x="4" y="${bot + 16}" fill="#92a8a6">DATA</text>`;
  return svg(70 + nb * cw + 20, bot + 40, g);
}

/** Wird von der App in der Render-/Step-Schleife aufgerufen (macht nichts, wenn nichts offen ist). */
export function updateMemView(force = false): void {
  const st = current;
  if (!st) return;
  if (!st.circuit.comps.has(st.comp.id)) {
    closeMemView();
    return;
  }
  const { comp, els } = st;
  const ins = st.circuit.inputValues(comp);
  const kind = comp.kind as "rom" | "ram";
  const dec = decodeAddress(ins[0] ?? 0, comp.addrWidth);
  observeAccess(st.obs, dec.addr, normWord(comp.data[dec.addr] ?? 0, comp.dataWidth));

  const next = nextActionText(kind, ins, comp.addrWidth, comp.dataWidth);
  if (force || next !== st.sig.text) {
    st.sig.text = next;
    els.next.textContent = next;
  }

  const win = rowWindow(dec.row, dec.rows, 7);
  const dsig = `${ins.join(",")}|${win.map((r) => comp.data[r] ?? 0).join(",")}`;
  if (force || dsig !== st.sig.diagram) {
    st.sig.diagram = dsig;
    els.diagram.innerHTML = diagramSvg(st, ins);
  }

  renderMatrix(st, false);

  const cs = cellState(st.cell);
  const csig = kind === "ram" ? JSON.stringify(cs) : `rom|${dec.row}|${win.map((r) => comp.data[r] ?? 0).join(",")}`;
  if (force || csig !== st.sig.cell) {
    st.sig.cell = csig;
    els.cell.innerHTML = kind === "ram" ? cellSvg(st) : romDiodeSvg(st, dec.row);
  }

  const lsig = JSON.stringify(st.obs.log);
  if (force || lsig !== st.sig.log) {
    st.sig.log = lsig;
    const aw = Math.max(1, Math.ceil(comp.addrWidth / 4));
    els.log.innerHTML = st.obs.log.length
      ? st.obs.log
          .map(
            (e) =>
              `<div class="mv-logrow ${e.kind}"><b>${e.kind === "write" ? "SCHREIBEN" : "LESEN"}</b> 0x${e.addr
                .toString(16)
                .toUpperCase()
                .padStart(aw, "0")} → ${esc(formatWord(e.value, comp.dataWidth, "hex"))}</div>`
          )
          .join("")
      : `<div class="mv-hint">Noch keine Zugriffe beobachtet – ändere die Adresse oder starte die Simulation.</div>`;
  }
}
