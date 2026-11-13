import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type MarkFinancePlugin from "./main";
import type { LocalStore } from "./main";
import {
  FinanceFile, Transaction, Summary, summarize, reconcile, categoryColor, categoryName, codeName,
  money, monthLabel, MONTHS_UA, nextMonth, prevMonth, r2, CATEGORY_ICONS, CATEGORY_NAMES,
  Converter, convertTransactions, CURRENCY_LABEL, categoryDetail, categoryShares, inCategory,
  PlanItem, Note, loanSign, loanActive,
} from "./data";
import { PlanModal, NoteModal, TxModal, OverrideModal, TxDraft } from "./modals";
import type { ExtensionTab } from "./extensions";

export const VIEW_TYPE = "mark-finance-view";
type BuiltinTab = "overview" | "transactions" | "plan" | "loans" | "notes" | "review";
/** Built-in tab, or "ext:<id>" for a tab registered by an extension plugin. */
type Tab = BuiltinTab | `ext:${string}`;
type Mode = "month" | "year" | "all" | "custom";
const SVG_NS = "http://www.w3.org/2000/svg";
const PAGE = 40;
const MONTHS_FULL = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const WEEKDAYS = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const TABS: [BuiltinTab, string, string][] = [
  ["overview", "Огляд", "pie-chart"], ["transactions", "Операції", "list"], ["plan", "План", "target"],
  ["loans", "Борги", "hand-coins"], ["notes", "Нотатки", "sticky-note"], ["review", "Перевірка", "check-circle"],
];
const EXCLUDED_LABEL: Record<string, string> = { transfer: "переказ між своїми", refund: "повернення", internal: "внутрішній рух", manual: "не враховується" };

export class FinanceView extends ItemView {
  private plugin: MarkFinancePlugin;
  private data: FinanceFile | null = null;
  private txs: Transaction[] = []; // in the display currency
  private conv!: Converter;
  private local: LocalStore = { plan: [], notes: [] };
  private error = "";
  /** true when the data comes from <dataDir>/ledger (format v3): adding and editing operations is possible. */
  private v3 = false;
  private tab: Tab = "overview";
  private mode: Mode = "month";
  private anchor = "";
  private from = "";
  private to = "";
  private periodOpen = false;
  private category = "";
  private direction = "";
  private search = "";
  private shown = PAGE;
  private detailCat = ""; // overview: category drill-down
  private scrollEl!: HTMLElement;
  /** Mounted extension tab: its container survives re-renders (month changes), cleanup runs when it is left. */
  private extMount: { id: string; el: HTMLElement; month: string; cleanup?: () => void; listeners: Set<(m: string) => void> } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MarkFinancePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Фінанси"; }
  getIcon(): string { return "wallet"; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mf-root");
    this.addAction("plus", "Нова операція", () => this.openNewTx());
    await this.reload();
  }

  private categoryCodes(): string[] {
    return Object.keys(CATEGORY_NAMES).concat((this.data?.categoryDefs ?? []).map((c) => c.code))
      .filter((c, i, a) => c !== "internal" && a.indexOf(c) === i);
  }
  /** New cash operation (or card, if chosen) entered by hand. */
  openNewTx(): void {
    if (!this.v3) { new Notice("Додавати операції можна після переходу на папку ledger/ (формат v3)."); return; }
    const today = new Date().toISOString().slice(0, 10);
    const draft: TxDraft = { tx_id: "", date: today, amount: 0, direction: "debit", category: "groceries", merchant: "", notes: "", payment: "cash" };
    new TxModal(this.app, draft, this.categoryCodes(), async (res) => {
      if (res === "delete") return;
      const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      await this.saveManual(res, id);
    }).open();
  }
  private async saveManual(d: TxDraft, id: string, oldDate?: string): Promise<void> {
    const tx: Transaction = {
      tx_id: id, date: d.date, amount: Math.round(d.amount * 100) / 100, direction: d.direction, currency: "PLN",
      merchant: d.merchant.trim(), description: "", category: d.category, payment: d.payment, account: d.payment === "cash" ? "cash" : "",
      notes: d.notes.trim(), source: "manual", hasReceipt: false, receiptUrl: null, verified: true, created: new Date().toISOString(),
    } as Transaction;
    try { await this.plugin.saveManual(tx, oldDate); new Notice(oldDate ? "Операцію змінено" : "Операцію додано"); }
    catch (e) { new Notice(`Не вдалося зберегти: ${e instanceof Error ? e.message : e}`); }
  }
  private editTx(t: Transaction): void {
    const raw = this.data?.transactions.find((x) => x.tx_id === t.tx_id) ?? t; // PLN values, not the display currency
    if (raw.origin === "manual") {
      const d: TxDraft = { tx_id: raw.tx_id, date: raw.date, amount: raw.amount, direction: raw.direction, category: raw.category || "other", merchant: raw.merchant || "", notes: raw.notes || "", payment: raw.payment || "cash" };
      new TxModal(this.app, d, this.categoryCodes(), async (res) => {
        if (res === "delete") { await this.plugin.deleteManual(raw.tx_id, raw.date); new Notice("Операцію видалено"); return; }
        await this.saveManual(res, raw.tx_id, raw.date);
      }).open();
      return;
    }
    new OverrideModal(this.app, raw, this.categoryCodes(), async (res) => {
      await this.plugin.setOverride(raw.tx_id, res);
      new Notice(res ? "Зміни збережено" : "Зміни скинуто");
    }).open();
  }

  private get cur(): string { return CURRENCY_LABEL[this.conv?.target] ?? this.conv?.target ?? "zł"; }

