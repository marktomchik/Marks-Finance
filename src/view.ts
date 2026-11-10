import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type MarkFinancePlugin from "./main";
import {
  FinanceFile, Transaction, Summary, summarize, reconcile, categoryColor, categoryName,
  money, monthLabel, MONTHS_UA, nextMonth, r2, CATEGORY_ICONS,
} from "./data";

export const VIEW_TYPE = "mark-finance-view";
type Tab = "overview" | "transactions" | "reconcile";
type Mode = "month" | "year" | "all" | "custom";
const SVG_NS = "http://www.w3.org/2000/svg";
const PAGE = 40;
const MONTHS_FULL = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const WEEKDAYS = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

function prevMonth(m: string): string {
  let [y, mo] = m.split("-").map(Number);
  mo--; if (mo < 1) { mo = 12; y--; }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

export class FinanceView extends ItemView {
  private plugin: MarkFinancePlugin;
  private data: FinanceFile | null = null;
  private error = "";
  private tab: Tab = "overview";
  private mode: Mode = "month";
  private anchor = ""; // YYYY-MM for month mode, YYYY for year mode uses anchor.slice(0,4)
  private from = "";
  private to = "";
  private periodOpen = false;
  private category = "";
  private direction = "";
  private search = "";
  private shown = PAGE;
  private scrollEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: MarkFinancePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Фінанси"; }
  getIcon(): string { return "wallet"; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mf-root");
    await this.reload();
  }

  async reload(): Promise<void> {
    try {
      this.data = await this.plugin.loadFinance();
      this.error = "";
      const last = this.lastDataMonth();
      if (!this.anchor || (last && this.anchor > last)) this.anchor = last || new Date().toISOString().slice(0, 7);
    } catch (e) {
      this.data = null;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  // ---------- period ----------
  private range(): [string, string] {
    if (this.mode === "month") return [`${this.anchor}-01`, `${this.anchor}-31`];
    if (this.mode === "year") { const y = this.anchor.slice(0, 4); return [`${y}-01-01`, `${y}-12-31`]; }
    if (this.mode === "custom") return [this.from || "0000-00-00", this.to || "9999-99-99"];
    return ["0000-00-00", "9999-99-99"];
  }
  private prevRange(): [string, string] | null {
    if (this.mode === "month") { const p = prevMonth(this.anchor); return [`${p}-01`, `${p}-31`]; }
    if (this.mode === "year") { const y = Number(this.anchor.slice(0, 4)) - 1; return [`${y}-01-01`, `${y}-12-31`]; }
    return null;
  }
  private periodLabel(): string {
    if (this.mode === "month") return `${MONTHS_FULL[Number(this.anchor.slice(5)) - 1]} ${this.anchor.slice(0, 4)}`;
    if (this.mode === "year") return `${this.anchor.slice(0, 4)} рік`;
    if (this.mode === "custom") return `${this.from || "…"} – ${this.to || "…"}`;
    return "Весь час";
  }
  private prevLabel(): string {
    if (this.mode === "month") return MONTHS_UA[Number(prevMonth(this.anchor).slice(5)) - 1];
    return String(Number(this.anchor.slice(0, 4)) - 1);
  }
  private filter(a: string, b: string): Transaction[] {
    return (this.data?.transactions ?? []).filter((t) => t.date >= a && t.date <= b);
  }
  private step(dir: 1 | -1): void {
    if (dir > 0 && !this.canStepForward()) return;
    if (this.mode === "month") this.anchor = dir > 0 ? nextMonth(this.anchor) : prevMonth(this.anchor);
    else if (this.mode === "year") this.anchor = `${Number(this.anchor.slice(0, 4)) + dir}${this.anchor.slice(4)}`;
    else return;
    this.shown = PAGE;
    this.render(dir);
  }

  // ---------- render ----------
  render(slide: 0 | 1 | -1 = 0): void {
    const root = this.contentEl;
    const keepScroll = slide === 0 && this.scrollEl ? this.scrollEl.scrollTop : 0;
    root.empty();

    if (!this.data) {
      const box = root.createDiv("mf-empty");
      const ic = box.createDiv("mf-empty-icon"); setIcon(ic, "wallet");
      box.createEl("p", { text: `Не вдалося прочитати «${this.plugin.settings.dataPath}».` });
      if (this.error) box.createEl("p", { cls: "mf-muted", text: this.error });
      box.createEl("p", { cls: "mf-muted", text: "Файл створює /finance-check. Шлях можна змінити в налаштуваннях плагіна." });
      const b = box.createEl("button", { cls: "mod-cta", text: "Спробувати ще" });
      b.onclick = () => void this.reload();
      return;
    }

    this.renderHeader(root);
    this.scrollEl = root.createDiv("mf-scroll");
    if (slide) this.scrollEl.addClass(slide > 0 ? "mf-slide-l" : "mf-slide-r");
    this.attachSwipe(this.scrollEl);

    const [a, b] = this.range();
    const txs = this.filter(a, b);
    if (txs.length === 0 && this.renderNoDataHint(this.scrollEl)) { if (keepScroll) this.scrollEl.scrollTop = keepScroll; return; }
    if (this.tab === "overview") this.renderOverview(txs);
    else if (this.tab === "transactions") this.renderTransactions(txs);
    else this.renderReconcile(txs);

    if (keepScroll) this.scrollEl.scrollTop = keepScroll;
  }

  private renderHeader(root: HTMLElement): void {
    const head = root.createDiv("mf-head");
    const row = head.createDiv("mf-period-row");
    const canStep = this.mode === "month" || this.mode === "year";
    const prev = row.createEl("button", { cls: "mf-round", attr: { "aria-label": "Назад" } });
    setIcon(prev, "chevron-left");
    prev.disabled = !canStep;
    prev.onclick = () => this.step(-1);
    const label = row.createEl("button", { cls: "mf-period-label" });
    label.createSpan({ text: this.periodLabel() });
    setIcon(label.createSpan("mf-caret"), this.periodOpen ? "chevron-up" : "chevron-down");
    label.onclick = () => { this.periodOpen = !this.periodOpen; this.render(); };
    const next = row.createEl("button", { cls: "mf-round", attr: { "aria-label": "Вперед" } });
    setIcon(next, "chevron-right");
    next.disabled = !canStep || !this.canStepForward();
    next.onclick = () => this.step(1);
    this.renderNav(head);

    if (this.periodOpen) {
      const panel = head.createDiv("mf-period-panel");
      const seg = panel.createDiv("mf-seg");
      const modes: [Mode, string][] = [["month", "Місяць"], ["year", "Рік"], ["all", "Весь час"], ["custom", "Період"]];
      for (const [m, t] of modes) {
        const b = seg.createEl("button", { text: t, cls: m === this.mode ? "is-active" : "" });
        b.onclick = () => { this.mode = m; if (m !== "custom") this.periodOpen = false; this.shown = PAGE; this.render(); };
      }
      if (this.mode === "custom") {
        const dates = panel.createDiv("mf-dates");
        const f = dates.createEl("input", { type: "date", value: this.from });
        const t = dates.createEl("input", { type: "date", value: this.to });
        f.onchange = () => { this.from = f.value; this.render(); };
        t.onchange = () => { this.to = t.value; this.render(); };
      }
      const gen = this.data?.meta?.generatedAt;
      const foot = panel.createDiv("mf-panel-foot");
      foot.createSpan({ cls: "mf-muted mf-small", text: gen ? `Дані від ${new Date(gen).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" })}` : "" });
      const rb = foot.createEl("button", { cls: "mf-chip", text: "Перечитати" });
      rb.onclick = async () => { await this.reload(); new Notice("Фінанси оновлено"); };
    }
  }

  /** Latest YYYY-MM that has at least one transaction. */
  private lastDataMonth(): string {
    let max = "";
    for (const t of this.data?.transactions ?? []) if (t.date > max) max = t.date;
    return max.slice(0, 7);
  }

  private canStepForward(): boolean {
    const last = this.lastDataMonth();
    if (!last) return true;
    if (this.mode === "month") return this.anchor < last;
    if (this.mode === "year") return this.anchor.slice(0, 4) < last.slice(0, 4);
    return false;
  }

  /** Shown when the selected period has no transactions but data exists elsewhere. */
  private renderNoDataHint(el: HTMLElement): boolean {
    const last = this.lastDataMonth();
    if (!last || (this.mode !== "month" && this.mode !== "year")) return false;
    const box = el.createDiv("mf-empty");
    const ic = box.createDiv("mf-empty-icon"); setIcon(ic, "calendar-x");
    box.createEl("p", { text: `За ${this.periodLabel().toLowerCase()} операцій немає.` });
    box.createEl("p", { cls: "mf-muted mf-small", text: `Останні дані — ${MONTHS_FULL[Number(last.slice(5)) - 1].toLowerCase()} ${last.slice(0, 4)}.` });
    const b = box.createEl("button", { cls: "mod-cta", text: "До останніх даних" });
    b.onclick = () => { this.mode = "month"; this.anchor = last; this.shown = PAGE; this.render(); };
    return true;
  }

  private renderNav(root: HTMLElement): void {
    const nav = root.createDiv({ cls: "mf-nav", attr: { role: "tablist" } });
    const items: [Tab, string, string][] = [["overview", "Огляд", "pie-chart"], ["transactions", "Операції", "list"], ["reconcile", "Звірка", "check-circle"]];
    for (const [id, label, icon] of items) {
      const b = nav.createEl("button", { cls: id === this.tab ? "is-active" : "" });
      setIcon(b.createSpan("mf-nav-icon"), icon);
      b.createSpan({ cls: "mf-nav-label", text: label });
      b.onclick = () => { this.tab = id; this.shown = PAGE; this.periodOpen = false; this.render(); this.scrollEl.scrollTop = 0; };
    }
  }

  private attachSwipe(el: HTMLElement): void {
    let x0 = 0, y0 = 0, t0 = 0, ok = false;
    el.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      ok = e.touches.length === 1 && !(e.target as HTMLElement).closest(".mf-chips, input, .mf-chart-wrap");
      x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    }, { passive: true });
    el.addEventListener("touchend", (e) => {
      if (!ok) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 45 && Date.now() - t0 < 600) this.step(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  // ---------- overview ----------
  private renderOverview(txs: Transaction[]): void {
    const cur = this.plugin.settings.currencyLabel;
    const el = this.scrollEl;
    const s = summarize(txs);

    const hero = el.createDiv("mf-card mf-hero");
    hero.createDiv({ cls: "mf-hero-label", text: "Витрати" });
    hero.createDiv({ cls: "mf-hero-value", text: money(s.spend, cur) });
    const pr = this.prevRange();
    if (pr) {
      const ps = summarize(this.filter(pr[0], pr[1]));
      if (ps.spend > 0) {
        const pct = Math.round(((s.spend - ps.spend) / ps.spend) * 100);
        hero.createDiv({ cls: "mf-delta " + (pct > 0 ? "is-up" : "is-down"), text: `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% до ${this.prevLabel()} (${money(ps.spend, cur)})` });
      }
    }
    const sub = hero.createDiv("mf-hero-sub");
    const cell = (label: string, value: string, cls = "") => {
      const c = sub.createDiv("mf-hero-cell");
      c.createDiv({ cls: "mf-muted mf-small", text: label });
      c.createDiv({ cls: "mf-num " + cls, text: value });
    };
    const bal = r2(s.income - s.spend);
    cell("Надходження", money(s.income, cur), "is-income");
    cell("Баланс", `${bal > 0 ? "+" : ""}${money(bal, cur)}`, bal >= 0 ? "is-income" : "is-spend");
    cell("Операцій", String(s.count));

    // Monthly chart over all data, current month highlighted.
    const all = summarize(this.data!.transactions);
    if (all.monthly.length > 1) {
      const card = this.card("По місяцях");
      this.monthlyChart(card, all);
    }

    const cats = this.card("Категорії");
    if (!s.categories.length) cats.createDiv({ cls: "mf-muted", text: "Немає витрат за цей період." });
    const maxCat = s.categories[0]?.total || 1;
    for (const c of s.categories) {
      const row = cats.createDiv("mf-cat");
      row.onclick = () => { this.category = c.code; this.direction = ""; this.tab = "transactions"; this.shown = PAGE; this.render(); this.scrollEl.scrollTop = 0; };
      this.avatar(row, c.code, c.name);
      const mid = row.createDiv("mf-cat-mid");
      const top = mid.createDiv("mf-cat-top");
      top.createDiv({ cls: "mf-cat-name", text: c.name });
      top.createDiv({ cls: "mf-num", text: money(c.total, cur) });
      const track = mid.createDiv("mf-track");
      const fill = track.createDiv("mf-fill");
      fill.style.width = `${(c.total / maxCat) * 100}%`;
      fill.style.background = categoryColor(c.code);
      mid.createDiv({ cls: "mf-muted mf-small", text: `${s.spend ? Math.round((c.total / s.spend) * 100) : 0}% · ${c.count} опер.` });
    }

    if (s.card + s.cash > 0) {
      const pay = this.card("Картка / готівка");
      this.splitBar(pay, s, cur);
    }

    if (txs.length) {
      const recent = this.card("Останні операції");
      this.txList(recent, txs.slice(0, 5), cur, false);
      const more = recent.createEl("button", { cls: "mf-link-btn", text: "Усі операції →" });
      more.onclick = () => { this.category = ""; this.tab = "transactions"; this.render(); this.scrollEl.scrollTop = 0; };
    }
  }

  // ---------- transactions ----------
  private renderTransactions(all: Transaction[]): void {
    const cur = this.plugin.settings.currencyLabel;
    const el = this.scrollEl;
    const tools = el.createDiv("mf-tools");
    const searchWrap = tools.createDiv("mf-search");
    setIcon(searchWrap.createSpan("mf-search-icon"), "search");
    const q = searchWrap.createEl("input", { type: "search", placeholder: "Магазин, сума, нотатка…", value: this.search });
    const chips = tools.createDiv("mf-chips");
    const list = el.createDiv();

    const drawChips = () => {
      chips.empty();
      const chip = (label: string, active: boolean, on: () => void, color?: string) => {
        const c = chips.createEl("button", { cls: "mf-chip" + (active ? " is-active" : "") });
        if (color) c.createSpan({ cls: "mf-dot" }).style.background = color;
        c.createSpan({ text: label });
        c.onclick = () => { on(); this.shown = PAGE; drawChips(); this.drawList(list, all, cur); };
      };
      chip("Усі", !this.category && !this.direction, () => { this.category = ""; this.direction = ""; });
      chip("Витрати", this.direction === "debit", () => { this.direction = this.direction === "debit" ? "" : "debit"; });
      chip("Надходження", this.direction === "credit", () => { this.direction = this.direction === "credit" ? "" : "credit"; });
      const cats = summarize(all).categories;
      for (const c of cats) chip(c.name, this.category === c.code, () => { this.category = this.category === c.code ? "" : c.code; }, categoryColor(c.code));
      chips.querySelector(".is-active:not(:first-child)")?.scrollIntoView({ inline: "center", block: "nearest" });
    };
    drawChips();
    let timer = 0;
    q.oninput = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { this.search = q.value; this.shown = PAGE; this.drawList(list, all, cur); }, 200); };
    this.drawList(list, all, cur);
  }

  private drawList(el: HTMLElement, all: Transaction[], cur: string): void {
    el.empty();
    const q = this.search.trim().toLowerCase().replace(",", ".");
    const txs = all.filter((t) =>
      (!this.category || (t.category || "other") === this.category)
      && (!this.direction || t.direction === this.direction)
      && (!q || `${t.merchant} ${t.description} ${t.notes} ${t.amount}`.toLowerCase().includes(q)));
    const s = summarize(txs);
    const sum = el.createDiv("mf-list-sum");
    sum.createSpan({ text: `${txs.length} операцій` });
    sum.createSpan({ cls: "is-spend", text: `−${money(s.spend, cur)}` });
    if (s.income) sum.createSpan({ cls: "is-income", text: `+${money(s.income, cur)}` });
    if (!txs.length) { el.createDiv({ cls: "mf-empty-inline", text: "Нічого не знайдено" }); return; }
    this.txList(el, txs.slice(0, this.shown), cur, true);
    if (txs.length > this.shown) {
      const more = el.createEl("button", { cls: "mf-more", text: `Показати ще (${txs.length - this.shown})` });
      more.onclick = () => { this.shown += PAGE * 2; this.drawList(el, all, cur); };
    }
  }

  // ---------- reconcile ----------
  private renderReconcile(txs: Transaction[]): void {
    const cur = this.plugin.settings.currencyLabel;
    const el = this.scrollEl;
    const issues = reconcile(txs, this.plugin.settings.bigAmount);
    const s = summarize(txs);
    const debits = txs.filter((t) => t.direction === "debit");
    const stats = el.createDiv("mf-stats");
    const stat = (n: string, label: string) => { const d = stats.createDiv("mf-stat"); d.createDiv({ cls: "mf-stat-n", text: n }); d.createDiv({ cls: "mf-muted mf-small", text: label }); };
    stat(`${txs.length ? Math.round((s.withReceipt / txs.length) * 100) : 0}%`, "з чеком");
    stat(String(debits.filter((t) => t.payment === "cash").length), "готівкою");
    stat(String(issues.reduce((a, i) => a + Math.max(1, i.txs.length), 0)), "до перевірки");

    if (!issues.length) { el.createDiv({ cls: "mf-card mf-ok", text: "Розбіжностей не знайдено ✓" }); return; }
    const icons: Record<string, string> = { duplicate: "copy", "cash-card": "banknote", "orphan-receipt": "receipt", "no-receipt": "file-question", other: "tag", category: "tag", gap: "calendar-x" };
    for (const is of issues) {
      const d = el.createEl("details", { cls: "mf-card mf-issue" });
      const sm = d.createEl("summary");
      setIcon(sm.createSpan("mf-issue-icon"), icons[is.kind] || "alert-circle");
      sm.createSpan({ cls: "mf-issue-title", text: is.title });
      if (is.txs.length) sm.createSpan({ cls: "mf-badge", text: String(is.txs.length) });
      if (is.txs.length) {
        let drawn = false;
        d.addEventListener("toggle", () => { if (d.open && !drawn) { drawn = true; this.txList(d, is.txs.slice(0, 150), cur, false); } });
      }
    }
  }

  // ---------- pieces ----------
  private card(title: string): HTMLElement {
    const c = this.scrollEl.createDiv("mf-card");
    c.createDiv({ cls: "mf-card-title", text: title });
    return c;
  }

  private avatar(parent: HTMLElement, code: string, name: string): void {
    const a = parent.createDiv({ cls: "mf-avatar", attr: { "aria-label": name } });
    const icon = CATEGORY_ICONS[code];
    if (icon) setIcon(a, icon);
    if (!a.firstChild) a.setText((name || "?").charAt(0).toUpperCase());
    a.style.setProperty("--mf-c", categoryColor(code));
  }

  private txList(el: HTMLElement, txs: Transaction[], cur: string, grouped: boolean): void {
    const list = el.createDiv("mf-list");
    let day = "";
    for (const t of txs) {
      if (grouped && t.date !== day) {
        day = t.date;
        const d = new Date(`${t.date}T12:00:00`);
        const h = list.createDiv("mf-day");
        h.createSpan({ text: `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_UA[d.getMonth()]}${t.date.slice(0, 4) !== String(new Date().getFullYear()) ? " " + t.date.slice(0, 4) : ""}` });
        const dayTotal = txs.filter((x) => x.date === t.date && x.direction === "debit").reduce((a, x) => a + x.amount, 0);
        if (dayTotal) h.createSpan({ cls: "mf-muted mf-day-sum", text: `−${money(r2(dayTotal), cur)}` });
      }
      const row = list.createDiv("mf-tx");
      this.avatar(row, t.category || "other", categoryName(t));
      const mid = row.createDiv("mf-tx-mid");
      mid.createDiv({ cls: "mf-tx-name", text: t.merchant || t.description || "—" });
      const sub = mid.createDiv({ cls: "mf-muted mf-small mf-tx-sub" });
      sub.createSpan({ text: grouped ? categoryName(t) : `${t.date.slice(8)}.${t.date.slice(5, 7)} · ${categoryName(t)}` });
      if (t.payment === "cash") sub.createSpan({ cls: "mf-tag", text: "готівка" });
      if (t.hasReceipt) setIcon(sub.createSpan({ cls: "mf-receipt", attr: { "aria-label": "Є чек" } }), "receipt");
      row.createDiv({ cls: "mf-tx-amt " + (t.direction === "credit" ? "is-income" : ""), text: `${t.direction === "credit" ? "+" : "−"}${money(t.amount, cur)}` });
      row.onclick = (e) => {
        if ((e.target as HTMLElement).closest("a")) return;
        if (row.hasClass("is-open")) { row.removeClass("is-open"); row.querySelector(".mf-tx-details")?.remove(); return; }
        row.addClass("is-open");
        const det = row.createDiv("mf-tx-details");
        det.createDiv({ text: t.date });
        if (t.description) det.createDiv({ text: t.description });
        if (t.notes) det.createDiv({ cls: "mf-muted", text: t.notes });
        if (t.receiptUrl) det.createEl("a", { text: "Відкрити чек", href: t.receiptUrl });
      };
    }
  }

  private splitBar(el: HTMLElement, s: Summary, cur: string): void {
    const total = s.card + s.cash;
    const track = el.createDiv("mf-split");
    track.createDiv("mf-split-card").style.width = `${(s.card / total) * 100}%`;
    track.createDiv("mf-split-cash").style.width = `${(s.cash / total) * 100}%`;
    const leg = el.createDiv("mf-legend");
    const item = (cls: string, label: string, v: number) => {
      const i = leg.createDiv("mf-legend-item");
      i.createSpan({ cls: "mf-dot " + cls });
      i.createSpan({ text: `${label} ${Math.round((v / total) * 100)}%` });
      i.createSpan({ cls: "mf-muted", text: money(v, cur) });
    };
    item("mf-bg-card", "Картка", s.card);
    item("mf-bg-cash", "Готівка", s.cash);
  }

  private monthlyChart(el: HTMLElement, s: Summary): void {
    const narrow = (this.contentEl.clientWidth || 400) < 560;
    const count = narrow ? 6 : 12;
    let end = s.monthly.findIndex((m) => m.month === this.anchor);
    if (this.mode !== "month" || end < 0) end = s.monthly.length - 1;
    const start = Math.max(0, end - count + 1);
    const months = s.monthly.slice(start, Math.max(end + 1, start + count));
    const W = narrow ? 340 : 640, H = 170, padB = 30, padT = 18;
    const max = Math.max(1, ...months.map((m) => Math.max(m.spend, m.income)));
    const wrap = el.createDiv("mf-chart-wrap");
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "mf-chart");
    const slot = W / months.length;
    const bw = Math.min(20, slot / 2 - 4);
    const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
    const mk = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
      const n = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      parent.appendChild(n);
      return n;
    };
    const short = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(Math.round(v)));
    months.forEach((m, i) => {
      const cx = slot * i + slot / 2;
      const sel = this.mode === "month" && m.month === this.anchor;
      const g = mk("g", { class: "mf-col" + (sel ? " is-sel" : "") });
      mk("rect", { x: slot * i + 2, y: 0, width: slot - 4, height: H, rx: 8, class: "mf-col-bg" }, g);
      mk("rect", { x: cx - bw - 1, y: y(m.spend), width: bw, height: Math.max(1, H - padB - y(m.spend)), rx: 4, class: "mf-bar-spend" }, g);
      mk("rect", { x: cx + 1, y: y(m.income), width: bw, height: Math.max(1, H - padB - y(m.income)), rx: 4, class: "mf-bar-income" }, g);
      if (sel || !narrow) mk("text", { x: cx - bw / 2 - 1, y: y(m.spend) - 4, "text-anchor": "middle", class: "mf-val" }, g).textContent = short(m.spend);
      mk("text", { x: cx, y: H - 10, "text-anchor": "middle", class: "mf-axis" }, g).textContent = monthLabel(m.month);
      g.addEventListener("click", () => { this.mode = "month"; this.anchor = m.month; this.render(); });
    });
    wrap.appendChild(svg);
    const leg = el.createDiv("mf-legend");
    const li = (cls: string, t: string) => { const i = leg.createDiv("mf-legend-item"); i.createSpan({ cls: "mf-dot " + cls }); i.createSpan({ text: t }); };
    li("mf-bg-spend", "Витрати"); li("mf-bg-income", "Надходження");
    leg.createDiv({ cls: "mf-muted mf-small mf-legend-hint", text: "Торкніться місяця" });
  }
}
