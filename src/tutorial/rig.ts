import { Circuit } from "../circuit";
import { layoutOf } from "../logic";
import { Comp, CompKind, maskOf } from "../types";

/** Quelle eines Signals: Bauteil + Ausgangsport. */
export interface Src {
  c: Comp;
  p: number;
}

export const o = (c: Comp, p = 0): Src => ({ c, p });

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
}

type AddOpts = Partial<Comp> & { name?: string };

/**
 * Eine kleine, benannte Schaltung für das Tutorial: Circuit + Namenstabelle +
 * Bequemlichkeits-Funktionen zum Bauen, Setzen und Lesen. Kennt kein DOM.
 */
export class Rig {
  n: Record<string, Comp> = {};
  regions: Region[] = [];

  constructor(public c: Circuit = new Circuit()) {}

  add(kind: CompKind, x: number, y: number, opts: AddOpts = {}): Comp {
    const { name, ...rest } = opts;
    const comp = this.c.addComp(kind, x, y);
    Object.assign(comp, rest);
    if (name) this.n[name] = comp;
    return comp;
  }

  /** Zieht ein Kabel von einer Quelle an einen Eingangsport (wirft bei Fehlern). */
  link(from: Src | Comp, to: Comp, toPort: number): void {
    const src = "c" in from ? from : o(from);
    if (!this.c.addWire(src.c.id, src.p, to.id, toPort)) {
      throw new Error(`Kabel nicht möglich: ${src.c.kind}[${src.p}] → ${to.kind}[${toPort}]`);
    }
  }

  /** Gatter anlegen und die Eingänge gleich verdrahten. */
  gate(kind: CompKind, x: number, y: number, a: Src | Comp, b?: Src | Comp, opts: AddOpts = {}): Comp {
    const g = this.add(kind, x, y, opts);
    this.link(a, g, 0);
    if (b) this.link(b, g, 1);
    return g;
  }

  region(x: number, y: number, w: number, h: number, title: string): void {
    this.regions.push({ x, y, w, h, title });
  }

  /** Abschluss: Reihenfolge berechnen und in den Ausgangszustand gehen. */
  done(): this {
    this.c.rebuild();
    this.c.reset();
    return this;
  }

  comp(name: string): Comp {
    const comp = this.n[name];
    if (!comp) throw new Error(`Unbekanntes Bauteil "${name}"`);
    return comp;
  }

  /** Aktueller Wert: Eingang = eingestellter Wert, Ausgang = anliegendes Signal, sonst Q. */
  get(name: string): number {
    const comp = this.comp(name);
    if (comp.kind === "input" || comp.kind === "const") return comp.value;
    if (comp.kind === "output") return (this.c.inputValues(comp)[0] ?? 0) >>> 0;
    return (comp.outs[0] ?? 0) >>> 0;
  }

  set(name: string, value: number): void {
    this.c.setInputValue(this.comp(name), value);
  }

  step(n = 1): void {
    for (let i = 0; i < n; i++) this.c.step();
  }

  half(): void {
    this.c.halfStep();
  }

  hasClock(): boolean {
    for (const comp of this.c.comps.values()) if (comp.kind === "clock") return true;
    return false;
  }

  inputs(): Comp[] {
    return [...this.c.comps.values()]
      .filter((comp) => comp.kind === "input")
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }

  outputs(): Comp[] {
    return [...this.c.comps.values()]
      .filter((comp) => comp.kind === "output")
      .sort((a, b) => a.x - b.x || a.y - b.y);
  }

  /** Bauteile, die sich überlappen (Layout-Kontrolle für Tests). */
  overlaps(): string[] {
    const boxes = [...this.c.comps.values()]
      .filter((comp) => !this.c.isCompHidden(comp.id))
      .map((comp) => {
        const l = layoutOf(comp);
        const p = this.c.posOf(comp);
        return { id: `${comp.kind}:${comp.label}@${p.x},${p.y}`, x: p.x, y: p.y, w: l.cols, h: l.rows };
      });
    const bad: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) bad.push(`${a.id} ~ ${b.id}`);
      }
    }
    return bad;
  }
}

export interface TableRow {
  ins: number[];
  outs: number[];
}

/** Alle Eingangskombinationen durchprobieren; stellt die Eingänge danach wieder her. */
export function truthTable(r: Rig, ins: string[], outs: string[]): TableRow[] {
  const widths = ins.map((n) => r.comp(n).width);
  const total = widths.reduce((a, b) => a + b, 0);
  const saved = ins.map((n) => r.get(n));
  const rows: TableRow[] = [];
  for (let k = 0; k < 1 << total; k++) {
    let shift = total;
    const vals = widths.map((w) => {
      shift -= w;
      return (k >> shift) & maskOf(w);
    });
    ins.forEach((n, i) => r.set(n, vals[i]));
    rows.push({ ins: vals, outs: outs.map((n) => r.get(n)) });
  }
  ins.forEach((n, i) => r.set(n, saved[i]));
  return rows;
}
