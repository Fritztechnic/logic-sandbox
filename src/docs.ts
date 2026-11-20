import { CompKind } from "./types";
import type { ModuleDef } from "./modules";

/** Deutsche Erklärungen („Was macht das?“) für alle Bauteile und Module. */

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
  );
}

interface Table {
  head: string[];
  rows: string[][];
}

interface CompDoc {
  summary: string;
  usage: string;
  pins: [name: string, dir: "Ein" | "Aus", desc: string][];
  table?: Table;
  note?: string;
}

const BITWISE = "Bei Bussen mit mehr als 1 Bit wirkt das Gatter bitweise auf jedes Bit einzeln.";

const gateTable = (f: (a: number, b: number) => number): Table => ({
  head: ["A", "B", "Y"],
  rows: [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ].map(([a, b]) => [String(a), String(b), String(f(a, b))]),
});

export const COMP_DOCS: Record<CompKind, CompDoc> = {
  input: {
    summary: "Ein Schalter, den du per Klick umlegst. Er liefert einen festen Wert in die Schaltung, bis du ihn änderst.",
    usage: "Zum Testen von Schaltungen von Hand, als Pin „Eingang“ eines Moduls (die Bezeichnung wird zum Pin-Namen) oder als Steuersignal.",
    pins: [["Q", "Aus", "Der eingestellte Wert (1 bis 32 Bit)"]],
    note: "Bei breiten Eingängen setzt du den Wert im Eigenschaften-Panel (dezimal) oder per Klick auf einzelne Bits.",
  },
  output: {
    summary: "Eine Lampe bzw. Anzeige: zeigt den Wert des angeschlossenen Signals (binär, hex oder dezimal).",
    usage: "Zum Beobachten von Ergebnissen und als Pin „Ausgang“ eines Moduls (die Bezeichnung wird zum Pin-Namen).",
    pins: [["X", "Ein", "Das anzuzeigende Signal"]],
  },
  const: {
    summary: "Ein fester Wert, der sich nie ändert (z. B. 0, 1 oder ein Bitmuster).",
    usage: "Für Vergleichswerte, Offsets, Maskierungen oder um einen Eingang dauerhaft auf 0 oder 1 zu legen.",
    pins: [["Q", "Aus", "Der eingestellte feste Wert"]],
  },
  clock: {
    summary: "Ein Taktgeber: wechselt bei jedem Simulationsschritt zwischen 0 und 1 (ein Takt = zwei Halbschritte). Der Taktteiler verlangsamt ihn.",
    usage: "Versorgt Flip-Flops, Register, Zähler und RAM mit dem Arbeitstakt. Alles, was „bei steigender Flanke“ passiert, geschieht beim Wechsel 0 → 1.",
    pins: [["Q", "Aus", "Taktsignal (0/1)"]],
  },
  not: {
    summary: "Inverter: kehrt jedes Bit um – aus 0 wird 1 und aus 1 wird 0.",
    usage: "Zum Negieren von Steuersignalen, für Zweierkomplement (zusammen mit +1) und als Baustein anderer Gatter.",
    pins: [
      ["A", "Ein", "Eingang"],
      ["Y", "Aus", "Invertierter Wert"],
    ],
    table: { head: ["A", "Y"], rows: [["0", "1"], ["1", "0"]] },
    note: BITWISE,
  },
  buf: {
    summary: "Puffer: gibt das Signal unverändert weiter. Hat keine logische Wirkung, dient aber als Beschriftungs- und Anschlusspunkt.",
    usage: "Als Pin eines Moduls (Ein-/Ausgangsbauteile werden dort zu Puffern) oder um Leitungen übersichtlich zu führen.",
    pins: [
      ["A", "Ein", "Eingang"],
      ["Y", "Aus", "Derselbe Wert wie A"],
    ],
    table: { head: ["A", "Y"], rows: [["0", "0"], ["1", "1"]] },
  },
  and: {
    summary: "UND-Gatter: Der Ausgang ist 1, wenn A und B beide 1 sind.",
    usage: "Zum Maskieren (Bits ausblenden), als Freigabe („nur wenn …“) und für Adressdekodierung.",
    pins: [
      ["A", "Ein", "Erster Eingang"],
      ["B", "Ein", "Zweiter Eingang"],
      ["Y", "Aus", "A UND B"],
    ],
    table: gateTable((a, b) => a & b),
    note: BITWISE,
  },
  or: {
    summary: "ODER-Gatter: Der Ausgang ist 1, wenn mindestens einer der Eingänge 1 ist.",
    usage: "Zum Zusammenführen von Bedingungen, zum Setzen von Bits und für Übertragslogik.",
    pins: [
      ["A", "Ein", "Erster Eingang"],
      ["B", "Ein", "Zweiter Eingang"],
      ["Y", "Aus", "A ODER B"],
    ],
    table: gateTable((a, b) => a | b),
    note: BITWISE,
  },
  nand: {
    summary: "NAND: negiertes UND – der Ausgang ist 0 nur dann, wenn beide Eingänge 1 sind.",
    usage: "Universelles Gatter: Jede andere Logik lässt sich allein aus NAND-Gattern bauen. Typisch in Latches und Flip-Flops.",
    pins: [
      ["A", "Ein", "Erster Eingang"],
      ["B", "Ein", "Zweiter Eingang"],
      ["Y", "Aus", "NICHT (A UND B)"],
    ],
    table: gateTable((a, b) => 1 - (a & b)),
    note: BITWISE,
  },
  nor: {
    summary: "NOR: negiertes ODER – der Ausgang ist 1 nur dann, wenn beide Eingänge 0 sind.",
    usage: "Ebenfalls ein universelles Gatter. Praktisch für „nichts ist aktiv“-Erkennung, z. B. Null-Detektoren.",
    pins: [
      ["A", "Ein", "Erster Eingang"],
      ["B", "Ein", "Zweiter Eingang"],
      ["Y", "Aus", "NICHT (A ODER B)"],
    ],
    table: gateTable((a, b) => 1 - (a | b)),
    note: BITWISE,
  },
  xor: {
    summary: "XOR (exklusives ODER): Der Ausgang ist 1, wenn A und B verschieden sind.",
    usage: "Herzstück jedes Addierers (Summenbit), für Paritätsprüfung, Vergleiche auf Gleichheit und bedingtes Invertieren.",
    pins: [
      ["A", "Ein", "Erster Eingang"],
      ["B", "Ein", "Zweiter Eingang"],
      ["Y", "Aus", "A XOR B"],
    ],
    table: gateTable((a, b) => a ^ b),
    note: BITWISE,
  },
  xnor: {
    summary: "XNOR: Der Ausgang ist 1, wenn A und B gleich sind (negiertes XOR).",
    usage: "Gleichheitsvergleich einzelner Bits; mit anschließendem UND über alle Bits entsteht ein Vergleicher.",
    pins: [
      ["A", "Ein", "Erster Eingang"],
      ["B", "Ein", "Zweiter Eingang"],
      ["Y", "Aus", "1 wenn A = B"],
    ],
    table: gateTable((a, b) => 1 - (a ^ b)),
    note: BITWISE,
  },
  dff: {
    summary: "D-Flip-Flop: ein Speicher, der den Wert an D nur im Moment der steigenden Taktflanke (CLK: 0 → 1) übernimmt und sonst festhält. RST=1 löscht ihn auf 0.",
    usage: "Grundbaustein von Registern, Zählern, Zustandsautomaten und Programmzählern. Mehrere Bits breit ergibt direkt ein Register.",
    pins: [
      ["D", "Ein", "Daten, die übernommen werden"],
      ["CLK", "Ein", "Takt – übernommen wird bei der steigenden Flanke"],
      ["RST", "Ein", "Reset: 1 setzt den Speicher auf 0"],
      ["Q", "Aus", "Gespeicherter Wert"],
      ["Q̄", "Aus", "Invertierter gespeicherter Wert"],
    ],
    table: {
      head: ["RST", "CLK", "D", "Q danach"],
      rows: [
        ["1", "×", "×", "0"],
        ["0", "↑ (0→1)", "0", "0"],
        ["0", "↑ (0→1)", "1", "1"],
        ["0", "sonst", "×", "unverändert"],
      ],
    },
  },
  latch: {
    summary: "D-Latch: ein pegelgesteuerter Speicher. Solange EN=1, folgt Q dem Eingang D (transparent); sobald EN=0 wird, bleibt der letzte Wert gespeichert.",
    usage: "Einfachste Speicherzelle; zwei gegengleich getaktete Latches bilden ein Master-Slave-Flip-Flop. Auch für Zwischenspeicher mit Freigabe.",
    pins: [
      ["D", "Ein", "Daten"],
      ["EN", "Ein", "Freigabe (1 = transparent, 0 = halten)"],
      ["Q", "Aus", "Gespeicherter Wert"],
      ["Q̄", "Aus", "Invertierter gespeicherter Wert"],
    ],
    table: {
      head: ["EN", "D", "Q danach"],
      rows: [
        ["0", "×", "unverändert (gehalten)"],
        ["1", "0", "0"],
        ["1", "1", "1"],
      ],
    },
  },
  splitter: {
    summary: "Splitter: zerlegt einen Bus der Breite N in N einzelne Leitungen (Bits). Der Eingang A bleibt ein Bus, die Ausgänge b(N−1) … b0 sind einzelne Bits.",
    usage: "Um einzelne Bits eines Wertes zu verwenden – etwa das Vorzeichenbit, ein Flag oder Bits eines Befehlsworts.",
    pins: [
      ["A", "Ein", "Bus (N Bit)"],
      ["b(N−1) … b0", "Aus", "Einzelne Bits; b0 ist das niederwertigste"],
    ],
    note: "Die Bit-Breite des Splitters stellst du im Eigenschaften-Panel ein; sie muss zum angeschlossenen Bus passen.",
  },
  joiner: {
    summary: "Joiner: fügt N einzelne Bits zu einem Bus der Breite N zusammen – das Gegenstück zum Splitter.",
    usage: "Um aus Einzelbits ein Datenwort zu bauen, Bits zu verschieben/umzusortieren oder ein Bit auf einen ganzen Bus zu verteilen.",
    pins: [
      ["b(N−1) … b0", "Ein", "Einzelne Bits; b0 ist das niederwertigste"],
      ["Y", "Aus", "Zusammengesetzter Bus (N Bit)"],
    ],
  },
  rom: {
    summary: "ROM: ein Festwertspeicher. Die Adresse an ADDR wählt eine Zeile; deren Inhalt liegt sofort (ohne Takt) an DATA an. Der Inhalt wird im Panel oder im Speicher-Fenster eingetragen.",
    usage: "Für Programme (Befehlsspeicher), Steuertabellen (Mikrocode) und Nachschlagetabellen.",
    pins: [
      ["ADDR", "Ein", "Adresse der Zeile"],
      ["DATA", "Aus", "Inhalt der adressierten Zeile"],
    ],
  },
  ram: {
    summary: "RAM: ein Schreib-/Lesespeicher. DOUT zeigt immer den Inhalt der Zeile ADDR; bei steigender Taktflanke mit WE=1 wird DIN in diese Zeile geschrieben.",
    usage: "Für Daten, Stapel (Stack) und Variablen einer CPU. Registerdateien lassen sich daraus oder aus Flip-Flops bauen.",
    pins: [
      ["ADDR", "Ein", "Adresse der Zeile (Lesen und Schreiben)"],
      ["DIN", "Ein", "Zu schreibender Wert"],
      ["WE", "Ein", "Schreiben erlauben (1 = ja)"],
      ["CLK", "Ein", "Takt – geschrieben wird bei der steigenden Flanke"],
      ["DOUT", "Aus", "Inhalt der adressierten Zeile (asynchron)"],
    ],
    table: {
      head: ["WE", "CLK", "Wirkung"],
      rows: [
        ["0", "×", "nur lesen"],
        ["1", "↑ (0→1)", "Speicher[ADDR] ← DIN"],
        ["1", "sonst", "nur lesen"],
      ],
    },
  },
};

