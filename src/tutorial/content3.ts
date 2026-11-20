import { Chapter, ProgTask } from "./types";

export const EX_ADD = `; 17 + 25
LDA #17
ADD #25
OUT
HLT`;

export const EX_COUNT = `; zählt 1 … 10 und gibt jede Zahl aus
        LDA #1
        STA 0x40        ; RAM[0x40] = Zähler
loop:   LDA 0x40
        OUT
        ADD #1
        STA 0x40
        SUB #11         ; Akku = 0, wenn der Zähler 11 erreicht hat
        JNZ loop
        HLT`;

export const EX_LOOP = `; Schleife mit JNZ: 5, 4, 3, 2, 1 abwärts
        LDA #5
loop:   OUT
        SUB #1
        JNZ loop        ; solange der Akku ≠ 0 ist, zurück
        HLT`;

export const EX_MUL = `; 6 × 7 durch wiederholtes Addieren
        LDA #0
        STA 0x41        ; Ergebnis
        LDA #7
        STA 0x42        ; Zähler (wie oft wird 6 addiert?)
loop:   LDA 0x41
        ADD #6
        STA 0x41
        LDA 0x42
        SUB #1
        STA 0x42
        JNZ loop        ; Akku = Zähler
        LDA 0x41
        OUT
        HLT`;

export const EX_FIB = `; Fibonacci: gibt die ersten 13 Zahlen aus (1 1 2 3 5 … 233)
        LDA #1
        STA 0x40        ; a
        STA 0x41        ; b
        LDA #13
        STA 0x43        ; Anzahl
loop:   LDA 0x40
        OUT
        ADD 0x41
        STA 0x42        ; t = a + b
        LDA 0x41
        STA 0x40        ; a = b
        LDA 0x42
        STA 0x41        ; b = t
        LDA 0x43
        SUB #1
        STA 0x43
        JNZ loop
        HLT`;

export const EX_LOGIC = `; Bits maskieren: nur das untere Halbbyte von 0xAB
LDA #0xAB
AND #0x0F
OUT             ; 0x0B = 11
XOR #0xFF       ; alle Bits kippen
OUT
HLT`;

const sameList = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export const PROG_TASKS: ProgTask[] = [
  {
    id: "p-100",
    text: "Gib die Zahl <b>100</b> aus – nicht mit <code>LDA #100</code>, sondern berechnet mit mindestens einem <code>ADD</code>.",
    hint: "Zum Beispiel 60 laden und 40 addieren.",
    check: (r) => r.halted && sameList(r.outputs, [100]) && r.asm.words.some((w) => (w >> 8) === 0x04 || (w >> 8) === 0x05),
    solution: "LDA #60\nADD #40\nOUT\nHLT",
  },
  {
    id: "p-down",
    text: "Gib die Zahlen <b>5, 4, 3, 2, 1</b> in dieser Reihenfolge aus und halte dann an.",
    hint: "Schleife: OUT, dann SUB #1, dann JNZ.",
    check: (r) => r.halted && sameList(r.outputs, [5, 4, 3, 2, 1]),
    solution: EX_LOOP,
  },
  {
    id: "p-even",
    text: "Gib die ersten fünf geraden Zahlen <b>2, 4, 6, 8, 10</b> aus.",
    hint: "Wie beim Zählen, aber mit ADD #2. Als Abbruch kannst du den Akku mit SUB auf 0 bringen.",
    check: (r) => r.halted && sameList(r.outputs, [2, 4, 6, 8, 10]),
    solution: `LDA #2
loop: OUT
ADD #2
STA 0x40
SUB #12
JNZ cont
HLT
cont: LDA 0x40
JMP loop`,
  },
  {
    id: "p-mul",
    text: "Berechne <b>5 × 9</b> durch wiederholtes Addieren und gib das Ergebnis (45) <i>einmal</i> aus.",
    hint: "Verwende zwei RAM-Zellen: Ergebnis und Zähler (siehe Beispiel 6 × 7).",
    check: (r) => r.halted && sameList(r.outputs, [45]),
    solution: EX_MUL.replace("ADD #6", "ADD #5").replace("LDA #7", "LDA #9"),
  },
  {
    id: "p-ovf",
    text: "Zeige den <b>8-Bit-Überlauf</b>: Gib das Ergebnis von 200 + 100 aus (es muss 44 sein, weil 300 mod 256 = 44).",
    check: (r) => r.halted && sameList(r.outputs, [44]),
    solution: "LDA #200\nADD #100\nOUT\nHLT",
  },
];

