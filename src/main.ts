import { App, normalizePath, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, debounce, requestUrl } from "obsidian";
import { CURRENCIES, CURRENCY_LABEL, FinanceFile, Note, PlanItem, Transaction, TxOverride, assembleLedger, mergeFx, parseFinance, parseMonthFile, serializeMonthFile } from "./data";
import { FinanceView, VIEW_TYPE } from "./view";
import { ExtensionHost, MarkFinanceApi, READY_EVENT } from "./extensions";

interface Settings {
  /** Folder with ledger/, manual/, meta.json and overrides.json (format v3). */
  dataDir: string;
  /** Old single-file format (v2), read only when <dataDir>/ledger does not exist. */
  dataPath: string;
  localPath: string;
  /** Folder for plan lines written by extensions (one JSON file per source). */
  externalPlanDir: string;
  currency: string;
  /** Optional fixed rates (PLN per 1 unit); 0 = use NBP rates from the data file. */
  fixedRates: Record<string, number>;
  bigAmount: number;
  /** NBP rates fetched by the plugin (PLN per unit), kept outside the vault files. */
  fxCache: Record<string, [string, number][]>;
}
const DEFAULT_SETTINGS: Settings = {
  dataDir: "Фінанси",
  dataPath: "Фінанси/finance-data.json",
  localPath: "Фінанси/finance-local.json",
  externalPlanDir: "Фінанси/plan-external",
  currency: "PLN",
  fixedRates: {},
  bigAmount: 200,
  fxCache: {},
};

/** Things edited in Obsidian (plan, notes). Lives in a normal vault file, so it syncs to the phone. */
export interface LocalStore { plan: PlanItem[]; notes: Note[]; updatedAt?: string }

export default class MarkFinancePlugin extends Plugin {
  settings!: Settings;
  ext!: ExtensionHost;
  /** Extensions API (see EXTENSIONS.md): app.plugins.plugins["mark-finance"].api */
  api!: MarkFinanceApi;

  async onload(): Promise<void> {
    const saved = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.fixedRates = { ...(saved.fixedRates ?? {}) };
    this.settings.fxCache = { ...(saved.fxCache ?? {}) };
    this.ext = new ExtensionHost(this.app, () => this.settings.externalPlanDir, () => this.rerenderViews());
    this.api = this.ext.api;
    this.registerView(VIEW_TYPE, (leaf) => new FinanceView(leaf, this));
    this.addRibbonIcon("wallet", "Фінанси Марка", () => this.activateView());
    this.addCommand({ id: "open", name: "Відкрити фінанси", callback: () => this.activateView() });
    this.addCommand({ id: "reload", name: "Перечитати файл фінансів", callback: () => this.refreshViews() });
    this.addSettingTab(new FinanceSettingTab(this.app, this));

    // Re-render when sync replaces the data file or the plan/notes file.
    const onChange = debounce(() => this.refreshViews(), 1500, true);
    const onExtChange = debounce(async () => { await this.ext.loadAll(); this.rerenderViews(); }, 1500, true);
    const watch = (f: TAbstractFile) => {
      if (f.path === normalizePath(this.settings.dataPath) || f.path === normalizePath(this.settings.localPath) || this.isLedgerFile(f.path)) onChange();
      else if (this.ext.isOwnFile(f.path)) onExtChange();
    };
    this.registerEvent(this.app.vault.on("modify", watch));
    this.registerEvent(this.app.vault.on("create", watch));
    this.registerEvent(this.app.vault.on("delete", watch));

    // Extensions: load saved plan lines first, then announce the API.
    this.app.workspace.onLayoutReady(async () => {
      await this.ext.loadAll();
      this.rerenderViews();
      this.app.workspace.trigger(READY_EVENT, this.api);
    });
  }

  onunload(): void {
    this.ext?.tabs.clear();
  }

