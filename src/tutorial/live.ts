import { Circuit } from "../circuit";
import { layoutOf } from "../logic";
import { Renderer } from "../render";
import { CELL, Comp, EditorState, View } from "../types";
import { Rig, TableRow, truthTable } from "./rig";

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface LiveOptions {
  height?: number;
  table?: { ins: string[]; outs: string[] };
  /** Namen von ROM/RAM-Bauteilen, die als editierbares Hex-Raster erscheinen */
  mem?: string[];
  readout?: (r: Rig) => string;
  /** Wird nach jeder Änderung des Zustands aufgerufen. */
  onUpdate?: () => void;
  /** Auto-Pause, sobald wahr (z. B. CPU hält an). */
  isDone?: () => boolean;
  /** Bauteil-/Gruppen-IDs, die im Bild hervorgehoben werden. */
  highlight?: () => string[];
  /** Eingaben/Ausgaben-Panel ausblenden (z. B. bei der CPU). */
  hidePanels?: boolean;
  /** Vor jedem Takt (z. B. um Ausgaben mitzuschreiben). */
  beforeStep?: () => void;
  onReset?: () => void;
}

const SPEEDS = [1, 2, 4, 8, 16, 32];

/** Canvas + Bedienleiste um eine Rig-Schaltung, ohne Verbindung zur Sandbox-App. */
export class LiveCircuit {
  readonly el = h("div", "lc");
  private canvas = h("canvas", "lc-canvas");
  private stage = h("div", "lc-stage");
  private renderer: Renderer;
  private view: View = { panX: 20, panY: 20, zoom: 1 };
  private state: EditorState = { tool: "select", selection: null, selected: [], box: null, ghost: null, wireDrag: null, hovered: null };
  private dirty = true;
  private raf = 0;
  private timer = 0;
  private running = false;
  private big = false;
  private fitted = false;
  private ro: ResizeObserver;
  private panelIn = h("div", "lc-inputs");
  private panelOut = h("div", "lc-outputs");
  private readoutEl = h("div", "lc-readout");
  private tableEl: HTMLElement | null = null;
  private tableRows: TableRow[] = [];
  private memEls: { comp: Comp; cells: HTMLInputElement[] }[] = [];
  private runBtn = h("button", "btn primary", "Start");
  private speedIdx = 3;
  private initInputs: [Comp, number][] = [];
  private initRam: [Comp, number[]][] = [];
  private inputEls = new Map<Comp, { bits: HTMLButtonElement[]; text?: HTMLInputElement }>();
  private outEls = new Map<Comp, HTMLElement>();
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.big) this.toggleBig();
  };

  constructor(readonly rig: Rig, private opts: LiveOptions = {}) {
    this.canvas.setAttribute("aria-label", "Schaltung");
    this.renderer = new Renderer(this.canvas);
    this.stage.style.height = `${opts.height ?? 260}px`;
    this.stage.append(this.canvas);

    for (const c of rig.c.comps.values()) {
      if (c.kind === "input") this.initInputs.push([c, c.value]);
      if (c.kind === "ram") this.initRam.push([c, [...c.data]]);
    }

    this.el.append(this.buildToolbar(), this.stage);
    if (!opts.hidePanels) {
      const io = h("div", "lc-io");
      io.append(this.panelIn, this.panelOut);
      this.el.append(io);
      this.buildInputs();
      this.buildOutputs();
    }
    if (opts.readout) this.el.append(this.readoutEl);
    if (opts.table) {
      this.tableRows = truthTable(rig, opts.table.ins, opts.table.outs);
      this.tableEl = h("div", "lc-table");
      this.el.append(this.tableEl);
      this.buildTable();
    }
    for (const name of opts.mem ?? []) this.buildMem(name);

    this.bindCanvas();
    this.ro = new ResizeObserver(() => {
      if (!this.fitted && this.canvas.clientWidth > 0) this.fit();
      this.dirty = true;
    });
    this.ro.observe(this.canvas);
    document.addEventListener("keydown", this.onKey);
    const loop = (): void => {
      if (this.dirty) {
        this.dirty = false;
        this.draw();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.refresh();
  }

  destroy(): void {
    this.pause();
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    document.removeEventListener("keydown", this.onKey);
  }

  /** Nach externen Änderungen am Zustand aufrufen. */
  refresh(): void {
    this.dirty = true;
    this.updateInputs();
    this.updateOutputs();
    this.updateTable();
    this.updateMem();
    if (this.opts.readout) this.readoutEl.textContent = this.opts.readout(this.rig);
    this.opts.onUpdate?.();
  }

  /* ---------- Steuerleiste ---------- */

  private buildToolbar(): HTMLElement {
    const bar = h("div", "lc-bar");
    bar.setAttribute("role", "toolbar");
    const mk = (label: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = h("button", "btn", label);
      b.type = "button";
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    };
    if (this.rig.hasClock()) {
      this.runBtn.type = "button";
      this.runBtn.title = "Takt laufen lassen oder anhalten";
      this.runBtn.addEventListener("click", () => (this.running ? this.pause() : this.start()));
      bar.append(
        this.runBtn,
        mk("Schritt", "Einen ganzen Takt weiterschalten", () => this.stepOnce()),
        mk("½ Takt", "Nur eine Taktflanke weiterschalten", () => {
          this.pause();
          this.rig.half();
          this.refresh();
        }),
        mk("Reset", "Zustand zurücksetzen", () => this.reset())
      );
      const sp = h("select", "lc-speed");
      sp.setAttribute("aria-label", "Tempo");
      SPEEDS.forEach((s, i) => sp.append(new Option(`${s} Hz`, String(i), false, i === this.speedIdx)));
      sp.addEventListener("change", () => {
        this.speedIdx = Number(sp.value);
        if (this.running) this.start();
      });
      bar.append(sp);
    } else {
      bar.append(mk("Reset", "Eingänge zurücksetzen", () => this.reset()));
    }
    bar.append(
      h("span", "lc-sp"),
      mk("−", "Verkleinern", () => this.zoomBy(1 / 1.25)),
      mk("+", "Vergrößern", () => this.zoomBy(1.25)),
      mk("Einpassen", "Ganze Schaltung zeigen", () => this.fit()),
      mk("Groß", "Vollbild-Ansicht (Esc beendet)", () => this.toggleBig())
    );
    return bar;
  }

  start(): void {
    this.pause();
    this.running = true;
    this.runBtn.textContent = "Pause";
    this.timer = window.setInterval(() => this.stepOnce(true), 1000 / SPEEDS[this.speedIdx]);
  }

  pause(): void {
    this.running = false;
    this.runBtn.textContent = "Start";
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  stepOnce(fromTimer = false): void {
    if (!fromTimer) this.pause();
    if (this.opts.isDone?.()) {
      this.pause();
      this.refresh();
      return;
    }
    this.opts.beforeStep?.();
    this.rig.step();
    if (this.opts.isDone?.()) this.pause();
    this.refresh();
  }

  reset(): void {
    this.pause();
    for (const [c, d] of this.initRam) c.data = [...d];
    this.rig.c.reset();
    for (const [c, v] of this.initInputs) this.rig.c.setInputValue(c, v);
    this.opts.onReset?.();
    this.refresh();
  }

  private zoomAt(cx: number, cy: number, f: number): void {
    const z = Math.min(2.5, Math.max(0.05, this.view.zoom * f));
    const k = z / this.view.zoom;
    this.view.panX = cx - (cx - this.view.panX) * k;
    this.view.panY = cy - (cy - this.view.panY) * k;
    this.view.zoom = z;
    this.dirty = true;
  }

  private zoomBy(f: number): void {
    this.zoomAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, f);
  }

  fit(): void {
    const c = this.rig.c;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const comp of c.comps.values()) {
      if (c.isCompHidden(comp.id)) continue;
      const l = layoutOf(comp);
      const p = c.posOf(comp);
      minX = Math.min(minX, p.x * CELL);
      minY = Math.min(minY, p.y * CELL);
      maxX = Math.max(maxX, (p.x + l.cols) * CELL);
      maxY = Math.max(maxY, (p.y + l.rows) * CELL);
    }
    for (const g of c.groups.values()) {
      minX = Math.min(minX, g.x * CELL);
      minY = Math.min(minY, g.y * CELL);
      maxX = Math.max(maxX, (g.x + g.cols) * CELL);
      maxY = Math.max(maxY, (g.y + g.rows) * CELL);
    }
    for (const r of this.rig.regions) {
      minX = Math.min(minX, r.x * CELL);
      minY = Math.min(minY, (r.y - 1) * CELL);
      maxX = Math.max(maxX, (r.x + r.w) * CELL);
      maxY = Math.max(maxY, (r.y + r.h) * CELL);
    }
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!Number.isFinite(minX) || cw === 0) return;
    const z = Math.min(1.3, Math.max(0.05, Math.min((cw - 40) / (maxX - minX), (ch - 40) / (maxY - minY))));
    this.view.zoom = z;
    this.view.panX = (cw - (maxX - minX) * z) / 2 - minX * z;
    this.view.panY = (ch - (maxY - minY) * z) / 2 - minY * z;
    this.fitted = true;
    this.dirty = true;
  }

  private toggleBig(): void {
    this.big = !this.big;
    this.el.classList.toggle("lc-big", this.big);
    this.stage.style.height = this.big ? "" : `${this.opts.height ?? 260}px`;
    this.fitted = false;
    requestAnimationFrame(() => this.fit());
  }

  /* ---------- Zeichnen und Mausbedienung ---------- */

  private draw(): void {
    const c: Circuit = this.rig.c;
    this.state.selected = this.opts.highlight?.() ?? [];
    this.renderer.draw(c, this.view, this.state, {
      wireStyle: "ortho",
      clockPulse: this.running ? Math.floor(performance.now() / 300) % 2 === 0 : undefined,
    });
    this.drawRegions();
    if (this.running) this.dirty = true;
  }

  private drawRegions(): void {
    if (this.rig.regions.length === 0) return;
    const ctx = this.canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr * this.view.zoom, 0, 0, dpr * this.view.zoom, dpr * this.view.panX, dpr * this.view.panY);
    ctx.lineWidth = 1 / this.view.zoom;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "rgba(90,209,230,0.35)";
    ctx.fillStyle = "rgba(90,209,230,0.8)";
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    for (const r of this.rig.regions) {
      ctx.strokeRect(r.x * CELL, r.y * CELL, r.w * CELL, r.h * CELL);
      ctx.fillText(r.title, r.x * CELL + 4, r.y * CELL - 4);
    }
    ctx.restore();
  }

  private world(e: MouseEvent): { x: number; y: number } {
    const b = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - b.left - this.view.panX) / this.view.zoom, y: (e.clientY - b.top - this.view.panY) / this.view.zoom };
  }

  private bindCanvas(): void {
    let drag: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
    this.canvas.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, px: this.view.panX, py: this.view.panY, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        this.view.panX = drag.px + dx;
        this.view.panY = drag.py + dy;
        this.dirty = true;
      }
    });
    this.canvas.addEventListener("pointerup", (e) => {
      const d = drag;
      drag = null;
      if (!d || d.moved) return;
      const w = this.world(e);
      for (const comp of this.rig.c.comps.values()) {
        if (comp.kind !== "input" || comp.width !== 1 || this.rig.c.isCompHidden(comp.id)) continue;
        const l = layoutOf(comp);
        const p = this.rig.c.posOf(comp);
        if (w.x >= p.x * CELL && w.x <= (p.x + l.cols) * CELL && w.y >= p.y * CELL && w.y <= (p.y + l.rows) * CELL) {
          this.rig.c.toggleInput(comp);
          this.refresh();
          return;
        }
      }
    });
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey && !this.big) return;
        e.preventDefault();
        const b = this.canvas.getBoundingClientRect();
        this.zoomAt(e.clientX - b.left, e.clientY - b.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      },
      { passive: false }
    );
  }

  /* ---------- Eingänge / Ausgänge ---------- */

  private buildInputs(): void {
    for (const comp of this.rig.inputs()) {
      const row = h("div", "lc-row");
      row.append(h("span", "lc-name", comp.label || comp.kind));
      const bits: HTMLButtonElement[] = [];
      const w = Math.min(comp.width, 16);
      for (let i = w - 1; i >= 0; i--) {
        const b = h("button", "lc-bit", "0");
        b.type = "button";
        b.title = `Bit ${i} umschalten`;
        b.setAttribute("aria-label", `${comp.label || "Eingang"} Bit ${i}`);
        b.addEventListener("click", () => {
          this.rig.c.toggleBit(comp, i);
          this.refresh();
        });
        bits[i] = b;
        row.append(b);
        if (i % 4 === 0 && i > 0) row.append(h("span", "lc-gap"));
      }
      let text: HTMLInputElement | undefined;
      if (comp.width > 1) {
        const t = h("input", "lc-num");
        text = t;
        t.type = "text";
        t.size = 8;
        t.setAttribute("aria-label", `${comp.label || "Eingang"} Wert (dezimal, 0x… oder 0b…)`);
        t.addEventListener("change", () => {
          const v = Number(t.value.trim());
          if (Number.isFinite(v) && v >= 0) this.rig.c.setInputValue(comp, Math.floor(v));
          this.refresh();
        });
        row.append(t);
      }
      this.inputEls.set(comp, { bits, text });
      this.panelIn.append(row);
    }
  }

  private updateInputs(): void {
    for (const [comp, e] of this.inputEls) {
      e.bits.forEach((b, i) => {
        const on = (comp.value >> i) & 1;
        b.textContent = String(on);
        b.classList.toggle("on", on === 1);
        b.setAttribute("aria-pressed", String(on === 1));
      });
      if (e.text && document.activeElement !== e.text) e.text.value = String(comp.value >>> 0);
    }
  }

  private buildOutputs(): void {
    for (const comp of this.rig.outputs()) {
      const row = h("div", "lc-row");
      row.append(h("span", "lc-name", comp.label || comp.kind));
      const v = h("span", "lc-val");
      this.outEls.set(comp, v);
      row.append(v);
      this.panelOut.append(row);
    }
  }

  private updateOutputs(): void {
    for (const [comp, e] of this.outEls) {
      const v = (this.rig.c.inputValues(comp)[0] ?? 0) >>> 0;
      e.classList.toggle("on", v !== 0);
      e.textContent =
        comp.width === 1 ? String(v) : `${v} · 0x${v.toString(16).toUpperCase().padStart(Math.ceil(comp.width / 4), "0")} · ${v.toString(2).padStart(comp.width, "0")}`;
    }
  }

  /* ---------- Wahrheitstabelle ---------- */

  private buildTable(): void {
    const t = this.opts.table!;
    const tbl = h("table", "tt");
    const head = h("tr");
    for (const n of [...t.ins, ...t.outs]) head.append(h("th", "", this.rig.comp(n).label || n));
    tbl.append(head);
    this.tableRows.forEach((row, i) => {
      const tr = h("tr");
      tr.tabIndex = 0;
      tr.title = "Klick stellt diese Eingabe ein";
      const apply = (): void => {
        t.ins.forEach((n, k) => this.rig.set(n, row.ins[k]));
        this.refresh();
      };
      tr.addEventListener("click", apply);
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          apply();
        }
      });
      [...row.ins, ...row.outs].forEach((v, k) => {
        const td = h("td", k >= row.ins.length ? "out" : "", String(v));
        if (k >= row.ins.length && v) td.classList.add("one");
        tr.append(td);
      });
      tr.dataset.row = String(i);
      tbl.append(tr);
    });
    this.tableEl!.append(tbl);
  }

  private updateTable(): void {
    const t = this.opts.table;
    if (!t || !this.tableEl) return;
    const cur = t.ins.map((n) => this.rig.get(n));
    this.tableEl.querySelectorAll("tr[data-row]").forEach((tr, i) => {
      tr.classList.toggle("cur", this.tableRows[i].ins.every((v, k) => v === cur[k]));
    });
  }

  /* ---------- Speicher ---------- */

  private buildMem(name: string): void {
    const comp = this.rig.comp(name);
    const box = h("details", "lc-mem");
    box.open = true;
    box.append(h("summary", "", `Inhalt: ${comp.label || name} (${comp.data.length} Wörter, hex – editierbar)`));
    const grid = h("div", "mem-grid");
    const digits = Math.ceil(comp.dataWidth / 4);
    const cells: HTMLInputElement[] = [];
    comp.data.forEach((_, i) => {
      const cell = h("label", "mem-cell");
      cell.append(h("span", "mem-adr", i.toString(16).toUpperCase().padStart(2, "0")));
      const inp = h("input");
      inp.type = "text";
      inp.size = digits + 1;
      inp.setAttribute("aria-label", `${comp.label || name}[${i}]`);
      inp.addEventListener("change", () => {
        const v = parseInt(inp.value.replace(/^0x/i, ""), 16);
        if (Number.isFinite(v)) comp.data[i] = v & (2 ** comp.dataWidth - 1);
        this.rig.c.evalComb();
        this.refresh();
      });
      cells.push(inp);
      cell.append(inp);
      grid.append(cell);
    });
    box.append(grid);
    this.el.append(box);
    this.memEls.push({ comp, cells });
  }

  private updateMem(): void {
    for (const { comp, cells } of this.memEls) {
      const digits = Math.ceil(comp.dataWidth / 4);
      cells.forEach((inp, i) => {
        if (document.activeElement !== inp) inp.value = (comp.data[i] ?? 0).toString(16).toUpperCase().padStart(digits, "0");
      });
    }
  }
}
