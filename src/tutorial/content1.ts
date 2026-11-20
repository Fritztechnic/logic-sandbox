import * as C from "./circuits";
import { Chapter, Task } from "./types";
import { Rig } from "./rig";

export const bin = (v: number, w: number): string => (v >>> 0).toString(2).padStart(w, "0");
export const hx = (v: number, w = 8): string => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(Math.ceil(w / 4), "0");

export function task(
  id: string,
  text: string,
  check: (r: Rig) => boolean,
  solve: (r: Rig) => void,
  solution: string,
  hint?: string
): Task {
  return { id, text, check, solve, solution, hint };
}

const set =
  (vals: Record<string, number>) =>
  (r: Rig): void => {
    for (const [k, v] of Object.entries(vals)) r.set(k, v);
  };

export const SB = {
  place: "Bauteil links in der Palette anklicken, dann auf die Fläche klicken, um es zu platzieren.",
  wire: "Kabel ziehen: mit der Maus von einem Ausgangs-Pin (rechte Seite eines Bauteils) zu einem Eingangs-Pin (linke Seite) ziehen.",
  props: "Breite (Bit) und Startwert stellst du im Eigenschaften-Panel rechts ein, wenn das Bauteil ausgewählt ist.",
  label: "Beschriftung (Label) ebenfalls im Eigenschaften-Panel – so erkennst du die Teile später wieder.",
};

