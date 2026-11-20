const KEY = "logic-tutorial-v1";

export interface Progress {
  /** Aufgaben-ID → 1 = selbst gelöst, 2 = mit Lösung */
  tasks: Record<string, 1 | 2>;
  visited: Record<string, 1>;
  last?: string;
}

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Progress>;
      return { tasks: p.tasks ?? {}, visited: p.visited ?? {}, last: p.last };
    }
  } catch {
    /* kaputter oder nicht verfügbarer Speicher */
  }
  return { tasks: {}, visited: {} };
}

export function saveProgress(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* Speicher nicht verfügbar */
  }
}

export function resetProgress(): Progress {
  const p: Progress = { tasks: {}, visited: {} };
  saveProgress(p);
  return p;
}