function tableHtml(t: Table): string {
  return `<table class="doc-table"><thead><tr>${t.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${t.rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

export function shortDoc(kind: CompKind): string {
  return COMP_DOCS[kind].summary;
}

/** Inhalt des Abschnitts „Was macht das?“ für ein Grundbauteil. */
export function compDocHtml(kind: CompKind): string {
  const d = COMP_DOCS[kind];
  const pins = `<table class="doc-table"><thead><tr><th>Pin</th><th>Richtung</th><th>Bedeutung</th></tr></thead><tbody>${d.pins
    .map(([n, dir, t]) => `<tr><td><b>${esc(n)}</b></td><td>${dir}</td><td>${esc(t)}</td></tr>`)
    .join("")}</tbody></table>`;
  return `<p class="doc-text">${esc(d.summary)}</p>
    ${d.table ? `<h5>${kind === "dff" || kind === "latch" || kind === "ram" ? "Zustandstabelle" : "Wahrheitstabelle"}</h5>${tableHtml(d.table)}` : ""}
    ${d.note ? `<p class="doc-text muted">${esc(d.note)}</p>` : ""}
    <h5>Typische Verwendung</h5><p class="doc-text">${esc(d.usage)}</p>
    <h5>Pins</h5>${pins}`;
}

export function shortModuleDoc(def: ModuleDef): string {
  const text = def.description ?? "";
  return text.length > 220 ? `${text.slice(0, 217)}…` : text;
}

/** Beschreibungstext eines Moduls (leer, wenn keine vorhanden). */
export function moduleDocHtml(def: ModuleDef | undefined): string {
  if (!def?.description) return "";
  return `<p class="doc-text">${esc(def.description)}</p>`;
}

/** Pin-Beschreibung eines Moduls (leer, wenn keine vorhanden). */
export function pinDoc(def: ModuleDef | undefined, name: string): string {
  return def?.pinDocs?.[name] ?? "";
}
