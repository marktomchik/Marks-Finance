import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type MarkFinancePlugin from "./main";
import {
  FinanceFile, Transaction, Summary, summarize, reconcile, categoryColor, categoryName,
  money, monthLabel, MONTHS_UA, r2,
} from "./data";

export const VIEW_TYPE = "mark-finance-view";
type Tab = "overview" | "transactions" | "reconcile";
const SVG_NS = "http://www.w3.org/2000/svg";
const PAGE = 60;

export class FinanceView extends ItemView {
  private plugin: MarkFinancePlugin;
  private data: FinanceFile | null = null;
  private error = "";
  private tab: Tab = "overview";
  private period = "all";
  private from = "";
  private to = "";
  private category = "";
  private direction = "";
  private search = "";
  private shown = PAGE;
  private body!: HTMLElement;

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
    } catch (e) {
      this.data = null;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  // ---------- period ----------
  private range(): [string, string] {
    const now = new Date();
    const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const p = this.period;
    if (p === "all") return ["0000-00-00", "9999-99-99"];
    if (p === "custom") return [this.from || "0000-00-00", this.to || "9999-99-99"];
    if (p === "this-month") { const m = ym(now); return [`${m}-01`, `${m}-31`]; }
    if (p === "last-month") { const m = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1)); return [`${m}-01`, `${m}-31`]; }
    if (p === "3m") { const m = ym(new Date(now.getFullYear(), now.getMonth() - 2, 1)); return [`${m}-01`, "9999-99-99"]; }
    if (p === "year") return [`${now.getFullYear()}-01-01`, `${now.getFullYear()}-12-31`];
    if (/^\d{4}-\d{2}$/.test(p)) return [`${p}-01`, `${p}-31`];
    if (/^\d{4}$/.test(p)) return [`${p}-01-01`, `${p}-12-31`];
    return ["0000-00-00", "9999-99-99"];
  }

  private periodTxs(): Transaction[] {
    const [a, b] = this.range();
    return (this.data?.transactions ?? []).filter((t) => t.date >= a && t.date <= b);
  }

  // ---------- render ----------
  render(): void {
    const root = this.contentEl;
    root.empty();
    const cur = this.plugin.settings.currencyLabel;

    const head = root.createDiv("mf-head");
    head.createEl("h3", { text: "Фінанси" });
    const meta = head.createDiv("mf-meta");
    const gen = this.data?.meta?.generatedAt;
    if (gen) meta.setText(`оновлено ${new Date(gen).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" })}`);
    const btn = head.createEl("button", { cls: "clickable-icon mf-icon-btn", attr: { "aria-label": "Перечитати файл" } });
    setIcon(btn, "refresh-cw");
    btn.onclick = async () => { await this.reload(); new Notice("Фінанси оновлено"); };

    if (!this.data) {
      const box = root.createDiv("mf-empty");
      box.createEl("p", { text: `Не вдалося прочитати «${this.plugin.settings.dataPath}».` });
      if (this.error) box.createEl("p", { cls: "mf-muted", text: this.error });
      box.createEl("p", { cls: "mf-muted", text: "Файл створює /finance-check. Шлях можна змінити в налаштуваннях плагіна." });
      return;
    }

    this.renderControls(root);
    const tabs = root.createDiv("mf-tabs");
    const tabDefs: [Tab, string][] = [["overview", "Огляд"], ["transactions", "Операції"], ["reconcile", "Звірка"]];
    for (const [id, label] of tabDefs) {
      const b = tabs.createEl("button", { text: label, cls: id === this.tab ? "is-active" : "" });
      b.onclick = () => { this.tab = id; this.shown = PAGE; this.render(); };
    }

    this.body = root.createDiv("mf-body");
    const txs = this.periodTxs();
    if (this.tab === "overview") this.renderOverview(txs, cur);
    else if (this.tab === "transactions") this.renderTransactions(txs, cur);
    else this.renderReconcile(txs, cur);
  }

  private renderControls(root: HTMLElement): void {
    const bar = root.createDiv("mf-controls");
    const sel = bar.createEl("select", { cls: "dropdown" });
    const opt = (v: string, t: string) => sel.createEl("option", { value: v, text: t });
    opt("all", "Весь час"); opt("this-month", "Цей місяць"); opt("last-month", "Минулий місяць");
    opt("3m", "Останні 3 місяці"); opt("year", "Цей рік");
    const months = [...new Set(this.data!.transactions.map((t) => t.date.slice(0, 7)))].sort().reverse();
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    const gy = sel.createEl("optgroup", { attr: { label: "Рік" } });
    years.forEach((y) => gy.createEl("option", { value: y, text: y }));
    const gm = sel.createEl("optgroup", { attr: { label: "Місяць" } });
    months.forEach((m) => gm.createEl("option", { value: m, text: `${MONTHS_UA[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}` }));
    opt("custom", "Свій період…");
    sel.value = this.period;
    sel.onchange = () => { this.period = sel.value; this.shown = PAGE; this.render(); };

    if (this.period === "custom") {
      const f = bar.createEl("input", { type: "date", value: this.from });
      bar.createSpan({ text: "–", cls: "mf-muted" });
      const t = bar.createEl("input", { type: "date", value: this.to });
      f.onchange = () => { this.from = f.value; this.render(); };
      t.onchange = () => { this.to = t.value; this.render(); };
    }
  }

  private renderOverview(txs: Transaction[], cur: string): void {
    const s = summarize(txs);
    const kpi = this.body.createDiv("mf-kpis");
    const tile = (label: string, value: string, cls = "") => {
      const d = kpi.createDiv("mf-kpi " + cls);
      d.createDiv({ cls: "mf-kpi-label", text: label });
      d.createDiv({ cls: "mf-kpi-value", text: value });
    };
    tile("Витрати", money(s.spend, cur), "is-spend");
    tile("Надходження", money(s.income, cur), "is-income");
    tile("Баланс", money(r2(s.income - s.spend), cur), s.income - s.spend >= 0 ? "is-income" : "is-spend");
    tile("Операцій", String(s.count));

    if (s.monthly.length > 1) {
      const sec = this.section("По місяцях");
      this.monthlyChart(sec, s);
    }

    const pay = this.section("Картка / готівка");
    this.splitBar(pay, s, cur);

    const cats = this.section("Категорії витрат");
    if (!s.categories.length) cats.createDiv({ cls: "mf-muted", text: "Немає витрат за цей період." });
    for (const c of s.categories) {
      const row = cats.createDiv("mf-cat");
      row.onclick = () => { this.category = c.code; this.tab = "transactions"; this.shown = PAGE; this.render(); };
      const top = row.createDiv("mf-cat-top");
      const name = top.createDiv("mf-cat-name");
      name.createSpan({ cls: "mf-dot" }).style.background = categoryColor(c.code);
      name.createSpan({ text: c.name });
      top.createDiv({ cls: "mf-cat-sum", text: `${money(c.total, cur)} · ${s.spend ? Math.round((c.total / s.spend) * 100) : 0}%` });
      const track = row.createDiv("mf-track");
      const fill = track.createDiv("mf-fill");
      fill.style.width = `${s.categories[0].total ? (c.total / s.categories[0].total) * 100 : 0}%`;
      fill.style.background = categoryColor(c.code);
      row.createDiv({ cls: "mf-muted mf-small", text: `${c.count} операцій` });
    }

    const recent = this.section("Останні операції");
    this.txList(recent, txs.slice(0, 8), cur);
  }

  private renderTransactions(all: Transaction[], cur: string): void {
    const bar = this.body.createDiv("mf-controls");
    const q = bar.createEl("input", { type: "search", placeholder: "Пошук…", value: this.search });
    q.oninput = () => { this.search = q.value; this.shown = PAGE; this.drawList(list, all, cur); };
    const cat = bar.createEl("select", { cls: "dropdown" });
    cat.createEl("option", { value: "", text: "Усі категорії" });
    const codes = new Map<string, string>();
    all.forEach((t) => codes.set(t.category || "other", categoryName(t)));
    [...codes].sort((a, b) => a[1].localeCompare(b[1])).forEach(([c, n]) => cat.createEl("option", { value: c, text: n }));
    cat.value = this.category;
    cat.onchange = () => { this.category = cat.value; this.shown = PAGE; this.drawList(list, all, cur); };
    const dir = bar.createEl("select", { cls: "dropdown" });
    [["", "Усі"], ["debit", "Витрати"], ["credit", "Надходження"]].forEach(([v, t]) => dir.createEl("option", { value: v, text: t }));
    dir.value = this.direction;
    dir.onchange = () => { this.direction = dir.value; this.shown = PAGE; this.drawList(list, all, cur); };

    const list = this.body.createDiv();
    this.drawList(list, all, cur);
  }

  private drawList(el: HTMLElement, all: Transaction[], cur: string): void {
    el.empty();
    const q = this.search.trim().toLowerCase();
    const txs = all.filter((t) =>
      (!this.category || (t.category || "other") === this.category)
      && (!this.direction || t.direction === this.direction)
      && (!q || `${t.merchant} ${t.description} ${t.notes} ${t.amount}`.toLowerCase().includes(q)));
    const s = summarize(txs);
    el.createDiv({ cls: "mf-muted mf-small", text: `${txs.length} операцій · витрати ${money(s.spend, cur)} · надходження ${money(s.income, cur)}` });
    this.txList(el, txs.slice(0, this.shown), cur);
    if (txs.length > this.shown) {
      const more = el.createEl("button", { cls: "mf-more", text: `Показати ще (${txs.length - this.shown})` });
      more.onclick = () => { this.shown += PAGE * 2; this.drawList(el, all, cur); };
    }
  }

  private renderReconcile(txs: Transaction[], cur: string): void {
    const issues = reconcile(txs, this.plugin.settings.bigAmount);
    const s = summarize(txs);
    const debits = txs.filter((t) => t.direction === "debit");
    this.body.createDiv({
      cls: "mf-muted mf-small",
      text: `З чеком: ${s.withReceipt} з ${txs.length} · готівкою ${debits.filter((t) => t.payment === "cash").length}, карткою ${debits.filter((t) => t.payment !== "cash").length}`,
    });
    if (!issues.length) { this.body.createDiv({ cls: "mf-empty", text: "Розбіжностей не знайдено ✓" }); return; }
    for (const is of issues) {
      const d = this.body.createEl("details", { cls: "mf-issue" });
      const sum = d.createEl("summary");
      sum.createSpan({ text: is.title });
      if (is.txs.length) sum.createSpan({ cls: "mf-badge", text: String(is.txs.length) });
      if (is.txs.length) this.txList(d, is.txs.slice(0, 200), cur);
    }
  }

  // ---------- pieces ----------
  private section(title: string): HTMLElement {
    const s = this.body.createDiv("mf-section");
    s.createEl("h4", { text: title });
    return s;
  }

  private txList(el: HTMLElement, txs: Transaction[], cur: string): void {
    const list = el.createDiv("mf-list");
    for (const t of txs) {
      const row = list.createDiv("mf-tx");
      row.createSpan({ cls: "mf-dot" }).style.background = categoryColor(t.category || "other");
      const mid = row.createDiv("mf-tx-mid");
      mid.createDiv({ cls: "mf-tx-name", text: t.merchant || t.description || "—" });
      const sub = mid.createDiv({ cls: "mf-muted mf-small" });
      sub.setText(`${t.date} · ${categoryName(t)}${t.payment === "cash" ? " · готівка" : ""}`);
      if (t.hasReceipt) {
        const r = sub.createSpan({ cls: "mf-receipt", attr: { "aria-label": "Є чек" } });
        setIcon(r, "receipt");
      }
      row.createDiv({ cls: "mf-tx-amt " + (t.direction === "credit" ? "is-income" : ""), text: `${t.direction === "credit" ? "+" : "−"}${money(t.amount, cur)}` });
      row.onclick = () => row.toggleClass("is-open", !row.hasClass("is-open"));
      const det = row.createDiv("mf-tx-details");
      if (t.description) det.createDiv({ text: t.description });
      if (t.notes) det.createDiv({ cls: "mf-muted", text: t.notes });
      if (t.receiptUrl) det.createEl("a", { text: "Відкрити чек", href: t.receiptUrl });
    }
  }

  private splitBar(el: HTMLElement, s: Summary, cur: string): void {
    const total = s.card + s.cash;
    const track = el.createDiv("mf-split");
    const a = track.createDiv("mf-split-card"); a.style.width = `${total ? (s.card / total) * 100 : 0}%`;
    const b = track.createDiv("mf-split-cash"); b.style.width = `${total ? (s.cash / total) * 100 : 0}%`;
    const leg = el.createDiv("mf-legend");
    leg.createSpan({ text: `■ Картка ${money(s.card, cur)}`, cls: "mf-l-card" });
    leg.createSpan({ text: `■ Готівка ${money(s.cash, cur)}`, cls: "mf-l-cash" });
  }

  private monthlyChart(el: HTMLElement, s: Summary): void {
    const months = s.monthly.slice(-12);
    const W = 640, H = 200, padL = 8, padB = 22, padT = 8;
    const max = Math.max(1, ...months.map((m) => Math.max(m.spend, m.income)));
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "mf-chart");
    const slot = (W - padL * 2) / months.length;
    const bw = Math.min(18, slot / 2 - 3);
    const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
    const rect = (x: number, v: number, cls: string, title: string) => {
      const r = document.createElementNS(SVG_NS, "rect");
      r.setAttribute("x", String(x)); r.setAttribute("y", String(y(v)));
      r.setAttribute("width", String(bw)); r.setAttribute("height", String(Math.max(0, H - padB - y(v))));
      r.setAttribute("rx", "3"); r.setAttribute("class", cls);
      const t = document.createElementNS(SVG_NS, "title"); t.textContent = title; r.appendChild(t);
      svg.appendChild(r);
    };
    const cur = this.plugin.settings.currencyLabel;
    months.forEach((m, i) => {
      const cx = padL + slot * i + slot / 2;
      rect(cx - bw - 1, m.spend, "mf-bar-spend", `${monthLabel(m.month)}: витрати ${money(m.spend, cur)}`);
      rect(cx + 1, m.income, "mf-bar-income", `${monthLabel(m.month)}: надходження ${money(m.income, cur)}`);
      const lbl = document.createElementNS(SVG_NS, "text");
      lbl.setAttribute("x", String(cx)); lbl.setAttribute("y", String(H - 6));
      lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("class", "mf-axis");
      lbl.textContent = monthLabel(m.month);
      svg.appendChild(lbl);
    });
    el.appendChild(svg);
    const leg = el.createDiv("mf-legend");
    leg.createSpan({ text: "■ Витрати", cls: "mf-l-spend" });
    leg.createSpan({ text: "■ Надходження", cls: "mf-l-income" });
  }
}
