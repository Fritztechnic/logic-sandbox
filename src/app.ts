import { Circuit, SerializedCircuit } from "./circuit";
import { Editor } from "./editor";
import { Renderer } from "./render";
import { KIND_GROUPS, KIND_INFO, PALETTE, portWidths } from "./logic";
import { Comp, DisplayFormat, GroupInstance, Tool, View, maskOf } from "./types";
import { EXAMPLES } from "./examples";
import { ensureCpuModules } from "./cpu";
import { ensureCpu32Modules, findCpu32ProgramRom, loadCpu32Program } from "./cpu32";
import { ASM32_REFERENCE, assemble32, Asm32Result, formatListing } from "./assembler32";
import { CPU32_DEFAULT_PROGRAM, CPU32_PROGRAMS } from "./cpu32-programs";
import { STD_CATALOG, ensureStdModules, stdModuleId } from "./stdlib";
import { compDocHtml, moduleDocHtml, pinDoc, shortDoc, shortModuleDoc } from "./docs";
import { WireStyle } from "./route";
import { FANOUT_MAX } from "./connect";
import { ExpandedFrame, computeExpandedLayout, savedExpandedLayout } from "./expand";
import { ASSEMBLY_REFERENCE, AsmResult, assemble } from "./assembler";
import {
  ModuleDef,
  addModule,
  buildModuleDef,
  clampBlockSize,
  createModuleFromSelection,
  editableCircuitForDef,
  editableCircuitForGroup,
  findModuleSpot,
  getModule,
  importModuleDefs,
  instantiateModule,
  listModules,
  loadModuleLibrary,
  moduleBlockDefaults,
  removeModule,
  replaceGroupInternals,
  replaceModuleInstances,
} from "./modules";
import * as store from "./persistence";
import { openMemView, updateMemView } from "./memview";

const SPEED_MIN = 1;
const SPEED_MAX = 1_000_000;
const SPEED_SLIDER_STEPS = 1000;

/** Logarithmische Kennlinie: der Regler deckt 1 Hz bis 1 MHz sinnvoll ab. */
function sliderToHz(value: number): number {
  const t = Math.max(0, Math.min(1, value / SPEED_SLIDER_STEPS));
  return Math.max(SPEED_MIN, Math.round(SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, t)));
}