export const chapters3: Chapter[] = [
  /* ------------------------------------------------------------------ 11 */
  {
    id: "cpu",
    num: 11,
    title: "Alles zusammen: die 8-Bit-CPU",
    lead: "Alle Bausteine in einer Schaltung – und was bei einem Befehl Schritt für Schritt passiert.",
    blocks: [
      {
        t: "html",
        html: `
<h3>Der Aufbau</h3>
<p>Die komplette Mini-CPU (die Sandbox-Funktion <code>buildCpu</code>) besteht aus den Bausteinen, die du kennst:</p>
<ul>
<li><b>Programmzähler (PC)</b> – Adresse des nächsten Befehls (Kapitel 8).</li>
<li><b>Programm-ROM</b> – liefert zur PC-Adresse ein 16-Bit-Befehlswort; ein <b>Splitter</b> trennt es in Opcode (oben) und Operand (unten).</li>
<li><b>Steuer-ROM</b> – übersetzt den Opcode in das Steuerwort (Kapitel 10).</li>
<li><b>Daten-RAM</b> – Speicher für Variablen (Kapitel 9).</li>
<li><b>ALU</b> – rechnet mit dem <b>Akkumulator</b> (A) und einem zweiten Wert B (Kapitel 6).</li>
<li><b>Akku</b> – Register, das das ALU-Ergebnis aufnimmt (Kapitel 7); <b>Ausgaberegister</b> – Register für OUT.</li>
<li>Ein <b>Mux</b> wählt B: Operand aus dem Befehl <i>oder</i> RAM-Inhalt (Steuerbit MEM).</li>
</ul>
<p>Die Leitungen, über die Daten zwischen diesen Teilen laufen, nennt man einen <b>Bus</b>: ein Bündel von Leitungen (hier 8), das eine ganze Zahl auf einmal transportiert.</p>
<h3>Der Befehlszyklus</h3>
<p>Jeder Befehl durchläuft vier Phasen, den <b>Befehlszyklus</b>. In dieser Mini-CPU erledigt <i>ein Taktschritt</i> den kompletten Zyklus (Einzyklus-Entwurf): Die ersten drei Phasen sind rein kombinatorisch und stehen zur Flanke fertig bereit, die vierte ist die Flanke selbst.</p>
<ol>
<li><b>Fetch (holen):</b> Das Programm-ROM liefert das Wort an der Adresse PC.</li>
<li><b>Decode (entschlüsseln):</b> Der Opcode adressiert das Steuer-ROM; das Steuerwort liegt an.</li>
<li><b>Execute (ausführen):</b> Die ALU berechnet Akku ⊙ B (und die Flags/Zero-Bedingung für Sprünge).</li>
<li><b>Write-back (zurückschreiben):</b> Mit der steigenden Taktflanke übernehmen gleichzeitig der Akku (ALU-Ergebnis), der PC (+1 oder Sprungziel), eventuell RAM (WE) und Ausgaberegister (OUT).</li>
</ol>
<p>Unten steuerst du die CPU selbst: <b>Befehl</b> führt einen kompletten Befehl aus (= ein Takt). Das Fenster „Phasen“ erklärt für den <i>nächsten</i> Befehl, was in jeder Phase passiert. Du kannst das Programm links im Editor ändern und mit <b>Programm laden</b> ins ROM schreiben (der Assembler meldet Fehler mit Zeilennummer).</p>`,
      },
      {
        t: "cpu",
        cpu: {
          id: "cpu-main",
          program: EX_ADD,
          examples: [
            { name: "add", text: "17 + 25", src: EX_ADD },
            { name: "logic", text: "Bits maskieren", src: EX_LOGIC },
            { name: "count", text: "Zählen 1…10", src: EX_COUNT },
          ],
          phases: true,
          caption: "Die komplette CPU als Live-Schaltung. Der Akku, der PC und die Ausgabe sind als Gruppen dargestellt (Innenschaltung ausgeblendet); in der Sandbox kannst du sie öffnen.",
          steps: [
            "Alle Module der Mini-CPU gibt es auch in der Sandbox: Menü <b>Beispiele</b> → „Mini-CPU (8 Bit …)“ (oder <b>In der Sandbox öffnen</b> unten).",
            "Wenn du sie selbst bauen willst: Baue der Reihe nach <b>(1)</b> den ALU-Block (Kapitel 6) und speichere ihn als Modul, <b>(2)</b> Akku-Register mit Load-Enable (Kapitel 7), <b>(3)</b> PC (Kapitel 8), <b>(4)</b> Programm-ROM (Adressbreite 8, Datenbreite 16), <b>(5)</b> Steuer-ROM mit der Befehlstabelle aus Kapitel 10, <b>(6)</b> Daten-RAM (8/8).",
            "Verbinde: PC → Programm-ROM (Adresse); Programm-ROM → Splitter (16 Bit): obere 8 Bit = Opcode → Steuer-ROM-Adresse, untere 8 Bit = Operand.",
            "Operand → Mux (B-Seite), RAM-Ausgang → Mux; Wahlsignal MEM aus dem Steuerwort. Mux-Ausgang → ALU-Eingang B; Akku-Ausgang → ALU-Eingang A.",
            "Steuerwort per Splitter auf Modus (Bits 0–2) und EN (Bit 3) → ALU; WE (Bit 5) → RAM-WE; OUT (Bit 6) → Load-Enable des Ausgaberegisters.",
            "Sprünge: JZ AND Zero(Akku), JNZ AND ¬Zero(Akku), JMP → ODER → PC-Eingang SPRUNG; Operand → ZIEL; HLT → HALT.",
            "Akku-Ausgang → RAM-Dateneingang und Ausgaberegister. Der <b>Takt</b> geht an PC, Akku, RAM-Takt und Ausgaberegister – <i>alle</i> Flip-Flops sollen an derselben Flanke übernehmen.",
          ],
        },
      },
      {
        t: "html",
        html: `
<h3>Was beim Einzelschritt passiert – ein Beispiel</h3>
<p>Bei <code>ADD #25</code> (Wort <code>0x0419</code>) mit Akku = 17 und PC = 1:</p>
<ol>
<li>Fetch: ROM[1] = 0x0419 → Opcode 0x04, Operand 25.</li>
<li>Decode: Steuer-ROM[0x04] = 0x009 → Modus ADD, EN = 1, MEM = 0.</li>
<li>Execute: Der Mux gibt den Operand (25) als B; ALU: 17 + 25 = 42.</li>
<li>Write-back: Flanke: Akku ← 42, PC ← 2.</li>
</ol>
<p>Beachte: JZ/JNZ prüfen den <b>Akku vor</b> der Flanke – also das Ergebnis des <i>vorigen</i> Befehls. Darum steht bei Schleifen oft ein <code>SUB</code> direkt vor <code>JNZ</code>.</p>`,
      },
      {
        t: "merk",
        items: ["Befehlszyklus: Fetch → Decode → Execute → Write-back; hier ein Takt pro Befehl.", "Der PC adressiert das ROM, der Opcode das Steuer-ROM, das Steuerwort stellt alles ein.", "Alle Register übernehmen gleichzeitig an der Taktflanke."],
      },
    ],
  },

  /* ------------------------------------------------------------------ 12 */
  {
    id: "programmieren",
    num: 12,
    title: "Die CPU programmieren",
    lead: "Beispiele und Aufgaben: von „17 + 25“ bis Fibonacci – direkt auf der simulierten CPU.",
    blocks: [
      {
        t: "html",
        html: `
<p>Ein <b>Programm</b> ist eine Folge von Befehlen. Die <b>Assemblersprache</b> macht die Zahlen lesbar: Pro Zeile ein Befehl, <code>;</code> beginnt einen Kommentar, <code>name:</code> ist eine <b>Marke</b> (Label) für eine Adresse, die Sprünge verwenden. Wichtige Muster:</p>
<ul>
<li><b>Variablen</b> liegen im RAM. <code>STA 0x40</code> speichert den Akku, <code>LDA 0x40</code> lädt ihn zurück, <code>ADD 0x40</code> addiert den Inhalt.</li>
<li><b>Schleifen:</b> Ein Zähler wird heruntergezählt (<code>SUB #1</code>); <code>JNZ marke</code> springt zurück, solange er nicht 0 ist.</li>
<li><b>Überlauf:</b> Die CPU rechnet modulo 256 – 200 + 100 ergibt 44.</li>
<li><b>Es gibt nur einen Akku:</b> Wer zwei Werte braucht, muss einen zwischendurch ins RAM legen.</li>
</ul>
<p>Wähle ein Beispiel, lass es mit „Befehl“ oder „Start“ laufen und verfolge PC, Akku und Ausgabe. Dann löse die Aufgaben – sie werden automatisch geprüft, indem dein Programm auf einer eigenen CPU zu Ende gerechnet wird (maximal 5000 Befehle).</p>`,
      },
      {
        t: "cpu",
        cpu: {
          id: "cpu-prog",
          program: EX_LOOP,
          examples: [
            { name: "add", text: "17 + 25", src: EX_ADD },
            { name: "count", text: "Zählen 1…10 (RAM)", src: EX_COUNT },
            { name: "loop", text: "Schleife mit JNZ", src: EX_LOOP },
            { name: "mul", text: "6 × 7 durch Addieren", src: EX_MUL },
            { name: "fib", text: "Fibonacci (8 Bit)", src: EX_FIB },
          ],
          tasks: PROG_TASKS,
          phases: false,
          steps: [
            "Das Programm ist reiner Text – es braucht nur die fertige CPU (Beispiele → „Mini-CPU (8 Bit …)“ in der Sandbox).",
            "Dort schreibst du es im <b>Assembler</b>-Fenster, klickst auf „Übersetzen & laden“ und startest den Takt.",
          ],
          caption: "Die Aufgabenprüfung läuft separat: Dein Programm wird übersetzt, auf einer frischen CPU gerechnet und die OUT-Folge verglichen.",
        },
      },
      {
        t: "merk",
        items: ["Variablen = RAM-Adressen, Schleifen = Zähler + JNZ.", "Es gibt nur einen Akku, Zwischenwerte gehören ins RAM.", "Alle Rechnungen erfolgen modulo 256."],
      },
    ],
  },

  /* ------------------------------------------------------------------ 13 */
  {
    id: "ausblick",
    num: 13,
    title: "Ausblick: Wie geht es weiter?",
    lead: "Was echte Prozessoren anders (und schneller) machen – und wo du weiterbasteln kannst.",
    blocks: [
      {
        t: "html",
        html: `
<h3>Pipelines</h3>
<p>Wenn ein Befehl in vier Phasen zerfällt und jede Phase eigene Hardware hat, steht dort meistens etwas still. Bei einer <b>Pipeline</b> arbeiten die Stufen gleichzeitig an <i>verschiedenen</i> Befehlen – wie ein Fließband: Während Befehl 1 ausgeführt wird, wird Befehl 2 entschlüsselt und Befehl 3 geholt. Der Durchsatz steigt auf bis zu einen Befehl pro Takt, bei kürzerem Takt. Neue Probleme entstehen: <b>Datenabhängigkeiten</b> (ein Befehl braucht das Ergebnis des vorherigen) und <b>Sprünge</b> (die schon geholten Befehle sind plötzlich falsch). Gelöst wird das mit <i>Forwarding</i>, Warten (<i>Stall</i>) und Sprungvorhersage.</p>`,
      },
      { t: "widget", name: "pipeline" },
      {
        t: "html",
        html: `
<h3>Mehr Register: die Register-Datei</h3>
<p>Unsere CPU hat <i>einen</i> Akku. Moderne Rechenwerke haben meist 16 oder 32 gleichberechtigte <b>Register</b> in einer <b>Register-Datei</b> (kleiner, sehr schneller Speicher mit zwei Leseports und einem Schreibport). Befehle benennen dann zwei Quellregister und ein Zielregister (<code>ADD r1, r2, r3</code>) – so braucht man viel weniger RAM-Zugriffe.</p>
<h3>RISC, 32 Bit und mehr</h3>
<p>Die Mini-CPU ähnelt einer <b>RISC</b>-Architektur (<i>reduced instruction set computer</i>): wenige, einfach codierte Befehle mit fester Wortlänge. In der Sandbox gibt es dazu als nächsten Schritt eine <b>32-Bit-RISC-CPU</b> (Beispiele-Menü der Sandbox: „CPU 32 Bit (RISC …)“) mit größerer Registerdatei und breiterem Befehlswort. Weitere Themen, die du dir ansehen kannst:</p>
<ul>
<li><b>Interrupts</b> und <b>Stack</b> (Unterprogramme: <code>CALL</code>/<code>RET</code>),</li>
<li><b>Caches</b> (schnelle Zwischenspeicher vor dem RAM),</li>
<li><b>Mikroarchitektur</b> moderner CPUs: mehrere Befehle pro Takt (superskalar), Befehle umsortieren (Out-of-Order).</li>
</ul>
<h3>Wo geht’s weiter?</h3>
<ul>
<li>Baue die CPU in der Sandbox <b>selbst</b> nach und erweitere sie um einen neuen Befehl, z. B. <code>INC</code> oder <code>SHL</code> (Eintrag im Steuer-ROM + passender ALU-Modus).</li>
<li>Schreibe ein größeres Programm: Primzahlen, Division durch Subtraktion, Sortieren im RAM.</li>
<li>Lies den Quelltext der ALU- und PC-Builder (<code>src/cpu.ts</code>) – es sind nur wenige Zeilen.</li>
</ul>
<p>Du hast jetzt jede Schicht gesehen: Transistoren → Gatter → Addierer → ALU → Register → CPU → Programm. Der Rest ist „nur“ mehr davon.</p>`,
      },
      { t: "merk", items: ["Pipeline: mehrere Befehle gleichzeitig in verschiedenen Phasen.", "Register-Datei statt Akku: schnellere Zugriffe, weniger RAM-Verkehr.", "RISC: wenige einfache Befehle, feste Wortlänge."] },
    ],
  },
];
