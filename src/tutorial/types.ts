import { Rig } from "./rig";
import { RunResult } from "./isa";

/** Prüfbare Aufgabe an einer Live-Schaltung. */
export interface Task {
  id: string;
  text: string;
  hint?: string;
  /** Wird laufend gegen die Live-Schaltung geprüft. */
  check(r: Rig): boolean;
  /** Bringt die Schaltung in einen Lösungszustand. */
  solve(r: Rig): void;
  /** Erklärung der Lösung (HTML). */
  solution: string;
}

export interface Demo {
  id: string;
  title: string;
  /** Erklärung unter der Überschrift (HTML) */
  caption?: string;
  build(): Rig;
  /** Höhe der Zeichenfläche in px */
  height?: number;
  /** Wahrheitstabelle über diese Ein-/Ausgänge (nur kombinatorisch) */
  table?: { ins: string[]; outs: string[] };
  /** ROM/RAM-Bauteile, deren Inhalt als Hex-Raster angezeigt wird */
  mem?: string[];
  /** Zusatzzeile mit abgeleiteten Werten, jedes Bild neu berechnet */
  readout?: (r: Rig) => string;
  tasks?: Task[];
  /** „Selbst bauen“: Schritte (HTML) */
  steps: string[];
}

export interface ProgTask {
  id: string;
  text: string;
  hint?: string;
  check(res: RunResult): boolean;
  /** Musterlösung als Assembler-Programm */
  solution: string;
}

export interface CpuBlock {
  id: string;
  /** Programm beim Öffnen */
  program: string;
  examples?: { name: string; text: string; src: string }[];
  tasks?: ProgTask[];
  steps: string[];
  /** Phasenanzeige (Fetch → Write-back) ein-/ausblenden */
  phases: boolean;
  caption?: string;
}

export type WidgetName = "ripple" | "srlatch" | "instr" | "pipeline" | "ops";

export type Block =
  | { t: "html"; html: string }
  | { t: "merk"; items: string[] }
  | { t: "demo"; demo: Demo }
  | { t: "widget"; name: WidgetName }
  | { t: "cpu"; cpu: CpuBlock };

export interface Chapter {
  id: string;
  num: number;
  title: string;
  lead: string;
  blocks: Block[];
}