export const chapters1: Chapter[] = [
  /* ------------------------------------------------------------------ 0 */
  {
    id: "einstieg",
    num: 0,
    title: "Einstieg: Bits, Signale, Gatter",
    lead: "Alles, was ein Computer tut, besteht aus Ja/Nein-Entscheidungen. Hier lernst du die Grundbausteine und wie dieses Tutorial funktioniert.",
    blocks: [
      {
        t: "html",
        html: `
<h3>Das Bit: die kleinste Informationseinheit</h3>
<p>In einer Schaltung gibt es nur zwei erlaubte Zustände: Auf einer Leitung liegt entweder eine <b>niedrige</b> Spannung (zum Beispiel 0&nbsp;V) oder eine <b>hohe</b> Spannung (zum Beispiel 3,3&nbsp;V). Wir nennen das <b>0</b> und <b>1</b> – ein <b>Bit</b> (<i>binary digit</i>). Dass es nur zwei Zustände gibt, ist Absicht: Zwischen „deutlich niedrig“ und „deutlich hoch“ liegt ein großer Sicherheitsabstand. Ein bisschen Rauschen auf der Leitung ändert deshalb nichts – genau das macht digitale Elektronik so zuverlässig und billig.</p>
<p>In der Sandbox und in diesem Tutorial siehst du Bits so: <b>grau = 0</b>, <b>grün = 1</b>. Leitungen, die mehrere Bits gemeinsam führen (ein <b>Bus</b>), sind <b>blau</b>, sobald sie nicht 0 sind.</p>

<h3>Viele Bits ergeben Zahlen</h3>
<p>Wie im Dezimalsystem hat jede Stelle einen Stellenwert – nur dass es hier Zweierpotenzen sind: von rechts 1, 2, 4, 8, 16, 32, 64, 128. Die Bitfolge <code>0010 1010</code> bedeutet 32 + 8 + 2 = <b>42</b>. Acht Bits bilden ein <b>Byte</b> und stellen die Zahlen 0 bis 255 dar (2<sup>8</sup> = 256 Möglichkeiten). Das niederwertigste Bit (ganz rechts) heißt <b>LSB</b>, das höchstwertige (ganz links) <b>MSB</b>.</p>
<p>Lange Bitfolgen sind unhandlich, deshalb schreibt man sie <b>hexadezimal</b>: Vier Bits ergeben genau eine Ziffer 0–9, A–F. <code>0010 1010</code> wird zu <code>0x2A</code>. Das Präfix <code>0x</code> sagt „hexadezimal“, <code>0b</code> sagt „binär“.</p>

<h3>Gatter: Bits verknüpfen</h3>
<p>Ein <b>Logikgatter</b> bekommt ein oder zwei Bits und liefert ein Bit. Aus diesen wenigen Bausteinen entsteht später alles – Rechnen, Speichern, Entscheiden.</p>
<table class="plain">
<tr><th>Gatter</th><th>Ausgang ist 1, wenn …</th><th>Alltagsbild</th></tr>
<tr><td>NOT</td><td>der Eingang 0 ist</td><td>Umkehrer</td></tr>
<tr><td>AND</td><td>beide Eingänge 1 sind</td><td>zwei Schalter in Reihe</td></tr>
<tr><td>OR</td><td>mindestens ein Eingang 1 ist</td><td>zwei Schalter parallel</td></tr>
<tr><td>XOR</td><td>genau ein Eingang 1 ist</td><td>Wechselschaltung</td></tr>
<tr><td>NAND / NOR / XNOR</td><td>das Gegenteil von AND / OR / XOR</td><td>mit eingebautem NOT</td></tr>
</table>

<h3>So benutzt du dieses Tutorial</h3>
<ul>
<li><b>Live-Schaltungen:</b> Das sind echte Schaltungen, berechnet von derselben Simulation wie in der Sandbox. Klicke auf die Schalter unter dem Bild (oder auf 1-Bit-Eingänge im Bild), um Eingänge umzuschalten. Bei Schaltungen mit Takt gibt es <b>Start/Pause</b>, <b>Schritt</b> (ein ganzer Takt), <b>½ Takt</b> (nur eine Flanke) und <b>Reset</b>.</li>
<li><b>Aufgaben:</b> Jede Aufgabe wird automatisch geprüft. Ein Haken ✓ bedeutet: Die Live-Schaltung befindet sich gerade im geforderten Zustand. „Lösung ansehen“ erklärt und zeigt den Weg.</li>
<li><b>Selbst bauen:</b> Zu jeder Schaltung gibt es eine Schritt-für-Schritt-Anleitung für die Sandbox. „In der Sandbox öffnen“ lädt die fertige Schaltung dort – dort kannst du sie verändern, ausprobieren und erweitern.</li>
<li><b>Fortschritt:</b> wird nur in deinem Browser (localStorage) gespeichert, nichts wird übertragen.</li>
<li><b>Tastatur:</b> Alle Schalter und Knöpfe sind mit <kbd>Tab</kbd> erreichbar und mit <kbd>Leertaste</kbd>/<kbd>Enter</kbd> bedienbar. Mit <kbd>[</kbd> und <kbd>]</kbd> blätterst du durch die Kapitel.</li>
</ul>
<h3>Bedienung der Sandbox in Kürze</h3>
<ul>
<li>Bauteil links wählen → auf die Fläche klicken. Von einem Ausgangs-Pin zu einem Eingangs-Pin ziehen, um ein Kabel zu legen.</li>
<li>Mausrad zoomt, mittlere Maustaste (oder Leertaste + Ziehen) verschiebt die Ansicht, Rechtsklick löscht, <kbd>Entf</kbd> löscht die Auswahl.</li>
<li>Rechts im Eigenschaften-Panel stellst du Breite, Werte, Beschriftungen und Taktteiler ein.</li>
<li>Oben starten, pausieren und steppen: <b>Start</b>, <b>Schritt</b>, <b>Reset</b>.</li>
</ul>`,
      },
      {
        t: "demo",
        demo: {
          id: "zahl",
          title: "Live: Zahlen als Bits",
          caption:
            "Ein 8-Bit-<b>Eingang</b> trägt acht Schalter (Bit 7 links … Bit 0 rechts). Probiere Bits aus oder tippe eine Zahl ein (dezimal, <code>0x…</code> oder <code>0b…</code>). Die LED-Reihe rechts zeigt dasselbe Muster als Ausgang.",
          build: C.numberDemo,
          height: 150,
          readout: (r) => {
            const v = r.get("ZAHL");
            return `Dezimal ${v} · Hex ${hx(v)} · Binär 0b${bin(v, 8)}`;
          },
          tasks: [
            task("zahl42", "Stelle die Zahl 42 (hexadezimal 0x2A) ein.", (r) => r.get("ZAHL") === 42, set({ ZAHL: 42 }), "42 = 32 + 8 + 2 → Bits 5, 3 und 1 sind 1: <code>0010 1010</code> = <code>0x2A</code>."),
            task("zahlAA", "Stelle das Wechselmuster <code>1010 1010</code> ein. Welche Zahl ist das?", (r) => r.get("ZAHL") === 0xaa, set({ ZAHL: 0xaa }), "<code>1010 1010</code> = 128 + 32 + 8 + 2 = <b>170</b> = <code>0xAA</code>.", "Jedes zweite Bit ist 1, beginnend mit Bit 7."),
            task("zahl255", "Welche ist die größte Zahl, die in 8 Bit passt? Stelle sie ein.", (r) => r.get("ZAHL") === 255, set({ ZAHL: 255 }), "Alle acht Bits auf 1: 128+64+32+16+8+4+2+1 = <b>255</b> = 2<sup>8</sup> − 1 = <code>0xFF</code>."),
          ],
          steps: [
            "Eingang (Kategorie „Ein-/Ausgabe“) platzieren, im Eigenschaften-Panel <b>Breite = 8</b> setzen und das Label <code>ZAHL</code> vergeben.",
            "Ausgang daneben platzieren, ebenfalls <b>Breite = 8</b>, Anzeigeformat nach Wunsch (bin/hex/dec).",
            "Ausgangs-Pin des Eingangs mit dem Eingangs-Pin des Ausgangs verbinden. <i>Hinweis:</i> Die Breiten an beiden Enden eines Kabels müssen exakt gleich sein, sonst lässt die Sandbox das Kabel nicht zu.",
            "Im Eigenschaften-Panel des Eingangs einzelne Bits umschalten oder einen Wert tippen.",
          ],
        },
      },
      {
        t: "demo",
        demo: {
          id: "lampe",
          title: "Live: Dein erstes Gatter",
          caption: "Zwei Schalter in Reihe: Die Lampe leuchtet nur, wenn <b>beide</b> an sind – das ist ein AND-Gatter.",
          build: C.lampDemo,
          height: 150,
          table: { ins: ["A", "B"], outs: ["L"] },
          tasks: [task("lampe", "Bringe die Lampe zum Leuchten.", (r) => r.get("L") === 1, set({ A: 1, B: 1 }), "Beide Schalter müssen 1 sein: A AND B = 1.")],
          steps: [
            "Zwei <b>Eingänge</b>, ein <b>AND</b>-Gatter und einen <b>Ausgang</b> platzieren.",
            "A und B mit den beiden Eingängen des Gatters verbinden, das Gatter mit dem Ausgang.",
            "Eingänge anklicken: grün = 1, grau = 0.",
          ],
        },
      },
      {
        t: "merk",
        items: [
          "Ein Bit ist 0 oder 1 – elektrisch „niedrige“ oder „hohe“ Spannung mit großem Sicherheitsabstand.",
          "n Bits stellen 2<sup>n</sup> verschiedene Werte dar; 8 Bit = 1 Byte = 0…255 = zwei Hex-Ziffern.",
          "Gatter verknüpfen Bits; aus Gattern baut man alles Weitere.",
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ 1 */
  {
    id: "gatter",
    num: 1,
    title: "Gatter und die Allmacht von NAND",
    lead: "Die sechs wichtigsten Gatter, ihre Wahrheitstabellen – und warum man mit einem einzigen Typ alle anderen bauen kann.",
    blocks: [
      {
        t: "html",
        html: `
<p>Ein Gatter ist eine <b>Funktion</b> von Bits auf Bits. Weil es nur wenige Eingangskombinationen gibt, lässt sich jedes Gatter vollständig durch eine <b>Wahrheitstabelle</b> beschreiben: eine Zeile pro Kombination, dazu der Ausgang. Unten siehst du alle sechs nebeneinander. Die Wahrheitstabelle neben der Schaltung wird live aus der <i>echten</i> Simulation berechnet; die Zeile deiner aktuellen Schalterstellung ist hervorgehoben, und ein Klick auf eine Zeile stellt die Schalter entsprechend ein.</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "labor",
          title: "Live: Gatter-Labor",
          caption: "Beide Eingänge A und B gehen an sechs Gatter gleichzeitig. Ein Ausgang kann beliebig viele Eingänge speisen (<b>Fan-out</b>); ein Eingang dagegen hat immer genau einen Treiber.",
          build: C.gateLab,
          height: 330,
          table: { ins: ["A", "B"], outs: ["AND", "OR", "NAND", "NOR", "XOR", "XNOR"] },
          tasks: [
            task("xor-nand", "Finde die Eingabe, bei der <b>XOR</b>, <b>OR</b> und <b>NAND</b> zugleich 1 sind.", (r) => r.get("XOR") === 1 && r.get("OR") === 1 && r.get("NAND") === 1, set({ A: 1, B: 0 }), "Genau ein Eingang ist 1 (A=1, B=0 oder umgekehrt): XOR = 1, OR = 1, und weil nicht beide 1 sind, ist NAND = 1."),
            task("and-xnor", "Finde die Eingabe, bei der <b>AND</b> und <b>XNOR</b> beide 1 sind.", (r) => r.get("AND") === 1 && r.get("XNOR") === 1, set({ A: 1, B: 1 }), "XNOR bedeutet „gleich“. Gleich <i>und</i> AND = 1 gibt es nur bei A = B = 1."),
          ],
          steps: [
            "Zwei <b>Eingänge</b> (A, B) setzen.",
            "Aus der Palette die Gatter <b>AND, OR, NAND, NOR, XOR, XNOR</b> untereinander platzieren.",
            "Jeden der beiden Eingänge mit Eingang A bzw. B <i>aller</i> sechs Gatter verbinden (ein Ausgang darf mehrere Kabel haben).",
            "An jedes Gatter einen <b>Ausgang</b> hängen und beschriften.",
            "Schalter umlegen und die Tabelle im Kopf mitlesen.",
          ],
        },
      },
      {
        t: "html",
        html: `
<h3>NAND ist universell</h3>
<p>Das NAND-Gatter ist ein AND mit nachgeschaltetem NOT. Erstaunlich: Mit <b>nur NAND-Gattern</b> lässt sich jede logische Funktion bauen. Drei Tricks genügen:</p>
<ul>
<li><b>NOT:</b> Beide NAND-Eingänge zusammenschalten: <code>NAND(A, A) = NOT A</code>.</li>
<li><b>AND:</b> Ein NAND und danach ein NOT (also noch ein NAND mit zusammengeschalteten Eingängen): <code>AND(A, B) = NAND(NAND(A, B), NAND(A, B))</code>.</li>
<li><b>OR:</b> Erst beide Eingänge invertieren, dann NAND: <code>OR(A, B) = NAND(NOT A, NOT B)</code> – das ist <b>De Morgan</b>: „nicht (nicht A und nicht B)“ heißt „A oder B“.</li>
</ul>
<p>Echte Chips nutzen das aus: Ein NAND braucht in CMOS-Technik nur vier Transistoren und ist schnell. Für uns ist die Erkenntnis wichtiger: Alles, was folgt, könnte man ausschließlich aus NAND bauen – wir nehmen der Lesbarkeit halber AND/OR/XOR.</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "nand",
          title: "Live: NOT, AND und OR nur aus NAND",
          build: C.nandUniversal,
          height: 400,
          table: { ins: ["A", "B"], outs: ["NOT", "AND", "OR"] },
          tasks: [
            task("nand-mix", "Setze A und B so, dass <b>NOT A</b> und <b>OR</b> gleich 1 sind, <b>AND</b> aber 0 ist.", (r) => r.get("NOT") === 1 && r.get("OR") === 1 && r.get("AND") === 0, set({ A: 0, B: 1 }), "NOT A = 1 verlangt A = 0. OR = 1 braucht dann B = 1. AND ist bei A = 0 automatisch 0."),
          ],
          steps: [
            "Eingänge A und B setzen und <b>fünf NAND-Gatter</b> bereitlegen … sogar sechs: eines für NOT, zwei für AND, drei für OR.",
            "<b>NOT:</b> Eingang A an <i>beide</i> Eingänge eines NAND legen.",
            "<b>AND:</b> NAND(A, B) bilden; sein Ausgang geht an beide Eingänge eines zweiten NAND.",
            "<b>OR:</b> A an beide Eingänge eines NAND, B an beide Eingänge eines zweiten NAND; deren Ausgänge in ein drittes NAND.",
            "Mit der Wahrheitstabelle gegenprüfen.",
          ],
        },
      },
      {
        t: "merk",
        items: [
          "Eine Wahrheitstabelle beschreibt ein Gatter vollständig: Zeile je Eingangskombination.",
          "AND = „beide“, OR = „mindestens eins“, XOR = „genau eins“ (ungleich), NAND/NOR/XNOR sind die Gegenteile.",
          "NAND (und ebenso NOR) ist <b>universell</b>: Aus ihm lassen sich NOT, AND, OR und damit alles bauen.",
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ 2 */
  {
    id: "halbaddierer",
    num: 2,
    title: "Der Halbaddierer",
    lead: "Rechnen mit Gattern: zwei einzelne Bits addieren.",
    blocks: [
      {
        t: "html",
        html: `
<p>Wie addiert man zwei Bits? Es gibt nur vier Fälle:</p>
<table class="plain">
<tr><th>A</th><th>B</th><th>A + B</th><th>Übertrag (Carry)</th><th>Summenbit (Sum)</th></tr>
<tr><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>
<tr><td>0</td><td>1</td><td>1</td><td>0</td><td>1</td></tr>
<tr><td>1</td><td>0</td><td>1</td><td>0</td><td>1</td></tr>
<tr><td>1</td><td>1</td><td>2 = <code>10</code></td><td>1</td><td>0</td></tr>
</table>
<p>Das Ergebnis passt nicht immer in ein Bit: 1 + 1 = <code>10</code> (binär). Wie im Dezimalsystem bei 9 + 1 schreibt man die 0 hin und „merkt sich“ einen <b>Übertrag</b> in die nächste Stelle. Schaut man genau hin, sind beide Spalten bekannte Gatter:</p>
<ul>
<li><b>Summenbit = A XOR B</b> (genau dann 1, wenn die Bits verschieden sind)</li>
<li><b>Übertrag = A AND B</b> (nur 1 + 1 erzeugt einen Übertrag)</li>
</ul>
<p>Zwei Gatter – das ist ein <b>Halbaddierer</b>. „Halb“, weil er <i>keinen</i> Übertrag von einer niedrigeren Stelle entgegennehmen kann. Für die niederwertigste Stelle einer Zahl reicht er, für alle anderen brauchen wir im nächsten Kapitel mehr.</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "ha",
          title: "Live: Halbaddierer",
          build: C.halfAdderDemo,
          height: 190,
          table: { ins: ["A", "B"], outs: ["S", "C"] },
          readout: (r) => `${r.get("A")} + ${r.get("B")} = ${r.get("A") + r.get("B")} (binär ${bin(r.get("A") + r.get("B"), 2)}) → Übertrag ${r.get("C")}, Summe ${r.get("S")}`,
          tasks: [
            task("ha-11", "Berechne 1 + 1: Es soll <b>Summe 0</b> und <b>Übertrag 1</b> herauskommen.", (r) => r.get("S") === 0 && r.get("C") === 1 && r.get("A") === 1 && r.get("B") === 1, set({ A: 1, B: 1 }), "1 + 1 = <code>10</code>: Summenbit 0, Übertrag 1."),
            task("ha-s1", "Finde eine Eingabe mit <b>Summe 1 und Übertrag 0</b>.", (r) => r.get("S") === 1 && r.get("C") === 0, set({ A: 1, B: 0 }), "Genau ein Eingang 1: 1 + 0 = 1, kein Übertrag."),
          ],
          steps: [
            "Zwei <b>Eingänge</b> A und B, ein <b>XOR</b>, ein <b>AND</b> und zwei <b>Ausgänge</b> (Summe, Übertrag) platzieren.",
            "A und B jeweils an <i>beide</i> Gatter führen.",
            "XOR → Ausgang „Summe“, AND → Ausgang „Übertrag“.",
            "Alle vier Eingangskombinationen testen.",
          ],
        },
      },
      {
        t: "merk",
        items: ["Summenbit = A XOR B, Übertrag = A AND B.", "Ein Halbaddierer addiert zwei Bits, nimmt aber keinen Übertrag von rechts an."],
      },
    ],
  },

  /* ------------------------------------------------------------------ 3 */
  {
    id: "volladdierer",
    num: 3,
    title: "Der Volladdierer",
    lead: "Drei Bits addieren: A, B und den Übertrag der Stelle davor.",
    blocks: [
      {
        t: "html",
        html: `
<p>Beim schriftlichen Addieren stehen in jeder Spalte <i>drei</i> Dinge: die zwei Ziffern und der Übertrag der Spalte rechts. Ein <b>Volladdierer</b> (engl. <i>full adder</i>) kann das: Eingänge <b>A, B, Cin</b>, Ausgänge <b>Summe S</b> und <b>Cout</b>. Das Maximum ist 1 + 1 + 1 = 3 = <code>11</code> – immer noch zwei Bits, also reicht <i>ein</i> Übertragsbit.</p>
<p>Bauweise: zwei Halbaddierer hintereinander.</p>
<ol>
<li>Der erste addiert A und B: <code>x = A XOR B</code>, <code>c1 = A AND B</code>.</li>
<li>Der zweite addiert x und Cin: <code>S = x XOR Cin</code>, <code>c2 = x AND Cin</code>.</li>
<li>Ein Übertrag entsteht, wenn <i>einer</i> der beiden Halbaddierer einen erzeugt hat – beide gleichzeitig kommt nie vor: <code>Cout = c1 OR c2</code>.</li>
</ol>
<p>Merke: <b>S = A ⊕ B ⊕ Cin</b> (ungerade Anzahl Einsen), <b>Cout = Mehrheit</b> (mindestens zwei Einsen).</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "fa",
          title: "Live: Volladdierer aus 5 Gattern",
          build: C.fullAdderDemo,
          height: 230,
          table: { ins: ["A", "B", "CIN"], outs: ["S", "COUT"] },
          readout: (r) => {
            const t = r.get("A") + r.get("B") + r.get("CIN");
            return `${r.get("A")} + ${r.get("B")} + ${r.get("CIN")} = ${t} (binär ${bin(t, 2)})`;
          },
          tasks: [
            task("fa-111", "Berechne 1 + 1 + 1: Summe 1, Cout 1.", (r) => r.get("A") + r.get("B") + r.get("CIN") === 3 && r.get("S") === 1 && r.get("COUT") === 1, set({ A: 1, B: 1, CIN: 1 }), "3 = <code>11</code>: Summenbit 1, Übertrag 1."),
            task("fa-c", "Finde eine Eingabe mit <b>Cout = 1 aber S = 0</b>.", (r) => r.get("COUT") === 1 && r.get("S") === 0, set({ A: 1, B: 1, CIN: 0 }), "Zwei Einsen: 2 = <code>10</code>. (Auch A=1, Cin=1 oder B=1, Cin=1 geht.)"),
          ],
          steps: [
            "Eingänge A, B, Cin setzen.",
            "<b>Halbaddierer 1:</b> XOR (A, B) und AND (A, B).",
            "<b>Halbaddierer 2:</b> XOR (Ausgang des ersten XOR, Cin) → <b>Summe</b>; AND (derselbe XOR-Ausgang, Cin).",
            "<b>OR</b> aus den beiden AND-Ausgängen → <b>Cout</b>.",
            "Tipp: Danach alle 5 Gatter markieren und über „Modul aus Auswahl“ zu einem eigenen Modul „Volladdierer“ machen – dann kannst du es wiederverwenden (nächstes Kapitel).",
          ],
        },
      },
      { t: "merk", items: ["Volladdierer = 2 Halbaddierer + OR für die Überträge.", "S = A ⊕ B ⊕ Cin; Cout = 1, wenn mindestens zwei Eingänge 1 sind."] },
    ],
  },

  /* ------------------------------------------------------------------ 4 */
  {
    id: "mehrbit",
    num: 4,
    title: "Mehrbit-Addierer",
    lead: "Volladdierer in einer Kette: Ripple-Carry, Überlauf und wie aus 4 Bit 8 Bit werden.",
    blocks: [
      {
        t: "html",
        html: `
<p>Um Zahlen mit mehreren Bits zu addieren, schaltet man Volladdierer <b>hintereinander</b>: Der Übertrag <code>Cout</code> der Stelle <i>i</i> wird zum <code>Cin</code> der Stelle <i>i+1</i>. Die niederwertigste Stelle bekommt Cin = 0 (oder einen eigenen Eingang). Weil der Übertrag wie eine Welle durch die Kette „plätschert“, heißt das <b>Ripple-Carry-Addierer</b>.</p>
<p>Damit jede Stelle ihre Bits bekommt, werden die Busse mit <b>Splittern</b> in Einzelbits zerlegt, und die Summenbits mit einem <b>Joiner</b> wieder zu einem Bus zusammengesetzt. (Zur Erinnerung: in der Sandbox zeigt der Splitter-Ausgang <code>b0</code> das niederwertigste Bit.)</p>
<h3>Überlauf</h3>
<p>Ein 4-Bit-Addierer kann nur 0…15 darstellen. Ergibt 9 + 7 = 16 = <code>1 0000</code>, fällt das fünfte Bit hinaus – es erscheint als <b>Cout</b> des letzten Volladdierers (<b>Carry-Flag</b>). Bei vorzeichenloser Zahlendarstellung bedeutet Cout = 1: „Das Ergebnis war zu groß, das Summenfeld enthält nur die unteren Bits“ (Rechnen modulo 2<sup>n</sup>). Das ist kein Fehler der Schaltung, sondern die Natur fester Bitbreite.</p>
<h3>Von 4 auf 8 Bit</h3>
<p>Mehr Bits heißt einfach: mehr Volladdierer in der Kette – 8 Bit brauchen 8 Stück (40 Gatter). Das Prinzip ändert sich nicht. Der Preis ist die <b>Laufzeit</b>: Das letzte Bit muss warten, bis der Übertrag durch <i>alle</i> Stellen gelaufen ist. Schnelle Prozessoren nutzen deshalb <i>Carry-Lookahead</i>-Schaltungen, die Überträge parallel vorausberechnen. Die Sandbox rechnet die Gatter in einem Durchgang durch (ohne Laufzeiten); unten siehst du die Welle deshalb als Animation.</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "add4",
          title: "Live: 4-Bit-Addierer",
          caption: "Die Volladdierer sind im Zickzack angeordnet: Bit 0 → Bit 1 (obere Reihe), dann Bit 2 ← Bit 3 (untere Reihe, der Übertrag läuft zurück). Probiere 9 + 7!",
          build: C.adder4,
          height: 420,
          readout: (r) => {
            const s = r.get("A") + r.get("B") + r.get("CIN");
            return `${r.get("A")} + ${r.get("B")} + ${r.get("CIN")} = ${s} → Summe ${r.get("SUM")}, Cout ${r.get("COUT")}${s > 15 ? " (Überlauf: " + s + " passt nicht in 4 Bit)" : ""}`;
          },
          tasks: [
            task("add-ovf", "Löse einen <b>Überlauf</b> aus: Cout = 1 mit A = 9 und B = 7.", (r) => r.get("A") === 9 && r.get("B") === 7 && r.get("COUT") === 1 && r.get("SUM") === 0, set({ A: 9, B: 7 }), "9 + 7 = 16 = <code>1 0000</code>: Die unteren vier Bits sind 0, das fünfte Bit erscheint als Cout."),
            task("add-15", "Finde zwei <b>von 0 verschiedene</b> Zahlen A, B mit Summe 15 ohne Überlauf.", (r) => r.get("A") > 0 && r.get("B") > 0 && r.get("SUM") === 15 && r.get("COUT") === 0 && r.get("CIN") === 0, set({ A: 8, B: 7 }), "z. B. 8 + 7 = 15 = <code>1111</code>. Wenn sich die Einsen der Zahlen nicht überlappen, entsteht nie ein Übertrag."),
          ],
          steps: [
            "Zwei 4-Bit-<b>Eingänge</b> A, B und einen 1-Bit-Eingang Cin setzen (Breite im Eigenschaften-Panel).",
            "Je einen <b>Splitter</b> (Breite 4) dahinter: er zerlegt den Bus in b3…b0.",
            "Vier <b>Volladdierer</b> bauen (5 Gatter, siehe Kapitel 3) – oder den ersten bauen, als Modul speichern und vier Instanzen platzieren.",
            "Bit i von A und B an Volladdierer i; Cin an Volladdierer 0. <b>Cout von i → Cin von i+1</b>.",
            "Die vier Summenbits mit einem <b>Joiner</b> (Breite 4) zusammensetzen – der Eingang b0 des Joiners ist das niederwertigste Bit. Joiner → Ausgang (Breite 4).",
            "Cout des letzten Volladdierers an einen eigenen 1-Bit-Ausgang „Cout“.",
          ],
        },
      },
      { t: "widget", name: "ripple" },
      { t: "merk", items: ["Ripple-Carry: Cout jeder Stelle speist das Cin der nächsten.", "Splitter zerlegen Busse in Bits, Joiner setzen sie zusammen.", "Cout = 1 bei vorzeichenloser Addition heißt: Ergebnis passt nicht in die Bitbreite (Überlauf).", "Mehr Bits = mehr Volladdierer, aber längere Laufzeit durch die Übertragskette."] },
    ],
  },

  /* ------------------------------------------------------------------ 5 */
  {
    id: "subtrahieren",
    num: 5,
    title: "Subtrahieren, Zweierkomplement, Flags",
    lead: "Der Addierer kann auch subtrahieren – mit einem Trick aus XOR-Gattern. Dazu: wie die CPU Ergebnisse „bewertet“.",
    blocks: [
      {
        t: "html",
        html: `
<h3>Negative Zahlen: das Zweierkomplement</h3>
<p>Wie stellt man −3 mit Bits dar? Der Standard ist das <b>Zweierkomplement</b>: Bei n Bit gilt die Zahl <code>x</code> mit gesetztem MSB als <code>x − 2<sup>n</sup></code>. Bei 4 Bit ist <code>1111</code> also 15 − 16 = <b>−1</b>, und <code>1101</code> ist 13 − 16 = −3. Wertebereich: −8…+7. Das MSB wirkt wie ein Vorzeichen (<b>Negative-Flag</b>).</p>
<p>Der große Vorteil: <b>Der Addierer muss nichts wissen</b>. Weil modulo 2<sup>n</sup> gerechnet wird, ergibt 5 + (−3) = <code>0101 + 1101</code> = <code>1 0010</code> → ohne das Übertragsbit <code>0010</code> = 2. Dasselbe Bauteil rechnet mit und ohne Vorzeichen.</p>
<h3>Subtrahieren = Addieren des Komplements</h3>
<p>Das Zweierkomplement von B bekommt man so: <b>alle Bits invertieren und 1 addieren</b> (−B = ~B + 1). Also gilt <code>A − B = A + ~B + 1</code>. Das lässt sich fast ohne Mehraufwand bauen:</p>
<ul>
<li>Jedes Bit von B läuft durch ein <b>XOR mit dem Steuerbit SUB</b>. XOR mit 0 lässt ein Bit unverändert, XOR mit 1 invertiert es – ein steuerbarer Inverter.</li>
<li>Dasselbe Signal SUB wird als <b>Übertrag in die niederwertigste Stelle</b> (Cin) eingespeist – das ist das „+1“.</li>
</ul>
<p>Ergebnis: Mit SUB = 0 addiert die Schaltung, mit SUB = 1 subtrahiert sie. Genau so arbeitet die ALU der Mini-CPU (Kapitel 6).</p>
<h3>Flags: die Schaltung bewertet ihr Ergebnis</h3>
<ul>
<li><b>Z (Zero):</b> 1, wenn <i>alle</i> Ergebnisbits 0 sind – ein großes NOR/„ODER aller Bits, dann NOT“. Grundlage für bedingte Sprünge (<code>JZ</code>, <code>JNZ</code>).</li>
<li><b>N (Negative):</b> das MSB des Ergebnisses.</li>
<li><b>C (Carry):</b> der Übertrag aus der obersten Stelle. Bei Subtraktion ist <b>C = 1 gleichbedeutend mit „kein Borgen nötig“</b> (A ≥ B vorzeichenlos); C = 0 heißt A &lt; B.</li>
</ul>`,
      },
      {
        t: "demo",
        demo: {
          id: "addsub",
          title: "Live: Addierer/Subtrahierer (4 Bit) mit Flags",
          build: C.addSub4,
          height: 440,
          readout: (r) => {
            const a = r.get("A");
            const b = r.get("B");
            const res = r.get("ERG");
            const sgn = res >= 8 ? res - 16 : res;
            return `${a} ${r.get("SUB") ? "−" : "+"} ${b} → ${res} (als Zahl mit Vorzeichen: ${sgn}) · Flags: Z=${r.get("Z")} N=${r.get("N")} C=${r.get("C")}`;
          },
          tasks: [
            task("sub-neg", "Berechne <b>3 − 5</b>. Das Ergebnis soll 14 (= −2) sein und das N-Flag setzen.", (r) => r.get("SUB") === 1 && r.get("A") === 3 && r.get("B") === 5 && r.get("ERG") === 14 && r.get("N") === 1, set({ A: 3, B: 5, SUB: 1 }), "3 + ~5 + 1 = 0011 + 1010 + 1 = <code>1110</code> = 14 = −2 (Zweierkomplement). Das MSB ist 1 → N = 1; es gab keinen Übertrag → C = 0 (hier: „geborgt“)."),
            task("sub-zero", "Subtrahiere zwei gleiche, von 0 verschiedene Zahlen, sodass das <b>Zero-Flag</b> gesetzt ist.", (r) => r.get("SUB") === 1 && r.get("A") === r.get("B") && r.get("A") !== 0 && r.get("Z") === 1, set({ A: 6, B: 6, SUB: 1 }), "A − A = 0: Alle Ergebnisbits sind 0, das NOR über alle Bits liefert Z = 1. Gleichzeitig ist C = 1 (kein Borgen)."),
          ],
          steps: [
            "Den 4-Bit-Addierer aus Kapitel 4 übernehmen (oder neu bauen) und einen Eingang <b>SUB</b> (1 Bit) ergänzen.",
            "Zwischen die B-Splitter-Ausgänge und die Volladdierer je ein <b>XOR</b> setzen: B-Bit an Eingang A, SUB an Eingang B des XOR; Ausgang → Volladdierer.",
            "SUB zusätzlich an das <b>Cin</b> des niederwertigsten Volladdierers.",
            "<b>Negative:</b> Ergebnisbit 3 mit einem 1-Bit-Ausgang verbinden (Splitter hinter dem Ergebnis-Joiner).",
            "<b>Zero:</b> die vier Ergebnisbits mit OR-Gattern zusammenfassen (OR(b0,b1), OR(b2,b3), OR der beiden) und ein NOT dahinter.",
            "<b>Carry:</b> Cout des letzten Volladdierers an einen Ausgang.",
          ],
        },
      },
      { t: "merk", items: ["Zweierkomplement: −B = ~B + 1; das MSB ist das Vorzeichenbit.", "A − B = A + (B XOR SUB) + SUB: XOR invertiert B, Cin liefert das +1.", "Flags: Z = alle Bits 0, N = MSB, C = Übertrag aus der obersten Stelle."] },
    ],
  },
];
