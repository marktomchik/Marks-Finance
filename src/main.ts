import { App, normalizePath, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, debounce } from "obsidian";
import { CURRENCIES, CURRENCY_LABEL, FinanceFile, Note, PlanItem, parseFinance } from "./data";
import { FinanceView, VIEW_TYPE } from "./view";
import { ExtensionHost, MarkFinanceApi, READY_EVENT } from "./extensions";

interface Settings {
  dataPath: string;
  localPath: string;
  /** Folder for plan lines written by extensions (one JSON file per source). */
  externalPlanDir: string;
  currency: string;
  /** Optional fixed rates (PLN per 1 unit); 0 = use NBP rates from the data file. */
  fixedRates: Record<string, number>;
  bigAmount: number;
}
const DEFAULT_SETTINGS: Settings = {
  dataPath: "Фінанси/finance-data.json",
  localPath: "Фінанси/finance-local.json",
  externalPlanDir: "Фінанси/plan-external",
  currency: "PLN",
  fixedRates: {},
  bigAmount: 200,
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
      if (f.path === normalizePath(this.settings.dataPath) || f.path === normalizePath(this.settings.localPath)) onChange();
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

  async loadFinance(): Promise<FinanceFile> {
    const path = normalizePath(this.settings.dataPath);
    if (!(await this.app.vault.adapter.exists(path))) throw new Error("Файл ще не з'явився у сховищі (чекає синхронізації?)");
    return parseFinance(await this.app.vault.adapter.read(path));
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
    new Setting(containerEl).setName("Файл даних").setDesc("JSON з операціями, який створює /finance-check (з Google Sheet).")
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
