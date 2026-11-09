import { App, normalizePath, Plugin, PluginSettingTab, Setting, TAbstractFile, debounce } from "obsidian";
import { FinanceFile, parseFinance } from "./data";
import { FinanceView, VIEW_TYPE } from "./view";

interface Settings {
  dataPath: string;
  currencyLabel: string;
  bigAmount: number;
}
const DEFAULT_SETTINGS: Settings = {
  dataPath: "Фінанси/finance-data.json",
  currencyLabel: "zł",
  bigAmount: 200,
};

export default class MarkFinancePlugin extends Plugin {
  settings!: Settings;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new FinanceView(leaf, this));
    this.addRibbonIcon("wallet", "Фінанси Марка", () => this.activateView());
    this.addCommand({ id: "open", name: "Відкрити фінанси", callback: () => this.activateView() });
    this.addCommand({ id: "reload", name: "Перечитати файл фінансів", callback: () => this.refreshViews() });
    this.addSettingTab(new FinanceSettingTab(this.app, this));

    // Re-render when sync replaces the data file.
    const onChange = debounce(() => this.refreshViews(), 1500, true);
    const watch = (f: TAbstractFile) => { if (f.path === normalizePath(this.settings.dataPath)) onChange(); };
    this.registerEvent(this.app.vault.on("modify", watch));
    this.registerEvent(this.app.vault.on("create", watch));
  }

  async loadFinance(): Promise<FinanceFile> {
    const path = normalizePath(this.settings.dataPath);
    if (!(await this.app.vault.adapter.exists(path))) throw new Error("Файл ще не з'явився у сховищі (чекає синхронізації?)");
    return parseFinance(await this.app.vault.adapter.read(path));
  }

  views(): FinanceView[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).filter((v): v is FinanceView => v instanceof FinanceView);
  }
  refreshViews(): void { this.views().forEach((v) => void v.reload()); }

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
    containerEl.empty();
    new Setting(containerEl).setName("Файл даних").setDesc("Шлях у сховищі до JSON із фінансами.")
      .addText((t) => t.setValue(this.plugin.settings.dataPath).onChange(async (v) => {
        this.plugin.settings.dataPath = v.trim() || DEFAULT_SETTINGS.dataPath;
        await this.plugin.saveSettings(); this.plugin.refreshViews();
      }));
    new Setting(containerEl).setName("Позначка валюти")
      .addText((t) => t.setValue(this.plugin.settings.currencyLabel).onChange(async (v) => {
        this.plugin.settings.currencyLabel = v.trim() || "zł"; await this.plugin.saveSettings(); this.plugin.refreshViews();
      }));
    new Setting(containerEl).setName("Поріг «без чека»").setDesc("Звірка показує витрати без чека, більші за цю суму.")
      .addText((t) => t.setValue(String(this.plugin.settings.bigAmount)).onChange(async (v) => {
        const n = Number(v); if (isFinite(n) && n >= 0) { this.plugin.settings.bigAmount = n; await this.plugin.saveSettings(); this.plugin.refreshViews(); }
      }));
  }
}