  // ---------- data files ----------
  private dir(sub = ""): string { return normalizePath(sub ? `${this.settings.dataDir}/${sub}` : this.settings.dataDir); }
  isLedgerFile(path: string): boolean {
    return path.startsWith(this.dir("ledger") + "/") || path.startsWith(this.dir("manual") + "/")
      || path === this.dir("meta.json") || path === this.dir("overrides.json");
  }
  /** "v3" when <dataDir>/ledger exists, otherwise the old single file. */
  async format(): Promise<"v3" | "v2"> { return (await this.app.vault.adapter.exists(this.dir("ledger"))) ? "v3" : "v2"; }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      if (await this.app.vault.adapter.exists(path)) return JSON.parse(await this.app.vault.adapter.read(path)) as T;
    } catch (e) { console.warn("mark-finance: cannot read", path, e); }
    return fallback;
  }
  private async readMonthDir(sub: string): Promise<Transaction[]> {
    const dir = this.dir(sub);
    if (!(await this.app.vault.adapter.exists(dir))) return [];
    const { files } = await this.app.vault.adapter.list(dir);
    const out: Transaction[] = [];
    for (const f of files.filter((x) => /\/\d{4}-\d{2}\.json$/.test(x)).sort()) {
      try { out.push(...parseMonthFile(await this.app.vault.adapter.read(f))); }
      catch (e) { console.warn("mark-finance: bad month file", f, e); }
    }
    return out;
  }

  async loadFinance(): Promise<FinanceFile> {
    if ((await this.format()) === "v2") {
      const path = normalizePath(this.settings.dataPath);
      if (!(await this.app.vault.adapter.exists(path))) throw new Error("Файл ще не з'явився у сховищі (чекає синхронізації?)");
      const data = parseFinance(await this.app.vault.adapter.read(path));
      data.fx = mergeFx(data.fx, this.settings.fxCache);
      return data;
    }
    const meta = await this.readJson<Partial<FinanceFile>>(this.dir("meta.json"), {});
    const ledger = await this.readMonthDir("ledger");
    const manual = await this.readMonthDir("manual");
    const overrides = await this.readJson<Record<string, TxOverride>>(this.dir("overrides.json"), {});
    const data = assembleLedger(meta, ledger, manual, overrides);
    data.fx = mergeFx(meta.fx, this.settings.fxCache);
    void this.refreshFx(data);
    return data;
  }

  // ---------- writes (only files this plugin owns: manual/*, overrides.json, finance-local.json) ----------
  private async writeFile(path: string, text: string): Promise<void> {
    this.writing = true;
    try {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await this.app.vault.modify(f, text);
      else {
        const dir = path.split("/").slice(0, -1).join("/");
        if (dir && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir).catch(() => undefined);
        await this.app.vault.create(path, text);
      }
    } finally {
      window.setTimeout(() => { this.writing = false; }, 2000);
    }
  }
  private async readManualMonth(month: string): Promise<Transaction[]> {
    const p = this.dir(`manual/${month}.json`);
    try { return (await this.app.vault.adapter.exists(p)) ? parseMonthFile(await this.app.vault.adapter.read(p)) : []; }
    catch { throw new Error(`Не вдалося прочитати ${p}`); }
  }
  /** Adds or replaces a manual row; moves it between month files when its date changes. */
  async saveManual(tx: Transaction, oldDate?: string): Promise<void> {
    const clean: Transaction = { ...tx };
    delete clean.origin; delete clean.category_name;
    const month = clean.date.slice(0, 7);
    if (oldDate && oldDate.slice(0, 7) !== month) await this.deleteManual(tx.tx_id, oldDate);
    const rows = (await this.readManualMonth(month)).filter((t) => t.tx_id !== clean.tx_id);
    rows.push(clean);
    await this.writeFile(this.dir(`manual/${month}.json`), serializeMonthFile(month, rows));
    this.refreshNow();
  }
  async deleteManual(id: string, date: string): Promise<void> {
    const month = date.slice(0, 7);
    const rows = await this.readManualMonth(month);
    const left = rows.filter((t) => t.tx_id !== id);
    if (left.length !== rows.length) await this.writeFile(this.dir(`manual/${month}.json`), serializeMonthFile(month, left));
    this.refreshNow();
  }
  async setOverride(id: string, patch: TxOverride | null): Promise<void> {
    const path = this.dir("overrides.json");
    const all = await this.readJson<Record<string, TxOverride>>(path, {});
    if (patch === null) delete all[id]; else all[id] = { ...(all[id] ?? {}), ...patch };
    const lines = Object.keys(all).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(all[k])}`);
    await this.writeFile(path, `{\n${lines.join(",\n")}\n}\n`);
    this.refreshNow();
  }
  private refreshNow(): void { this.views().forEach((v) => void v.reload()); }

  // ---------- NBP rates ----------
  private fxBusy = false;
  /** Fetches missing NBP mid rates (EUR, USD, UAH) up to today; works on desktop and mobile. */
  async refreshFx(data: FinanceFile): Promise<void> {
    if (this.fxBusy) return;
    const today = new Date().toISOString().slice(0, 10);
    const last = (cur: string) => (data.fx?.[cur] ?? []).reduce((m, p) => (p[0] > m ? p[0] : m), "");
    const curs = ["EUR", "USD", "UAH"].filter((c) => last(c) < today && Date.parse(today) - Date.parse(last(c) || "2000-01-01") > 86_400_000);
    if (!curs.length) return;
    this.fxBusy = true;
    let changed = false;
    try {
      for (const cur of curs) {
        let from = last(cur) || (data.transactions.length ? data.transactions[data.transactions.length - 1].date : today);
        while (from < today) {
          const to = new Date(Math.min(Date.parse(from) + 360 * 86_400_000, Date.parse(today))).toISOString().slice(0, 10);
          const res = await requestUrl({ url: `https://api.nbp.pl/api/exchangerates/rates/a/${cur.toLowerCase()}/${from}/${to}/?format=json`, throw: false });
          if (res.status === 200) {
            const pts = (res.json?.rates ?? []).map((r: { effectiveDate: string; mid: number }) => [r.effectiveDate, r.mid] as [string, number]);
            this.settings.fxCache[cur] = mergeFx({ [cur]: this.settings.fxCache[cur] ?? [] }, { [cur]: pts })[cur];
            changed = true;
          }
          from = new Date(Date.parse(to) + 86_400_000).toISOString().slice(0, 10);
        }
      }
    } catch (e) {
      console.warn("mark-finance: NBP rates not updated", e);
    } finally {
      this.fxBusy = false;
    }
    if (changed) { await this.saveSettings(); data.fx = mergeFx(data.fx, this.settings.fxCache); this.rerenderViews(); }
  }

  /** Plan and notes: from the local file; the first time, seeded from the data file (Google Sheet export). */
  async loadLocal(data: FinanceFile): Promise<LocalStore> {
    const path = normalizePath(this.settings.localPath);
    try {
      if (await this.app.vault.adapter.exists(path)) {
        const raw = JSON.parse(await this.app.vault.adapter.read(path)) as Partial<LocalStore>;
        return { plan: Array.isArray(raw.plan) ? raw.plan : [], notes: Array.isArray(raw.notes) ? raw.notes : [], updatedAt: raw.updatedAt };
      }
    } catch (e) {
      console.warn("mark-finance: cannot read local store", e);
    }
    return { plan: [...(data.plan ?? [])], notes: [...(data.notes ?? [])] };
  }

  private writing = false;
  async saveLocal(store: LocalStore): Promise<void> {
    const path = normalizePath(this.settings.localPath);
    const text = JSON.stringify({ ...store, updatedAt: new Date().toISOString() }, null, 1);
    this.writing = true;
    try {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await this.app.vault.modify(f, text);
      else {
        const dir = path.split("/").slice(0, -1).join("/");
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => undefined);
        await this.app.vault.create(path, text);
      }
    } finally {
      window.setTimeout(() => { this.writing = false; }, 2000);
    }
  }

  views(): FinanceView[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).filter((v): v is FinanceView => v instanceof FinanceView);
  }
  refreshViews(): void { if (!this.writing) this.views().forEach((v) => void v.reload()); }
  rerenderViews(): void { this.views().forEach((v) => { v.applyCurrency(); v.render(); }); }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}

class FinanceSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MarkFinancePlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("Валюта").setHeading();
    new Setting(containerEl).setName("Показувати суми в").setDesc("Операції в злотих перераховуються за курсом НБП на дату операції (курси є у файлі даних).")
      .addDropdown((d) => {
        for (const c of CURRENCIES) d.addOption(c, `${c} (${CURRENCY_LABEL[c]})`);
        d.setValue(s.currency).onChange(async (v) => { s.currency = v; await this.plugin.saveSettings(); this.plugin.rerenderViews(); this.display(); });
      });
    if (s.currency !== "PLN") {
      new Setting(containerEl).setName(`Фіксований курс ${s.currency}`).setDesc(`Скільки злотих за 1 ${s.currency}. Порожньо — курс НБП на дату кожної операції.`)
        .addText((t) => {
          t.inputEl.inputMode = "decimal";
          t.setPlaceholder("НБП").setValue(s.fixedRates[s.currency] ? String(s.fixedRates[s.currency]) : "").onChange(async (v) => {
            const n = Number(v.replace(",", "."));
            if (v.trim() === "" || !(n > 0)) delete s.fixedRates[s.currency]; else s.fixedRates[s.currency] = n;
            await this.plugin.saveSettings(); this.plugin.rerenderViews();
          });
        });
    }

    new Setting(containerEl).setName("Файли").setHeading();
    new Setting(containerEl).setName("Папка фінансів").setDesc("Тут лежать ledger/ (виписки й чеки від /finance-check), manual/ (готівка, внесена тут), meta.json і overrides.json.")
      .addText((t) => t.setValue(s.dataDir).onChange(async (v) => {
        s.dataDir = v.trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.dataDir; await this.plugin.saveSettings(); this.plugin.refreshViews();
      }));
    new Setting(containerEl).setName("Старий файл даних").setDesc("Один JSON (формат v2). Читається, лише коли в папці фінансів немає ledger/.")
      .addText((t) => t.setValue(s.dataPath).onChange(async (v) => {
        s.dataPath = v.trim() || DEFAULT_SETTINGS.dataPath; await this.plugin.saveSettings(); this.plugin.refreshViews();
      }));
    new Setting(containerEl).setName("План і нотатки").setDesc("Файл у сховищі, куди плагін зберігає план і нотатки. Синхронізується разом зі сховищем.")
      .addText((t) => t.setValue(s.localPath).onChange(async (v) => {
        s.localPath = v.trim() || DEFAULT_SETTINGS.localPath; await this.plugin.saveSettings(); this.plugin.refreshViews();
      }));

    new Setting(containerEl).setName("Перевірка").setHeading();
    new Setting(containerEl).setName("Поріг «без чека»").setDesc("Вкладка «Перевірка» показує витрати без чека, більші за цю суму (у вибраній валюті).")
      .addText((t) => t.setValue(String(s.bigAmount)).onChange(async (v) => {
        const n = Number(v); if (isFinite(n) && n >= 0) { s.bigAmount = n; await this.plugin.saveSettings(); this.plugin.refreshViews(); }
      }));
  }
}
