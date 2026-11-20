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

## Betrieb

Läuft als nginx-Pod im RKE2-Cluster (Argo-App `static-sites`, Repo VioServe/infra).
Image bauen und auf k8s1-3 importieren (keine Registry), dann Tag im Infra-Repo per PR erhöhen:

```sh
docker build -t vio-static-logic:N .
docker save vio-static-logic:N | ssh ops@<node> 'sudo ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images import -'
```
