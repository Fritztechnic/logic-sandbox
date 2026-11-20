/** Beispielprogramme für die RISC-32-CPU (Assembler siehe assembler32.ts). */
export interface Cpu32Program {
  name: string;
  source: string;
}

export const CPU32_PROGRAMS: Cpu32Program[] = [
  {
    name: "Fibonacci",
    source: `; Fibonacci: gibt die ersten 12 Zahlen per OUT aus
; (Register sind nicht fest null: R0 wird selbst gelöscht)
      CLR R0
      LDI R1, 0          ; a
      LDI R2, 1          ; b
      LDI R3, 12         ; Zähler
loop: OUT R1
      ADD R4, R1, R2     ; a + b
      MOV R1, R2
      MOV R2, R4
      DEC R3
      BNE R3, R0, loop
      HLT
`,
  },
  {
    name: "Summe 1..N",
    source: `; Summe 1..N mit einer Schleife (N = 100 → 5050)
.equ N, 100
      CLR R0
      LDI R1, N
      CLR R2             ; Summe
loop: ADD R2, R2, R1
      DEC R1
      BNE R1, R0, loop
      OUT R2
      HLT
`,
  },
  {
    name: "Multiplikation (Shift-Add)",
    source: `; 1234 * 5678 per Schieben und Addieren (= 7006652)
      CLR R0
      LDI R1, 1234       ; Multiplikand
      LDI R2, 5678       ; Multiplikator
      CLR R3             ; Produkt
loop: BEQ R2, R0, done
      ANDI R4, R2, 1     ; niedrigstes Bit gesetzt?
      BEQ R4, R0, skip
      ADD R3, R3, R1
skip: SHLI R1, R1, 1
      SHRI R2, R2, 1
      JMP loop
done: OUT R3
      HLT
`,
  },
  {
    name: "Array sortieren (RAM)",
    source: `; Bubble-Sort von 8 Zahlen im Datenspeicher, danach sortiert ausgeben
.equ N, 8
      CLR R0
      LDI R1, 42
      ST R1, [R0+0]
      LDI R1, 7
      ST R1, [R0+1]
      LDI R1, 19
      ST R1, [R0+2]
      LDI R1, -5         ; negative Zahlen sortiert BLT/BGE vorzeichenrichtig
      ST R1, [R0+3]
      LDI R1, 100
      ST R1, [R0+4]
      LDI R1, 3
      ST R1, [R0+5]
      LDI R1, 77
      ST R1, [R0+6]
      LDI R1, 0
      ST R1, [R0+7]
      LDI R8, N-1        ; Grenze der inneren Schleife
outer: CLR R2             ; i
inner: LD R3, [R2+0]
      LD R4, [R2+1]
      BGE R4, R3, next   ; schon in Ordnung
      ST R4, [R2+0]      ; tauschen
      ST R3, [R2+1]
next: INC R2
      BNE R2, R8, inner
      DEC R8
      BNE R8, R0, outer
      CLR R2
      LDI R9, N
print: LD R3, [R2+0]
      OUT R3
      INC R2
      BNE R2, R9, print
      HLT
`,
  },
  {
    name: "Unterprogramm (CALL/RET)",
    source: `; Summe der Quadrate 1²+…+5² (= 55) mit einem Unterprogramm.
; CALL speichert die Rücksprungadresse in R14, PUSH/POP nutzen SP = R15.
      LDI SP, 1023       ; Stapel am Ende des Datenspeichers
      CLR R0
      LDI R6, 5
      CLR R7
next: MOV R1, R6
      CALL square        ; R1 = R1 * R1
      ADD R7, R7, R1
      DEC R6
      BNE R6, R0, next
      OUT R7
      HLT

square: PUSH R2
      PUSH R3
      MOV R2, R1
      CLR R3
sqlp: BEQ R2, R0, sqend
      ADD R3, R3, R1
      DEC R2
      JMP sqlp
sqend: MOV R1, R3
      POP R3
      POP R2
      RET
`,
  },
  {
    name: "32-Bit-Konstanten und Schieben",
    source: `; 32-Bit-Konstanten (LUI+ORI), Überlauf, Schieben, vorzeichenbehafteter Vergleich
      CLR R0
      LI R1, 0x12345678
      LI R2, 0xDEADBEEF
      ADD R3, R1, R2    ; Überlauf: Ergebnis modulo 2^32
      OUT R3
      XOR R4, R1, R2
      OUT R4
      SHLI R5, R1, 4
      OUT R5
      SHRI R6, R2, 28   ; logisch: 0xD
      OUT R6
      LUI R8, 0x8000    ; 0x80000000 = kleinste negative Zahl
      BLT R8, R0, neg   ; signed: R8 < 0
      LDI R9, 0
      JMP show
neg:  LDI R9, 1
show: OUT R9
      NOT R10, R0       ; 0xFFFFFFFF
      OUT R10
      HLT
`,
  },
];

export const CPU32_DEFAULT_PROGRAM = CPU32_PROGRAMS[0].source;
