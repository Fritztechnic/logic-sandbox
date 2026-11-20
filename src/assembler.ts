export interface AsmError {
  line: number;
  message: string;
}

export interface AsmResult {
  /** Gepackte 16-Bit-Wörter (Opcode high, Operand low) – klassische CPU. */
  words: number[];
  /** Opcode je Adresse (für CPUs mit getrenntem Operand-ROM). */
  opcodes: number[];
  /** Operand je Adresse (Breite siehe operandBits). */
  operands: number[];
  errors: AsmError[];
  labels: Record<string, number>;
  instructionCount: number;
}

type Variant = "none" | "imm" | "addr";
type OpSpec = Partial<Record<Variant, number>>;

const OPS: Record<string, OpSpec> = {
  NOP: { none: 0x00 },
  LDA: { imm: 0x01, addr: 0x02 },
  STA: { addr: 0x03 },
  ADD: { imm: 0x04, addr: 0x05 },
  SUB: { imm: 0x06, addr: 0x07 },
  AND: { imm: 0x08, addr: 0x09 },
  OR: { imm: 0x0a, addr: 0x0b },
  XOR: { imm: 0x0c, addr: 0x0d },
  OUT: { none: 0x10 },
  JMP: { addr: 0x20 },
  JZ: { addr: 0x21 },
  JNZ: { addr: 0x22 },
  HLT: { none: 0xff },
};

export const ASSEMBLY_REFERENCE = [
  { code: "LDA #n / addr", text: "Akkumulator laden" },
  { code: "STA addr", text: "Akkumulator speichern" },
  { code: "ADD/SUB/AND/OR/XOR", text: "Akkumulator verknüpfen (#n oder addr)" },
  { code: "OUT", text: "Akkumulator ausgeben" },
  { code: "JMP/JZ/JNZ addr", text: "Sprung / bei Null / bei Nicht-Null" },
  { code: "HLT", text: "Anhalten" },
  { code: ".org n / .word n", text: "Adresse setzen / Datenwort" },
];

interface Item {
  line: number;
  at: number;
  kind: "instr" | "word";
  mnemonic?: string;
  operand?: string;
  word?: number;
}

function parseNumber(token: string | undefined, labels: Map<string, number>): number | null {
  if (!token) return null;
  const t = token.trim();
  if (!t) return null;
  if (t.length >= 3 && t.startsWith("'") && t.endsWith("'")) return t.charCodeAt(1);
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^0b[01]+$/i.test(t)) return parseInt(t.slice(2), 2);
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const label = labels.get(t.toLowerCase());
  return label === undefined ? null : label;
}

/**
 * Übersetzt eine kleine Assemblersprache in 16-Bit-Wörter (Opcode high,
 * Operand low). Mit operandBits > 8 (getrenntes Operand-ROM) sind größere
 * Konstanten erlaubt; `opcodes`/`operands` liefern die Felder einzeln.
 */
export function assemble(source: string, operandBits = 8): AsmResult {
  const bits = Math.max(8, Math.min(32, Math.round(operandBits)));
  const maxOperand = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
  const errors: AsmError[] = [];
  const labels = new Map<string, number>();
  const items: Item[] = [];
  const lines = source.split(/\r?\n/);
  let pc = 0;

  lines.forEach((raw, index) => {
    const line = index + 1;
    let text = raw.replace(/;.*$/, "").replace(/\/\/.*$/, "").trim();
    if (!text) return;

    const labelMatch = text.match(/^([A-Za-z_.][\w.$]*):\s*(.*)$/);
    if (labelMatch) {
      const name = labelMatch[1].toLowerCase();
      if (labels.has(name)) errors.push({ line, message: `Label "${labelMatch[1]}" ist doppelt.` });
      else labels.set(name, pc);
      text = labelMatch[2].trim();
      if (!text) return;
    }

    if (text.startsWith(".")) {
      const [directive, ...args] = text.split(/\s+/);
      const value = parseNumber(args[0], labels);
      if (directive.toLowerCase() === ".org") {
        if (value === null || value < 0) {
          errors.push({ line, message: "Ungültige Adresse für .org." });
        } else {
          pc = value;
        }
        return;
      }
      if (directive.toLowerCase() === ".word") {
        if (value === null) {
          errors.push({ line, message: "Ungültiger Wert für .word." });
        } else {
          items.push({ line, at: pc, kind: "word", word: value & 0xffff });
          pc++;
        }
        return;
      }
      errors.push({ line, message: `Unbekannte Direktive ${directive}.` });
      return;
    }

    const [mnemonic, ...rest] = text.split(/\s+/);
    items.push({ line, at: pc, kind: "instr", mnemonic, operand: rest.join(" ").trim() });
    pc++;
  });

  const needed = items.reduce((max, item) => Math.max(max, item.at + 1), 0);
  if (needed > 256) {
    errors.push({ line: 0, message: `Programm ist zu groß: ${needed} Wörter (maximal 256).` });
  }
  const words = new Array(Math.min(needed, 256)).fill(0);
  const opcodes = new Array(words.length).fill(0);
  const operands = new Array(words.length).fill(0);

  for (const item of items) {
    if (item.at >= words.length) continue;
    if (item.kind === "word") {
      words[item.at] = item.word ?? 0;
      operands[item.at] = item.word ?? 0;
      continue;
    }
    const mnemonic = (item.mnemonic ?? "").toUpperCase();
    const spec = OPS[mnemonic];
    if (!spec) {
      errors.push({ line: item.line, message: `Unbekannter Befehl "${item.mnemonic}".` });
      continue;
    }
    const operandText = (item.operand ?? "").trim();
    const variant: Variant = operandText === "" ? "none" : operandText.startsWith("#") ? "imm" : "addr";
    const opcode = spec[variant];
    if (opcode === undefined) {
      const wanted = Object.keys(spec).join("/");
      errors.push({ line: item.line, message: `${mnemonic} erwartet ${wanted === "none" ? "keinen Operanden" : wanted}.` });
      continue;
    }
    let operand = 0;
    if (variant !== "none") {
      const token = variant === "imm" ? operandText.replace(/^#/, "").trim() : operandText;
      const value = parseNumber(token, labels);
      if (value === null) {
        errors.push({ line: item.line, message: `Operand "${token}" ist keine Zahl und kein Label.` });
        continue;
      }
      if (value < 0 || value > maxOperand) {
        errors.push({
          line: item.line,
          message:
            bits === 8
              ? `Operand ${value} passt nicht in 8 Bit (0–255).`
              : `Operand ${value} passt nicht in ${bits} Bit (0–${maxOperand}).`,
        });
        continue;
      }
      // Der Adressraum der CPU ist 8 Bit, auch bei breiteren Datenpfaden.
      if (bits > 8 && variant === "addr" && value > 0xff) {
        errors.push({ line: item.line, message: `Adresse ${value} passt nicht in 8 Bit (0–255).` });
        continue;
      }
      operand = value;
    }
    opcodes[item.at] = opcode;
    operands[item.at] = operand;
    words[item.at] = ((opcode << 8) | (operand & 0xff)) & 0xffff;
  }

  return {
    words,
    opcodes,
    operands,
    errors,
    labels: Object.fromEntries(labels),
    instructionCount: items.filter((i) => i.kind === "instr").length,
  };
}
