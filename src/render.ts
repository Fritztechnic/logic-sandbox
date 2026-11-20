import { Circuit, groupHeaderRows, groupPinPoint } from "./circuit";
import { ExpandedFrame } from "./expand";
import { wireCurve, curvePoint } from "./geometry";
import { KIND_INFO, layoutOf, portWidths } from "./logic";
import { WireStyle, getWireRoutes, pointAtPolyline } from "./route";
import { CELL, Comp, EditorState, Point, View, maskOf } from "./types";

const C = {
  bg: "#0a0f10",
  gridMinor: "rgba(230,239,236,0.1)",
  gridMajor: "rgba(184,240,74,0.22)",
  box: "#0f181b",
  boxSel: "#16262b",
  border: "#2a3d43",
  borderSel: "#5ad1e6",
  borderErr: "#f0b44c",
  title: "#e6efec",
  muted: "#88a09e",
  off: "#36484d",
  on: "#b8f04a",
  bus: "#5ad1e6",
  err: "#ff7a6b",
  pin: "#0a0f10",
};

export function signalColor(value: number, width: number): string {
  if (value === 0) return C.off;
  if (width === 1) return C.on;
  return C.bus;
}

function fmtValue(v: number, width: number, format: "bin" | "hex" | "dec" = "hex"): string {
  const u = v >>> 0;
  if (format === "bin") return "0b" + u.toString(2).padStart(width, "0");
  if (format === "dec") return String(u);
  const digits = Math.max(1, Math.ceil(width / 4));
  return "0x" + u.toString(16).toUpperCase().padStart(digits, "0");
}

export class Renderer {
  private gridPattern: CanvasPattern | null = null;
  /** Aktuelle Kabelführung – wird bei jedem draw() gesetzt. */
  private style: WireStyle = "ortho";
  /** Sichtbarer Taktzustand beim Laufen (null = echten Wert zeigen). */
  private clockPulse: boolean | null = null;
  private clockNet: Set<string> = new Set();

  constructor(private canvas: HTMLCanvasElement) {}

  private resize(): { w: number; h: number; dpr: number } {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    return { w, h, dpr };
  }

