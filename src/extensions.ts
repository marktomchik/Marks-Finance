// Extensions API: other plugins add a tab to the finance view and write plan lines into «План».
// Spec: EXTENSIONS.md. Reached as app.plugins.plugins["mark-finance"].api; announced with
// app.workspace.trigger("mark-finance:ready", api).
import { normalizePath, TFile, type App } from "obsidian";

export const API_VERSION = 1;
export const READY_EVENT = "mark-finance:ready";

export interface TabContext {
  /** Month shown in the finance view, YYYY-MM. */
  month: string;
  /** Display currency code from the finance settings (PLN, EUR, USD, UAH). */
  currency: string;
  /** Formats an amount that is already in `currency`, e.g. "1 234,50 zł". */
  formatMoney(n: number): string;
  /** Called when the user switches months while the tab is open. Returns an unsubscribe function. */
  onMonthChange(cb: (month: string) => void): () => void;
}
export interface ExtensionTab {
  id: string;
  title: string;
  icon: string;
  order?: number;
  render(containerEl: HTMLElement, ctx: TabContext): void | (() => void);
}
export interface ExternalPlanEntry {
  id: string;
  month: string; // YYYY-MM
  kind: "income" | "expense";
  title: string;
  amount: number;
  currency: string; // "PLN" expected; other codes are converted with the NBP rates from the data file
  status: "planned" | "confirmed";
  meta?: Record<string, unknown>;
}
/** One file per source: <folder>/<sourceId>.json */
interface SourceFile { sourceId: string; updatedAt: string; entries: ExternalPlanEntry[] }

export interface MarkFinanceApi {
  version: number;
  registerTab(tab: ExtensionTab): void;
  unregisterTab(id: string): void;
  setPlanEntries(sourceId: string, entries: ExternalPlanEntry[]): Promise<void>;
  getPlanEntries(sourceId: string): ExternalPlanEntry[];
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class ExtensionHost {
  readonly tabs = new Map<string, ExtensionTab>();
  /** sourceId → entries. Read from the vault folder, so entries stay visible when the extension is disabled. */
  readonly plan = new Map<string, ExternalPlanEntry[]>();
  readonly api: MarkFinanceApi;

  constructor(private app: App, private folder: () => string, private onChange: () => void) {
    this.api = {
      version: API_VERSION,
      registerTab: (tab) => this.registerTab(tab),
      unregisterTab: (id) => this.unregisterTab(id),
      setPlanEntries: (sourceId, entries) => this.setPlanEntries(sourceId, entries),
      getPlanEntries: (sourceId) => (this.plan.get(sourceId) ?? []).map((e) => ({ ...e })),
    };
  }

  private registerTab(tab: ExtensionTab): void {
    if (!tab || !ID_RE.test(String(tab.id)) || typeof tab.render !== "function") throw new Error("mark-finance: registerTab needs { id, title, icon, render }");
    this.tabs.set(tab.id, { ...tab, title: String(tab.title || tab.id), icon: String(tab.icon || "puzzle") });
    this.onChange();
  }
  private unregisterTab(id: string): void {
    if (this.tabs.delete(id)) this.onChange();
  }

  sortedTabs(): ExtensionTab[] {
    return [...this.tabs.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
  }

  private path(sourceId: string): string { return normalizePath(`${this.folder()}/${sourceId}.json`); }

  private async setPlanEntries(sourceId: string, entries: ExternalPlanEntry[]): Promise<void> {
    if (!ID_RE.test(String(sourceId))) throw new Error("mark-finance: invalid sourceId");
    const clean = (Array.isArray(entries) ? entries : []).map(sanitize).filter((e): e is ExternalPlanEntry => !!e);
    const file: SourceFile = { sourceId, updatedAt: new Date().toISOString(), entries: clean };
    const text = JSON.stringify(file, null, 1);
    const p = this.path(sourceId);
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof TFile) {
      if ((await this.app.vault.read(existing)) !== text) await this.app.vault.modify(existing, text);
    } else {
      const dir = p.split("/").slice(0, -1).join("/");
      for (let i = 1, parts = dir.split("/"); i <= parts.length; i++) {
        const d = parts.slice(0, i).join("/");
        if (!this.app.vault.getAbstractFileByPath(d)) await this.app.vault.createFolder(d).catch(() => undefined);
      }
      await this.app.vault.create(p, text);
    }
    this.plan.set(sourceId, clean);
    this.onChange();
  }

  /** Reads every <folder>/*.json (also files synced from other devices). */
  async loadAll(): Promise<void> {
    const dir = normalizePath(this.folder());
    const a = this.app.vault.adapter;
    this.plan.clear();
    if (!(await a.exists(dir))) return;
    const { files } = await a.list(dir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await a.read(f)) as Partial<SourceFile>;
        const id = String(raw.sourceId || f.split("/").pop()!.replace(/\.json$/, ""));
        this.plan.set(id, (Array.isArray(raw.entries) ? raw.entries : []).map(sanitize).filter((e): e is ExternalPlanEntry => !!e));
      } catch (e) {
        console.warn("mark-finance: cannot read", f, e);
      }
    }
  }

  isOwnFile(path: string): boolean {
    return path.startsWith(normalizePath(this.folder()) + "/") && path.endsWith(".json");
  }

  /** Entries of all sources for one month. */
  entriesFor(month: string): (ExternalPlanEntry & { sourceId: string })[] {
    const out: (ExternalPlanEntry & { sourceId: string })[] = [];
    for (const [sourceId, list] of this.plan) for (const e of list) if (e.month === month) out.push({ ...e, sourceId });
    return out;
  }
}

function sanitize(e: unknown): ExternalPlanEntry | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  const month = String(o.month ?? "");
  const amount = Number(o.amount);
  if (!/^\d{4}-\d{2}$/.test(month) || !isFinite(amount)) return null;
  return {
    id: String(o.id ?? `${month}-${String(o.title ?? "")}`),
    month,
    kind: o.kind === "expense" ? "expense" : "income",
    title: String(o.title ?? ""),
    amount: Math.abs(amount),
    currency: String(o.currency || "PLN").toUpperCase(),
    status: o.status === "confirmed" ? "confirmed" : "planned",
    ...(o.meta && typeof o.meta === "object" ? { meta: o.meta as Record<string, unknown> } : {}),
  };
}
