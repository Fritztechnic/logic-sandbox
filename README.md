# Logic Sandbox

Browser-Simulator für Digitalschaltungen: von Logikgattern über Addierer und
Register bis zu einer 8-Bit- und einer 32-Bit-RISC-CPU. Dazu eine interaktive
Anleitung (`/cpu8bit/`) mit Live-Schaltungen und Assembler.

Live: https://logic.vioserve.de

## Entwicklung

```sh
npm ci
npm run dev     # Entwicklungsserver
npm test        # Simulations-, Router-, CPU- und Tutorial-Tests
npm run build   # tsc + statischer Build nach dist/
```

Statischer Build, kein Backend. Schriften (Schibsted Grotesk, JetBrains Mono)
werden lokal aus `@fontsource-variable` gebündelt.

## Design

Messplatz-Optik: tiefes Teal-Schwarz, Signalgrün = logisch 1, Cyan = Bus,
Bernstein = Warnung. Alle Farben liegen als Variablen in `src/styles.css`
und `src/tutorial/tutorial.css`; die Canvas-Palette in `src/render.ts`.
