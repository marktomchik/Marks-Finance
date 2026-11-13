import { App, Modal, Setting } from "obsidian";
import { codeName, Direction, Note, PlanItem, Transaction, TxOverride } from "./data";

/** Add / edit / delete one plan line. Amounts are in PLN, like on the web dashboard. */
export class PlanModal extends Modal {
  constructor(app: App, private item: PlanItem, private categories: string[], private done: (r: PlanItem | "delete") => void | Promise<void>) {
    super(app);
  }
  onOpen(): void {
    const v: PlanItem = { ...this.item };
    const { contentEl } = this;
    this.setTitle(this.item.id ? "Рядок плану" : "Новий рядок плану");
    new Setting(contentEl).setName("Тип").addDropdown((d) => d.addOption("expense", "Витрата").addOption("income", "Дохід").setValue(v.kind).onChange((x) => { v.kind = x as PlanItem["kind"]; }));
    new Setting(contentEl).setName("Категорія").addDropdown((d) => {
      for (const c of this.categories) d.addOption(c, codeName(c));
      if (!this.categories.includes(v.category)) d.addOption(v.category, codeName(v.category));
      d.setValue(v.category).onChange((x) => { v.category = x; });
    });
    new Setting(contentEl).setName("Назва").setDesc("Необов'язково: інакше покажеться назва категорії.").addText((t) => t.setValue(v.name).onChange((x) => { v.name = x; }));
    new Setting(contentEl).setName("Сума, zł").addText((t) => {
      t.inputEl.type = "number"; t.inputEl.inputMode = "decimal"; t.inputEl.step = "0.01";
      t.setValue(v.amount ? String(v.amount) : "").onChange((x) => { v.amount = Math.abs(Number(x.replace(",", "."))) || 0; });
      window.setTimeout(() => t.inputEl.focus(), 50);
    });
    new Setting(contentEl).setName("Місяць").addText((t) => { t.inputEl.type = "month"; t.setValue(v.month).onChange((x) => { if (/^\d{4}-\d{2}$/.test(x)) v.month = x; }); });
    const row = new Setting(contentEl);
    if (this.item.id) row.addButton((b) => b.setButtonText("Видалити").setWarning().onClick(async () => { this.close(); await this.done("delete"); }));
    row.addButton((b) => b.setButtonText("Зберегти").setCta().onClick(async () => {
      if (!v.amount) { b.setButtonText("Вкажіть суму"); return; }
      if (!v.name) v.name = codeName(v.category);
      this.close(); await this.done(v);
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}

export class NoteModal extends Modal {
  constructor(app: App, private note: Note, private done: (r: { text: string; done: boolean } | "delete") => void | Promise<void>) {
    super(app);
  }
  onOpen(): void {
    const v = { text: this.note.text, done: this.note.done };
    const { contentEl } = this;
    this.setTitle(this.note.id ? "Нотатка" : "Нова нотатка");
    const ta = contentEl.createEl("textarea", { cls: "mf-note-input", attr: { rows: "6", placeholder: "Напр.: 120 zł готівкою за обід — категорія «Кафе»" } });
    ta.value = v.text;
    ta.oninput = () => { v.text = ta.value; };
    window.setTimeout(() => ta.focus(), 50);
    new Setting(contentEl).setName("Виконано").addToggle((t) => t.setValue(v.done).onChange((x) => { v.done = x; }));
    const row = new Setting(contentEl);
    if (this.note.id) row.addButton((b) => b.setButtonText("Видалити").setWarning().onClick(async () => { this.close(); await this.done("delete"); }));
    row.addButton((b) => b.setButtonText("Зберегти").setCta().onClick(async () => {
      if (!v.text.trim()) return;
      this.close(); await this.done({ text: v.text.trim(), done: v.done });
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}

export interface TxDraft { tx_id: string; date: string; amount: number; direction: Direction; category: string; merchant: string; notes: string; payment: string }

/** Add / edit / delete a transaction entered by hand (cash by default). Saved to <dataDir>/manual/YYYY-MM.json. */
export class TxModal extends Modal {
  constructor(app: App, private tx: TxDraft, private categories: string[], private done: (r: TxDraft | "delete") => void | Promise<void>) {
    super(app);
  }
  onOpen(): void {
    const v: TxDraft = { ...this.tx };
    const { contentEl } = this;
    const isNew = !this.tx.tx_id;
    this.setTitle(isNew ? "Нова операція" : "Операція (внесена вручну)");
    new Setting(contentEl).setName("Тип").addDropdown((d) => d.addOption("debit", "Витрата").addOption("credit", "Надходження").setValue(v.direction).onChange((x) => { v.direction = x as Direction; }));
    new Setting(contentEl).setName("Сума, zł").addText((t) => {
      t.inputEl.type = "number"; t.inputEl.inputMode = "decimal"; t.inputEl.step = "0.01";
      t.setValue(v.amount ? String(v.amount) : "").onChange((x) => { v.amount = Math.abs(Number(x.replace(",", "."))) || 0; });
      if (isNew) window.setTimeout(() => t.inputEl.focus(), 50);
    });
    new Setting(contentEl).setName("Дата").addText((t) => { t.inputEl.type = "date"; t.setValue(v.date).onChange((x) => { if (/^\d{4}-\d{2}-\d{2}$/.test(x)) v.date = x; }); });
    new Setting(contentEl).setName("Категорія").addDropdown((d) => {
      for (const c of this.categories) d.addOption(c, codeName(c));
      if (!this.categories.includes(v.category)) d.addOption(v.category, codeName(v.category));
      d.setValue(v.category).onChange((x) => { v.category = x; });
    });
    new Setting(contentEl).setName("Де / кому").addText((t) => t.setPlaceholder("Напр.: EVITA Miechów").setValue(v.merchant).onChange((x) => { v.merchant = x; }));
    new Setting(contentEl).setName("Спосіб").addDropdown((d) => d.addOption("cash", "Готівка").addOption("card", "Картка").setValue(v.payment).onChange((x) => { v.payment = x; }));
    new Setting(contentEl).setName("Нотатка").addTextArea((t) => { t.inputEl.rows = 2; t.setValue(v.notes).onChange((x) => { v.notes = x; }); });
    const row = new Setting(contentEl);
    if (!isNew) row.addButton((b) => b.setButtonText("Видалити").setWarning().onClick(async () => { this.close(); await this.done("delete"); }));
    row.addButton((b) => b.setButtonText("Зберегти").setCta().onClick(async () => {
      if (!v.amount) { b.setButtonText("Вкажіть суму"); return; }
      if (!v.merchant.trim()) v.merchant = codeName(v.category);
      this.close(); await this.done(v);
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}

/** Category / note / "not counted" for a bank or receipt row. Saved to overrides.json; the ledger stays untouched. */
export class OverrideModal extends Modal {
  constructor(app: App, private tx: Transaction, private categories: string[], private done: (r: TxOverride | null) => void | Promise<void>) {
    super(app);
  }
  onOpen(): void {
    const t = this.tx;
    const v: TxOverride = { category: t.category || "other", notes: t.notes || "" };
    let skip = t.excluded === "manual";
    const { contentEl } = this;
    this.setTitle(t.merchant || "Операція");
    contentEl.createEl("p", { cls: "mf-muted", text: `${t.date} · ${t.amount.toFixed(2)} · ${t.description || ""}` });
    new Setting(contentEl).setName("Категорія").addDropdown((d) => {
      for (const c of this.categories) d.addOption(c, codeName(c));
      if (!this.categories.includes(v.category!)) d.addOption(v.category!, codeName(v.category!));
      d.setValue(v.category!).onChange((x) => { v.category = x; });
    });
    new Setting(contentEl).setName("Нотатка").addTextArea((x) => { x.inputEl.rows = 2; x.setValue(v.notes || "").onChange((y) => { v.notes = y; }); });
    new Setting(contentEl).setName("Не враховувати").setDesc("Напр. переказ між своїми рахунками.").addToggle((x) => x.setValue(skip).onChange((y) => { skip = y; }));
    const row = new Setting(contentEl);
    row.addButton((b) => b.setButtonText("Скинути зміни").onClick(async () => { this.close(); await this.done(null); }));
    row.addButton((b) => b.setButtonText("Зберегти").setCta().onClick(async () => {
      v.excluded = skip ? "manual" : (t.excluded === "manual" ? null : undefined);
      if (v.excluded === undefined) delete v.excluded;
      this.close(); await this.done(v);
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}