  async reload(): Promise<void> {
    try {
      this.v3 = (await this.plugin.format()) === "v3";
      this.data = await this.plugin.loadFinance();
      this.local = await this.plugin.loadLocal(this.data);
      this.applyCurrency();
      this.error = "";
      const last = this.lastDataMonth();
      if (!this.anchor || (this.tab !== "plan" && !this.isExtTab() && last && this.anchor > last)) this.anchor = last || new Date().toISOString().slice(0, 7);
    } catch (e) {
      this.data = null;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  applyCurrency(): void {
    if (!this.data) return;
    const s = this.plugin.settings;
    this.conv = new Converter(s.currency, this.data.fx, Number(s.fixedRates?.[s.currency]) || 0);
    if (!this.conv.ok) { new Notice(`Немає курсу ${s.currency} у файлі даних — показую злоті.`); this.conv = new Converter("PLN", this.data.fx); }
    this.txs = convertTransactions(this.data.transactions, this.conv);
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
  private filter(a: string, b: string, src = this.txs): Transaction[] {
    return src.filter((t) => t.date >= a && t.date <= b);
  }
  private step(dir: 1 | -1): void {
    if (dir > 0 && !this.canStepForward()) return;
    if (this.mode === "month") this.anchor = dir > 0 ? nextMonth(this.anchor) : prevMonth(this.anchor);
    else if (this.mode === "year") this.anchor = `${Number(this.anchor.slice(0, 4)) + dir}${this.anchor.slice(4)}`;
    else return;
    this.shown = PAGE;
    this.render(dir);
  }

  /** Latest YYYY-MM that has at least one transaction. */
  private lastDataMonth(): string {
    let max = "";
    for (const t of this.data?.transactions ?? []) if (t.date > max) max = t.date;
    return max.slice(0, 7);
  }
  /** The plan tab may look ahead: up to the latest planned month or a year from today. */
  private lastAllowedMonth(): string {
    const last = this.lastDataMonth();
    if (this.tab !== "plan" && !this.isExtTab()) return last;
    let m = new Date().toISOString().slice(0, 7);
    for (let i = 0; i < 12; i++) m = nextMonth(m);
    for (const p of this.local.plan) if (p.month > m) m = p.month;
    return m > last ? m : last;
  }
  private canStepForward(): boolean {
    const last = this.lastAllowedMonth();
    if (!last) return true;
    if (this.mode === "month") return this.anchor < last;
    if (this.mode === "year") return this.anchor.slice(0, 4) < last.slice(0, 4);
    return false;
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
      box.createEl("p", { cls: "mf-muted", text: "Дані створює /finance-check у папці фінансів (ledger/, meta.json). Шлях можна змінити в налаштуваннях плагіна." });
      const b = box.createEl("button", { cls: "mod-cta", text: "Спробувати ще" });
      b.onclick = () => void this.reload();
      return;
    }
    if ((this.tab === "plan" || this.isExtTab()) && this.mode !== "month") this.mode = "month";
    if (this.isExtTab() && !this.plugin.ext.tabs.has(this.tab.slice(4))) { this.unmountExt(); this.tab = "overview"; }

    this.renderHeader(root);
    this.scrollEl = root.createDiv("mf-scroll");
    if (slide) this.scrollEl.addClass(slide > 0 ? "mf-slide-l" : "mf-slide-r");
    this.attachSwipe(this.scrollEl);

    const [a, b] = this.range();
    const txs = this.filter(a, b);
    const periodless = this.tab === "loans" || this.tab === "notes" || this.tab === "plan" || this.isExtTab();
    if (!this.isExtTab()) this.unmountExt();
    if (!periodless && txs.length === 0 && this.renderNoDataHint(this.scrollEl)) { if (keepScroll) this.scrollEl.scrollTop = keepScroll; return; }
    if (this.tab === "overview") { if (this.detailCat) this.renderCategoryDetail(txs, this.detailCat); else this.renderOverview(txs); }
    else if (this.tab === "transactions") this.renderTransactions(txs);
    else if (this.tab === "plan") this.renderPlan();
    else if (this.tab === "loans") this.renderLoans();
    else if (this.tab === "notes") this.renderNotes();
    else if (this.isExtTab()) this.renderExtTab(this.plugin.ext.tabs.get(this.tab.slice(4))!);
    else this.renderReview(txs);

    if (keepScroll) this.scrollEl.scrollTop = keepScroll;
  }

  private renderHeader(root: HTMLElement): void {
    const head = root.createDiv("mf-head");
    const periodless = this.tab === "loans" || this.tab === "notes";
    if (!periodless) {
      const row = head.createDiv("mf-period-row");
      const canStep = this.mode === "month" || this.mode === "year";
      const prev = row.createEl("button", { cls: "mf-round", attr: { "aria-label": "Назад" } });
      setIcon(prev, "chevron-left");
      prev.disabled = !canStep;
      prev.onclick = () => this.step(-1);
      const label = row.createEl("button", { cls: "mf-period-label" });
      label.createSpan({ text: this.periodLabel() });
      const monthOnly = this.tab === "plan" || this.isExtTab();
      if (!monthOnly) setIcon(label.createSpan("mf-caret"), this.periodOpen ? "chevron-up" : "chevron-down");
      label.onclick = () => { if (monthOnly) return; this.periodOpen = !this.periodOpen; this.render(); };
      const next = row.createEl("button", { cls: "mf-round", attr: { "aria-label": "Вперед" } });
      setIcon(next, "chevron-right");
      next.disabled = !canStep || !this.canStepForward();
      next.onclick = () => this.step(1);
    }
    this.renderNav(head);

    if (this.periodOpen && !periodless && this.tab !== "plan" && !this.isExtTab()) {
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
    const all: [Tab, string, string][] = [...TABS, ...this.plugin.ext.sortedTabs().map((t): [Tab, string, string] => [`ext:${t.id}`, t.title, t.icon])];
    if (all.length > 6) nav.addClass("has-ext");
    for (const [id, label, icon] of all) {
      const b = nav.createEl("button", { cls: id === this.tab ? "is-active" : "", attr: { role: "tab", "aria-label": label } });
      setIcon(b.createSpan("mf-nav-icon"), icon);
      b.createSpan({ cls: "mf-nav-label", text: label });
      b.onclick = () => {
        if (id === "overview" && this.tab === "overview") this.detailCat = "";
        const leavingPlan = (this.tab === "plan" || this.isExtTab()) && id !== "plan" && !id.startsWith("ext:");
        this.tab = id; this.shown = PAGE; this.periodOpen = false;
        if (leavingPlan) { const last = this.lastDataMonth(); if (last && this.anchor > last) this.anchor = last; }
        this.render(); this.scrollEl.scrollTop = 0;
      };
    }
    nav.querySelector(".is-active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  private attachSwipe(el: HTMLElement): void {
    let x0 = 0, y0 = 0, t0 = 0, ok = false;
    el.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      ok = e.touches.length === 1 && !(e.target as HTMLElement).closest(".mf-chips, input, textarea, .mf-chart-wrap");
      x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    }, { passive: true });
    el.addEventListener("touchend", (e) => {
      if (!ok || this.tab === "loans" || this.tab === "notes" || this.isExtTab()) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 45 && Date.now() - t0 < 600) this.step(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  // ---------- overview ----------
  private renderOverview(txs: Transaction[]): void {
    const cur = this.cur;
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

    const all = summarize(this.txs);
    if (all.monthly.length > 1) {
      const card = this.card("По місяцях");
      this.monthlyChart(card, all);
    }

    const cats = this.card("Категорії");
    if (!s.categories.length) cats.createDiv({ cls: "mf-muted", text: "Немає витрат за цей період." });
    else cats.createDiv({ cls: "mf-muted mf-small mf-card-hint", text: "Торкніться категорії, щоб побачити, з чого вона складається." });
    this.categoryRows(cats, s.categories, s.spend, (code) => { this.detailCat = code; this.render(); this.scrollEl.scrollTop = 0; });

    if (s.incomeCategories.length) {
      const inc = this.card("Надходження");
      this.categoryRows(inc, s.incomeCategories, s.income, (code) => this.openTransactions(code, "credit"));
    }

    if (s.card + s.cash > 0) {
      const pay = this.card("Картка / готівка");
      this.splitBar(pay, s, cur);
    }

    this.internalBlock(txs);

    if (txs.length) {
      const recent = this.card("Останні операції");
      this.txList(recent, txs.slice(0, 5), cur, false);
      const more = recent.createEl("button", { cls: "mf-link-btn", text: "Усі операції →" });
      more.onclick = () => this.openTransactions("", "");
    }
  }

  /** Internal movements and other excluded rows: shown collapsed, never counted. */
  private internalBlock(txs: Transaction[]): void {
    const ex = txs.filter((t) => t.excluded);
    if (!ex.length) return;
    const cur = this.cur;
    const out = r2(ex.filter((t) => t.direction === "debit").reduce((s, t) => s + t.amount, 0));
    const inn = r2(ex.filter((t) => t.direction === "credit").reduce((s, t) => s + t.amount, 0));
    const box = this.scrollEl.createEl("details", { cls: "mf-card mf-issue mf-internal" });
    const sm = box.createEl("summary");
    setIcon(sm.createSpan("mf-issue-icon"), "repeat-2");
    const t = sm.createDiv("mf-cover-text");
    t.createDiv({ text: `Внутрішні рухи · ${ex.length}` });
    t.createDiv({ cls: "mf-muted mf-small", text: `Не витрати й не доходи: внесення і зняття готівки, обмін валют, перекази між своїми рахунками, повернення. Вийшло ${money(out, cur)} · зайшло ${money(inn, cur)}.` });
    let drawn = false;
    box.addEventListener("toggle", () => { if (box.open && !drawn) { drawn = true; this.txList(box, ex, cur, false); } });
  }

  private categoryRows(el: HTMLElement, list: Summary["categories"], total: number, onTap: (code: string) => void): void {
    const max = list[0]?.total || 1;
    for (const c of list) {
      const row = el.createDiv("mf-cat");
      row.onclick = () => onTap(c.code);
      this.avatar(row, c.code, c.name);
      const mid = row.createDiv("mf-cat-mid");
      const top = mid.createDiv("mf-cat-top");
      top.createDiv({ cls: "mf-cat-name", text: c.name });
      top.createDiv({ cls: "mf-num", text: money(c.total, this.cur) });
      const track = mid.createDiv("mf-track");
      const fill = track.createDiv("mf-fill");
      fill.style.width = `${(c.total / max) * 100}%`;
      fill.style.background = categoryColor(c.code);
      mid.createDiv({ cls: "mf-muted mf-small", text: `${total ? Math.round((c.total / total) * 100) : 0}% · ${c.count} опер.` });
    }
  }

  private openTransactions(category: string, direction: string): void {
    this.category = category; this.direction = direction; this.tab = "transactions"; this.shown = PAGE;
    this.render(); this.scrollEl.scrollTop = 0;
  }

  // ---------- category drill-down ----------
  private renderCategoryDetail(txs: Transaction[], code: string): void {
    const cur = this.cur;
    const el = this.scrollEl;
    const d = categoryDetail(txs, code);
    const spend = summarize(txs).spend;

    const back = el.createEl("button", { cls: "mf-back" });
    setIcon(back.createSpan(), "arrow-left");
    back.createSpan({ text: "Усі категорії" });
    back.onclick = () => { this.detailCat = ""; this.render(); this.scrollEl.scrollTop = 0; };

    const hero = el.createDiv("mf-card mf-hero");
    const ttl = hero.createDiv("mf-detail-title");
    this.avatar(ttl, code, codeName(code));
    ttl.createDiv({ cls: "mf-hero-label", text: codeName(code) });
    hero.createDiv({ cls: "mf-hero-value", text: money(d.total, cur) });
    hero.createDiv({ cls: "mf-muted mf-small", text: `${spend ? Math.round((d.total / spend) * 100) : 0}% усіх витрат · ${this.periodLabel().toLowerCase()}` });

    // Coverage: what part of the category is explained by receipt lines.
    const cov = this.card("Покриття чеками");
    const detailed = r2(d.total - d.noDetail.total);
    const pct = d.total ? Math.round((detailed / d.total) * 100) : 0;
    const bar = cov.createDiv("mf-split");
    const fill = bar.createDiv("mf-split-card"); fill.style.width = `${pct}%`; fill.style.background = categoryColor(code);
    cov.createDiv({ cls: "mf-small", text: `Деталізовано ${pct}% · ${money(detailed, cur)}` });
    if (d.noDetail.txs.length) {
      const n = d.noDetail.txs.length;
      const npct = d.total ? Math.round((d.noDetail.total / d.total) * 100) : 0;
      const box = cov.createEl("details", { cls: "mf-cover" });
      const sm = box.createEl("summary");
      setIcon(sm.createSpan("mf-issue-icon"), "file-question");
      const txt = sm.createDiv("mf-cover-text");
      txt.createDiv({ text: `Без чека: ${n} ${plural(n, "покупка", "покупки", "покупок")} · ${money(d.noDetail.total, cur)} · ${npct}% суми категорії` });
      txt.createDiv({ cls: "mf-muted mf-small", text: "Не потрапили в деталізацію" + (d.noDetail.noItems ? ` (з них ${d.noDetail.noItems} з чеком без позицій)` : "") + "." });
      let drawn = false;
      box.addEventListener("toggle", () => { if (box.open && !drawn) { drawn = true; this.txList(box, d.noDetail.txs, cur, false); } });
    } else cov.createDiv({ cls: "mf-muted mf-small", text: "Усі покупки цієї категорії мають позиції з чеків." });
    if (Math.abs(d.diff) >= 0.01) {
      const box = cov.createEl("details", { cls: "mf-cover" });
      const sm = box.createEl("summary");
      setIcon(sm.createSpan("mf-issue-icon"), "percent");
      const txt = sm.createDiv("mf-cover-text");
      txt.createDiv({ text: `Інше / знижки: ${d.diff > 0 ? "+" : "−"}${money(Math.abs(d.diff), cur)}` });
      txt.createDiv({ cls: "mf-muted mf-small", text: "Різниця між сумою позицій і сумою чека: знижки, кауція, округлення." });
      let drawn = false;
      box.addEventListener("toggle", () => { if (box.open && !drawn) { drawn = true; this.txList(box, d.diffTxs, cur, false); } });
    }

    if (d.groups.length) {
      const list = this.card(code === "groceries" || code === "dining" || code === "alcohol" ? "З чого складається" : "Позиції з чеків");
      const max = d.groups[0].total || 1;
      for (const g of d.groups) {
        const box = list.createEl("details", { cls: "mf-sub" });
        const row = box.createEl("summary", { cls: "mf-cat" });
        const mid = row.createDiv("mf-cat-mid");
        const top = mid.createDiv("mf-cat-top");
        top.createDiv({ cls: "mf-cat-name", text: g.name });
        top.createDiv({ cls: "mf-num", text: money(g.total, cur) });
        const track = mid.createDiv("mf-track");
        const f = track.createDiv("mf-fill"); f.style.width = `${(g.total / max) * 100}%`; f.style.background = categoryColor(code);
        const share = detailed ? Math.round((g.total / detailed) * 100) : 0;
        mid.createDiv({ cls: "mf-muted mf-small", text: `${share}% деталізованого · ${g.items.length} поз.` });
        let drawn = false;
        box.addEventListener("toggle", () => {
          if (!box.open || drawn) return;
          drawn = true;
          const ul = box.createDiv("mf-items");
          for (const it of [...g.items].sort((a, b) => (a.tx.date < b.tx.date ? 1 : -1))) {
            const r = ul.createDiv("mf-item");
            const l = r.createDiv("mf-item-mid");
            l.createDiv({ cls: "mf-item-name", text: it.item.n + (it.item.q ? ` × ${it.item.q}${it.item.u ? " " + it.item.u : ""}` : "") });
            l.createDiv({ cls: "mf-muted mf-small", text: `${it.tx.date.slice(8)}.${it.tx.date.slice(5, 7)} · ${it.tx.merchant || "—"}` });
            r.createDiv({ cls: "mf-num", text: money(it.amount, cur) });
            if (it.tx.receiptUrl) this.receiptButton(r, it.tx.receiptUrl, true);
          }
        });
      }
    }

    const all = el.createEl("button", { cls: "mf-link-btn", text: "Усі операції категорії →" });
    all.onclick = () => { this.detailCat = ""; this.openTransactions(code, "debit"); };
  }

  // ---------- transactions ----------
  private renderTransactions(all: Transaction[]): void {
    const cur = this.cur;
    const el = this.scrollEl;
    const tools = el.createDiv("mf-tools");
    const searchWrap = tools.createDiv("mf-search");
    setIcon(searchWrap.createSpan("mf-search-icon"), "search");
    const q = searchWrap.createEl("input", { type: "search", placeholder: "Магазин, сума, нотатка, позиція…", value: this.search });
    if (this.v3) {
      const add = searchWrap.createEl("button", { cls: "mf-add-btn", attr: { "aria-label": "Нова операція" } });
      setIcon(add, "plus");
      add.onclick = () => this.openNewTx();
    }
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
      const s = summarize(all);
      const seen = new Set<string>();
      for (const c of [...s.categories, ...s.incomeCategories].filter((x) => !seen.has(x.code) && seen.add(x.code))) chip(c.name, this.category === c.code, () => { this.category = this.category === c.code ? "" : c.code; }, categoryColor(c.code));
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
      (!this.category || (t.direction === "credit" ? (t.category || "other") === this.category : inCategory(t, this.category) || (t.category || "other") === this.category))
      && (!this.direction || t.direction === this.direction)
      && (!q || `${t.merchant} ${t.description} ${t.notes} ${t.amount} ${(t.items ?? []).map((i) => i.n).join(" ")}`.toLowerCase().includes(q)));
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

  // ---------- plan ----------
  private renderPlan(): void {
    const el = this.scrollEl;
    const month = this.anchor;
    const raw = this.data!.transactions; // plan is kept in PLN, so the facts are too
    const mtx = raw.filter((t) => t.date.startsWith(month) && !t.excluded);
    const p1 = prevMonth(month), p2 = prevMonth(p1);
    const fact = (kind: "income" | "expense", code: string, m: string) => {
      let v = 0;
      for (const t of raw) {
        if (!t.date.startsWith(m) || t.excluded) continue;
        if (kind === "income" && t.direction === "credit" && (t.category || "other") === code) v += t.amount;
        if (kind === "expense" && t.direction === "debit") for (const [c, a] of categoryShares(t)) if (c === code) v += a;
      }
      return r2(v);
    };
    const items = this.local.plan.filter((p) => p.month === month);
    const ext = this.plugin.ext.entriesFor(month).map((e) => ({
      ...e, amountPln: r2(e.currency === "PLN" ? e.amount : new Converter("PLN", this.data!.fx).convert(e.amount, e.currency, `${month}-15`, this.data!.fx)),
    }));
    const extInc = ext.filter((e) => e.kind === "income"), extExp = ext.filter((e) => e.kind === "expense");
    const extSum = (a: typeof ext) => r2(a.reduce((s, e) => s + e.amountPln, 0));
    const inc = items.filter((p) => p.kind === "income"), exp = items.filter((p) => p.kind === "expense");
    const sumP = (a: PlanItem[]) => r2(a.reduce((s, p) => s + p.amount, 0));
    const sumF = (a: PlanItem[], kind: "income" | "expense") => r2([...new Set(a.map((p) => p.category))].reduce((s, c) => s + fact(kind, c, month), 0));
    const hasFacts = mtx.length > 0;

    const hero = el.createDiv("mf-card mf-hero");
    hero.createDiv({ cls: "mf-hero-label", text: `План на ${this.periodLabel().toLowerCase()}` });
    const left = r2(sumP(inc) + extSum(extInc) - sumP(exp) - extSum(extExp));
    hero.createDiv({ cls: "mf-hero-value " + (left >= 0 ? "is-income" : "is-spend"), text: `${left >= 0 ? "+" : ""}${money(left, "zł")}` });
    hero.createDiv({ cls: "mf-muted mf-small", text: "Залишок за планом: доходи мінус витрати. План ведеться в злотих." });
    const sub = hero.createDiv("mf-hero-sub");
    const cell = (label: string, value: string, cls = "") => { const c = sub.createDiv("mf-hero-cell"); c.createDiv({ cls: "mf-muted mf-small", text: label }); c.createDiv({ cls: "mf-num " + cls, text: value }); };
    cell("Доходи", money(r2(sumP(inc) + extSum(extInc)), "zł"), "is-income");
    cell("Витрати", money(r2(sumP(exp) + extSum(extExp)), "zł"), "is-spend");
    if (hasFacts) cell("Факт витрат", money(sumF(exp, "expense"), "zł"));

    const section = (title: string, list: PlanItem[], kind: "income" | "expense", extList: typeof ext) => {
      const card = this.card(title);
      for (const e of extList) {
        const row = card.createDiv("mf-plan-row mf-plan-ext");
        const tab = this.plugin.ext.tabs.get(e.sourceId);
        this.avatar(row, kind === "income" ? "income_ext" : "other", e.title);
        const mid = row.createDiv("mf-cat-mid");
        const top = mid.createDiv("mf-cat-top");
        top.createDiv({ cls: "mf-cat-name", text: e.title || e.sourceId });
        top.createDiv({ cls: "mf-num", text: money(e.amountPln, "zł") });
        const meta = mid.createDiv({ cls: "mf-muted mf-small mf-tx-sub" });
        meta.createSpan({ cls: "mf-tag mf-tag-src", text: tab?.title || e.sourceId });
        meta.createSpan({ text: e.status === "confirmed" ? "підтверджено" : "очікується" });
        if (e.currency !== "PLN") meta.createSpan({ text: money(e.amount, e.currency) });
        row.onclick = () => {
          if (tab) { this.tab = `ext:${tab.id}`; this.render(); this.scrollEl.scrollTop = 0; }
          else new Notice(`Цей рядок веде доповнення «${e.sourceId}». Увімкніть його, щоб змінити.`);
        };
      }
      if (!list.length && !extList.length) card.createDiv({ cls: "mf-muted mf-small", text: "Ще нічого не заплановано." });
      for (const p of list) {
        const row = card.createDiv("mf-plan-row");
        this.avatar(row, p.category || "other", p.name);
        const mid = row.createDiv("mf-cat-mid");
        const top = mid.createDiv("mf-cat-top");
        top.createDiv({ cls: "mf-cat-name", text: p.name || codeName(p.category) });
        top.createDiv({ cls: "mf-num", text: money(p.amount, "zł") });
        const f = fact(kind, p.category, month);
        if (hasFacts) {
          const track = mid.createDiv("mf-track");
          const fill = track.createDiv("mf-fill");
          const ratio = p.amount ? f / p.amount : 0;
          fill.style.width = `${Math.min(100, ratio * 100)}%`;
          fill.style.background = kind === "expense" && ratio > 1 ? "var(--mf-spend)" : kind === "income" ? "var(--mf-income)" : categoryColor(p.category);
          mid.createDiv({ cls: "mf-muted mf-small", text: `факт ${money(f, "zł")} · ${Math.round(ratio * 100)}%${kind === "expense" && f > p.amount ? ` · понад план на ${money(r2(f - p.amount), "zł")}` : ""}` });
        }
        const h1 = fact(kind, p.category, p1), h2 = fact(kind, p.category, p2);
        if (h1 || h2) mid.createDiv({ cls: "mf-muted mf-small", text: `${MONTHS_UA[Number(p1.slice(5)) - 1]}: ${money(h1, "zł")} · ${MONTHS_UA[Number(p2.slice(5)) - 1]}: ${money(h2, "zł")}` });
        row.onclick = () => this.editPlan(p);
      }
      const add = card.createEl("button", { cls: "mf-link-btn", text: kind === "income" ? "+ Дохід" : "+ Витрата" });
      add.onclick = () => this.editPlan({ id: "", kind, name: "", category: kind === "income" ? "income_main" : "groceries", amount: 0, month });
    };
    section("Доходи", inc, "income", extInc);
    section("Витрати", exp, "expense", extExp);

    // Spending categories this month that have no plan line.
    if (hasFacts) {
      const planned = new Set(exp.map((p) => p.category));
      const s = summarize(mtx);
      const extra = s.categories.filter((c) => !planned.has(c.code) && c.total >= 1);
      if (extra.length) {
        const card = this.card("Витрати поза планом");
        for (const c of extra) {
          const r = card.createDiv("mf-plan-extra");
          r.createSpan({ text: c.name });
          r.createSpan({ cls: "mf-num", text: money(c.total, "zł") });
          r.onclick = () => this.editPlan({ id: "", kind: "expense", name: c.name, category: c.code, amount: Math.ceil(c.total), month });
        }
        card.createDiv({ cls: "mf-muted mf-small", text: "Торкніться, щоб додати в план." });
      }
    }

    const prev = this.local.plan.filter((p) => p.month === p1);
    if (!items.length && !ext.length && prev.length) {
      const b = el.createEl("button", { cls: "mod-cta mf-wide", text: `Скопіювати план з ${MONTHS_FULL[Number(p1.slice(5)) - 1].toLowerCase()} (${prev.length})` });
      b.onclick = async () => {
        const copy = prev.map((p) => ({ ...p, id: newId("p"), month }));
        this.local.plan.push(...copy);
        await this.saveLocal();
      };
    }
    el.createDiv({ cls: "mf-muted mf-small mf-foot-note", text: "План і нотатки зберігаються у файлі сховища й синхронізуються між пристроями. У Google Sheet вони потрапляють під час /finance-check." });
  }

  private editPlan(p: PlanItem): void {
    const cats = Object.keys(CATEGORY_NAMES).concat((this.data?.categoryDefs ?? []).map((c) => c.code)).filter((c, i, a) => a.indexOf(c) === i);
    new PlanModal(this.app, p, cats, async (res) => {
      if (res === "delete") this.local.plan = this.local.plan.filter((x) => x.id !== p.id);
      else if (p.id) this.local.plan = this.local.plan.map((x) => (x.id === p.id ? { ...res, id: p.id } : x));
      else this.local.plan.push({ ...res, id: newId("p") });
      await this.saveLocal();
    }).open();
  }

  private async saveLocal(): Promise<void> {
    await this.plugin.saveLocal(this.local);
    this.render();
  }

  // ---------- extension tabs ----------
  private isExtTab(): boolean { return this.tab.startsWith("ext:"); }

  private renderExtTab(tab: ExtensionTab): void {
    const m = this.extMount;
    if (m && m.id === tab.id) {
      this.scrollEl.appendChild(m.el); // keep the extension's DOM and state across re-renders
      if (m.month !== this.anchor) { m.month = this.anchor; for (const cb of [...m.listeners]) { try { cb(this.anchor); } catch (e) { console.error(e); } } }
      return;
    }
    this.unmountExt();
    const el = createDiv({ cls: "mf-ext-host" });
    this.scrollEl.appendChild(el);
    const listeners = new Set<(m: string) => void>();
    const mount: { id: string; el: HTMLElement; month: string; cleanup?: () => void; listeners: Set<(m: string) => void> } = { id: tab.id, el, month: this.anchor, listeners };
    this.extMount = mount;
    const ctx = {
      get month() { return mount.month; },
      currency: this.conv.target,
      formatMoney: (n: number) => money(n, this.cur),
      onMonthChange: (cb: (m: string) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    };
    try {
      const res = tab.render(el, ctx);
      if (typeof res === "function") mount.cleanup = res;
    } catch (e) {
      el.createDiv({ cls: "mf-empty-inline", text: `Доповнення «${tab.title}» не змогло відкритися: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  unmountExt(): void {
    const m = this.extMount;
    if (!m) return;
    this.extMount = null;
    m.listeners.clear();
    try { m.cleanup?.(); } catch (e) { console.error(e); }
    m.el.remove();
  }

  async onClose(): Promise<void> { this.unmountExt(); }

  // ---------- loans ----------
  private renderLoans(): void {
    const el = this.scrollEl;
    const loans = this.data?.loans ?? [];
    if (!loans.length) { el.createDiv({ cls: "mf-empty-inline", text: "Боргів немає." }); return; }
    const today = new Date().toISOString().slice(0, 10);
    const conv = (l: { amount: number; currency: string }) => this.conv.convert(l.amount, l.currency, today, this.data!.fx);
    const active = loans.filter(loanActive), closed = loans.filter((l) => !loanActive(l));
    const owe = r2(active.filter((l) => loanSign(l) < 0).reduce((s, l) => s + conv(l), 0));
    const owed = r2(active.filter((l) => loanSign(l) > 0).reduce((s, l) => s + conv(l), 0));

    const hero = el.createDiv("mf-card mf-hero");
    const sub = hero.createDiv("mf-hero-sub");
    const cell = (label: string, value: string, cls = "") => { const c = sub.createDiv("mf-hero-cell"); c.createDiv({ cls: "mf-muted mf-small", text: label }); c.createDiv({ cls: "mf-num " + cls, text: value }); };
    cell("Я винен", money(owe, this.cur), "is-spend");
    cell("Мені винні", money(owed, this.cur), "is-income");
    cell("Активних", String(active.length));
    if (this.conv.target !== "PLN" || active.some((l) => l.currency !== "PLN")) hero.createDiv({ cls: "mf-muted mf-small", text: `У ${this.conv.target} за останнім курсом НБП.` });

    const draw = (title: string, list: typeof loans) => {
      if (!list.length) return;
      const card = this.card(title);
      for (const l of list) {
        const box = card.createEl("details", { cls: "mf-loan" });
        const sm = box.createEl("summary", { cls: "mf-cat" });
        this.avatar(sm, "family", l.person);
        const mid = sm.createDiv("mf-cat-mid");
        const top = mid.createDiv("mf-cat-top");
        top.createDiv({ cls: "mf-cat-name", text: l.person });
        top.createDiv({ cls: "mf-num " + (loanSign(l) < 0 ? "is-spend" : "is-income"), text: money(l.amount, l.currency === "PLN" ? "zł" : l.currency) });
        mid.createDiv({ cls: "mf-muted mf-small", text: `${loanSign(l) < 0 ? "я винен" : "мені винні"} · з ${l.dateGiven}${l.dateReturned ? ` · повернено ${l.dateReturned}` : ""}${l.currency !== this.conv.target ? ` · ≈ ${money(r2(conv(l)), this.cur)}` : ""}` });
        if (l.notes) box.createDiv({ cls: "mf-muted mf-small mf-loan-notes", text: l.notes });
      }
    };
    draw("Активні", active);
    draw("Закриті", closed);
  }

  // ---------- notes ----------
  private renderNotes(): void {
    const el = this.scrollEl;
    const add = el.createEl("button", { cls: "mod-cta mf-wide", text: "+ Нотатка" });
    add.onclick = () => this.editNote({ id: "", text: "", created: "", done: false });
    const notes = [...this.local.notes].sort((a, b) => Number(a.done) - Number(b.done) || (a.created < b.created ? 1 : -1));
    if (!notes.length) el.createDiv({ cls: "mf-empty-inline", text: "Нотаток немає." });
    const open = notes.filter((n) => !n.done), done = notes.filter((n) => n.done);
    const draw = (title: string, list: Note[]) => {
      if (!list.length) return;
      const card = this.card(`${title} · ${list.length}`);
      for (const n of list) {
        const row = card.createDiv("mf-note" + (n.done ? " is-done" : ""));
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = n.done;
        cb.onclick = (e) => e.stopPropagation();
        cb.onchange = async () => { n.done = cb.checked; await this.saveLocal(); };
        const mid = row.createDiv("mf-note-mid");
        mid.createDiv({ cls: "mf-note-text", text: n.text });
        if (n.created) mid.createDiv({ cls: "mf-muted mf-small", text: n.created });
        mid.onclick = () => this.editNote(n);
      }
    };
    draw("Відкриті", open);
    draw("Виконані", done);
    el.createDiv({ cls: "mf-muted mf-small mf-foot-note", text: "Нотатки зберігаються у файлі сховища. Відкриті нотатки /finance-check читає як інструкції." });
  }

  private editNote(n: Note): void {
    new NoteModal(this.app, n, async (res) => {
      if (res === "delete") this.local.notes = this.local.notes.filter((x) => x.id !== n.id);
      else if (n.id) this.local.notes = this.local.notes.map((x) => (x.id === n.id ? { ...x, text: res.text, done: res.done } : x));
      else this.local.notes.push({ id: newId("n"), text: res.text, done: res.done, created: new Date().toISOString().slice(0, 16).replace("T", " ") });
      await this.saveLocal();
    }).open();
  }

  // ---------- review ----------
  private renderReview(txs: Transaction[]): void {
    const cur = this.cur;
    const el = this.scrollEl;
    const issues = reconcile(txs, this.plugin.settings.bigAmount, cur);
    const s = summarize(txs);
    const debits = txs.filter((t) => t.direction === "debit" && !t.excluded);
    const stats = el.createDiv("mf-stats");
    const stat = (n: string, label: string) => { const d = stats.createDiv("mf-stat"); d.createDiv({ cls: "mf-stat-n", text: n }); d.createDiv({ cls: "mf-muted mf-small", text: label }); };
    stat(`${debits.length ? Math.round((debits.filter((t) => t.hasReceipt).length / debits.length) * 100) : 0}%`, "покупок з чеком");
    stat(String(debits.filter((t) => t.payment === "cash").length), "готівкою");
    stat(String(issues.reduce((a, i) => a + Math.max(1, i.txs.length), 0)), "до перевірки");

    const queue = (this.data?.review ?? []).filter((r) => { const [a, b] = this.range(); return r.date >= a && r.date <= b; });
    if (queue.length) {
      const card = this.card(`Чеки на перевірку · ${queue.length}`);
      card.createDiv({ cls: "mf-muted mf-small mf-card-hint", text: "Розпізнані чеки, які ще не зіставлені з операцією. Підтвердити можна на сайті або через /finance-check." });
      for (const r of queue) {
        const row = card.createDiv("mf-item");
        const l = row.createDiv("mf-item-mid");
        l.createDiv({ cls: "mf-item-name", text: r.merchant || "Чек" });
        l.createDiv({ cls: "mf-muted mf-small", text: `${r.date}${r.payment ? " · " + (r.payment === "cash" ? "готівка" : r.payment === "card" ? "картка" : r.payment) : ""}${r.items ? ` · ${r.items} поз.` : ""}` });
        row.createDiv({ cls: "mf-num", text: money(r.total, r.currency === "PLN" ? "zł" : r.currency) });
        if (r.url) this.receiptButton(row, r.url, true);
      }
    }
    void s;

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
    const icon = CATEGORY_ICONS[code] || (code.startsWith("income") ? "trending-up" : "");
    if (icon) setIcon(a, icon);
    if (!a.firstChild) a.setText((name || "?").charAt(0).toUpperCase());
    a.style.setProperty("--mf-c", categoryColor(code));
  }

  /** Opens the receipt photo in Google Drive (external browser on phones). Nothing is saved in the vault. */
  private receiptButton(parent: HTMLElement, url: string, compact = false): void {
    const b = parent.createEl("button", { cls: compact ? "mf-icon-btn" : "mf-chip mf-receipt-btn", attr: { "aria-label": "Відкрити чек у Google Drive" } });
    setIcon(b.createSpan(), "receipt");
    if (!compact) b.createSpan({ text: "Відкрити чек" });
    b.onclick = (e) => { e.stopPropagation(); window.open(url, "_blank"); };
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
        const dayTotal = txs.filter((x) => x.date === t.date && x.direction === "debit" && !x.excluded).reduce((a, x) => a + x.amount, 0);
        if (dayTotal) h.createSpan({ cls: "mf-muted mf-day-sum", text: `−${money(r2(dayTotal), cur)}` });
      }
      const row = list.createDiv("mf-tx" + (t.excluded ? " is-excluded" : ""));
      this.avatar(row, t.category || "other", categoryName(t));
      const mid = row.createDiv("mf-tx-mid");
      mid.createDiv({ cls: "mf-tx-name", text: t.merchant || t.description || "—" });
      const sub = mid.createDiv({ cls: "mf-muted mf-small mf-tx-sub" });
      sub.createSpan({ text: grouped ? categoryName(t) : `${t.date.slice(8)}.${t.date.slice(5, 7)} · ${categoryName(t)}` });
      if (t.payment === "cash") sub.createSpan({ cls: "mf-tag", text: "готівка" });
      if (t.origin === "manual") sub.createSpan({ cls: "mf-tag", text: "вручну" });
      if (t.orig) sub.createSpan({ cls: "mf-tag", text: t.orig.currency });
      if (t.excluded) sub.createSpan({ cls: "mf-tag", text: EXCLUDED_LABEL[t.excluded] || t.excluded });
      if (t.hasReceipt) setIcon(sub.createSpan({ cls: "mf-receipt", attr: { "aria-label": "Є чек" } }), "receipt");
      row.createDiv({ cls: "mf-tx-amt " + (t.direction === "credit" ? "is-income" : ""), text: `${t.direction === "credit" ? "+" : "−"}${money(t.amount, cur)}` });
      row.onclick = (e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        if (row.hasClass("is-open")) { row.removeClass("is-open"); row.querySelector(".mf-tx-details")?.remove(); return; }
        row.addClass("is-open");
        const det = row.createDiv("mf-tx-details");
        det.createDiv({ text: t.date + (t.account && t.account !== "cash" ? ` · ${accountLabel(t.account)}` : "") });
        if (t.orig) det.createDiv({ text: `${money(t.orig.amount, t.orig.currency)}${t.orig.fx ? ` · курс ${t.orig.fx}` : ""}` });
        if (t.excluded) det.createDiv({ cls: "mf-muted", text: "Не враховується у витратах і доходах." });
        if (t.description) det.createDiv({ text: t.description });
        if (t.notes) det.createDiv({ cls: "mf-muted", text: t.notes });
        if (t.items?.length) {
          const its = det.createDiv("mf-items");
          for (const i of t.items) {
            const r = its.createDiv("mf-item");
            r.createDiv({ cls: "mf-item-name", text: i.n + (i.q ? ` × ${i.q}${i.u ? " " + i.u : ""}` : "") });
            r.createDiv({ cls: "mf-num", text: money(i.t, cur) });
          }
        }
        if (t.receiptUrl) this.receiptButton(det, t.receiptUrl);
        if (this.v3 && t.excluded !== "internal") {
          const eb = det.createEl("button", { cls: "mf-btn-small" });
          setIcon(eb.createSpan(), "pencil");
          eb.createSpan({ text: t.origin === "manual" ? "Редагувати" : "Категорія / нотатка" });
          eb.onclick = (e) => { e.stopPropagation(); this.editTx(t); };
        }
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

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
function accountLabel(a: string): string {
  if (/^mono_/.test(a)) return `Monobank ${a.slice(5)}`;
  if (/^PL\d{26}$/.test(a)) return `рахунок …${a.slice(-4)}`;
  return a;
}
function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