  draw(
    circuit: Circuit,
    view: View,
    state: EditorState,
    options: { frames?: ExpandedFrame[]; wireStyle?: WireStyle; clockPulse?: boolean } = {}
  ): void {
    this.style = options.wireStyle ?? "ortho";
    this.clockPulse = options.clockPulse ?? null;
    this.clockNet = circuit.clockNet();
    const { w, h, dpr } = this.resize();
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);
    this.drawGrid(ctx, view, w, h);
    if (circuit.expanded) this.drawFrames(ctx, options.frames ?? [], view.zoom);
    this.drawWires(ctx, circuit, state, view.zoom);
    this.drawComps(ctx, circuit, state, view.zoom);
    if (!circuit.expanded) this.drawGroupBlocks(ctx, circuit, state, view.zoom);
    this.drawWireDrag(ctx, circuit, state);
    this.drawPreview(ctx, state, view.zoom);
    this.drawGhost(ctx, state);
    this.drawBox(ctx, state);
    ctx.restore();
  }

  /** Felder der entpackten Ansicht: je Modul ein eigener Bereich mit Titel. */
  private drawFrames(ctx: CanvasRenderingContext2D, frames: ExpandedFrame[], zoom: number): void {
    const fs = Math.max(8, 12 / Math.max(0.6, Math.min(1.6, zoom)));
    for (const frame of frames) {
      const x = frame.x * CELL;
      const y = frame.y * CELL;
      const w = frame.w * CELL;
      const h = frame.h * CELL;
      const titleH = fs * 2.4;
      ctx.beginPath();
      ctx.roundRect(x, y - titleH, w, h + titleH, 10);
      ctx.fillStyle = "rgba(90,209,230,0.035)";
      ctx.fill();
      ctx.strokeStyle = "rgba(90,209,230,0.34)";
      ctx.lineWidth = 1 / Math.max(0.6, Math.min(1.4, zoom));
      ctx.stroke();
      ctx.font = `600 ${fs}px "Schibsted Grotesk Variable", system-ui, sans-serif`;
      ctx.fillStyle = C.title;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(`◇ ${frame.group.name}`, x + 8, y - titleH / 2, Math.max(10, w - 16));
    }
  }

  private worldBounds(view: View, w: number, h: number) {
    const x0 = -view.panX / view.zoom;
    const y0 = -view.panY / view.zoom;
    return { x0, y0, x1: x0 + w / view.zoom, y1: y0 + h / view.zoom };
  }

  /** Punktmuster als Canvas-Pattern: ein Fill pro Frame statt tausender Einzelpunkte. */
  private dotPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.gridPattern) return this.gridPattern;
    const tile = document.createElement("canvas");
    tile.width = CELL * 8;
    tile.height = CELL * 8;
    const c = tile.getContext("2d");
    if (!c) return null;
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        const major = x === 0 && y === 0;
        c.fillStyle = major ? C.gridMajor : C.gridMinor;
        const size = major ? 1.8 : 1.2;
        c.fillRect(x * CELL - size / 2 + CELL / 2, y * CELL - size / 2 + CELL / 2, size, size);
      }
    }
    this.gridPattern = ctx.createPattern(tile, "repeat");
    return this.gridPattern;
  }

  private drawGrid(ctx: CanvasRenderingContext2D, view: View, w: number, h: number): void {
    const b = this.worldBounds(view, w, h);
    const step = CELL * view.zoom;
    if (step >= 5) {
      const pattern = this.dotPattern(ctx);
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        return;
      }
    }
    // Stark ausgezoomt: nur die groben Rasterlinien zeichnen (deutlich günstiger).
    const major = CELL * 8;
    ctx.strokeStyle = C.gridMinor;
    ctx.lineWidth = 1 / view.zoom;
    ctx.beginPath();
    for (let x = Math.floor(b.x0 / major) * major; x <= b.x1; x += major) {
      ctx.moveTo(x, b.y0);
      ctx.lineTo(x, b.y1);
    }
    for (let y = Math.floor(b.y0 / major) * major; y <= b.y1; y += major) {
      ctx.moveTo(b.x0, y);
      ctx.lineTo(b.x1, y);
    }
    ctx.stroke();
  }

  private drawWires(
    ctx: CanvasRenderingContext2D,
    circuit: Circuit,
    state: EditorState,
    zoom: number
  ): void {
    const routes = getWireRoutes(circuit, this.style);
    for (const wire of circuit.wires) {
      if (circuit.isWireHidden(wire)) continue;
      const src = circuit.get(wire.from);
      const dst = circuit.get(wire.to);
      if (!src || !dst) continue;
      const from = circuit.pinPos(src, "out", wire.fromPort);
      const to = circuit.pinPos(dst, "in", wire.toPort);
      const route = routes.get(wire.id);
      const curve = route ? null : wireCurve(from, to);
      const width = portWidths(src).out[wire.fromPort] ?? 1;
      const value = this.displayValue(src.id, src.outs[wire.fromPort] ?? 0, width);
      const invalid = circuit.invalidWires.has(wire.id);
      const looped = circuit.loopWires.has(wire.id);
      const selected = state.selection?.type === "wire" && state.selection.id === wire.id;

      const stroke = () => {
        if (route) this.strokePolyline(ctx, route);
        else this.strokeCurve(ctx, curve!);
      };

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (selected) {
        ctx.strokeStyle = "rgba(90,209,230,0.3)";
        ctx.lineWidth = width > 1 ? 9 : 6;
        stroke();
      }
      ctx.strokeStyle = invalid || looped ? C.err : signalColor(value, width);
      const scale = Math.max(0.6, Math.min(1.4, zoom));
      ctx.lineWidth = (width > 1 ? 2.6 : 1.6) / scale;
      if (invalid || looped) ctx.setLineDash([6, 4]);
      stroke();
      ctx.setLineDash([]);

      if (width > 1 && !invalid) {
        const mid = route ? pointAtPolyline(route, 0.5) : curvePoint(curve!, 0.5);
        this.drawLabel(ctx, fmtValue(value, width, "hex"), mid.x, mid.y, zoom);
      }
    }
  }

  private strokeCurve(ctx: CanvasRenderingContext2D, curve: ReturnType<typeof wireCurve>): void {
    ctx.beginPath();
    ctx.moveTo(curve.p0.x, curve.p0.y);
    ctx.bezierCurveTo(curve.c1.x, curve.c1.y, curve.c2.x, curve.c2.y, curve.p1.x, curve.p1.y);
    ctx.stroke();
  }

  /**
   * Beim Laufen wird das Taktnetz sichtbar gepulst: so bleibt der Takt auch bei
   * 1 MHz als blinkende Leitung erkennbar (der echte Wert wäre nur Flackern).
   */
  private displayValue(compId: string, value: number, width: number): number {
    if (this.clockPulse === null || !this.clockNet.has(compId)) return value;
    return this.clockPulse ? maskOf(width) : 0;
  }

  private strokePolyline(ctx: CanvasRenderingContext2D, points: Point[]): void {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1];
      const b = points[i];
      const c = points[i + 1];
      const r = Math.min(6, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
      ctx.arcTo(b.x, b.y, c.x, c.y, r);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.stroke();
  }

  private drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, zoom: number): void {
    const fs = 10 / Math.max(0.75, Math.min(1.6, zoom));
    ctx.font = `${fs}px "JetBrains Mono Variable", ui-monospace, monospace`;
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = "#0d1416ee";
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - fs * 0.85, w, fs * 1.7, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.bus;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
  }

  private drawComps(
    ctx: CanvasRenderingContext2D,
    circuit: Circuit,
    state: EditorState,
    zoom: number
  ): void {
    // In der entpackten Ansicht liegen die Innenteile an ihren berechneten Plätzen.
    for (const comp of circuit.comps.values()) {
      if (circuit.isCompHidden(comp.id)) continue;
      const l = layoutOf(comp);
      const pos = circuit.posOf(comp);
      const x = pos.x * CELL;
      const y = pos.y * CELL;
      const w = l.cols * CELL;
      const h = l.rows * CELL;
      const selected = state.selected.includes(comp.id);
      const looped = circuit.loopComps.has(comp.id);

      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 6);
      ctx.fillStyle = selected ? C.boxSel : C.box;
      ctx.fill();
      ctx.lineWidth = selected ? 1.6 : 1;
      ctx.strokeStyle = looped ? C.borderErr : selected ? C.borderSel : C.border;
      ctx.stroke();

      this.drawBody(ctx, circuit, comp, x, y, w, h, zoom);
      this.drawPins(ctx, circuit, comp, state, zoom);
    }
  }

  private drawBody(
    ctx: CanvasRenderingContext2D,
    circuit: Circuit,
    comp: Comp,
    x: number,
    y: number,
    w: number,
    h: number,
    zoom: number
  ): void {
    const info = KIND_INFO[comp.kind];
    const fs = Math.max(7, 9 / Math.max(0.8, Math.min(1.5, zoom)));
    const cy = y + h / 2;
    const m = maskOf(comp.width);
    const gate = ["not", "buf", "and", "or", "nand", "nor", "xor", "xnor"].includes(comp.kind);

    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = `600 ${fs}px "JetBrains Mono Variable", ui-monospace, monospace`;
    ctx.fillStyle = C.muted;
    if (!gate) ctx.fillText(comp.label.trim() || info.label, x + 7, y + 10);

    if (gate) {
      ctx.textAlign = "center";
      ctx.font = `700 ${Math.max(9, 13 / Math.max(0.8, Math.min(1.5, zoom)))}px "JetBrains Mono Variable", ui-monospace, monospace`;
      ctx.fillStyle = C.title;
      ctx.fillText(comp.label.trim() || info.label, x + w / 2, cy - (comp.width > 1 ? 5 : 0));
      if (comp.width > 1) {
        ctx.font = `${fs}px "JetBrains Mono Variable", ui-monospace, monospace`;
        ctx.fillStyle = C.bus;
        ctx.fillText(`${comp.width} Bit`, x + w / 2, cy + 10);
      }
      return;
    }

    switch (comp.kind) {
      case "input":
      case "const": {
        this.drawBits(ctx, comp.value & m, comp.width, x + 8, cy + 2, w - 16, comp.format);
        break;
      }
      case "output": {
        const v = circuit.inputValues(comp)[0] ?? 0;
        this.drawBits(ctx, v & m, comp.width, x + 8, cy + 2, w - 16, comp.format);
        break;
      }
      case "clock": {
        const on = this.clockPulse ?? (comp.outs[0] ?? 0) !== 0;
        ctx.fillStyle = on ? C.on : C.off;
        ctx.beginPath();
        ctx.arc(x + w - 16, cy + 2, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = C.muted;
        ctx.font = `${fs}px "JetBrains Mono Variable", ui-monospace, monospace`;
        ctx.textAlign = "left";
        ctx.fillText(`÷${comp.div}`, x + 8, cy + 4);
        break;
      }
      case "dff":
      case "latch": {
        ctx.fillStyle = C.title;
        ctx.font = `600 ${fs}px "JetBrains Mono Variable", ui-monospace, monospace`;
        ctx.textAlign = "left";
        ctx.fillText(`Q=${fmtValue(comp.outs[0] ?? 0, comp.width, comp.format)}`, x + 8, cy + 8);
        break;
      }
      case "splitter":
      case "joiner": {
        ctx.textAlign = "center";
        ctx.fillStyle = C.bus;
        ctx.font = `600 ${fs}px "JetBrains Mono Variable", ui-monospace, monospace`;
        ctx.fillText(`${comp.width} Bit`, x + w / 2, y + 10);
        break;
      }
      case "rom":
      case "ram": {
        ctx.fillStyle = C.muted;
        ctx.font = `600 ${fs}px "JetBrains Mono Variable", ui-monospace, monospace`;
        ctx.fillText(`${comp.addrWidth}b Adr.`, x + 8, y + 11);
        ctx.fillText(`${comp.dataWidth}b Daten`, x + 8, y + 11 + fs + 3);
        const outv = comp.outs[0] ?? 0;
        ctx.fillStyle = signalColor(outv, comp.dataWidth);
        ctx.fillText(fmtValue(outv, comp.dataWidth, "hex"), x + 8, y + h - 12);
        break;
      }
    }
  }

  private drawBits(
    ctx: CanvasRenderingContext2D,
    value: number,
    width: number,
    x: number,
    cy: number,
    avail: number,
    format: "bin" | "hex" | "dec" = "hex"
  ): void {
    const m = maskOf(width);
    const v = value & m;
    if (width <= 8) {
      const size = Math.max(6, Math.min(12, avail / width - 2));
      const gap = 2;
      let sx = x;
      for (let i = width - 1; i >= 0; i--) {
        const bit = (v >> i) & 1;
        ctx.fillStyle = bit ? C.on : C.boxSel;
        ctx.strokeStyle = bit ? C.on : C.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(sx, cy - size / 2, size, size, 2);
        ctx.fill();
        ctx.stroke();
        sx += size + gap;
      }
    } else {
      ctx.textAlign = "left";
      ctx.font = `600 11px "JetBrains Mono Variable", ui-monospace, monospace`;
      ctx.fillStyle = signalColor(v, width);
      ctx.fillText(fmtValue(v, width, format), x, cy);
    }
  }

  private drawPins(
    ctx: CanvasRenderingContext2D,
    circuit: Circuit,
    comp: Comp,
    state: EditorState,
    zoom: number
  ): void {
    const l = layoutOf(comp);
    // In der entpackten Ansicht verschieben sich die Innenteile: Pins und
    // Beschriftungen müssen an der gezeichneten Position sitzen.
    const pos = circuit.posOf(comp);
    const x = pos.x * CELL;
    const y = pos.y * CELL;
    const w = l.cols * CELL;
    const h = l.rows * CELL;
    const widths = portWidths(comp);
    const fs = Math.max(6.5, 8 / Math.max(0.8, Math.min(1.5, zoom)));
    const ins = circuit.inputValues(comp).map((v, i) => this.displayValue(comp.id, v, widths.in[i] ?? 1));

    const drawPin = (px: number, py: number, value: number, pw: number, name: string, left: boolean) => {
      const hovered =
        state.hovered?.comp === comp.id && state.hovered.dir === (left ? "in" : "out");
      ctx.beginPath();
      ctx.arc(px, py, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = signalColor(value, pw);
      ctx.fill();
      ctx.lineWidth = hovered ? 2 : 1.2;
      ctx.strokeStyle = hovered ? C.title : C.pin;
      ctx.stroke();
      ctx.font = `${fs}px "JetBrains Mono Variable", ui-monospace, monospace`;
      ctx.fillStyle = C.muted;
      ctx.textBaseline = "middle";
      if (left) {
        ctx.textAlign = "left";
        ctx.fillText(name, x + 8, py);
      } else {
        ctx.textAlign = "right";
        ctx.fillText(name, x + w - 8, py);
      }
    };

    l.ins.forEach((p, i) => {
      drawPin(x + p.fx * w, y + p.fy * h, ins[i] ?? 0, widths.in[i] ?? 1, p.name, true);
    });
    l.outs.forEach((p, i) => {
      const width = widths.out[i] ?? 1;
      drawPin(x + p.fx * w, y + p.fy * h, this.displayValue(comp.id, comp.outs[i] ?? 0, width), width, p.name, false);
    });
  }

  private drawGroupBlocks(
    ctx: CanvasRenderingContext2D,
    circuit: Circuit,
    state: EditorState,
    zoom: number
  ): void {
    for (const group of circuit.groups.values()) {
      const x = group.x * CELL;
      const y = group.y * CELL;
      const w = group.cols * CELL;
      const h = group.rows * CELL;
      const selected = state.selected.includes(group.id);
      const header = groupHeaderRows(group) * CELL;

      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 7);
      ctx.fillStyle = selected ? C.boxSel : C.box;
      ctx.fill();
      ctx.lineWidth = selected ? 1.6 : 1;
      ctx.strokeStyle = selected ? C.borderSel : C.border;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x + 1, y + header);
      ctx.lineTo(x + w - 1, y + header);
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 1;
      ctx.stroke();

      const fs = Math.max(6, Math.min(9 / Math.max(0.7, Math.min(1.5, zoom)), header * 0.62));
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = `600 ${fs}px "Schibsted Grotesk Variable", system-ui, sans-serif`;
      ctx.fillStyle = C.title;
      ctx.fillText(group.name, x + 6, y + header / 2, Math.max(8, w - 12));

      const count = Math.max(group.inputs.length, group.outputs.length, 1);
      const spacing = (h - header) / count;
      const pinFs = Math.max(5, Math.min(8 / Math.max(0.8, Math.min(1.5, zoom)), spacing * 0.85));
      const radius = Math.max(2, Math.min(3.6, spacing / 2.6));
      ctx.font = `${pinFs}px "JetBrains Mono Variable", ui-monospace, monospace`;
      ctx.textBaseline = "middle";
      const showLabels = spacing >= 10 && w >= 60;
      const maxLabel = Math.max(8, w / 2 - 12);
      const drawPin = (px: number, py: number, value: number, width: number, label: string, left: boolean) => {
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fillStyle = signalColor(value, width);
        ctx.fill();
        ctx.strokeStyle = C.pin;
        ctx.lineWidth = 1.1;
        ctx.stroke();
        if (!showLabels) return;
        if (ctx.measureText(label).width > maxLabel) return;
        ctx.fillStyle = C.muted;
        ctx.textAlign = left ? "left" : "right";
        ctx.fillText(label, left ? px + radius + 4 : px - radius - 4, py);
      };

      group.inputs.forEach((pin, i) => {
        const comp = circuit.get(pin.compId);
        const pos = groupPinPoint(group, true, i, group.inputs.length);
        const value = comp ? (circuit.inputValues(comp)[0] ?? 0) & maskOf(pin.width) : 0;
        drawPin(pos.x, pos.y, value, pin.width, pin.name, true);
      });
      group.outputs.forEach((pin, i) => {
        const comp = circuit.get(pin.compId);
        const pos = groupPinPoint(group, false, i, group.outputs.length);
        const value = comp ? (comp.outs[0] ?? 0) & maskOf(pin.width) : 0;
        drawPin(pos.x, pos.y, value, pin.width, pin.name, false);
      });
    }
  }

  private drawBox(ctx: CanvasRenderingContext2D, state: EditorState): void {
    const box = state.box;
    if (!box) return;
    const x = Math.min(box.x1, box.x2);
    const y = Math.min(box.y1, box.y2);
    const w = Math.abs(box.x2 - box.x1);
    const h = Math.abs(box.y2 - box.y1);
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.fillStyle = "rgba(90,209,230,0.08)";
    ctx.fill();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = C.borderSel;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawWireDrag(ctx: CanvasRenderingContext2D, circuit: Circuit, state: EditorState): void {
    const drag = state.wireDrag;
    if (!drag) return;
    const comp = circuit.get(drag.comp);
    if (!comp) return;
    const pin = circuit.pinPos(comp, drag.dir, drag.port);
    const widths = portWidths(comp);
    const value = drag.dir === "out" ? comp.outs[drag.port] ?? 0 : circuit.inputValues(comp)[drag.port] ?? 0;
    const pw = drag.dir === "out" ? widths.out[drag.port] ?? 1 : widths.in[drag.port] ?? 1;
    const color = signalColor(value, pw);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(pin.x, pin.y);
    const midX = (pin.x + drag.to.x) / 2;
    if (this.style === "ortho") {
      ctx.lineTo(midX, pin.y);
      ctx.lineTo(midX, drag.to.y);
      ctx.lineTo(drag.to.x, drag.to.y);
    } else {
      ctx.bezierCurveTo(midX, pin.y, midX, drag.to.y, drag.to.x, drag.to.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(drag.to.x, drag.to.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  private drawPreview(ctx: CanvasRenderingContext2D, state: EditorState, zoom: number): void {
    const pv = state.preview;
    if (!pv) return;
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#c9f56f";
    for (const p of pv.pairs) {
      const midX = (p.a.x + p.b.x) / 2;
      ctx.beginPath();
      ctx.moveTo(p.a.x, p.a.y);
      ctx.lineTo(midX, p.a.y);
      ctx.lineTo(midX, p.b.y);
      ctx.lineTo(p.b.x, p.b.y);
      ctx.stroke();
    }
    ctx.restore();
    this.drawLabel(ctx, pv.label, pv.at.x, pv.at.y, zoom);
  }

  private drawGhost(ctx: CanvasRenderingContext2D, state: EditorState): void {
    if (!state.ghost) return;
    const temp: Comp = {
      id: "ghost",
      kind: state.ghost.kind,
      x: state.ghost.x,
      y: state.ghost.y,
      width: 1,
      value: 0,
      div: 1,
      addrWidth: 4,
      dataWidth: 8,
      data: [],
      format: "hex",
      label: "",
      outs: [0],
      prevClk: 0,
      clkCounter: 0,
    };
    const l = layoutOf(temp);
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.roundRect(state.ghost.x * CELL, state.ghost.y * CELL, l.cols * CELL, l.rows * CELL, 6);
    ctx.fillStyle = C.boxSel;
    ctx.fill();
    ctx.strokeStyle = C.borderSel;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
}
