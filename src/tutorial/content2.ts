import * as C from "./circuits";
import { Chapter } from "./types";
import { bin, hx, task, SB } from "./content1";
import { Rig } from "./rig";
import { controlRomContents } from "./isa";

const set =
  (vals: Record<string, number>) =>
  (r: Rig): void => {
    for (const [k, v] of Object.entries(vals)) r.set(k, v);
  };

/** Ein Takt, nachdem Eingänge gesetzt wurden. */
const clock =
  (vals: Record<string, number>, steps = 1) =>
  (r: Rig): void => {
    for (const [k, v] of Object.entries(vals)) r.set(k, v);
    r.step(steps);
  };

export const chapters2: Chapter[] = [
  /* ------------------------------------------------------------------ 6 */
  {
    id: "alu",
    num: 6,
    title: "Multiplexer, Logikeinheit und ALU",
    lead: "Wie eine Schaltung „auswählt“, was sie rechnet: der Weg vom Mux zur Arithmetic Logic Unit.",
    blocks: [
      {
        t: "html",
        html: `
<h3>Der Multiplexer: ein Wahlschalter für Signale</h3>
<p>Eine ALU kann mehrere Dinge – addieren, subtrahieren, UND, ODER … – aber an ihrem Ausgang liegt immer nur <i>ein</i> Ergebnis. Man braucht also eine Schaltung, die aus mehreren Kandidaten genau einen durchlässt: den <b>Multiplexer</b> (kurz <b>Mux</b>).</p>
<p>Der einfachste Mux hat zwei Datenleitungen A, B und eine Wahlleitung S: <code>Y = (A AND ¬S) OR (B AND S)</code>. Ist S = 0, ist das rechte AND gesperrt und A läuft durch; bei S = 1 umgekehrt. Das AND wirkt wie ein <b>Tor</b>: „Maske 0“ sperrt (Ausgang 0), „Maske 1“ lässt durch. Das ODER sammelt die Beiträge ein, von denen höchstens einer ungleich 0 ist.</p>
<h3>Der Masken-Trick für Busse</h3>
<p>Bei breiten Zahlen müsste man das Wahlbit an jedes Bit einzeln führen. Die Sandbox hat dafür einen Trick: Ein Wahlbit wird mit einem <b>Joiner</b> auf alle n Leitungen eines Busses verteilt (z. B. <code>1</code> → <code>1111</code>). Dieses <b>Maskenwort</b> wird dann mit einem <i>breiten</i> AND-Gatter auf den ganzen Datenbus angewendet. So genügen drei breite Gatter für einen n-Bit-Mux.</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "mux1",
          title: "Live: 1-Bit-Multiplexer",
          build: C.mux1,
          height: 230,
          table: { ins: ["A", "B", "S"], outs: ["Y"] },
          tasks: [
            task("mux1-b", "Wähle mit S den Eingang B aus, während A = 1 und B = 0 ist: Y soll 0 sein.", (r) => r.get("S") === 1 && r.get("A") === 1 && r.get("B") === 0 && r.get("Y") === 0, set({ A: 1, B: 0, S: 1 }), "S = 1 öffnet nur das B-Tor: Y = B = 0, obwohl A = 1 ist – A wird von der Maske gesperrt."),
          ],
          steps: ["Eingänge A, B, S setzen.", "Ein NOT für S, zwei AND (A mit ¬S, B mit S), ein OR.", "OR-Ausgang an einen Ausgang Y."],
        },
      },
      {
        t: "demo",
        demo: {
          id: "mux4",
          title: "Live: 4-Bit-Multiplexer mit Maskenwort",
          caption: "Das Wahlbit S (und sein Gegenteil) wird per Joiner auf alle vier Bit-Leitungen verteilt.",
          build: C.mux4,
          height: 380,
          tasks: [
            task("mux4-b", "Stelle S so ein, dass Y = B = 6 ist.", (r) => r.get("Y") === r.get("B") && r.get("B") !== r.get("A"), set({ S: 1 }), "S = 1 wählt B (0110 = 6)."),
          ],
          steps: [
            "Zwei 4-Bit-Eingänge A, B und 1-Bit-Eingang S.",
            "Ein NOT für S.",
            "Je einen <b>Joiner</b> (Breite 4), dessen vier Eingänge alle mit demselben Wahlbit verbunden sind (Maskenwort).",
            "Breite AND-Gatter (Breite 4): A mit Maske ¬S, B mit Maske S.",
            "Breites OR (Breite 4) → Ausgang.",
            SB.props,
          ],
        },
      },
      {
        t: "html",
        html: `
<h3>Die Logikeinheit</h3>
<p>Breite Gatter bearbeiten alle Bits gleichzeitig: Ein 4-Bit-AND verknüpft Bit 0 mit Bit 0, Bit 1 mit Bit 1 usw. (<b>bitweise</b>). Wenn man AND, OR, XOR und NOT <i>alle</i> rechnen lässt und danach per Mux das gewünschte Ergebnis nimmt, hat man eine <b>Logikeinheit</b>. Die Auswahl erfolgt über einen <b>Decoder</b>: Ein 2-Bit-Code (<code>SEL</code>) wird in vier Einzelleitungen „one-hot“ umgesetzt – genau eine ist 1 – und jede Leitung öffnet das Tor ihres Ergebnisses.</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "logic",
          title: "Live: Logikeinheit (AND / OR / XOR / NOT A)",
          caption: "SEL: 0 = AND, 1 = OR, 2 = XOR, 3 = NOT A. Alle vier Ergebnisse werden parallel berechnet – SEL entscheidet nur, welches durchkommt.",
          build: C.logicUnit,
          height: 430,
          readout: (r) => {
            const a = r.get("A");
            const b = r.get("B");
            const names = ["AND", "OR", "XOR", "NOT A"];
            return `A = ${bin(a, 4)}, B = ${bin(b, 4)}, ${names[r.get("SEL")]} → Y = ${bin(r.get("Y"), 4)}`;
          },
          tasks: [
            task("logic-xor", "Wähle XOR und prüfe: Y = 0110 bei A = 1100, B = 1010.", (r) => r.get("SEL") === 2 && r.get("A") === 12 && r.get("B") === 10 && r.get("Y") === 6, set({ A: 12, B: 10, SEL: 2 }), "XOR = 1, wo sich die Bits unterscheiden: 1100 ⊕ 1010 = 0110."),
          ],
          steps: [
            "A, B (4 Bit) und SEL (2 Bit) als Eingänge, SEL über einen Splitter in zwei Bits teilen.",
            "NOT für beide Auswahlbits; je Modus ein AND aus den passenden (negierten oder echten) Bits → <b>Decoder</b>.",
            "Breite Gatter AND, OR, XOR, NOT (Breite 4) auf A und B.",
            "Pro Ergebnis Maskenwort (Joiner) und breites AND als Tor; alle Beiträge mit breiten ORs sammeln.",
          ],
        },
      },
      {
        t: "html",
        html: `
<h3>Die ALU der Mini-CPU</h3>
<p>Eine <b>ALU</b> (<i>Arithmetic Logic Unit</i>) vereint Rechenwerk und Logikeinheit. Die ALU unserer CPU (in <code>cpu.ts</code> als <code>buildAlu</code>) hat dieselbe Gliederung wie die Schaltung unten (dort mit 4 Bit, in der CPU mit 8):</p>
<ol>
<li><b>Decoder:</b> Der 3-Bit-Modus wird zu einer one-hot-Leitung je Operation.</li>
<li><b>Freigabe EN:</b> Ist EN = 0, wird jede Rechenoperation gesperrt, die ALU „hält“ A.</li>
<li><b>Addierer/Subtrahierer:</b> B läuft durch XOR mit dem SUB-Signal, Cin = SUB (Kapitel 5).</li>
<li><b>Logikgatter</b> AND, OR, XOR rechnen parallel.</li>
<li><b>Masken und ODER-Sammler</b> wählen das Ergebnis aus: genau ein Tor ist offen.</li>
</ol>
<p>Modi: <code>0</code> halten (F = A), <code>1</code> ADD, <code>2</code> SUB, <code>3</code> AND, <code>4</code> OR, <code>5</code> XOR, <code>6</code> durchleiten (F = B), <code>7</code> null. Das <i>Durchleiten</i> von B braucht man zum Laden von Werten in den Akku (<code>LDA</code>).</p>
<p>Wichtig: Alle Operationen rechnen <b>gleichzeitig</b>. Eine ALU „führt nicht nacheinander aus“ – sie ist reine Kombinatorik; nur das Auswahltor entscheidet.</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "alu4",
          title: "Live: 4-Bit-ALU (Struktur wie in der CPU)",
          caption: "Beschriftete Kästen im Bild: ① Decoder, ② Freigabe, ③ Addierer mit XOR, ④ Logik, ⑤ Masken, ⑥ ODER-Sammler. Tipp: <b>Groß-Ansicht</b> nutzen.",
          build: C.alu4,
          height: 520,
          readout: (r) => {
            const m = r.get("MODE");
            return `Modus ${m} = ${C.ALU_MODES[m]}${r.get("EN") ? "" : " (EN = 0 → hält A)"} · F = ${r.get("F")} (${bin(r.get("F"), 4)})`;
          },
          tasks: [
            task("alu-sub", "Berechne 9 − 4 (Modus SUB). F soll 5 sein.", (r) => r.get("MODE") === 2 && r.get("EN") === 1 && r.get("A") === 9 && r.get("B") === 4 && r.get("F") === 5, set({ A: 9, B: 4, MODE: 2, EN: 1 }), "Modus 2 (SUB): 9 + ~4 + 1 = 1001 + 1011 + 1 = 1 0101 → F = 0101 = 5."),
            task("alu-xor", "Setze XOR mit A = 12 und B = 10 ein. F soll 6 sein.", (r) => r.get("MODE") === 5 && r.get("EN") === 1 && r.get("A") === 12 && r.get("B") === 10 && r.get("F") === 6, set({ A: 12, B: 10, MODE: 5, EN: 1 }), "Modus 5 = XOR: 1100 ⊕ 1010 = 0110 = 6."),
            task("alu-hold", "Schalte EN aus: Die ALU soll bei Modus ADD (A = 7, B = 3) nur A = 7 durchreichen.", (r) => r.get("EN") === 0 && r.get("MODE") === 1 && r.get("A") === 7 && r.get("B") === 3 && r.get("F") === 7, set({ A: 7, B: 3, MODE: 1, EN: 0 }), "Ohne Freigabe sperren alle Tore außer „Halten“ (dort wird ¬EN mit dem Modus verodert). F = A = 7."),
          ],
          steps: [
            "<b>Eingänge:</b> A, B (Breite n), MODUS (3 Bit), EN (1 Bit). Splitter für A, B, MODUS.",
            "<b>Decoder:</b> drei NOT-Gatter für die Modusbits, pro Modus zwei AND-Gatter verketten (Modus = Bits von links nach rechts); ergibt sieben Einzelleitungen.",
            "<b>Freigabe:</b> jede Leitung (außer „halten“) mit EN verunden; „halten“ = (Modus 0) OR (NOT EN).",
            "<b>Addierer:</b> Ripple-Carry wie in Kapitel 4 plus XOR (B ⊕ SUB) wie in Kapitel 5; SUB-Leitung = ADD/SUB-Freigabe aus dem Decoder.",
            "<b>Logik:</b> je ein breites AND/OR/XOR direkt auf A und B.",
            "<b>Masken:</b> jede Freigabe per Joiner auf n Bit verbreitern, mit dem jeweiligen Ergebnis (A, B, Summe, AND, OR, XOR) verunden.",
            "<b>Sammler:</b> alle Beiträge mit breiten OR-Gattern zusammenführen → Ausgang F.",
            "Alle Modi mit mehreren Zahlen durchprobieren.",
          ],
        },
      },
      {
        t: "merk",
        items: [
          "Mux = Tore (AND mit Maske) + Sammler (OR): genau ein Tor offen.",
          "Breite Gatter wirken bitweise auf ganze Busse; ein Maskenwort entsteht, indem ein Bit auf alle Leitungen verteilt wird.",
          "ALU = Decoder + Addierer/Subtrahierer + Logikgatter + Auswahl; alle Operationen werden parallel berechnet.",
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ 7 */
  {
    id: "speichern",
    num: 7,
    title: "Speichern: Latch, Flip-Flop, Register",
    lead: "Bisher hing jeder Ausgang nur vom aktuellen Eingang ab. Jetzt entsteht ein Gedächtnis – und mit ihm der Takt.",
    blocks: [
      {
        t: "html",
        html: `
<h3>Kombinatorisch vs. sequentiell</h3>
<p>Gatter-Schaltungen ohne Rückkopplung sind <b>kombinatorisch</b>: Der Ausgang ist eine reine Funktion der Eingänge. Um etwas zu <b>speichern</b>, muss ein Ausgang auf einen Eingang <i>zurückwirken</i> – die Schaltung muss ihren eigenen Zustand „sehen“. Dann hängt das Ergebnis auch von der Vergangenheit ab: Die Schaltung ist <b>sequentiell</b>.</p>
<h3>Das SR-Latch aus zwei NOR-Gattern</h3>
<p>Zwei NOR-Gatter, über Kreuz gekoppelt: Der Ausgang von jedem geht in den Eingang des anderen. Es gibt zwei Steuereingänge: <b>Set</b> (S) und <b>Reset</b> (R). Mit S = 1 geht Q auf 1, mit R = 1 auf 0 – und bei S = R = 0 <b>bleibt der alte Wert</b>, weil sich die Gatter gegenseitig festhalten. S = R = 1 ist verboten (beide Ausgänge wären 0, und beim Loslassen ist das Ergebnis zufällig).</p>
<p>Die Simulation der Sandbox rechnet jedes Gatter genau einmal in fester Reihenfolge und erlaubt <b>keine Rückkopplungsschleifen</b> aus Gattern. Deshalb gibt es dort Latch und Flip-Flop als fertige Bauteile; das SR-Latch unten ist ein eigenes kleines Modell, das genau diese Gatterschleife nachrechnet.</p>`,
      },
      { t: "widget", name: "srlatch" },
      {
        t: "html",
        html: `
<h3>Der D-Latch: pegelgesteuert</h3>
<p>Aus dem SR-Latch macht man mit etwas Zusatzlogik einen handlicheren Speicher: Der <b>D-Latch</b> hat einen Dateneingang <b>D</b> und ein <b>Enable</b> (EN). Solange EN = 1, folgt Q dem Eingang D („transparent“). Sobald EN auf 0 fällt, friert Q den letzten Wert ein. Der Latch reagiert auf einen <i>Pegel</i>: Während EN hoch ist, kann sich Q beliebig oft ändern. In getakteten Schaltungen ist das gefährlich – ein Wert könnte durch mehrere Stufen „durchrutschen“.</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "latch",
          title: "Live: D-Latch",
          build: C.latchDemo,
          height: 190,
          tasks: [
            task("latch-hold", "Speichere eine 1 und friere sie ein: Q = 1 bei EN = 0 und D = 0.", (r) => r.get("Q") === 1 && r.get("EN") === 0 && r.get("D") === 0, (r) => {
              r.set("EN", 1);
              r.set("D", 1);
              r.set("EN", 0);
              r.set("D", 0);
            }, "Reihenfolge: EN = 1, D = 1 → Q = 1 (transparent). Dann zuerst EN = 0 (einfrieren), erst danach D = 0 – Q bleibt 1."),
          ],
          steps: ["Palette: <b>Latch</b> (Kategorie Speicher) platzieren.", "Eingang D an den ersten, Eingang EN an den zweiten Pin.", "Ausgänge Q und Q̄ anschließen.", "Probiere: EN = 1, D ändern → Q folgt. EN = 0, D ändern → Q bleibt."],
        },
      },
      {
        t: "html",
        html: `
<h3>Takt und Flip-Flop: nur die Flanke zählt</h3>
<p>Alle Teile einer CPU müssen sich <b>abstimmen</b>: Wer rechnet wann, wer speichert wann? Dazu gibt es den <b>Takt</b> (<i>clock</i>): ein Signal, das regelmäßig 0, 1, 0, 1 … wechselt. Ein <b>Flip-Flop</b> (hier: <b>D-Flip-Flop</b>) übernimmt D <b>nur im Augenblick des Übergangs 0→1</b> – der <b>steigenden Flanke</b> – und hält den Wert danach bis zur nächsten Flanke, egal was D inzwischen tut. Intern besteht es aus zwei Latches (Master und Slave) mit entgegengesetztem Enable, sodass nie beide gleichzeitig offen sind.</p>
<p>Die Taktflanke teilt die Zeit in <b>Schritte</b>: Zwischen zwei Flanken rechnen die Gatter; die Ergebnisse stehen bis zur nächsten Flanke fest und werden dann gemeinsam übernommen. Genau das macht eine CPU berechenbar.</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "dff",
          title: "Live: D-Flip-Flop (Flankensteuerung)",
          caption: "Ändere D und beobachte: Q ändert sich nicht sofort, sondern erst bei der nächsten steigenden Flanke (Schritt oder ½ Takt). <b>½ Takt</b> springt genau eine Flanke weiter, „Schritt“ ein ganzer Takt.",
          build: C.flipFlopDemo,
          height: 200,
          tasks: [
            task("ff-flank", "Setze D = 1, gib einen Takt und setze D dann wieder auf 0: Q muss 1 bleiben.", (r) => r.get("D") === 0 && r.get("Q") === 1, (r) => { clock({ D: 1 }, 1)(r); r.set("D", 0); }, "Erst die Flanke übernimmt D = 1. Wenn du D danach auf 0 stellst, hält das Flip-Flop den Wert bis zur nächsten Flanke."),
          ],
          steps: ["Palette: <b>Takt</b> (Quelle) und <b>D-Flip-Flop</b> platzieren.", "D an Pin 1, Takt an Pin 2 des Flip-Flops.", "Q und Q̄ an Ausgänge hängen.", "Mit <b>Start</b> läuft der Takt; mit dem Eigenschaftsfeld des Takts änderst du die Geschwindigkeit."],
        },
      },
      {
        t: "html",
        html: `
<h3>Ein 8-Bit-Register mit Load-Enable</h3>
<p>Ein <b>Register</b> ist eine Gruppe von Flip-Flops mit gemeinsamem Takt, die ein Wort speichert (hier 8 Bit). Aber ein Flip-Flop übernimmt bei <i>jeder</i> Flanke einen neuen Wert. Wir wollen aber nur dann etwas Neues aufnehmen, wenn es ein Steuersignal <b>LADEN</b> (<i>load enable</i>) erlaubt – sonst soll das Register seinen Wert <b>behalten</b>.</p>
<p>Lösung: <b>Rückkopplung über einen Mux</b>. Der Eingang des Registers ist <code>D = LADEN ? DATEN : Q</code>. Bei LADEN = 0 wird der eigene Ausgang Q zurück an den Eingang geleitet – bei jedem Takt wird einfach derselbe Wert neu eingelesen. Das ist der Gruppen-Aufbau von Akku und Ausgaberegister der Mini-CPU.</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "reg8",
          title: "Live: 8-Bit-Register mit LADEN",
          caption: "Stelle DATEN ein, LADEN = 1 und gib einen Takt: Das Register übernimmt. Bei LADEN = 0 ignoriert es DATEN.",
          build: C.register8,
          height: 330,
          tasks: [
            task("reg-load", "Lade die Zahl 66 (0x42) ins Register.", (r) => r.get("Q") === 0x42, clock({ DATA: 0x42, LOAD: 1 }), "DATEN = 0x42, LADEN = 1, ein Takt: Der Mux wählt DATEN, die Flanke speichert."),
            task("reg-hold", "Das Register soll 0x42 <b>halten</b>, obwohl DATEN auf 0 steht und LADEN = 0 ist.", (r) => r.get("Q") === 0x42 && r.get("DATA") === 0 && r.get("LOAD") === 0, (r) => {
              r.set("DATA", 0x42);
              r.set("LOAD", 1);
              r.step();
              r.set("LOAD", 0);
              r.set("DATA", 0);
              r.step(2);
            }, "Erst laden (LADEN = 1, ein Takt), dann LADEN = 0 setzen: Jetzt wird bei jedem Takt Q zurück in sich selbst geschrieben, DATEN spielt keine Rolle mehr."),
          ],
          steps: [
            "Breite Eingänge DATEN (8 Bit), LADEN, <b>Takt</b>.",
            "Ein <b>D-Flip-Flop</b> mit Breite 8 platzieren.",
            "Zwei Joiner (Breite 8) als Masken: LADEN und NOT LADEN.",
            "AND(DATEN, Maske LADEN) und AND(Q, Maske NOT LADEN), dann ein breites OR → D des Flip-Flops.",
            "Q des Flip-Flops sowohl an den Ausgang als auch an das zweite AND (Rückkopplung!).",
            "Takt an den Takteingang.",
          ],
        },
      },
      {
        t: "merk",
        items: [
          "Rückkopplung macht aus Gattern einen Speicher; SR-Latch = zwei über Kreuz gekoppelte NOR.",
          "Latch: pegelgesteuert (transparent bei EN = 1). Flip-Flop: flankengesteuert (übernimmt nur bei 0→1).",
          "Takt = gemeinsamer Zeitgeber; die steigende Flanke ist der Moment, in dem alle Register gleichzeitig übernehmen.",
          "Register mit Load-Enable: D = LADEN ? Daten : Q (Mux-Rückkopplung).",
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ 8 */
  {
    id: "zaehler",
    num: 8,
    title: "Zähler und Programmzähler",
    lead: "Ein Register, das sich selbst um 1 erhöht – und das auf Befehl springt oder stehen bleibt.",
    blocks: [
      {
        t: "html",
        html: `
<h3>Ein Zähler aus Flip-Flops</h3>
<p>Ein <b>binärer Zähler</b> erhöht bei jedem Takt seinen Wert um 1. Schaut man auf die Zählfolge 0000, 0001, 0010, 0011, 0100 …, erkennt man ein Muster: Ein Bit <b>kippt</b> genau dann, wenn alle Bits darunter 1 sind. Bit 0 kippt immer; Bit 1 kippt, wenn Bit 0 = 1; Bit 2, wenn Bit 0 und Bit 1 = 1 usw. Pro Stelle gibt es also ein Flip-Flop, ein <b>XOR</b> (Q ⊕ „kippen?“) am D-Eingang und ein <b>AND</b>, das die „kippen?“-Bedingung für die nächste Stelle weiterreicht. Jedes Flip-Flop bekommt außerdem einen <b>Reset</b>-Eingang, der es auf 0 zurücksetzt.</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "counter",
          title: "Live: 4-Bit-Zähler",
          caption: "Starte den Takt oder gib Einzelschritte. Nach 15 folgt wieder 0: Der Zähler „läuft über“.",
          build: C.counter4,
          height: 250,
          tasks: [
            task("cnt-5", "Zähle bis 5: Der Zählerstand soll genau 5 sein (nach einem Reset).", (r) => r.get("Q") === 5, clock({ RST: 0 }, 5), "Reset auf 0 lösen, dann fünf Takte. Bit 0 und Bit 2 sind gesetzt: 0101."),
          ],
          steps: [
            "Vier <b>D-Flip-Flops</b> in einer Reihe, gemeinsamer <b>Takt</b> und ein gemeinsamer Eingang RESET (3. Pin).",
            "Flip-Flop 0: Q̄ zurück an D (es kippt bei jedem Takt).",
            "Für Stelle i ≥ 1: XOR aus Q<sub>i</sub> und „kippen?“ → D<sub>i</sub>.",
            "„kippen?“ für Stelle 1 = Q0; für höhere Stellen = AND(vorheriges „kippen?“, Q).",
            "Vier Q-Ausgänge mit einem Joiner (Breite 4) auf einen Ausgang führen.",
          ],
        },
      },
      {
        t: "html",
        html: `
<h3>Der Programmzähler (PC)</h3>
<p>Ein <b>Programm</b> ist eine Liste von Befehlen im Speicher, die der Reihe nach abgearbeitet wird. Der <b>Programmzähler</b> (<i>program counter</i>, PC) ist ein Register, das die <b>Adresse des nächsten Befehls</b> enthält. Er muss drei Dinge können:</p>
<ul>
<li><b>Weiterzählen:</b> nach jedem Befehl PC ← PC + 1.</li>
<li><b>Springen:</b> Bei <code>JMP</code> (und bedingt <code>JZ</code>/<code>JNZ</code>) wird die Zieladresse geladen: PC ← Ziel. Damit entstehen Schleifen und Verzweigungen.</li>
<li><b>Anhalten:</b> Bei <code>HLT</code> bleibt PC stehen.</li>
</ul>
<p>Die Schaltung (<code>buildPc</code> in <code>cpu.ts</code>) kommt ohne einen speziellen „Lade-Mux“ aus: <code>PC' = A + B</code> mit <code>A = PC AND ¬SPRUNG</code> (beim Sprung wird der alte Wert ausgeblendet) und <code>B = (ZIEL AND SPRUNG)</code>; das niederwertigste Bit von B bekommt zusätzlich <code>¬SPRUNG AND ¬HALT</code> – das ist das „+1“. Ein vorhandener Addierer erledigt also alle drei Fälle: Weiterzählen (PC + 1), Springen (0 + Ziel), Halten (PC + 0).</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "pc",
          title: "Live: Programmzähler (4 Bit)",
          caption: "Die Gruppen: <i>pc AND ¬Sprung</i> (links), <i>Ziel AND Sprung · +1</i> (Mitte), der Addierer, dann das PC-Register.",
          build: C.pc4,
          height: 480,
          readout: (r) => `PC = ${r.get("PC")} → nach dem nächsten Takt: ${r.get("HALT") ? r.get("PC") : r.get("JUMP") ? r.get("ZIEL") : (r.get("PC") + 1) & 15}`,
          tasks: [
            task("pc-5", "Lass den PC bis 5 hochzählen (Reset lösen, Sprung und Halt aus).", (r) => r.get("OUT") === 5 && r.get("JUMP") === 0 && r.get("HALT") === 0, clock({ JUMP: 0, HALT: 0, RST: 0 }, 5), "Ohne Sprung und Halt addiert die Schaltung bei jedem Takt +1."),
            task("pc-jump", "Springe mit einem Takt auf Adresse 3 (ZIEL = 3, SPRUNG danach wieder 0).", (r) => r.get("OUT") === 3 && r.get("JUMP") === 0, (r) => {
              r.set("RST", 0);
              r.set("ZIEL", 3);
              r.set("JUMP", 1);
              r.step();
              r.set("JUMP", 0);
              r.set("HALT", 1);
            }, "SPRUNG = 1: PC' = 0 + ZIEL = 3 – danach SPRUNG = 0 (und HALT = 1 zum Anhalten)."),
          ],
          steps: [
            "Eingänge ZIEL (n Bit), SPRUNG, HALT, RESET, Takt; ein D-Flip-Flop „PC“ (n Bit).",
            "Splitter für ZIEL und PC; NOT für SPRUNG und HALT.",
            "<b>A:</b> für jedes PC-Bit ein AND(PC-Bit, ¬SPRUNG).",
            "<b>B:</b> Bit 0 = OR(AND(ZIEL0, SPRUNG), AND(¬SPRUNG, ¬HALT)); Bits i > 0 = AND(ZIELi, SPRUNG).",
            "<b>Addierer</b> (Cin = Konstante 0) A + B → Joiner → D des PC-Flip-Flops.",
            "Q zurück an die Splitter-Eingänge und an den Ausgang.",
          ],
        },
      },
      {
        t: "merk",
        items: [
          "Ein Zähler kippt Bit i genau dann, wenn alle niedrigeren Bits 1 sind (XOR + AND-Kette).",
          "PC = Adresse des nächsten Befehls: +1, Sprung = Ziel laden, HLT = halten.",
          "Mit PC' = A + B reicht ein Addierer für alle drei Fälle.",
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ 9 */
  {
    id: "speicher",
    num: 9,
    title: "Speicher: RAM und ROM",
    lead: "Adresse rein, Wort raus: wie viele Register zu einem Speicher werden.",
    blocks: [
      {
        t: "html",
        html: `
<h3>Adressen und Wörter</h3>
<p>Ein Speicher ist eine nummerierte Liste von <b>Wörtern</b> (hier je 8 oder 16 Bit). Die Nummer heißt <b>Adresse</b>. Mit <i>k</i> Adressbits kann man 2<sup>k</sup> Wörter ansprechen: 3 Bit → 8 Wörter, 8 Bit → 256 Wörter. Die Schaltung bekommt eine Adresse und liefert den Inhalt dieser Stelle.</p>
<ul>
<li><b>ROM</b> (<i>read only memory</i>): fester Inhalt, nur Lesen. Im Programm-ROM stehen die Befehle, im Steuer-ROM die Steuerwörter (Kapitel 10).</li>
<li><b>RAM</b> (<i>random access memory</i>): lesen <i>und</i> schreiben. Der Inhalt ist veränderlich; ohne Strom wäre er weg. Beim Schreiben müssen <b>Adresse</b>, <b>Dateneingang</b> (DIN) und <b>Write-Enable</b> (WE) anliegen; die Übernahme geschieht mit der Taktflanke.</li>
</ul>
<h3>Wie wird ein Wort ausgewählt? Der Decoder</h3>
<p>Intern hat jedes Wort sein eigenes Register (z. B. 8 Flip-Flops). Der <b>Adress-Decoder</b> wandelt die Adresse in eine <i>one-hot</i>-Leitung (Wortleitung) um, sodass genau ein Register ausgewählt ist: beim Lesen gibt es seinen Wert auf den Datenbus aus (Mux!), beim Schreiben bekommt nur dieses Register ein Load-Enable (Kapitel 7).</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "decoder",
          title: "Live: 2-Bit-Adressdecoder",
          build: C.decoder2,
          height: 250,
          table: { ins: ["A1", "A0"], outs: ["W0", "W1", "W2", "W3"] },
          tasks: [task("dec-3", "Wähle Wort 2 aus (nur W2 = 1).", (r) => r.get("W2") === 1 && r.get("W0") + r.get("W1") + r.get("W3") === 0, set({ A1: 1, A0: 0 }), "Wort 2 = Binär 10: A1 = 1, A0 = 0. Das AND dieser (negierten bzw. echten) Adressbits ist nur dann 1.")],
          steps: ["Eingänge A1, A0.", "NOT für beide Adressbits.", "Pro Wort ein AND, dessen Eingänge je nach Bit des Wortes das echte oder das negierte Adressbit sind.", "Vier Ausgänge W0…W3."],
        },
      },
      {
        t: "demo",
        demo: {
          id: "rom",
          title: "Live: 8×8-ROM",
          caption: `Das ROM enthält die ASCII-Zeichen „HALLO!*“ (hex 48 41 4C 4C 4F 21 2A 00). Ändere die Adresse und lies das Wort ab. Die Tabelle rechts ist der Speicherinhalt.`,
          build: C.romDemo,
          height: 160,
          mem: ["ROM"],
          readout: (r) => `Adresse ${r.get("ADR")} → ${hx(r.get("DATA"))} (dezimal ${r.get("DATA")})`,
          tasks: [task("rom-6", "Lies Adresse 6 aus: Das Wort ist 0x2A (= 42).", (r) => r.get("ADR") === 6 && r.get("DATA") === 0x2a, set({ ADR: 6 }), "Adresse 6 → 0x2A.")],
          steps: ["Palette: <b>ROM</b> platzieren; im Eigenschaften-Panel Adressbreite 3, Datenbreite 8.", "Inhalt im Speicher-Editor (Doppelklick auf das ROM) eintragen.", "Adress-Eingang (3 Bit) an Pin 1, Ausgang (8 Bit, hex) an den Datenausgang."],
        },
      },
      {
        t: "demo",
        demo: {
          id: "ram",
          title: "Live: 16×8-RAM",
          caption: "Schreiben: Adresse und DIN einstellen, WE = 1, einen Takt geben. Lesen: Adresse einstellen, DOUT zeigt den Inhalt (auch ohne Takt).",
          build: C.ramDemo,
          height: 260,
          mem: ["RAM"],
          readout: (r) => `Adresse ${r.get("ADR")} → ${hx(r.get("DOUT"))}`,
          tasks: [
            task("ram-5", "Schreibe 0x2A an Adresse 5 und stelle WE danach wieder auf 0.", (r) => r.get("ADR") === 5 && r.get("DOUT") === 0x2a && r.get("WE") === 0, (r) => {
              r.set("ADR", 5);
              r.set("DIN", 0x2a);
              r.set("WE", 1);
              r.step();
              r.set("WE", 0);
            }, "ADR = 5, DIN = 0x2A, WE = 1, ein Takt. Danach WE = 0, damit weitere Takte nichts mehr überschreiben."),
          ],
          steps: ["Palette: <b>RAM</b> platzieren (Adressbreite 4, Datenbreite 8).", "Pins: Adresse, DIN, WE, Takt.", "Eingänge für die vier Signale, Ausgang DOUT (hex).", "Mit WE = 1 und Takt schreiben, mit WE = 0 nur lesen."],
        },
      },
      {
        t: "html",
        html: `<p><b>Weiterlesen:</b> In der Sandbox gibt es einen detaillierten <b>Speicher-Explorer</b>, der RAM/ROM-Inhalte feldweise anzeigt und bearbeitbar macht (zu finden im Speicher-Bereich der Werkzeugleiste). Dort kannst du Adressen, Wörter und Dekodierung genauer untersuchen – hier wird nichts davon dupliziert.</p>`,
      },
      {
        t: "merk",
        items: ["k Adressbits → 2<sup>k</sup> Wörter.", "ROM: nur lesen (Programm, Steuerwörter). RAM: lesen und schreiben, Schreiben mit WE + Taktflanke.", "Ein Decoder macht aus der Adresse genau eine aktive Wortleitung."],
      },
    ],
  },

  /* ------------------------------------------------------------------ 10 */
  {
    id: "befehle",
    num: 10,
    title: "Befehle und das Steuerwerk",
    lead: "Wie ein Zahlenwort zum Befehl wird: Opcode, Operand und das Steuer-ROM, das die Bauteile dirigiert.",
    blocks: [
      {
        t: "html",
        html: `
<h3>Das Befehlswort</h3>
<p>Ein Befehl ist selbst nur eine Zahl im Speicher. Unsere CPU nutzt <b>16-Bit-Wörter</b>: die oberen 8 Bit sind der <b>Opcode</b> (<i>operation code</i>: „was tun?“), die unteren 8 Bit der <b>Operand</b> („womit?“ – eine Konstante oder eine RAM-Adresse). Beispiel: <code>ADD #5</code> ist <code>0x0405</code> – Opcode <code>0x04</code> (ADD mit Konstante), Operand 5. Der <b>Assembler</b> ist ein Programm, das lesbaren Text wie <code>ADD #5</code> in solche Zahlen übersetzt; <code>#</code> bedeutet „Konstante“, ohne <code>#</code> ist es eine RAM-Adresse.</p>
<h3>Das Steuerwerk</h3>
<p>Das <b>Steuerwerk</b> (<i>control unit</i>) übersetzt den Opcode in <b>Steuersignale</b>, die alle anderen Teile (ALU, Register, RAM, PC) einstellen. In unserer CPU ist das kein Gatterlabyrinth, sondern ein <b>Steuer-ROM</b>: Die Adresse ist der Opcode (256 Einträge), der Inhalt ein 16-Bit-<b>Steuerwort</b>, dessen Bits direkt an Steuerleitungen gehen. Man nennt dieses Prinzip <b>Mikrocode</b> (hier in seiner einfachsten Form – ein Wort pro Befehl, keine Folge von Mikroschritten). Einen neuen Befehl einzuführen heißt dann: einen Eintrag im ROM ändern.</p>`,
      },
      { t: "widget", name: "instr" },
      {
        t: "html",
        html: `
<h3>Die Steuerleitungen im Einzelnen</h3>
<table class="plain">
<tr><th>Bit</th><th>Name</th><th>Wirkung</th></tr>
<tr><td>0–2</td><td>Modus</td><td>Rechenart der ALU (0 halten, 1 ADD, 2 SUB, 3 AND, 4 OR, 5 XOR, 6 B durchleiten, 7 null)</td></tr>
<tr><td>3</td><td>EN</td><td>ALU-Ergebnis darf in den Akku</td></tr>
<tr><td>4</td><td>MEM</td><td>zweiter Operand aus dem RAM statt aus dem Befehl</td></tr>
<tr><td>5</td><td>WE</td><td>Akku in den RAM schreiben</td></tr>
<tr><td>6</td><td>OUT</td><td>Akku ins Ausgaberegister laden</td></tr>
<tr><td>7</td><td>JMP</td><td>unbedingter Sprung</td></tr>
<tr><td>8</td><td>JZ</td><td>Sprung, wenn Akku = 0 (Zero-Flag)</td></tr>
<tr><td>9</td><td>JNZ</td><td>Sprung, wenn Akku ≠ 0</td></tr>
<tr><td>10</td><td>HLT</td><td>Programmzähler anhalten</td></tr>
</table>
<p>Beispiel <code>ADD</code> mit Konstante: Modus 1 (ADD), EN = 1 → Steuerwort <code>0b000 0000 1001</code> = <code>0x009</code>. <code>LDA #n</code> nutzt Modus 6 („B durchleiten“): Der Operand geht unverändert durch die ALU in den Akku. Bei <code>MEM = 1</code> kommt B statt aus dem Befehl aus dem RAM (Adresse = Operand).</p>`,
      },
      {
        t: "demo",
        demo: {
          id: "ctrl",
          title: "Live: Opcode → Steuerwort",
          caption: "Das echte Steuer-ROM der Mini-CPU. Gib einen Opcode ein und lies die Steuerleitungen an den Lampen ab.",
          build: () => C.ctrlDemo(controlRomContents()),
          height: 310,
          readout: (r) => `Opcode ${hx(r.get("OP"))} → Modus ${r.get("MODE")}${["EN", "MEM", "WE", "OUT", "JMP", "JZ", "JNZ", "HLT"].filter((n) => r.get(n)).map((n) => " + " + n).join("")}`,
          tasks: [
            task("ctrl-we", "Finde den Opcode, der den RAM beschreibt (WE = 1).", (r) => r.get("WE") === 1, set({ OP: 0x03 }), "<code>STA</code> hat Opcode 0x03 und aktiviert WE."),
            task("ctrl-hlt", "Finde den Opcode, der die CPU anhält (HLT = 1).", (r) => r.get("HLT") === 1, set({ OP: 0xff }), "<code>HLT</code> hat Opcode 0xFF."),
          ],
          steps: ["Eingang OPCODE (8 Bit).", "ROM mit Adressbreite 8 und Datenbreite 16 platzieren; Inhalt = Steuerwörter aus der Tabelle unten.", "Splitter (Breite 16) hinter das ROM; die Bits 3…10 mit Lampen (Ausgängen) verbinden.", "Modus = Bits 0–2 per Joiner zu einem 3-Bit-Ausgang."],
        },
      },
      { t: "widget", name: "ops" },
      {
        t: "merk",
        items: ["Befehlswort: 8 Bit Opcode + 8 Bit Operand = 16 Bit.", "Der Assembler übersetzt Text in Zahlen; # = Konstante, sonst RAM-Adresse.", "Steuerwerk = ROM: Opcode → Steuerwort (Mikrocode); jedes Bit schaltet eine Steuerleitung."],
      },
    ],
  },
];
