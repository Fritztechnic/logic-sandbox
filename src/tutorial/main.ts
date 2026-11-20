import "@fontsource-variable/schibsted-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./tutorial.css";
import { chapters } from "./content";
import { h } from "./live";
import { loadProgress, resetProgress, saveProgress } from "./progress";
import { renderChapter, ChapterView } from "./view";

let progress = loadProgress();
const app = document.getElementById("app")!;
const total = chapters.reduce((n, c) => n + c.blocks.reduce((m, b) => m + (b.t === "demo" ? b.demo.tasks?.length ?? 0 : b.t === "cpu" ? b.cpu.tasks?.length ?? 0 : 0), 0), 0);

const side = h("nav", "side");
side.setAttribute("aria-label", "Kapitel");
const main = h("main", "content");
main.id = "main";
main.tabIndex = -1;
const pager = h("div", "pager");
const topbar = h("header", "topbar");
const menuBtn = h("button", "btn menu", "☰ Kapitel");
menuBtn.type = "button";
menuBtn.setAttribute("aria-controls", "side");
const back = h("a", "btn", "← Sandbox");
back.href = "/";
const title = h("span", "ttl", "8-Bit-CPU selbst bauen");
const bar = h("div", "prog-bar");
const barFill = h("div", "prog-fill");
bar.append(barFill);
const barText = h("span", "prog-text");
topbar.append(menuBtn, title, h("span", "grow"), barText, bar, back);
side.id = "side";

const links: HTMLAnchorElement[] = [];
const sideList = h("ol", "ch-list");
for (const c of chapters) {
  const li = h("li");
  const a = h("a", "", "");
  a.href = `#${c.id}`;
  a.append(h("span", "n", String(c.num)), h("span", "t", c.title), h("span", "ck", ""));
  li.append(a);
  sideList.append(li);
  links.push(a);
}
const resetBtn = h("button", "btn small", "Fortschritt zurücksetzen");
resetBtn.type = "button";
resetBtn.addEventListener("click", () => {
  if (confirm("Gespeicherten Fortschritt wirklich löschen?")) {
    progress = resetProgress();
    show(current);
  }
});
side.append(sideList, resetBtn);
app.append(topbar, side, main);

let current = 0;
let view: ChapterView | null = null;

function chapterIndex(hash: string): number {
  const id = decodeURIComponent(hash.replace(/^#/, ""));
  const i = chapters.findIndex((c) => c.id === id);
  return i >= 0 ? i : -1;
}

function taskIds(ci: number): string[] {
  const ids: string[] = [];
  for (const b of chapters[ci].blocks) {
    if (b.t === "demo") b.demo.tasks?.forEach((t) => ids.push(t.id));
    if (b.t === "cpu") b.cpu.tasks?.forEach((t) => ids.push(t.id));
  }
  return ids;
}

function paintProgress(): void {
  let done = 0;
  Object.keys(progress.tasks).forEach(() => done++);
  barFill.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
  barText.textContent = `${done}/${total} Aufgaben`;
  chapters.forEach((c, i) => {
    const ids = taskIds(i);
    const n = ids.filter((id) => progress.tasks[id]).length;
    const full = ids.length > 0 ? n === ids.length : !!progress.visited[c.id];
    links[i].classList.toggle("done", full);
    links[i].classList.toggle("cur", i === current);
    links[i].querySelector(".ck")!.textContent = ids.length ? (full ? "✓" : `${n}/${ids.length}`) : full ? "✓" : "";
    if (i === current) links[i].setAttribute("aria-current", "page");
    else links[i].removeAttribute("aria-current");
  });
}

function show(i: number): void {
  view?.destroy();
  current = i;
  const ch = chapters[i];
  progress.visited[ch.id] = 1;
  progress.last = ch.id;
  saveProgress(progress);
  view = renderChapter(ch, {
    isSolved: (id) => !!progress.tasks[id],
    markTask: (id, withSolution) => {
      const old = progress.tasks[id];
      const val = withSolution ? 2 : 1;
      if (!old || (old === 2 && val === 1)) {
        progress.tasks[id] = val;
        saveProgress(progress);
        paintProgress();
      }
    },
  });
  main.textContent = "";
  main.append(view.el);
  pager.textContent = "";
  const prev = i > 0 ? h("a", "btn", `← ${chapters[i - 1].title}`) : null;
  const next = i < chapters.length - 1 ? h("a", "btn primary", `${chapters[i + 1].title} →`) : null;
  if (prev) prev.href = `#${chapters[i - 1].id}`;
  if (next) next.href = `#${chapters[i + 1].id}`;
  pager.append(...[prev, next].filter((x): x is HTMLAnchorElement => !!x));
  main.append(pager);
  document.title = `${ch.num}. ${ch.title} – 8-Bit-CPU selbst bauen`;
  paintProgress();
  window.scrollTo(0, 0);
  document.body.classList.remove("side-open");
}

function route(): void {
  const i = chapterIndex(location.hash);
  if (i >= 0) {
    if (i !== current || !view) show(i);
    return;
  }
  const last = progress.last ? chapters.findIndex((c) => c.id === progress.last) : 0;
  location.replace(`#${chapters[Math.max(0, last)].id}`);
}

window.addEventListener("hashchange", route);
menuBtn.addEventListener("click", () => document.body.classList.toggle("side-open"));
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.matches("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "]" && current < chapters.length - 1) location.hash = chapters[current + 1].id;
  else if (e.key === "[" && current > 0) location.hash = chapters[current - 1].id;
});
route();