function hzToSlider(hz: number): number {
  const t = Math.log(Math.max(SPEED_MIN, hz) / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
  return Math.round(t * SPEED_SLIDER_STEPS);
}

function formatHz(hz: number): string {
  const fmt = (n: number, digits: number) =>
    n.toLocaleString("de-DE", { maximumFractionDigits: digits });
  if (hz >= 1_000_000) return `${fmt(hz / 1_000_000, 2)} MHz`;
  if (hz >= 1_000) return `${fmt(hz / 1_000, 1)} kHz`;
  return `${fmt(hz, 0)} Hz`;
}

function fmtHex(value: number, width: number): string {
  const digits = Math.max(1, Math.ceil(width / 4));
  return "0x" + (value >>> 0).toString(16).toUpperCase().padStart(digits, "0");
}

function fmtBin(value: number, width: number): string {
  return (value >>> 0).toString(2).padStart(width, "0");
}

/** Pin-Wert je nach Breite: 1 Bit als 0/1, kurze Busse binär, breite Busse hex und dezimal. */
function fmtPin(value: number, width: number): string {
  const v = (value & maskOf(width)) >>> 0;
  if (width === 1) return String(v);
  if (width <= 4) return `${fmtBin(v, width)} (${v})`;
  if (width <= 8) return `${fmtHex(v, width)} · ${v} · ${fmtBin(v, width)}`;
  return `${fmtHex(v, width)} · ${v}`;
}

const ASM_KEY = "logic-sandbox-asm-v1";
const DEFAULT_ASM = `; Beispiel: 1 + 2 rechnen und ausgeben
start:
  LDA #1
  ADD #2
  OUT
  JMP start
`;

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export type TabKind = "circuit" | "expanded" | "code" | "module";

/** Ein geöffnetes Modul im eigenen Tab. */
interface ModuleSession {
  defId?: string;
  groupId?: string;
  name: string;
  version: number;
  cols: number;
  rows: number;
  /** Bearbeitete Kopie im Modul-Tab. */
  work: Circuit;
  baseline: string;
  tabId: string;
}

export interface ViewTab {
  id: string;
  kind: TabKind;
  title: string;
  /** Gemerkte Zoom-/Verschiebeposition der Ansicht. */
  view?: View;
}

const TAB_ICON: Record<TabKind, string> = {
  circuit: "◇",
  expanded: "⧉",
  code: "▤",
  module: "✎",
};

function tabTitle(kind: TabKind): string {
  if (kind === "expanded") return "Entpackt";
  if (kind === "code") return "Code";
  if (kind === "module") return "Modul";
  return "Gesamtansicht";
}

export class App {
  circuit = new Circuit();
  renderer: Renderer;
  editor: Editor;
  running = false;
  speedHz = 8;
  /** Entpackte, nur lesbare Gesamtansicht. */
  expandedView = false;
  /** Kabelführung: geschwungen oder rechtwinklig an Modulen vorbei. */
  wireStyle: WireStyle = "ortho";
  private expandedFrames: ExpandedFrame[] = [];

  private statusMsg = "Bereit.";
  private statusKind: "info" | "warn" | "err" = "info";
  private lastTime = 0;
  private acc = 0;
  private frame = 0;
  /** Zeichnen nur bei Änderungen oder laufender Simulation. */
  private needsDraw = true;
  private lastStatusLeft = "";
  private lastStatusRight = "";
  private lastZoomBadge = "";
  private lastEmptyVisible: boolean | null = null;
  private lastStatusDraw = 0;
  private measuredHz = 0;
  private measureStart = 0;
  private measureSteps = 0;

  private canvas: HTMLCanvasElement;
  /** Die Schaltung hinter allen Tabs – bleibt beim Modul-Bearbeiten unberührt. */
  private mainCircuit = this.circuit;
  /** Laufende Modul-Editoren, je Tab einer (beliebig viele gleichzeitig). */
  private sessions = new Map<string, ModuleSession>();
  /** Zuletzt benutzte Anordnung der entpackten Ansicht (bleibt beim Tabwechsel). */
  private expandedState: { positions: Map<string, { x: number; y: number }>; frames: ExpandedFrame[]; sig: string } | null = null;

  constructor() {
    this.canvas = document.getElementById("canvas") as HTMLCanvasElement;
    this.renderer = new Renderer(this.canvas);
    loadModuleLibrary();
    ensureCpuModules();
    ensureCpu32Modules();
    ensureStdModules();
    this.editor = new Editor(this.canvas, this.circuit, {
      structural: () => this.afterStructural(),
      moved: () => this.afterMoved(),
      valueChange: () => this.afterValue(),
      selectionChange: () => {
        this.refreshProps();
        this.invalidate();
      },
      invalidate: () => this.invalidate(),
      status: (msg, kind) => this.setStatus(msg, kind),
      openMemory: (compId) => this.openMemory(compId),
      placeModule: (moduleId, x, y) => this.placeModule(moduleId, x, y),
      openGroupModule: (groupId) => {
        const group = this.circuit.groups.get(groupId);
        if (group) this.openGroupModuleEditor(group);
      },
    });

    this.wireStyle = store.loadWireStyle() === "curved" ? "curved" : "ortho";
    this.editor.routeStyle = this.wireStyle;
    this.buildPalette();
    document.getElementById("props-body")!.addEventListener(
      "toggle",
      (e) => {
        const el = e.target as HTMLDetailsElement;
        if (el.matches?.("[data-doc]")) this.docOpen = el.open;
      },
      true
    );
    this.buildToolbar();
    this.updateRouteButton();
    this.buildModuleBar();
    this.buildCodePanel();
    this.buildTabs();
    this.bindKeys();
    window.addEventListener("resize", () => this.invalidate());

    if (store.loadLocal(this.circuit)) {
      this.setStatus("Letzte Schaltung geladen.");
      requestAnimationFrame(() => this.editor.centerContent());
    }
    this.circuit.rebuild();
    this.circuit.reset();
    this.syncAsmWidth();
    // Gemerkten Tab erst anwenden, wenn die Schaltung geladen ist.
    if (this.tabs.find((t) => t.id === this.activeTab)?.kind === "expanded") this.enterExpandedView();
    this.refreshProps();
    this.updateEmptyHint();

    requestAnimationFrame(this.loop);
  }

  // ---------- UI-Aufbau ----------

  private buildPalette(): void {
    const root = document.getElementById("palette")!;
    root.innerHTML = "";

    this.buildStdPalette(root);

    const modules = listModules().filter((m) => !m.builtin);
    if (modules.length > 0) {
      const g = document.createElement("div");
      g.className = "pal-group";
      const h = document.createElement("h4");
      h.textContent = "Eigene Module";
      g.appendChild(h);
      for (const def of modules) {
        const row = document.createElement("div");
        row.className = "pal-row";
        const btn = document.createElement("button");
        btn.className = "pal-item";
        btn.dataset.module = def.id;
        btn.title = `${def.name} · v${def.version ?? 1} · ${def.inputs.length} Ein · ${def.outputs.length} Aus${def.description ? `\n${shortModuleDoc(def)}` : ""}`;
        btn.innerHTML = `<span class="icon">◇</span><span>${esc(def.name)}<span class="sub">Modul · v${def.version ?? 1}</span></span>`;
        btn.addEventListener("click", () => this.setTool({ module: def.id }));
        const edit = document.createElement("button");
        edit.className = "pal-edit";
        edit.title = `Modul "${def.name}" bearbeiten`;
        edit.textContent = "✎";
        edit.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openModuleDefEditor(def);
        });
        const del = document.createElement("button");
        del.className = "pal-del";
        del.title = `Modul "${def.name}" aus der Bibliothek entfernen`;
        del.textContent = "×";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!confirm(`Modul "${def.name}" löschen? Bereits platzierte Instanzen bleiben erhalten.`)) return;
          removeModule(def.id);
          this.buildPalette();
          this.applyToolHighlight();
          this.setStatus(`Modul "${def.name}" entfernt.`);
        });
        row.appendChild(btn);
        row.appendChild(edit);
        row.appendChild(del);
        g.appendChild(row);
      }
      root.appendChild(g);
    }

    KIND_GROUPS.forEach((group, gi) => {
      const g = document.createElement("div");
      g.className = "pal-group";
      const h = document.createElement("h4");
      h.textContent = group;
      g.appendChild(h);
      PALETTE[gi].forEach((kind) => {
        const info = KIND_INFO[kind];
        const btn = document.createElement("button");
        btn.className = "pal-item";
        btn.dataset.kind = kind;
        btn.title = `${info.hint}\n${shortDoc(kind)}`;
        btn.innerHTML = `<span class="icon">${info.icon}</span><span>${info.label}<span class="sub">${info.hint}</span></span>`;
        btn.addEventListener("click", () => this.setTool({ place: kind }));
        g.appendChild(btn);
      });
      root.appendChild(g);
    });
    this.applyToolHighlight();
  }

  /** Gewählte Breite je Standardmodul und aufgeklappte Rubriken (bleiben beim Neuaufbau erhalten). */
  private stdBits = new Map<string, number>();
  private palOpen = new Set<string>();

  private buildStdPalette(root: HTMLElement): void {
    const categories = [...new Set(STD_CATALOG.map((e) => e.category))];
    for (const cat of categories) {
      const box = document.createElement("details");
      box.className = "pal-group pal-cat";
      box.open = this.palOpen.has(cat);
      box.addEventListener("toggle", () => {
        if (box.open) this.palOpen.add(cat);
        else this.palOpen.delete(cat);
      });
      const h = document.createElement("summary");
      h.textContent = cat;
      box.appendChild(h);
      for (const entry of STD_CATALOG.filter((e) => e.category === cat)) {
        const bitsList = entry.bits;
        const current = () =>
          bitsList ? this.stdBits.get(entry.name) ?? (bitsList.includes(8) ? 8 : bitsList[0]) : undefined;
        const row = document.createElement("div");
        row.className = "pal-row";
        const btn = document.createElement("button");
        btn.className = "pal-item";
        const label = entry.name === "decoder" ? "Dekoder" : entry.title;
        btn.innerHTML = `<span class="icon">◇</span><span>${esc(label)}<span class="sub">${esc(entry.description)}</span></span>`;
        const apply = () => {
          const n = current();
          btn.dataset.module = stdModuleId(entry.name, n);
          btn.title = `${entry.title}${n === undefined ? "" : ` (${entry.name === "decoder" ? "k" : "Datenbreite"} ${n})`}\n${entry.description}`;
        };
        apply();
        btn.addEventListener("click", () => this.setTool({ module: btn.dataset.module! }));
        row.appendChild(btn);
        if (bitsList && bitsList.length > 1) {
          const sel = document.createElement("select");
          sel.className = "pal-bits";
          sel.title = entry.name === "decoder" ? "Adressbreite k (Ausgänge 2^k)" : "Datenbreite in Bit";
          sel.innerHTML = bitsList.map((n) => `<option value="${n}" ${n === current() ? "selected" : ""}>${n}</option>`).join("");
          sel.addEventListener("change", () => {
            this.stdBits.set(entry.name, Number(sel.value));
            apply();
            const tool = this.editor.state.tool;
            if (typeof tool !== "string" && "module" in tool && tool.module.startsWith(`std-${entry.name}-`)) {
              this.setTool({ module: btn.dataset.module! });
            }
          });
          row.appendChild(sel);
        }
        const look = document.createElement("button");
        look.className = "pal-edit";
        look.title = "Innenleben ansehen";
        look.textContent = "✎";
        look.addEventListener("click", (e) => {
          e.stopPropagation();
          const def = getModule(btn.dataset.module!);
          if (def) this.openModuleDefEditor(def);
        });
        row.appendChild(look);
        box.appendChild(row);
      }
      root.appendChild(box);
    }
  }

  private applyToolHighlight(): void {
    const tool = this.editor.state.tool;
    document.querySelectorAll<HTMLElement>(".pal-item").forEach((el) => {
      const active =
        typeof tool !== "string" &&
        (("place" in tool && el.dataset.kind === tool.place) ||
          ("module" in tool && el.dataset.module === tool.module));
      el.classList.toggle("active", active);
    });
  }

  private buildToolbar(): void {
    document.getElementById("btn-run")!.addEventListener("click", () => this.toggleRun());
    document.getElementById("btn-step")!.addEventListener("click", () => this.stepOnce());
    document.getElementById("btn-reset")!.addEventListener("click", () => this.resetSim());
    document.getElementById("btn-expand")!.addEventListener("click", () => this.toggleExpandedView());
    document.getElementById("btn-route")!.addEventListener("click", () => this.toggleWireStyle());
    document.getElementById("btn-full")!.addEventListener("click", () => {
      if (this.activeTab !== this.circuitTabId()) this.activateTab(this.circuitTabId());
      this.editor.centerContent();
      const session = this.activeSession();
      this.setStatus(
        session
          ? `Gesamtansicht: „${session.name}“ eingepasst.`
          : "Gesamtansicht: ganze Schaltung eingepasst – Module bleiben kompakt."
      );
    });

    const speed = document.getElementById("speed") as HTMLInputElement;
    speed.value = String(hzToSlider(this.speedHz));
    speed.addEventListener("input", () => {
      this.speedHz = sliderToHz(Number(speed.value));
      this.acc = 0;
      this.measuredHz = 0;
      this.measureStart = 0;
      this.measureSteps = 0;
      this.updateSpeedLabel();
      this.updateStatus();
    });
    this.updateSpeedLabel();

    const examples = document.getElementById("examples") as HTMLSelectElement;
    EXAMPLES.forEach((ex) => {
      const opt = document.createElement("option");
      opt.value = ex.name;
      opt.textContent = ex.name;
      examples.appendChild(opt);
    });
    examples.addEventListener("change", () => {
      const ex = EXAMPLES.find((e) => e.name === examples.value);
      if (!ex) return;
      this.loadExample(ex.build);
      examples.value = "";
    });

    document.getElementById("btn-export")!.addEventListener("click", () =>
      store.downloadCircuit(this.circuit, listModules())
    );
    document.getElementById("btn-clear")!.addEventListener("click", () => {
      if (this.sessions.size > 0) {
        this.setStatus("Erst offene Modul-Tabs schließen (Abbrechen oder Speichern).", "warn");
        return;
      }
      if (!confirm("Wirklich alles löschen?")) return;
      this.exitExpandedView();
      this.circuit.clear();
      store.clearLocal();
      this.editor.select(null);
      this.editor.view = { panX: 80, panY: 60, zoom: 1 };
      this.afterStructural();
      this.setStatus("Schaltung geleert.");
    });

    const file = document.getElementById("import-file") as HTMLInputElement;
    document.getElementById("btn-import")!.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      if (this.sessions.size > 0) {
        file.value = "";
        this.setStatus("Erst offene Modul-Tabs schließen (Abbrechen oder Speichern).", "warn");
        return;
      }
      const text = await f.text();
      const data = store.parseCircuit(text);
      file.value = "";
      if (!data) {
        this.setStatus("Import fehlgeschlagen: ungültige Datei.", "err");
        return;
      }
      this.exitExpandedView();
      const imported = importModuleDefs(data.modules);
      this.circuit.load(data);
      this.editor.select(null);
      this.editor.centerContent();
      this.buildPalette();
      this.afterStructural();
      this.setStatus(
        imported > 0
          ? `Schaltung und ${imported} Modul(e) importiert.`
          : "Schaltung importiert."
      );
    });
  }

  private bindKeys(): void {
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) {
        if (e.key === "Escape") t.blur();
        return;
      }

      if (this.expandedView) {
        if (e.key === "Escape") {
          e.preventDefault();
          this.activateTab(this.circuitTabId());
          return;
        }
        // In der entpackten Ansicht: takten, auswählen und verschieben.
        const arrows: Record<string, [number, number]> = {
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
        };
        if (e.key in arrows) {
          e.preventDefault();
          const step = e.shiftKey ? 5 : 1;
          this.editor.nudgeSelection(arrows[e.key][0] * step, arrows[e.key][1] * step);
          return;
        }
        if (![" ", "s", "S", "r", "R"].includes(e.key)) {
          e.preventDefault();
          return;
        }
      }

      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "c") {
          e.preventDefault();
          if (this.editor.copySelection()) {
            this.setStatus(`${this.editor.state.selected.length} Objekte kopiert.`);
          }
        } else if (k === "x") {
          e.preventDefault();
          if (this.editor.cutSelection()) this.setStatus("Ausgeschnitten.");
        } else if (k === "v") {
          e.preventDefault();
          if (!this.editor.hasClipboard()) {
            this.setStatus("Zwischenablage ist leer.", "warn");
          } else {
            this.editor.pasteClipboard();
          }
        } else if (k === "d") {
          e.preventDefault();
          if (this.editor.state.selected.length > 0) this.editor.duplicateSelection();
        }
        return;
      }

      const arrowStep: Record<string, [number, number]> = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      };
      if (e.key in arrowStep) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 1;
        if (this.editor.selectedCompIds().length > 0 || this.editor.state.selected.length > 0) {
          this.editor.nudgeSelection(arrowStep[e.key][0] * step, arrowStep[e.key][1] * step);
        }
        return;
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          this.toggleRun();
          break;
        case "s":
        case "S":
          this.stepOnce();
          break;
        case "r":
        case "R":
          this.resetSim();
          break;
        case "m":
        case "M":
          if (!this.expandedView) this.editor.startBulkConnect();
          break;
        case "v":
        case "V":
        case "Escape":
          this.editor.state.wireDrag = null;
          this.setTool("select");
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          if (!this.expandedView) this.editor.deleteSelection();
          break;
      }
    });
  }

  // ---------- Aktionen ----------

  setTool(tool: Tool): void {
    if (this.expandedView && tool !== "select") {
      this.setStatus("In der entpackten Ansicht lassen sich nur auswählen und verschieben – Platzieren zurück in der Gesamtansicht.", "warn");
      return;
    }
    this.editor.setTool(tool);
    this.applyToolHighlight();
    if (typeof tool !== "string") {
      if ("place" in tool) {
        this.setStatus(`${KIND_INFO[tool.place].label}: auf die Fläche klicken zum Platzieren.`);
      } else {
        const def = getModule(tool.module);
        this.setStatus(def ? `${def.name}: auf die Fläche klicken zum Platzieren.` : "Modul nicht gefunden.", def ? "info" : "err");
      }
    } else {
      this.setStatus("Auswahl-Werkzeug.");
    }
  }

  private placeModule(moduleId: string, x: number, y: number): GroupInstance | null {
    const def = getModule(moduleId);
    if (!def) {
      this.setStatus("Modul nicht gefunden.", "err");
      return null;
    }
    const spot = findModuleSpot(this.circuit, def, x, y);
    if (!spot) {
      this.setStatus("Kein freier Platz für dieses Modul.", "warn");
      return null;
    }
    const group = instantiateModule(this.circuit, def, spot.x, spot.y);
    this.afterStructural();
    this.setStatus(`Modul "${def.name}" platziert – Pins per Kabel verbinden.`);
    return group;
  }

  toggleRun(): void {
    this.running = !this.running;
    this.acc = 0;
    this.measuredHz = 0;
    this.measureStart = 0;
    this.measureSteps = 0;
    const btn = document.getElementById("btn-run")!;
    btn.textContent = this.running ? "Pause" : "Start";
    btn.classList.toggle("primary", !this.running);
    this.setStatus(this.running ? "Simulation läuft." : "Simulation pausiert.");
    this.updateStatus();
  }

  stepOnce(): void {
    this.circuit.step();
    this.afterValue();
  }

  resetSim(): void {
    this.circuit.reset();
    this.afterValue();
    this.setStatus("Zustand zurückgesetzt (Register/Takte = 0).");
  }

  loadExample(build: (c: Circuit) => void): void {
    if (this.sessions.size > 0) {
      this.setStatus("Erst offene Modul-Tabs schließen (Abbrechen oder Speichern).", "warn");
      return;
    }
    this.exitExpandedView();
    this.circuit.clear();
    build(this.circuit);
    this.circuit.rebuild();
    this.circuit.reset();
    this.editor.select(null);
    // Beispiele können Module mitbringen (z. B. die CPU-Bausteine).
    this.buildPalette();
    this.editor.centerContent();
    this.afterStructural();
    this.setStatus("Beispiel geladen.");
  }

  // ---------- Assembler ----------

  private lastAsm: AsmResult | null = null;
  /** Operandbreite, mit der zuletzt übersetzt wurde (8, 16 oder 32 Bit). */
  private asmBits = 8;
  /** RISC-32-CPU (32-Bit-Befehlswort im ROM „PROGRAMM“) erkannt? */
  private asm32 = false;
  private lastAsm32: Asm32Result | null = null;

  private buildCodePanel(): void {
    const input = document.getElementById("code-input") as HTMLTextAreaElement;
    let stored = "";
    try {
      stored = localStorage.getItem(ASM_KEY) ?? "";
    } catch {
      stored = "";
    }
    input.value = stored || DEFAULT_ASM;
    this.asm32 = !!findCpu32ProgramRom(this.mainCircuit);
    if (this.asm32) input.value = this.loadAsmText();
    this.buildProgramSelect();
    input.addEventListener("input", () => {
      try {
        localStorage.setItem(this.asmKey(), input.value);
      } catch {
        /* egal */
      }
      this.compileAsm();
    });

    document.getElementById("btn-code")!.addEventListener("click", () => this.toggleCodeTab());
    document.getElementById("btn-code-close")!.addEventListener("click", () => {
      const tab = this.tabs.find((t) => t.kind === "code");
      if (tab) this.closeTab(tab.id);
    });
    document.getElementById("btn-code-copy")!.addEventListener("click", () => void this.copyAsm());
    document.getElementById("btn-code-rom")!.addEventListener("click", () => this.asmIntoRom());

    this.renderAsmReference();
    this.compileAsm();
  }

  private asmKey(): string {
    return this.asm32 ? ASM_KEY + "-risc32" : ASM_KEY;
  }

  private loadAsmText(): string {
    try {
      return localStorage.getItem(this.asmKey()) || (this.asm32 ? CPU32_DEFAULT_PROGRAM : DEFAULT_ASM);
    } catch {
      return this.asm32 ? CPU32_DEFAULT_PROGRAM : DEFAULT_ASM;
    }
  }

  private renderAsmReference(): void {
    const list = this.asm32 ? ASM32_REFERENCE : ASSEMBLY_REFERENCE;
    document.getElementById("code-reference")!.innerHTML = list
      .map((r) => `<div class="code-ref-row"><code>${esc(r.code)}</code><span>${esc(r.text)}</span></div>`)
      .join("");
    const sub = document.querySelector("#code-panel .code-sub");
    if (sub) {
      sub.textContent = this.asm32
        ? "RISC-32 · 32-Bit-Befehlswörter · 16 Register · Labels, .org / .word / .equ"
        : "8-Bit-Befehle · 16-Bit-Wörter · Labels und .org / .word";
    }
    const sel = document.getElementById("code-program") as HTMLSelectElement | null;
    if (sel) sel.hidden = !this.asm32;
  }

  /** Beispielprogramme der RISC-32-CPU (nur sichtbar, wenn diese CPU geladen ist). */
  private buildProgramSelect(): void {
    const actions = document.querySelector("#code-panel .code-actions");
    if (!actions || document.getElementById("code-program")) return;
    const sel = document.createElement("select");
    sel.id = "code-program";
    sel.className = "btn";
    sel.title = "Beispielprogramm laden";
    sel.innerHTML =
      `<option value="">Beispielprogramm …</option>` +
      CPU32_PROGRAMS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
    sel.hidden = !this.asm32;
    sel.addEventListener("change", () => {
      const p = CPU32_PROGRAMS[Number(sel.value)];
      sel.value = "";
      if (!p) return;
      const input = document.getElementById("code-input") as HTMLTextAreaElement;
      input.value = p.source;
      input.dispatchEvent(new Event("input"));
    });
    actions.insertBefore(sel, actions.firstChild);
  }

  /** Öffnet bzw. schließt das Code-Fenster über einen eigenen Tab. */
  private toggleCodeTab(): void {
    const active = this.tabs.find((t) => t.id === this.activeTab);
    if (active?.kind === "code") {
      this.activateTab(this.circuitTabId());
      return;
    }
    const existing = this.tabs.find((t) => t.kind === "code");
    if (existing) this.activateTab(existing.id);
    else this.addTab("code");
  }

  /** Operandbreite der aktuellen CPU: getrenntes Operand-ROM, sonst 8 Bit. */
  private asmOperandBits(): number {
    for (const comp of this.mainCircuit.comps.values()) {
      if (comp.kind === "rom" && /operand/i.test(comp.label) && comp.dataWidth > 8) {
        return comp.dataWidth;
      }
    }
    return 8;
  }

  /** Übernimmt eine geänderte CPU-Breite in die Assembler-Ausgabe. */
  private syncAsmWidth(): void {
    const risc = !!findCpu32ProgramRom(this.mainCircuit);
    if (risc !== this.asm32) {
      const input = document.getElementById("code-input") as HTMLTextAreaElement;
      try {
        localStorage.setItem(this.asmKey(), input.value);
      } catch {
        /* egal */
      }
      this.asm32 = risc;
      input.value = this.loadAsmText();
      this.renderAsmReference();
      this.compileAsm();
      return;
    }
    const bits = this.asmOperandBits();
    if (bits !== this.asmBits) {
      this.asmBits = bits;
      this.compileAsm();
    }
  }

  private compileAsm(): void {
    const input = document.getElementById("code-input") as HTMLTextAreaElement;
    const out = document.getElementById("code-output")!;
    if (this.asm32) {
      const r32 = assemble32(input.value);
      this.lastAsm32 = r32;
      out.className = r32.errors.length ? "code-output errors" : "code-output";
      out.textContent = r32.errors.length
        ? r32.errors.map((e) => (e.line ? `Zeile ${e.line}: ${e.message}` : e.message)).join("\n")
        : `${r32.words.length} Wörter · ${r32.instructionCount} Befehle · 32 Bit\n\n${formatListing(r32)}`;
      return;
    }
    const result = assemble(input.value, this.asmBits);
    this.lastAsm = result;
    if (result.errors.length > 0) {
      out.className = "code-output errors";
      out.textContent = result.errors
        .map((e) => (e.line ? `Zeile ${e.line}: ${e.message}` : e.message))
        .join("\n");
      return;
    }
    out.className = "code-output";
    if (this.asmBits > 8) {
      // Breite CPU: Opcode und Operand liegen in getrennten ROMs.
      const digits = Math.ceil(this.asmBits / 4);
      const rows = result.opcodes.map(
        (op, i) =>
          `${i.toString(16).toUpperCase().padStart(2, "0")}: ${op.toString(16).toUpperCase().padStart(2, "0")} ` +
          `${(result.operands[i] ?? 0).toString(16).toUpperCase().padStart(digits, "0")}`
      );
      out.textContent = `${result.words.length} Wörter · ${result.instructionCount} Befehle · Opcode 8b / Operand ${this.asmBits}b\n\n${rows.join("\n")}`;
      return;
    }
    const rows = result.words.map(
      (w, i) => `${i.toString(16).toUpperCase().padStart(2, "0")}: ${w.toString(16).toUpperCase().padStart(4, "0")}`
    );
    out.textContent = `${result.words.length} Wörter · ${result.instructionCount} Befehle\n\n${rows.join("\n")}`;
  }

  private asmHex(): string {
    if (this.asm32) {
      return (this.lastAsm32?.words ?? []).map((w) => (w >>> 0).toString(16).toUpperCase().padStart(8, "0")).join(" ");
    }
    const asm = this.lastAsm;
    if (!asm) return "";
    if (this.asmBits > 8) {
      const digits = Math.ceil(this.asmBits / 4);
      return asm.opcodes
        .map((op, i) =>
          `${op.toString(16).toUpperCase().padStart(2, "0")}${(asm.operands[i] ?? 0)
            .toString(16)
            .toUpperCase()
            .padStart(digits, "0")}`
        )
        .join(" ");
    }
    return asm.words.map((w) => w.toString(16).toUpperCase().padStart(4, "0")).join(" ");
  }

  private async copyAsm(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.asmHex());
      this.setStatus("Hex-Code in die Zwischenablage kopiert.");
    } catch {
      this.setStatus("Kopieren nicht möglich – bitte Hex aus der Ausgabe markieren.", "warn");
    }
  }

  private asmIntoRom(): void {
    if (this.asm32) {
      const rom = findCpu32ProgramRom(this.circuit);
      const r32 = this.lastAsm32;
      if (!rom || !r32) {
        this.setStatus("Programm-ROM der RISC-32-CPU nicht gefunden.", "warn");
        return;
      }
      if (r32.errors.length > 0) {
        this.compileAsm();
        this.setStatus("Assembler-Fehler – Programm nicht geladen.", "err");
        return;
      }
      loadCpu32Program(this.circuit, rom, r32.words);
      this.afterStructural();
      this.setStatus(`${r32.words.length} Wörter geladen · CPU zurückgesetzt.`);
      return;
    }
    const sel = this.editor.state.selection;
    const roms = [...this.circuit.comps.values()].filter((c) => c.kind === "rom");
    let rom = sel?.type === "comp" ? this.circuit.get(sel.id) : undefined;
    if (!rom || rom.kind !== "rom" || /operand/i.test(rom.label)) {
      // Bei mehreren ROMs (z. B. Mini-CPU) das Programm-ROM bevorzugen.
      rom =
        roms.find((r) => /programm|prog|code/i.test(r.label)) ??
        roms.find((r) => r.dataWidth === 16) ??
        roms[0];
    }
    if (!rom) {
      this.setStatus("Kein ROM in der Schaltung – bitte erst ein ROM platzieren.", "warn");
      return;
    }
    // CPUs mit getrenntem Operand-ROM (16/32 Bit) bekommen Opcode und Operand
    // in zwei Speicher; das klassische 8-Bit-Wort liegt weiter in einem ROM.
    const operandRom = roms.find((r) => r !== rom && /operand/i.test(r.label) && r.dataWidth > 8);
    const wide = rom.dataWidth === 8 && !!operandRom;
    const bits = wide && operandRom ? operandRom.dataWidth : this.asmBits;
    const input = document.getElementById("code-input") as HTMLTextAreaElement;
    const result = assemble(input.value, bits);
    this.lastAsm = result;
    if (result.errors.length > 0) {
      this.compileAsm();
      this.setStatus("Assembler-Fehler – Programm nicht geladen.", "err");
      return;
    }
    const words = result.words;
    if (words.length === 0) {
      this.setStatus("Assembler-Ausgabe ist leer.", "warn");
      return;
    }
    if (words.length > 256) {
      this.setStatus("Programm passt nicht in ein ROM (maximal 256 Wörter).", "err");
      return;
    }
    const needed = Math.max(2, Math.ceil(Math.log2(Math.max(2, words.length))));
    // ROMs nicht verkleinern: die CPU adressiert weiterhin den vollen Bereich.
    rom.addrWidth = Math.max(rom.addrWidth, needed);
    rom.data = new Array(1 << rom.addrWidth).fill(0);
    if (wide && operandRom) {
      rom.dataWidth = 8;
      result.opcodes.forEach((v, i) => {
        if (i < rom!.data.length) rom!.data[i] = v & 0xff;
      });
      operandRom.addrWidth = rom.addrWidth;
      operandRom.data = new Array(1 << operandRom.addrWidth).fill(0);
      result.operands.forEach((v, i) => {
        if (i < operandRom!.data.length) operandRom!.data[i] = v & maskOf(bits);
      });
      this.circuit.rebuild();
      this.circuit.reset();
      this.afterStructural();
      this.setStatus(
        `${words.length} Wörter geladen · Programm 8b, Operand ${bits}b · CPU zurückgesetzt.`
      );
      return;
    }
    rom.dataWidth = 16;
    words.forEach((w, i) => {
      if (i < rom!.data.length) rom!.data[i] = w & 0xffff;
    });
    this.circuit.rebuild();
    this.circuit.reset();
    this.afterStructural();
    this.setStatus(
      `${words.length} Wörter in „${rom.label || "ROM"}“ geladen · CPU zurückgesetzt (${rom.addrWidth}b Adresse, 16b Daten).`
    );
  }

  // ---------- Nebeneffekte ----------

  private invalidate(): void {
    this.needsDraw = true;
  }

  private afterStructural(): void {
    this.invalidate();
    this.circuit.rebuild();
    // Neue CPU geladen? Dann Assembler-Ausgabe auf die Operandbreite bringen.
    this.syncAsmWidth();
    // Einstellungen in der entpackten Ansicht können die Anordnung verschieben.
    if (this.expandedView) this.refreshExpandedLayout();
    // Im Modul-Editor wird nur die Kopie bearbeitet – nicht die Hauptschaltung speichern.
    if (!this.editingActive()) store.saveLocal(this.circuit);
    this.refreshProps();
    this.updateEmptyHint();
    this.updateStatus();
  }

  /** Rechnet die entpackte Ansicht nach Änderungen neu, ohne neu zu zentrieren. */
  private refreshExpandedLayout(): void {
    const cw = Math.max(320, this.canvas.clientWidth - 60);
    const ch = Math.max(240, this.canvas.clientHeight - 60);
    const layout = computeExpandedLayout(this.circuit, cw / ch);
    if (layout.frames.length === 0) return;
    this.circuit.setExpandedLayout(
      layout.positions,
      layout.frames.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, groupId: f.group.id }))
    );
    this.expandedFrames = layout.frames;
    this.editor.setFrames(layout.frames);
    this.expandedState = {
      positions: layout.positions,
      frames: layout.frames,
      sig: `${this.circuit.structureVersion}:${this.circuit.comps.size}:${this.circuit.groups.size}:${Math.round(cw)}x${Math.round(ch)}`,
    };
    this.needsDraw = true;
  }

  /** Nur verschoben: in der entpackten Ansicht bleibt die eigene Anordnung stehen. */
  private afterMoved(): void {
    this.invalidate();
    if (!this.expandedView) this.circuit.rebuild();
    // Auch die Anordnung der entpackten Ansicht dauerhaft sichern.
    if (!this.editingActive()) store.saveLocal(this.circuit);
    this.refreshProps();
    this.updateEmptyHint();
    this.updateStatus();
  }

  private afterValue(): void {
    this.invalidate();
    if (!this.editingActive()) store.saveLocal(this.circuit);
    this.updateEmptyHint();
    this.updateStatus();
  }

  private setStatus(msg: string, kind: "info" | "warn" | "err" = "info"): void {
    this.statusMsg = msg;
    this.statusKind = kind;
    this.updateStatus();
  }

  private updateSpeedLabel(): void {
    const label = document.getElementById("speed-label");
    if (label) label.textContent = formatHz(this.speedHz);
    const speed = document.getElementById("speed") as HTMLInputElement | null;
    if (speed) speed.title = formatHz(this.speedHz);
  }

  private updateStatus(): void {
    const left = document.getElementById("status-left")!;
    if (this.lastStatusLeft !== this.statusMsg) {
      this.lastStatusLeft = this.statusMsg;
      left.textContent = this.statusMsg;
    }
    left.className = this.statusKind === "info" ? "" : this.statusKind;

    const right = document.getElementById("status-right")!;
    const parts = [
      this.running ? "läuft" : "pausiert",
      `Takt ${formatHz(this.speedHz)}`,
      `Schritt ${this.circuit.stepCount.toLocaleString("de-DE")}`,
      `${this.circuit.comps.size} Bauteile`,
      `${this.circuit.wires.length} Kabel`,
    ];
    const session = this.activeSession();
    if (session) parts.push(`Editor: ${session.name} v${session.version}`);
    if (this.expandedView) parts.push("entpackt");
    if (this.running && this.measuredHz > 0 && this.measuredHz < this.speedHz * 0.9) {
      parts.splice(2, 0, `eff. ${formatHz(this.measuredHz)}`);
    }
    let warn = "";
    if (this.circuit.loopComps.size > 0) warn += ` ⚠ Schleife (${this.circuit.loopComps.size})`;
    if (this.circuit.invalidWires.size > 0) warn += ` ⚠ Breite (${this.circuit.invalidWires.size})`;
    const rightText = parts.join(" · ") + warn;
    if (this.lastStatusRight !== rightText) {
      this.lastStatusRight = rightText;
      right.textContent = rightText;
    }
    right.className = this.circuit.loopComps.size || this.circuit.invalidWires.size ? "warn" : "";
  }

  // ---------- Entpackte Gesamtansicht (nur Ansehen) ----------

  /** Schaltet zwischen geschwungenen und rechtwinkligen Kabelwegen um. */
  toggleWireStyle(): void {
    this.wireStyle = this.wireStyle === "curved" ? "ortho" : "curved";
    this.editor.routeStyle = this.wireStyle;
    store.saveWireStyle(this.wireStyle);
    this.updateRouteButton();
    this.invalidate();
    this.setStatus(
      this.wireStyle === "ortho"
        ? "Leiterbahnen: rechtwinklig, weichen Modulen aus (nochmal klicken für Kurven)."
        : "Leiterbahnen: geschwungene Kurven."
    );
  }

  private updateRouteButton(): void {
    const btn = document.getElementById("btn-route");
    if (!btn) return;
    btn.textContent = this.wireStyle === "ortho" ? "Bahn: Ortho" : "Bahn: Kurven";
    btn.classList.toggle("active", this.wireStyle === "ortho");
  }

  private toggleExpandedView(): void {
    if (this.editingActive()) {
      this.setStatus("Im Modul-Editor ist die entpackte Ansicht nicht verfügbar.", "warn");
      return;
    }
    if (this.expandedView) {
      this.activateTab(this.circuitTabId());
      return;
    }
    const existing = this.tabs.find((t) => t.kind === "expanded");
    if (existing) this.activateTab(existing.id);
    else this.addTab("expanded");
  }

  /** Öffnet die entpackte Ansicht (Positionen frei verschiebbar). */
  private enterExpandedView(): boolean {
    const cw = Math.max(320, this.canvas.clientWidth - 60);
    const ch = Math.max(240, this.canvas.clientHeight - 60);
    const sig = `${this.circuit.structureVersion}:${this.circuit.comps.size}:${this.circuit.groups.size}:${Math.round(cw)}x${Math.round(ch)}`;
    let positions: Map<string, { x: number; y: number }>;
    let frames: ExpandedFrame[];
    if (this.expandedState && this.expandedState.sig === sig) {
      // Gemerkte Anordnung übernehmen – so bleiben eigene Verschiebungen erhalten.
      positions = this.expandedState.positions;
      frames = this.expandedState.frames;
    } else {
      // Zuerst die dauerhaft gesicherte Anordnung aus der Schaltung versuchen.
      const saved = savedExpandedLayout(this.circuit);
      if (saved) {
        positions = saved.positions;
        frames = saved.frames;
        this.expandedState = { positions, frames, sig };
      } else {
        const layout = computeExpandedLayout(this.circuit, cw / ch);
        if (layout.frames.length === 0) {
          this.setStatus("Keine Module zum Entpacken vorhanden.", "warn");
          return false;
        }
        positions = layout.positions;
        frames = layout.frames;
        this.expandedState = { positions, frames, sig };
      }
    }
    this.editor.setTool("select");
    this.circuit.setExpandedLayout(
      positions,
      frames.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, groupId: f.group.id }))
    );
    this.expandedFrames = frames;
    this.editor.setFrames(frames);
    this.expandedView = true;
    this.editor.readOnly = true;
    this.editor.select(null);
    document.body.classList.add("expanded-view");
    document.getElementById("btn-expand")?.classList.add("active");
    this.editor.centerContent();
    this.needsDraw = true;
    this.setStatus(
      `Entpackte Ansicht: ${frames.length} Module – Module und Bauteile lassen sich verschieben (auch mehrfach, Pfeiltasten); die Anordnung wird gesichert.`
    );
    this.updateStatus();
    return true;
  }

  /** Verlässt die entpackte Ansicht; ggf. wechselt der aktive Tab zur Schaltung. */
  private exitExpandedView(center = true): void {
    if (!this.expandedView) return;
    if (center && this.tabs.find((t) => t.id === this.activeTab)?.kind === "expanded") {
      this.activeTab = this.circuitTabId();
      this.persistTabs();
      this.renderTabs();
    }
    this.expandedView = false;
    this.expandedFrames = [];
    this.circuit.setExpandedLayout(null);
    this.editor.setFrames([]);
    this.editor.readOnly = false;
    document.body.classList.remove("expanded-view");
    document.getElementById("btn-expand")?.classList.remove("active");
    if (center) this.editor.centerContent();
    this.needsDraw = true;
    this.updateStatus();
  }

  // ---------- Tabs (wie im Browser) ----------

  private tabs: ViewTab[] = [];
  private activeTab = "";
  private tabSeq = 0;

  private buildTabs(): void {
    const add = document.getElementById("tab-add")!;
    const menu = document.getElementById("tab-menu")!;
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    menu.querySelectorAll<HTMLElement>("[data-kind]").forEach((btn) => {
      btn.addEventListener("click", () => {
        menu.hidden = true;
        this.addTab(btn.dataset.kind as TabKind);
      });
    });
    document.addEventListener("click", () => {
      menu.hidden = true;
    });

    const saved = store.loadTabs();
    if (saved && saved.tabs.length > 0) {
      this.tabs = saved.tabs.slice(0, 12).map((t) => ({
        id: `tab${this.tabSeq++}`,
        kind: (["circuit", "expanded", "code"] as TabKind[]).includes(t.kind as TabKind)
          ? (t.kind as TabKind)
          : "circuit",
        title: typeof t.title === "string" && t.title.trim() ? t.title : tabTitle(t.kind as TabKind),
      }));
      const idx = Math.min(Math.max(0, saved.active), this.tabs.length - 1);
      this.activeTab = this.tabs[idx].id;
      const tab = this.tabs[idx];
      // Die Ansicht selbst wird nach dem Laden der Schaltung gesetzt.
      if (tab.kind === "code") this.applyCodeTab(true);
    }
    if (this.tabs.length === 0) {
      this.tabs = (["circuit", "expanded", "code"] as TabKind[]).map((kind) => ({
        id: `tab${this.tabSeq++}`,
        kind,
        title: tabTitle(kind),
      }));
      this.activeTab = this.tabs[0].id;
    }
    if (!this.activeTab) this.activeTab = this.tabs[0].id;
    this.renderTabs();
  }

  private applyCodeTab(open: boolean): void {
    document.body.classList.toggle("code-max", open);
    const panel = document.getElementById("code-panel")!;
    panel.hidden = !open;
    document.getElementById("btn-code")!.classList.toggle("active", open);
    if (open) this.compileAsm();
  }

  private renderTabs(): void {
    const list = document.getElementById("tab-list")!;
    list.innerHTML = "";
    for (const tab of this.tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (tab.id === this.activeTab ? " active" : "");
      el.dataset.tab = tab.id;
      el.title = `${tab.title} · ziehen zum Umsortieren`;
      el.innerHTML = `<span class="tab-kind">${TAB_ICON[tab.kind]}</span><span class="tab-title">${esc(tab.title)}</span>`;
      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "Tab schließen";
      close.addEventListener("mousedown", (e) => e.stopPropagation());
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(tab.id);
      });
      el.appendChild(close);
      el.addEventListener("mousedown", (e) => this.startTabDrag(e, tab.id));
      list.appendChild(el);
    }
    document.getElementById("btn-route")?.classList.toggle("active", this.wireStyle === "ortho");
  }

  /** Liefert den Tab der Gesamtansicht und legt ihn bei Bedarf neu an. */
  private circuitTabId(): string {
    const existing = this.tabs.find((t) => t.kind === "circuit");
    if (existing) return existing.id;
    this.addTab("circuit");
    return this.activeTab;
  }

  private addTab(kind: TabKind): string {
    const count = this.tabs.filter((t) => t.kind === kind).length;
    const tab: ViewTab = {
      id: `tab${this.tabSeq++}`,
      kind,
      title: count === 0 ? tabTitle(kind) : `${tabTitle(kind)} ${count + 1}`,
    };
    this.tabs.push(tab);
    this.activateTab(tab.id);
    return tab.id;
  }

  private closeTab(id: string): void {
    if (this.tabs.length <= 1) {
      this.setStatus("Der letzte Tab bleibt offen.", "warn");
      return;
    }
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    if (this.tabs[index].kind === "module") {
      const session = this.sessions.get(id);
      if (!session) return;
      if (this.moduleEditorChanged(session) && !confirm("Änderungen am Modul verwerfen?")) return;
      this.exitModuleEditor(id, null);
      return;
    }
    const [tab] = this.tabs.splice(index, 1);
    if (tab.kind === "expanded" && this.expandedView) this.exitExpandedView(false);
    if (this.activeTab === id) {
      // Beim Bearbeiten eines Moduls darf der nächste Tab nicht „entpackt“ sein.
      const candidates = this.tabs.filter((t) => !(this.editingActive() && t.kind === "expanded"));
      const next = candidates[Math.min(index, candidates.length - 1)] ?? this.tabs[0];
      this.activeTab = "";
      this.activateTab(next.id);
      this.setStatus(`Tab „${tab.title}“ geschlossen.`);
    } else {
      this.persistTabs();
      this.renderTabs();
      this.setStatus(`Tab „${tab.title}“ geschlossen.`);
    }
  }

  private startTabDrag(e: MouseEvent, id: string): void {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const onMove = (ev: MouseEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) < 6 && Math.abs(ev.clientY - startY) < 6) return;
      dragging = true;
      this.moveTab(id, ev.clientX);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (dragging) {
        this.persistTabs();
        this.renderTabs();
        const moved = this.tabs.find((t) => t.id === id);
        if (moved) this.setStatus(`Tab „${moved.title}“ verschoben.`);
      } else {
        this.activateTab(id);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** Sortiert den gezogenen Tab an der Mausposition ein. */
  private moveTab(id: string, clientX: number): void {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const tab = this.tabs[from];
    const others = this.tabs.filter((t) => t.id !== id);
    let insert = others.length;
    for (let i = 0; i < others.length; i++) {
      const rect = document
        .querySelector<HTMLElement>(`.tab[data-tab="${others[i].id}"]`)
        ?.getBoundingClientRect();
      if (rect && clientX < rect.left + rect.width / 2) {
        insert = i;
        break;
      }
    }
    const next = [...others.slice(0, insert), tab, ...others.slice(insert)];
    if (next.map((t) => t.id).join() === this.tabs.map((t) => t.id).join()) return;
    this.tabs = next;
    this.renderTabs();
    document.querySelector<HTMLElement>(`.tab[data-tab="${id}"]`)?.classList.add("dragging");
  }

  /** Wechselt auf einen Tab und stellt die zugehörige Ansicht her. */
  private activateTab(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === "module" && !this.sessions.has(tab.id)) {
      this.setStatus("Dieser Modul-Tab gehört nicht mehr zur aktuellen Sitzung.", "warn");
      return;
    }
    const prev = this.tabs.find((t) => t.id === this.activeTab);
    if (prev && prev.kind !== "expanded") prev.view = { ...this.editor.view };
    // Vor dem Umschalten setzen: Modulleiste und Status hängen am aktiven Tab.
    this.activeTab = id;

    if (tab.kind !== "expanded" && this.expandedView) this.exitExpandedView(false);
    this.applyCodeTab(tab.kind === "code");

    // Jeder Modul-Tab hält seine eigene Bearbeitungskopie; die Gesamtansicht
    // arbeitet währenddessen unverändert weiter.
    const session = this.sessions.get(tab.id);
    if (session) {
      if (this.circuit !== session.work) {
        this.circuit = session.work;
        this.editor.setCircuit(this.circuit);
        this.editor.setFrames([]);
        this.editor.readOnly = false;
        this.updateModuleBar();
        this.buildPalette();
        this.refreshProps();
      }
    } else if (this.circuit !== this.mainCircuit) {
      this.circuit = this.mainCircuit;
      this.editor.setCircuit(this.circuit);
      this.editor.setFrames([]);
      this.editor.readOnly = false;
      this.updateModuleBar();
      this.buildPalette();
      this.refreshProps();
    }

    if (tab.kind === "expanded") {
      this.activeTab = id;
      if (!this.enterExpandedView()) {
        this.activeTab = "";
        this.activateTab(this.circuitTabId());
        this.setStatus("Keine Module zum Entpacken vorhanden.", "warn");
        return;
      }
    } else {
      this.activeTab = id;
      this.editor.readOnly = false;
      if (tab.view) this.editor.view = { ...tab.view };
      this.needsDraw = true;
      if (tab.kind === "code") {
        this.setStatus("Code-Fenster maximiert – Tab wechseln für die Schaltung.");
      } else if (tab.kind === "module" && session) {
        this.setStatus(`Modul „${session.name}“ – „Speichern“ übernimmt die Änderungen.`);
      } else if (this.circuit.comps.size === 0) {
        this.setStatus("Leere Ansicht – Bauteil links wählen.");
      } else {
        this.setStatus("Gesamtansicht – frei editierbar.");
      }
      this.updateStatus();
    }
    this.persistTabs();
    this.renderTabs();
  }

  private persistTabs(): void {
    // Modul-Tabs gehören zu einer laufenden Sitzung und werden nicht gemerkt.
    const tabs = this.tabs.filter((t) => t.kind !== "module");
    const active = tabs.find((t) => t.id === this.activeTab);
    const index = active ? tabs.indexOf(active) : 0;
    store.saveTabs(tabs.map((t) => ({ kind: t.kind, title: t.title })), index);
  }

  private updateEmptyHint(): void {
    const empty = this.circuit.comps.size === 0;
    if (this.lastEmptyVisible !== empty) {
      this.lastEmptyVisible = empty;
      const hint = document.getElementById("empty-hint")!;
      hint.style.display = empty ? "grid" : "none";
    }
    const zoomText = `${Math.round(this.editor.view.zoom * 100)}%`;
    if (this.lastZoomBadge !== zoomText) {
      this.lastZoomBadge = zoomText;
      document.getElementById("zoom-badge")!.textContent = zoomText;
    }
  }

  /** Aktualisiert nur die Messwerte im Eigenschaften-Panel, ohne das DOM neu aufzubauen. */
  private updateLiveProps(): void {
    const body = document.getElementById("props-body");
    if (!body) return;
    const sel = this.editor.state.selection;
    if (!sel) return;
    const set = (key: string, text: string) => {
      const el = body.querySelector<HTMLElement>(`[data-live='${key}']`);
      if (el && el.textContent !== text) el.textContent = text;
    };

    if (sel.type === "wire") {
      const wire = this.circuit.wires.find((w) => w.id === sel.id);
      if (!wire) return;
      const src = this.circuit.get(wire.from);
      if (!src) return;
      const w = portWidths(src).out[wire.fromPort] ?? 1;
      const v = (src.outs[wire.fromPort] ?? 0) & maskOf(w);
      set("wire-hex", fmtHex(v, w));
      set("wire-dec", String(v >>> 0));
      set("wire-bin", fmtBin(v, w));
      return;
    }

    if (sel.type === "group") {
      const group = this.circuit.groups.get(sel.id);
      if (!group) return;
      group.inputs.forEach((p, i) => set(`gin-${i}`, fmtPin(this.groupPinValue(group, p.compId, true), p.width)));
      group.outputs.forEach((p, i) => set(`gout-${i}`, fmtPin(this.groupPinValue(group, p.compId, false), p.width)));
      return;
    }

    const comp = this.circuit.get(sel.id);
    if (!comp) return;
    const widths = portWidths(comp);
    if (comp.outs.length) {
      const w = widths.out[0] ?? 1;
      const v = comp.outs[0] ?? 0;
      set("out-hex", fmtHex(v, w));
      set("out-dec", String(v >>> 0));
      set("out-bin", fmtBin(v, w));
    } else {
      const w = widths.in[0] ?? 1;
      const v = this.circuit.inputValues(comp)[0] ?? 0;
      set("in-hex", fmtHex(v, w));
      set("in-dec", String(v >>> 0));
    }
    if (widths.in.length > 0 && widths.in.length <= 4) {
      const ins = this.circuit.inputValues(comp);
      widths.in.forEach((w, i) => set(`pin-${i}`, fmtHex(ins[i] ?? 0, w)));
    }
  }

  // ---------- Eigenschaften ----------

  private refreshProps(): void {
    this.renderProps();
    this.addConnectTools(document.getElementById("props-body")!);
  }

  /** Verbindungs- und Layout-Werkzeuge unter den Eigenschaften (nur Gesamtansicht). */
  private addConnectTools(body: HTMLElement): void {
    const ed = this.editor;
    const ids = ed.state.selected;
    if (this.expandedView || ids.length === 0) return;
    const comp = ids.length === 1 ? this.circuit.get(ids[0]) : undefined;
    const bus = !!comp && portWidths(comp).out.some((w) => w > 1 && w <= FANOUT_MAX);
    const btn = (act: string, text: string, title = "") => `<button class="btn" data-act="${act}" title="${title}">${text}</button>`;
    const sec = document.createElement("section");
    sec.className = "prop-section";
    sec.innerHTML = `<h4>Verbinden &amp; Anordnen</h4>
      ${btn("bulk", "Massen-Verbindung (M)", "Freie Ausgänge der Auswahl der Reihe nach mit dem angeklickten Ziel verbinden")}
      ${ids.length === 2 ? btn("auto", "Auto-Verbinden", "Passende Ausgänge von A mit Eingängen von B verbinden") : ""}
      ${bus ? btn("fan", "Bus auffächern", "Splitter und eine Lampe je Bit") : ""}
      ${
        ids.length >= 2
          ? `<div class="align-grid">
        ${btn("al-left", "⇤", "Links ausrichten")}${btn("al-centerX", "⇹", "Horizontal mittig")}${btn("al-right", "⇥", "Rechts ausrichten")}
        ${btn("al-top", "⤒", "Oben ausrichten")}${btn("al-centerY", "⇳", "Vertikal mittig")}${btn("al-bottom", "⤓", "Unten ausrichten")}
        ${btn("dist-x", "↔", "Horizontal gleichmäßig verteilen (ab 3)")}${btn("dist-y", "↕", "Vertikal gleichmäßig verteilen (ab 3)")}
      </div>`
          : ""
      }`;
    const on = (act: string, fn: () => void) => sec.querySelector(`[data-act='${act}']`)?.addEventListener("click", fn);
    on("bulk", () => ed.startBulkConnect());
    on("auto", () => ed.autoConnectSelection());
    on("fan", () => ed.fanOutSelection());
    for (const m of ["left", "centerX", "right", "top", "centerY", "bottom"] as const) on(`al-${m}`, () => ed.alignSelection(m));
    on("dist-x", () => ed.distributeSelection("x"));
    on("dist-y", () => ed.distributeSelection("y"));
    body.appendChild(sec);
  }

  private renderProps(): void {
    const body = document.getElementById("props-body")!;
    const sel = this.editor.state.selection;
    const selected = this.editor.state.selected;

    if (selected.length > 1) {
      body.innerHTML = this.multiProps(selected);
      this.wireMultiPropsEvents(body);
      return;
    }
    if (sel?.type === "wire") {
      body.innerHTML = this.wireProps(sel.id, this.expandedView);
      body.querySelector("[data-act='delete-wire']")?.addEventListener("click", () => this.editor.deleteSelection());
      return;
    }
    if (sel?.type === "group") {
      const group = this.circuit.groups.get(sel.id);
      if (!group) {
        body.innerHTML = `<p class="muted">Modul nicht gefunden.</p>`;
        return;
      }
      body.innerHTML = this.groupProps(group, this.expandedView);
      this.wireGroupPropsEvents(body, group);
      return;
    }
    if (!sel) {
      body.innerHTML = `<p class="muted">Nichts ausgewählt. Klicke ein Bauteil oder Kabel.</p>`;
      return;
    }
    const comp = this.circuit.get(sel.id);
    if (!comp) {
      body.innerHTML = `<p class="muted">Nichts ausgewählt.</p>`;
      return;
    }
    body.innerHTML = this.compProps(comp, this.expandedView);
    this.wireCompPropsEvents(body, comp);
  }

  private multiProps(ids: string[]): string {
    const comps = this.editor.selectedCompIds();
    const inputCount = comps.filter((id) => this.circuit.get(id)?.kind === "input").length;
    const outputCount = comps.filter((id) => this.circuit.get(id)?.kind === "output").length;
    const groupCount = ids.filter((id) => this.circuit.groups.has(id)).length;
    const canSave = inputCount + outputCount > 0;
    const block = moduleBlockDefaults(this.circuit, ids);
    const sizeFields = block
      ? `
        <div class="field">
          <label>Blockbreite (Zellen)</label>
          <input type="number" data-act="module-cols" min="${block.minCols}" max="64" value="${block.autoCols}" />
        </div>
        <div class="field">
          <label>Blockhöhe (Zellen)</label>
          <input type="number" data-act="module-rows" min="${block.minRows}" max="64" value="${block.autoRows}" />
        </div>
        <p class="muted">Mindestens ${block.minCols} × ${block.minRows} – damit passen alle ${block.inputs} Ein- und ${block.outputs} Ausgangspins in den Block.</p>`
      : "";
    return `
      ${this.propHead("▦", "Mehrfachauswahl", `${ids.length} Objekte · ${comps.length} Bauteile`)}
      <section class="prop-section">
        <h4>Als Modul speichern</h4>
        <p class="muted">Eingangs- und Ausgangsbauteile in der Auswahl werden zu Modul-Pins. Die Auswahl wird als Vorlage gespeichert und erscheint links unter „Eigene Module“.</p>
        <div class="field">
          <label>Modulname</label>
          <input type="text" data-act="module-name" value="Modul ${listModules().length + 1}" />
        </div>
        <div class="kv"><span>Eingänge</span><b>${inputCount}</b></div>
        <div class="kv"><span>Ausgänge</span><b>${outputCount}</b></div>
        ${groupCount ? `<div class="kv"><span>Module in Auswahl</span><b>${groupCount}</b></div>` : ""}
        ${sizeFields}
        ${canSave ? "" : `<p class="warn-text">Die Auswahl braucht mindestens ein Ein- oder Ausgangsbauteil.</p>`}
        <button class="btn primary module-save" data-act="save-module" ${canSave ? "" : "disabled"}>Als Modul speichern</button>
      </section>
      <section class="prop-section">
        <h4>Auswahl</h4>
        <button class="btn" data-act="duplicate-selection">Duplizieren (Strg+D)</button>
        <button class="btn" data-act="copy-selection">Kopieren (Strg+C)</button>
        <button class="btn" data-act="select-none">Auswahl aufheben</button>
      </section>
      <button class="btn danger prop-delete" data-act="delete-selection">Auswahl löschen</button>`;
  }

  private groupProps(group: GroupInstance, readOnly = false): string {
    const def = getModule(group.moduleId);
    const pinRows = (pins: GroupInstance["inputs"], key: string, arrow: string) =>
      pins
        .map((p, i) => {
          const doc = pinDoc(def, p.name);
          const input = key === "gin";
          return `<tr><td><b>${esc(p.name)}</b> <span class="dim">${arrow} ${p.width} Bit</span>${doc ? `<div class="doc-sub">${esc(doc)}</div>` : ""}</td><td class="pin-val" data-live="${key}-${i}">${fmtPin(this.groupPinValue(group, p.compId, input), p.width)}</td></tr>`;
        })
        .join("");
    const pinTable = `<h5>Pins (aktuelle Werte)</h5>
      <table class="doc-table pin-table"><thead><tr><th>Pin</th><th>Wert</th></tr></thead><tbody>
        ${pinRows(group.inputs, "gin", "▸")}${pinRows(group.outputs, "gout", "◂")}
      </tbody></table>`;
    const description = def?.builtin
      ? moduleDocHtml(def)
      : `<div class="field"><label>Beschreibung (gilt für alle Instanzen)</label><textarea data-act="module-desc" rows="3" placeholder="Was macht dieses Modul?">${esc(def?.description ?? "")}</textarea></div>`;
    return `
      ${this.propHead("◇", esc(group.name), `Modul · ${group.inputs.length} Ein · ${group.outputs.length} Aus`)}
      ${this.docSection(`${description}${pinTable}<button class="btn" data-act="view-inside">Innenleben ansehen</button>`)}
      <section class="prop-section">
        <h4>Instanz</h4>
        <div class="kv"><span>Block</span><b>${group.cols} × ${group.rows}</b></div>
        <div class="kv"><span>Vorlage</span><b>${esc(group.moduleId)}</b></div>
        <div class="kv"><span>Bauteile innen</span><b>${group.members.length}</b></div>
        ${
          readOnly
            ? `<p class="muted">Entpackte Ansicht: anklicken, anpassen und verschieben ja (auch Mehrfachauswahl), verbinden oder löschen nein. „Bearbeiten“ öffnet das Modul in einem neuen Tab.</p>
               <button class="btn primary" data-act="edit-group-module">Im neuen Tab bearbeiten</button>`
            : `<p class="muted">Module bleiben kompakt; die Größe wurde beim Erstellen festgelegt. „Bearbeiten“ öffnet nur dieses Modul.</p>
               <button class="btn primary" data-act="edit-group-module">Modul bearbeiten</button>
               <button class="btn" data-act="duplicate-group">Duplizieren (Strg+D)</button>`
        }
      </section>
      ${readOnly ? "" : `<button class="btn danger prop-delete" data-act="delete-group">Instanz löschen</button>`}`;
  }

  private groupPinValue(group: GroupInstance, compId: string, input: boolean): number {
    const comp = this.circuit.get(compId);
    if (!comp) return 0;
    const pin = (input ? group.inputs : group.outputs).find((p) => p.compId === compId);
    const width = pin?.width ?? comp.width;
    if (input) return (this.circuit.inputValues(comp)[0] ?? 0) & maskOf(width);
    return (comp.outs[0] ?? 0) & maskOf(width);
  }

  private wireMultiPropsEvents(body: HTMLElement): void {
    body.querySelector("[data-act='save-module']")?.addEventListener("click", () => {
      const name = body.querySelector<HTMLInputElement>("[data-act='module-name']")?.value ?? "";
      const info = moduleBlockDefaults(this.circuit, this.editor.state.selected);
      const rawCols = Number(body.querySelector<HTMLInputElement>("[data-act='module-cols']")?.value);
      const rawRows = Number(body.querySelector<HTMLInputElement>("[data-act='module-rows']")?.value);
      const cols = info ? clampBlockSize(rawCols, info.minCols) : undefined;
      const rows = info ? clampBlockSize(rawRows, info.minRows) : undefined;
      this.saveModuleFromSelection(name, cols !== undefined && rows !== undefined ? { cols, rows } : undefined);
    });
    body.querySelector("[data-act='duplicate-selection']")?.addEventListener("click", () => this.editor.duplicateSelection());
    body.querySelector("[data-act='copy-selection']")?.addEventListener("click", () => {
      if (this.editor.copySelection()) this.setStatus("Auswahl kopiert – mit Strg+V an der Mausposition einfügen.");
    });
    body.querySelector("[data-act='select-none']")?.addEventListener("click", () => this.editor.select(null));
    body.querySelector("[data-act='delete-selection']")?.addEventListener("click", () => this.editor.deleteSelection());
  }

  private wireGroupPropsEvents(body: HTMLElement, group: GroupInstance): void {
    body.querySelector("[data-act='edit-group-module']")?.addEventListener("click", () => {
      this.openGroupModuleEditor(group);
    });
    body.querySelector("[data-act='view-inside']")?.addEventListener("click", () => this.openGroupModuleEditor(group));
    const desc = body.querySelector<HTMLTextAreaElement>("[data-act='module-desc']");
    desc?.addEventListener("change", () => {
      const def = getModule(group.moduleId);
      if (!def) return;
      def.description = desc.value.trim() || undefined;
      addModule(def);
      this.setStatus(`Beschreibung von „${def.name}“ gespeichert.`);
    });
    body.querySelector("[data-act='duplicate-group']")?.addEventListener("click", () => {
      this.editor.select({ type: "group", id: group.id });
      this.editor.duplicateSelection();
    });
    body.querySelector("[data-act='delete-group']")?.addEventListener("click", () => {
      this.circuit.removeGroup(group.id);
      this.editor.select(null);
      this.afterStructural();
      this.setStatus("Modul-Instanz gelöscht.");
    });
  }

  // ---------- Modul-Editor ----------

  private buildModuleBar(): void {
    document.getElementById("btn-module-overview")!.addEventListener("click", () => {
      const session = this.activeSession();
      if (!session) return;
      if (this.moduleEditorChanged(session) && !confirm("Änderungen am Modul verwerfen?")) return;
      this.exitModuleEditor(session.tabId, "Bearbeitung abgebrochen – Änderungen verworfen.");
    });
    document.getElementById("btn-module-save")!.addEventListener("click", () => this.saveModuleEditor());
    document.getElementById("btn-module-version")!.addEventListener("click", () => this.newModuleVersion());
  }

  private updateModuleBar(): void {
    const bar = document.getElementById("module-bar");
    if (!bar) return;
    const session = this.activeSession();
    bar.hidden = !session;
    const name = document.getElementById("module-bar-name");
    if (name) name.textContent = session ? `${session.name} · v${session.version}` : "";
  }

  /** Findet einen bereits offenen Modul-Tab zu einer Vorlage oder Instanz. */
  private sessionFor(pred: (s: ModuleSession) => boolean): ModuleSession | null {
    for (const session of this.sessions.values()) if (pred(session)) return session;
    return null;
  }

  /** Öffnet ein Bibliotheksmodul im eigenen Editor. */
  private openModuleDefEditor(def: ModuleDef): void {
    const open = this.sessionFor((s) => s.defId === def.id && !s.groupId);
    if (open) {
      this.activateTab(open.tabId);
      return;
    }
    if (this.expandedView) this.exitExpandedView();
    this.startModuleEditor(editableCircuitForDef(def), {
      defId: def.id,
      name: def.name,
      version: def.version ?? 1,
      cols: def.block.cols,
      rows: def.block.rows,
    });
  }

  /** Öffnet die Innenschaltung einer platzierten Instanz im eigenen Editor. */
  private openGroupModuleEditor(group: GroupInstance): void {
    const open = this.sessionFor((s) => s.groupId === group.id);
    if (open) {
      this.activateTab(open.tabId);
      return;
    }
    if (this.expandedView) this.exitExpandedView();
    const snapshot = editableCircuitForGroup(this.circuit, group.id);
    if (!snapshot) {
      this.setStatus("Modul nicht gefunden.", "warn");
      return;
    }
    const def = getModule(group.moduleId);
    this.startModuleEditor(snapshot, {
      defId: group.moduleId,
      groupId: group.id,
      name: def?.name ?? group.name,
      version: def?.version ?? 1,
      cols: group.cols,
      rows: group.rows,
    });
  }

  /** Modul-Sitzung des aktiven Tabs (null bei normalen Tabs). */
  private activeSession(): ModuleSession | null {
    return this.sessions.get(this.activeTab) ?? null;
  }

  /** Wird gerade ein Modul-Tab bearbeitet? */
  private editingActive(): boolean {
    return !!this.activeSession();
  }

  private startModuleEditor(
    snapshot: SerializedCircuit,
    meta: { defId?: string; groupId?: string; name: string; version: number; cols: number; rows: number }
  ): void {
    if (this.expandedView) this.exitExpandedView(false);
    const work = new Circuit();
    work.load(snapshot);
    work.rebuild();
    work.reset();

    const tab: ViewTab = { id: `tab${this.tabSeq++}`, kind: "module", title: meta.name };
    this.tabs.push(tab);
    const session: ModuleSession = {
      ...meta,
      work,
      baseline: JSON.stringify(work.serialize()),
      tabId: tab.id,
    };
    this.sessions.set(tab.id, session);
    // Ansicht des bisherigen Tabs merken, damit der Wechsel zurück passt.
    const prevTab = this.tabs.find((t) => t.id === this.activeTab);
    if (prevTab && prevTab.kind !== "expanded") prevTab.view = { ...this.editor.view };
    this.activeTab = tab.id;
    this.circuit = work;
    this.editor.setCircuit(work);
    this.editor.readOnly = false;
    this.editor.setFrames([]);
    this.editor.view = { panX: 80, panY: 60, zoom: 1 };
    this.applyCodeTab(false);
    this.updateModuleBar();
    this.buildPalette();
    this.refreshProps();
    this.editor.centerContent();
    this.invalidate();
    this.updateEmptyHint();
    this.updateStatus();
    this.renderTabs();
    this.persistTabs();
    this.setStatus(
      `Modul „${meta.name}“ im neuen Tab geöffnet: „Speichern“ überschreibt alle Instanzen, „Neue Version“ legt eine Kopie an.`
    );
  }

  private moduleEditorChanged(session: ModuleSession): boolean {
    return JSON.stringify(session.work.serialize()) !== session.baseline;
  }

  /** Schließt einen Modul-Tab und kehrt zur Gesamtansicht zurück. */
  private exitModuleEditor(tabId: string, message: string | null): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.sessions.delete(tabId);
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    const wasActive = this.activeTab === tabId;
    if (wasActive) {
      this.circuit = this.mainCircuit;
      this.circuit.rebuild();
      this.editor.setCircuit(this.circuit);
      this.editor.setFrames(this.expandedView ? this.expandedFrames : []);
      this.editor.readOnly = this.expandedView;
      this.activeTab = "";
      this.activateTab(this.circuitTabId());
    } else if (!this.tabs.some((t) => t.id === this.activeTab)) {
      this.activeTab = "";
      this.activateTab(this.circuitTabId());
    } else {
      this.persistTabs();
      this.renderTabs();
    }
    this.updateModuleBar();
    this.buildPalette();
    this.refreshProps();
    this.invalidate();
    this.updateEmptyHint();
    this.updateStatus();
    this.setStatus(message ?? "Modul-Editor abgebrochen – zurück zur Gesamtansicht.");
  }

  /** Speichert die bearbeitete Vorlage und ersetzt alle alten Instanzen. */
  private saveModuleEditor(): void {
    const session = this.activeSession();
    if (!session) return;
    const work = session.work;
    const version = session.defId ? session.version + 1 : 1;
    const def = buildModuleDef(
      work,
      [...work.comps.keys()],
      session.name,
      { cols: session.cols, rows: session.rows },
      { id: session.defId, version }
    );
    if (!def) {
      this.setStatus("Ein Modul braucht mindestens ein Ein- oder Ausgangsbauteil.", "warn");
      return;
    }
    def.version = version;
    const prev = session.defId ? getModule(session.defId) : undefined;
    if (prev) {
      def.description = prev.description;
      def.category = prev.category;
      def.builtin = prev.builtin;
      def.pinDocs = prev.pinDocs;
    }
    addModule(def);

    const target = this.mainCircuit;
    target.rebuild();
    let replaced = replaceModuleInstances(target, def.id, def);
    if (session.groupId && target.groups.has(session.groupId)) {
      if (replaceGroupInternals(target, session.groupId, def)) replaced++;
    }
    target.rebuild();
    target.reset();
    store.saveLocal(target);
    this.exitModuleEditor(
      session.tabId,
      `Modul „${def.name}“ v${def.version} gespeichert – ${replaced} Instanz(en) ersetzt.`
    );
  }

  /** Legt eine Kopie als neues Modul an und bearbeitet sie weiter. */
  private newModuleVersion(): void {
    const session = this.activeSession();
    if (!session) return;
    const base = session.name.replace(/\s+Kopie(\s+\d+)?$/, "").replace(/\s+v\d+$/, "");
    const taken = new Set(listModules().map((m) => m.name.toLowerCase()));
    let copyName = `${base} Kopie`;
    let n = 2;
    while (taken.has(copyName.toLowerCase())) copyName = `${base} Kopie ${n++}`;
    const work = session.work;
    const def = buildModuleDef(work, [...work.comps.keys()], copyName, {
      cols: session.cols,
      rows: session.rows,
    });
    if (!def) {
      this.setStatus("Ein Modul braucht mindestens ein Ein- oder Ausgangsbauteil.", "warn");
      return;
    }
    addModule(def);
    session.defId = def.id;
    session.groupId = undefined;
    session.name = def.name;
    session.version = def.version ?? 1;
    const tab = this.tabs.find((t) => t.id === session.tabId);
    if (tab) tab.title = def.name;
    this.updateModuleBar();
    this.buildPalette();
    this.renderTabs();
    this.persistTabs();
    this.setStatus(
      `Neue Version „${def.name}“ angelegt – bestehende Instanzen bleiben unverändert, du bearbeitest jetzt die Kopie.`
    );
  }

  private saveModuleFromSelection(name: string, size?: { cols: number; rows: number }): void {
    const ids = this.editor.state.selected;
    if (ids.length === 0) return;
    const def = createModuleFromSelection(this.circuit, ids, name, size);
    if (!def) {
      this.setStatus("Modul braucht mindestens ein Ein- oder Ausgangsbauteil.", "warn");
      return;
    }
    this.buildPalette();
    this.refreshProps();
    this.setStatus(`Modul "${def.name}" gespeichert und links in der Palette verfügbar.`);
  }

  private docOpen = true;

  /** Einklappbarer Abschnitt „Was macht das?“ (Zustand bleibt beim Wechsel der Auswahl erhalten). */
  private docSection(inner: string): string {
    return `<details class="prop-section doc-section" data-doc ${this.docOpen ? "open" : ""}><summary>Was macht das?</summary>${inner}</details>`;
  }

  private propHead(icon: string, title: string, sub: string): string {
    return `<div class="prop-head">
      <span class="prop-icon">${icon}</span>
      <div class="prop-heading"><div class="prop-title">${title}</div><div class="prop-sub">${sub}</div></div>
    </div>`;
  }

  private wireProps(id: string, readOnly = false): string {
    const wire = this.circuit.wires.find((w) => w.id === id);
    if (!wire) return `<p class="muted">Kabel nicht gefunden.</p>`;
    const src = this.circuit.get(wire.from)!;
    const dst = this.circuit.get(wire.to)!;
    const width = portWidths(src).out[wire.fromPort] ?? 1;
    const value = src.outs[wire.fromPort] ?? 0;
    return `
      ${this.propHead("〜", "Kabel", `${width} Bit · ${KIND_INFO[src.kind].label} → ${KIND_INFO[dst.kind].label}`)}
      <section class="prop-section">
        <h4>Signal</h4>
        <div class="kv"><span>Hex</span><b data-live="wire-hex">${fmtHex(value & maskOf(width), width)}</b></div>
        <div class="kv"><span>Dezimal</span><b data-live="wire-dec">${(value & maskOf(width)) >>> 0}</b></div>
        <div class="kv"><span>Binär</span><b class="wrap" data-live="wire-bin">${fmtBin(value & maskOf(width), width)}</b></div>
      </section>
      <section class="prop-section">
        <h4>Verbindung</h4>
        <div class="kv"><span>Quelle</span><b>${KIND_INFO[src.kind].label}</b></div>
        <div class="kv"><span>Ziel</span><b>${KIND_INFO[dst.kind].label}</b></div>
      </section>
      ${readOnly ? "" : `<button class="btn danger prop-delete" data-act="delete-wire">Kabel löschen</button>`}`;
  }

  private compProps(comp: Comp, readOnly = false): string {
    const info = KIND_INFO[comp.kind];
    const widths = portWidths(comp);
    const isStorage = comp.kind === "rom" || comp.kind === "ram";
    const config = [
      this.labelField(comp),
      isStorage ? "" : this.widthSelect(comp),
      comp.kind === "input" || comp.kind === "const" ? this.valueField(comp) : "",
      comp.kind === "clock" ? this.divField(comp) : "",
      comp.kind === "output" ? this.formatField(comp) : "",
      isStorage ? this.storageFields(comp) : "",
    ].join("");

    const outs = comp.outs.length
      ? `<div class="kv"><span>Hex</span><b data-live="out-hex">${fmtHex(comp.outs[0] ?? 0, widths.out[0] ?? 1)}</b></div>
         <div class="kv"><span>Dezimal</span><b data-live="out-dec">${(comp.outs[0] ?? 0) >>> 0}</b></div>
         <div class="kv"><span>Binär</span><b class="wrap" data-live="out-bin">${fmtBin(comp.outs[0] ?? 0, widths.out[0] ?? 1)}</b></div>`
      : `<div class="kv"><span>Hex</span><b data-live="in-hex">${fmtHex(this.circuit.inputValues(comp)[0] ?? 0, widths.in[0] ?? 1)}</b></div>
         <div class="kv"><span>Dezimal</span><b data-live="in-dec">${(this.circuit.inputValues(comp)[0] ?? 0) >>> 0}</b></div>`;

    const pins =
      widths.in.length > 0 && widths.in.length <= 4
        ? `<section class="prop-section">
            <h4>Eingänge</h4>
            ${widths.in
              .map(
                (w, i) =>
                  `<div class="kv"><span>Pin ${i} · ${w} Bit</span><b data-live="pin-${i}">${fmtHex(this.circuit.inputValues(comp)[i] ?? 0, w)}</b></div>`
              )
              .join("")}
          </section>`
        : "";

    return `
      ${this.propHead(info.icon, info.label, `${info.group}${isStorage ? "" : ` · ${comp.width} Bit`}`)}
      ${this.docSection(compDocHtml(comp.kind))}
      <section class="prop-section">
        <h4>Signal</h4>
        ${outs}
      </section>
      ${pins}
      <section class="prop-section">
        <h4>Konfiguration</h4>
        ${config || `<p class="muted">Keine Einstellungen.</p>`}
        ${readOnly ? `<p class="muted">Entpackte Ansicht: Einstellungen ändern und verschieben ja, verbinden oder löschen nein.</p>` : `<button class="btn" data-act="duplicate-comp">Duplizieren (Strg+D)</button>`}
      </section>
      ${readOnly ? "" : `<button class="btn danger prop-delete" data-act="delete-comp">Bauteil löschen</button>`}`;
  }

  private labelField(comp: Comp): string {
    return `<div class="field"><label>Bezeichnung</label><input type="text" data-act="label" value="${esc(comp.label)}" placeholder="optional" /></div>`;
  }

  private widthSelect(comp: Comp): string {
    // Jede Breite von 1 bis 32 ist erlaubt – auch 3, 5, 6 … (z. B. Modus-Bus).
    const opts = Array.from({ length: 32 }, (_, i) => i + 1)
      .map((w) => `<option value="${w}" ${comp.width === w ? "selected" : ""}>${w} Bit</option>`)
      .join("");
    return `<div class="field"><label>Bit-Breite</label><select data-act="width">${opts}</select></div>`;
  }

  private valueField(comp: Comp): string {
    const m = maskOf(comp.width);
    const v = (comp.value & m) >>> 0;
    const bits =
      comp.width <= 8
        ? `<div class="bits">${Array.from({ length: comp.width }, (_, i) => {
            const bit = comp.width - 1 - i;
            const on = (v >> bit) & 1;
            return `<span class="bit ${on ? "on" : ""}" data-bit="${bit}" title="Bit ${bit}">${on ? 1 : 0}</span>`;
          }).join("")}</div>`
        : "";
    return `
      <div class="field">
        <label>Wert</label>
        <input type="number" data-act="value" min="0" max="${m >>> 0}" value="${v}" />
        ${bits}
      </div>`;
  }

  private divField(comp: Comp): string {
    const opts = [1, 2, 4, 8, 16]
      .map((d) => `<option value="${d}" ${comp.div === d ? "selected" : ""}>÷ ${d}</option>`)
      .join("");
    return `<div class="field"><label>Taktteiler</label><select data-act="div">${opts}</select></div>`;
  }

  private formatField(comp: Comp): string {
    const opts: DisplayFormat[] = ["bin", "hex", "dec"];
    return `<div class="field"><label>Anzeige</label><select data-act="format">${opts
      .map((f) => `<option value="${f}" ${comp.format === f ? "selected" : ""}>${f}</option>`)
      .join("")}</select></div>`;
  }

  private storageFields(comp: Comp): string {
    const addrOpts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      .map((a) => `<option value="${a}" ${comp.addrWidth === a ? "selected" : ""}>${1 << a} Zeilen (${a}b)</option>`)
      .join("");
    const dataOpts = [1, 2, 4, 8, 16, 32]
      .map((d) => `<option value="${d}" ${comp.dataWidth === d ? "selected" : ""}>${d} Bit</option>`)
      .join("");
    const hex = comp.data.map((v) => v.toString(16).toUpperCase().padStart(Math.ceil(comp.dataWidth / 4), "0")).join(" ");
    return `
      <div class="field"><label>Adressbreite</label><select data-act="addrWidth">${addrOpts}</select></div>
      <div class="field"><label>Datenbreite</label><select data-act="dataWidth">${dataOpts}</select></div>
      <div class="field"><label>Inhalt (Hex, ${comp.data.length} Werte)</label><textarea data-act="data">${hex}</textarea></div>
      <div class="field"><button class="btn" data-act="open-mem">Innenleben ansehen</button></div>`;
  }

  private wireCompPropsEvents(body: HTMLElement, comp: Comp): void {
    body.querySelector("[data-act='delete-comp']")?.addEventListener("click", () => this.editor.deleteSelection());
    body.querySelector("[data-act='duplicate-comp']")?.addEventListener("click", () => this.editor.duplicateSelection());

    const label = body.querySelector<HTMLInputElement>("[data-act='label']");
    label?.addEventListener("change", () => {
      comp.label = label.value.trim();
      this.afterStructural();
    });

    const width = body.querySelector<HTMLSelectElement>("[data-act='width']");
    width?.addEventListener("change", () => {
      this.circuit.setWidth(comp, Number(width.value));
      this.afterStructural();
    });

    const value = body.querySelector<HTMLInputElement>("[data-act='value']");
    value?.addEventListener("change", () => {
      this.circuit.setInputValue(comp, Number(value.value) || 0);
      this.afterValue();
      this.refreshProps();
    });

    body.querySelectorAll<HTMLElement>("[data-bit]").forEach((el) => {
      el.addEventListener("click", () => {
        this.circuit.toggleBit(comp, Number(el.dataset.bit));
        this.afterValue();
        this.refreshProps();
      });
    });

    const div = body.querySelector<HTMLSelectElement>("[data-act='div']");
    div?.addEventListener("change", () => {
      comp.div = Number(div.value);
      this.afterStructural();
    });

    const format = body.querySelector<HTMLSelectElement>("[data-act='format']");
    format?.addEventListener("change", () => {
      comp.format = format.value as DisplayFormat;
      this.afterStructural();
    });

    body.querySelector("[data-act='open-mem']")?.addEventListener("click", () => this.openMemory(comp.id));

    const addr = body.querySelector<HTMLSelectElement>("[data-act='addrWidth']");
    addr?.addEventListener("change", () => {
      comp.addrWidth = Number(addr.value);
      comp.data = new Array(1 << comp.addrWidth).fill(0);
      this.circuit.rebuild();
      this.afterStructural();
      this.refreshProps();
    });

    const dw = body.querySelector<HTMLSelectElement>("[data-act='dataWidth']");
    dw?.addEventListener("change", () => {
      comp.dataWidth = Number(dw.value);
      this.circuit.rebuild();
      this.afterStructural();
      this.refreshProps();
    });

    const data = body.querySelector<HTMLTextAreaElement>("[data-act='data']");
    data?.addEventListener("change", () => {
      const parsed = data.value
        .split(/[^0-9a-fA-FxX]+/)
        .filter(Boolean)
        .map((tok) => parseInt(tok.replace(/^0x/i, ""), 16))
        .filter((n) => !Number.isNaN(n));
      const next = new Array(1 << comp.addrWidth).fill(0);
      parsed.forEach((v, i) => {
        if (i < next.length) next[i] = (v & maskOf(comp.dataWidth)) >>> 0;
      });
      comp.data = next;
      this.setStatus(`${parsed.length} Speicherwerte übernommen.`);
      this.afterValue();
    });
  }

  private openMemory(compId: string): void {
    openMemView(this.circuit, compId, { changed: () => this.afterValue() });
  }

  // ---------- Laufzeit ----------

  private loop = (now: number): void => {
    if (!this.lastTime) this.lastTime = now;
    const dt = Math.min(250, now - this.lastTime);
    this.lastTime = now;

    if (this.running && this.speedHz > 0) {
      // Bis zu 25 ms Rückstand aufholen, damit hohe Taktraten nicht unbegrenzt nachlaufen.
      this.acc = Math.min(
        this.acc + (dt / 1000) * this.speedHz,
        Math.max(1, this.speedHz * 0.025)
      );
      const target = Math.floor(this.acc);
      // Kurzes Zeitbudget und häufige Prüfung: die Oberfläche bleibt flüssig,
      // auch wenn die Engine die eingestellte Taktrate nicht schafft.
      const deadline = performance.now() + 6;
      let done = 0;
      while (done < target) {
        this.circuit.step();
        done++;
        if ((done & 7) === 0 && performance.now() >= deadline) break;
      }
      this.acc = Math.max(0, this.acc - done);

      const t = performance.now();
      if (!this.measureStart) this.measureStart = t;
      this.measureSteps += done;
      const elapsed = t - this.measureStart;
      if (elapsed >= 500) {
        this.measuredHz = (this.measureSteps * 1000) / elapsed;
        this.measureStart = t;
        this.measureSteps = 0;
      }
      // Statusleiste höchstens ~7×/s neu schreiben, statt in jedem Frame.
      const nowMs = performance.now();
      if (done > 0 && nowMs - this.lastStatusDraw > 150) {
        this.lastStatusDraw = nowMs;
        this.updateStatus();
      }
    }

    // Nur zeichnen, wenn sich etwas ändert – im ruhenden Zustand spart das viel CPU.
    if (this.running || this.needsDraw) {
      this.needsDraw = false;
      this.renderer.draw(this.circuit, this.editor.view, this.editor.state, {
        frames: this.expandedFrames,
        wireStyle: this.wireStyle,
        clockPulse: this.running ? Math.floor(performance.now() / 300) % 2 === 0 : undefined,
      });
      this.updateEmptyHint();
    }
    updateMemView();
    this.frame++;
    if (this.frame % 8 === 0) this.updateLiveProps();
    requestAnimationFrame(this.loop);
  };
}

export function boot(): void {
  new App();
}
