import { App, Modal, Setting } from "obsidian";
import { codeName, Note, PlanItem } from "./data";

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
