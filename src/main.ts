import "@fontsource-variable/schibsted-grotesk";
import "@fontsource-variable/jetbrains-mono";
import { boot } from "./app";

boot();

// Canvas-Schrift erst nach dem Laden stimmig: erneut zeichnen lassen.
document.fonts.ready.then(() => window.dispatchEvent(new Event("resize")));
