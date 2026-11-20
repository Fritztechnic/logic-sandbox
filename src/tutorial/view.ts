import { h, LiveCircuit } from "./live";
import { mountCpu } from "./cpulab";
import { openInSandbox } from "./sandbox";
import { mountWidget } from "./widgets";
import { Block, Chapter, Demo } from "./types";

export interface ViewCtx {
  isSolved(id: string): boolean;
  /** with = Lösung wurde angesehen/angewendet */
  markTask(id: string, withSolution: boolean): void;
}

export interface ChapterView {
  el: HTMLElement;
  destroy(): void;
}

function html(markup: string, cls = "prose"): HTMLElement {
  const d = h("div", cls);
  d.innerHTML = markup;
  return d;
}

function stepsBox(steps: string[], extra?: HTMLElement): HTMLElement {
  const d = h("details", "build");
  d.append(h("summary", "", "Selbst bauen: Schritt für Schritt in der Sandbox"));
  const ol = h("ol");
  for (const s of steps) {
    const li = h("li");
    li.innerHTML = s;
    ol.append(li);
  }
  d.append(ol);
  if (extra) d.append(extra);
  return d;
}

function demoView(d: Demo, ctx: ViewCtx, cleanup: (() => void)[]): HTMLElement {
  const box = h("section", "demo");
  box.append(h("h3", "", d.title));
  if (d.caption) box.append(html(d.caption, "caption"));
  const rig = d.build();
  const used = new Set<string>();
  const marks = new Map<string, { li: HTMLElement; mark: HTMLElement }>();
  const evaluate = (): void => {
    for (const t of d.tasks ?? []) {
      let ok = false;
      try {
        ok = t.check(rig);
      } catch {
        ok = false;
      }
      const e = marks.get(t.id);
      if (ok) ctx.markTask(t.id, used.has(t.id));
      const done = ok || ctx.isSolved(t.id);
      if (e) {
        e.mark.textContent = ok ? "✓" : done ? "✓" : "○";
        e.li.classList.toggle("ok", done);
        e.li.classList.toggle("now", ok);
      }
    }
  };
  const live = new LiveCircuit(rig, { height: d.height, table: d.table, mem: d.mem, readout: d.readout, onUpdate: evaluate });
  cleanup.push(() => live.destroy());
  box.append(live.el);

  if (d.tasks?.length) {
    const tasks = h("div", "tasks");
    tasks.append(h("h4", "", "Aufgaben"));
    const ul = h("ul", "task-list");
    for (const t of d.tasks) {
      const li = h("li", "task");
      const mark = h("span", "mark", ctx.isSolved(t.id) ? "✓" : "○");
      mark.setAttribute("aria-label", "Aufgabenstatus");
      if (ctx.isSolved(t.id)) li.classList.add("ok");
      const txt = h("div", "txt");
      txt.append(html(t.text, "tt-text"));
      const btns = h("div", "tbtn");
      let hint: HTMLElement | null = null;
      if (t.hint) {
        const hp = h("p", "hint");
        hp.hidden = true;
        hp.textContent = "Tipp: " + t.hint;
        hint = hp;
        const hb = h("button", "btn small", "Tipp");
        hb.type = "button";
        hb.addEventListener("click", () => (hp.hidden = !hp.hidden));
        btns.append(hb);
      }
      const sol = h("div", "sol");
      sol.hidden = true;
      sol.append(html(t.solution, "tt-text"));
      const apply = h("button", "btn small", "Lösung anwenden");
      apply.type = "button";
      apply.addEventListener("click", () => {
        used.add(t.id);
        t.solve(rig);
        live.refresh();
      });
      sol.append(apply);
      const sb = h("button", "btn small", "Lösung ansehen");
      sb.type = "button";
      sb.setAttribute("aria-expanded", "false");
      sb.addEventListener("click", () => {
        sol.hidden = !sol.hidden;
        sb.setAttribute("aria-expanded", String(!sol.hidden));
        if (!sol.hidden) used.add(t.id);
      });
      btns.append(sb);
      txt.append(btns);
      if (hint) txt.append(hint);
      txt.append(sol);
      li.append(mark, txt);
      marks.set(t.id, { li, mark });
      ul.append(li);
    }
    tasks.append(ul);
    box.append(tasks);
  }

  const open = h("button", "btn", "In der Sandbox öffnen");
  open.type = "button";
  open.title = "Lädt diese Schaltung in die Sandbox, wo du sie verändern kannst";
  open.addEventListener("click", () => openInSandbox(rig.c));
  const bar = h("div", "demo-actions");
  bar.append(open);
  box.append(stepsBox(d.steps, bar));
  return box;
}

function blockView(b: Block, ctx: ViewCtx, cleanup: (() => void)[]): HTMLElement {
  switch (b.t) {
    case "html":
      return html(b.html);
    case "merk": {
      const box = h("aside", "merk");
      box.append(h("strong", "", "Merke"));
      const ul = h("ul");
      for (const i of b.items) {
        const li = h("li");
        li.innerHTML = i;
        ul.append(li);
      }
      box.append(ul);
      return box;
    }
    case "demo":
      return demoView(b.demo, ctx, cleanup);
    case "widget": {
      const w = mountWidget(b.name) as HTMLElement & { destroy?: () => void };
      if (w.destroy) cleanup.push(() => w.destroy!());
      return w;
    }
    case "cpu": {
      const lab = mountCpu(
        b.cpu,
        (id, ok, withSol) => ok && ctx.markTask(id, withSol),
        (id) => ctx.isSolved(id)
      );
      cleanup.push(() => lab.destroy());
      const sec = h("section", "demo cpu");
      if (b.cpu.caption) sec.append(html(b.cpu.caption, "caption"));
      sec.append(lab.el, stepsBox(b.cpu.steps));
      return sec;
    }
  }
}

export function renderChapter(ch: Chapter, ctx: ViewCtx): ChapterView {
  const el = h("article", "chapter");
  const cleanup: (() => void)[] = [];
  const head = h("header", "ch-head");
  head.append(h("div", "ch-num", `Kapitel ${ch.num}`), h("h1", "", ch.title), html(ch.lead, "lead"));
  el.append(head);
  for (const b of ch.blocks) el.append(blockView(b, ctx, cleanup));
  return { el, destroy: () => cleanup.forEach((f) => f()) };
}
