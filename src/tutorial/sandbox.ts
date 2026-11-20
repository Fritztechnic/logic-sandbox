import { Circuit } from "../circuit";
import { saveLocal } from "../persistence";

const KEY = "logic-sandbox-v1";
const TABS_KEY = "logic-sandbox-tabs-v1";
const BACKUP_KEY = "logic-sandbox-v1-before-tutorial";

/**
 * Schreibt die Schaltung in den Speicher der Sandbox und wechselt dorthin.
 * Eine vorhandene, nicht leere Sandbox-Schaltung wird vorher gesichert.
 */
export function openInSandbox(circuit: Circuit): boolean {
  try {
    const old = localStorage.getItem(KEY);
    if (old && old.length > 200) {
      if (!confirm("Die Sandbox enthält schon eine Schaltung. Sie wird ersetzt (eine Sicherung bleibt im Browser-Speicher). Fortfahren?")) return false;
      localStorage.setItem(BACKUP_KEY, old);
    }
    localStorage.removeItem(TABS_KEY);
    saveLocal(circuit);
  } catch {
    alert("Der Browser-Speicher ist nicht verfügbar – die Schaltung kann nicht übergeben werden.");
    return false;
  }
  location.href = "/";
  return true;
}
