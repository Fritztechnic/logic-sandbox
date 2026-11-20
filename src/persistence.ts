import { Circuit, SerializedCircuit } from "./circuit";

const KEY = "logic-sandbox-v1";

export function saveLocal(circuit: Circuit): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(circuit.serialize()));
  } catch {
    /* Speicher nicht verfügbar */
  }
}

export function loadLocal(circuit: Circuit): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const data = JSON.parse(raw) as SerializedCircuit;
    circuit.load(data);
    return true;
  } catch {
    return false;
  }
}

export function clearLocal(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* egal */
  }
}

const TABS_KEY = "logic-sandbox-tabs-v1";

export interface StoredTabs {
  tabs: { kind: string; title: string }[];
  active: number;
}

/** Merkt sich die geöffneten Tabs samt Reihenfolge. */
export function saveTabs(tabs: { kind: string; title: string }[], active: number): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active }));
  } catch {
    /* Speicher nicht verfügbar */
  }
}

export function loadTabs(): StoredTabs | null {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as StoredTabs;
    if (!data || !Array.isArray(data.tabs) || data.tabs.length === 0) return null;
    return { tabs: data.tabs, active: typeof data.active === "number" ? data.active : 0 };
  } catch {
    return null;
  }
}

const ROUTE_KEY = "logic-sandbox-route-v1";

/** Merkt sich die gewählte Kabelführung ("curved" oder "ortho"). */
export function saveWireStyle(style: string): void {
  try {
    localStorage.setItem(ROUTE_KEY, style);
  } catch {
    /* Speicher nicht verfügbar */
  }
}

export function loadWireStyle(): string | null {
  try {
    return localStorage.getItem(ROUTE_KEY);
  } catch {
    return null;
  }
}

export interface CircuitFile extends SerializedCircuit {
  /** Mitgelieferte Modulbibliothek (eigene Module). */
  modules?: unknown;
}

export function parseCircuit(text: string): CircuitFile | null {
  try {
    const data = JSON.parse(text) as CircuitFile;
    if (!data || !Array.isArray(data.comps)) return null;
    return data;
  } catch {
    return null;
  }
}

export function downloadCircuit(circuit: Circuit, modules: unknown = []): void {
  const payload: CircuitFile = { ...circuit.serialize(), modules };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "schaltung.json";
  a.click();
  URL.revokeObjectURL(url);
}
