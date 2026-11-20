import {
  buildCellCircuit,
  capacityText,
  cellState,
  decodeAddress,
  formatWord,
  newObserver,
  nextActionText,
  observeAccess,
  parseHexList,
  parseWord,
  rowWindow,
  toggleWordBit,
  wordBits,
} from "./memview";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed++;
    console.error(`  \u2717 ${name} ${detail}`);
  }
}

console.log("Speicher-Explorer (Logik)");
const d = decodeAddress(0b1011, 4);
check("Adresse dekodieren", d.row === 11 && d.bits.join("") === "1011" && d.rows === 16);
check("Adresse wird maskiert", decodeAddress(0x1ff, 4).addr === 15);
check("32-Bit-Wort unsigned", formatWord(-1, 32, "hex") === "0xFFFFFFFF" && formatWord(-1, 32, "dec") === "4294967295");
check("Bits zerlegen", wordBits(0x80000001, 32)[0] === 1 && wordBits(0x80000001, 32)[31] === 1 && wordBits(5, 4).join("") === "0101");
check("Bit kippen 32", toggleWordBit(0, 31, 32) === 0x80000000 && toggleWordBit(0x80000000, 31, 32) === 0);
check("parseWord", parseWord("0xFF", 8, "dec") === 255 && parseWord("256", 8, "dec") === null && parseWord("101", 3, "bin") === 5 && parseWord("zz", 8, "hex") === null);
check("parseWord 32 Bit", parseWord("FFFFFFFF", 32, "hex") === 0xffffffff);
const pl = parseHexList("1 2, 0xFFFFFFFF 4", 2, 32);
check("Hex-Liste", pl.data.length === 2 && pl.data[1] === 2 && pl.count === 4);
check("Kapazität", capacityText("ram", 8, 32).includes("256 Wörter × 32 Bit = 1 KiB"));
check("Aktion RAM schreiben", nextActionText("ram", [5, 0x2a, 1, 0], 8, 8).includes("0x2A nach Adresse 0x05"));
check("Aktion RAM lesen", nextActionText("ram", [5, 0x2a, 0, 0], 8, 8).includes("nur gelesen"));
check("Zeilenfenster", rowWindow(0, 100, 7).join() === "0,1,2,3,4,5,6" && rowWindow(99, 100, 7)[6] === 99 && rowWindow(1, 4, 7).length === 4);

const o = newObserver();
observeAccess(o, 1, 10);
observeAccess(o, 2, 20);
observeAccess(o, 2, 21);
observeAccess(o, 2, 21);
check("Zugriffsprotokoll", o.log.length === 2 && o.log[0].kind === "write" && o.log[1].kind === "read");
for (let i = 0; i < 20; i++) observeAccess(o, i + 5, 0);
check("Protokoll begrenzt", o.log.length === 8);

const m = buildCellCircuit();
const c = m.circuit;
const set = (x: typeof m.d, v: number): void => c.setInputValue(x, v);
set(m.d, 1);
check("Zelle ohne WL/WE speichert nicht", cellState(m).q === 0);
set(m.wl, 1);
set(m.we, 1);
check("Zelle schreibt 1", cellState(m).q === 1 && cellState(m).out === 1);
set(m.we, 0);
set(m.d, 0);
check("Zelle hält 1", cellState(m).q === 1);
set(m.wl, 0);
check("Zelle liest nur mit WL", cellState(m).out === 0 && cellState(m).q === 1);

if (failed) process.exit(1);
console.log("Alle Speicher-Explorer-Tests bestanden.");
