// Data model and aggregation. All numbers are recomputed from `transactions`,
// so the plugin works even if the precomputed blocks in the file are stale.

export type Direction = "debit" | "credit";

export interface Transaction {
  tx_id: string;
  date: string; // YYYY-MM-DD
  amount: number; // always positive
  direction: Direction;
  currency?: string;
  merchant?: string;
  description?: string;
  category?: string;
  category_name?: string;
  payment?: "card" | "cash" | string;
  hasReceipt?: boolean;
  receiptUrl?: string | null;
  notes?: string;
  verified?: boolean;
}

export interface FinanceFile {
  meta?: { generatedAt?: string; currency?: string; [k: string]: unknown };
  transactions: Transaction[];
  [k: string]: unknown;
}

export const CATEGORY_NAMES: Record<string, string> = {
  groceries: "Продукти",
  housing: "Житло і комунальні",
  transfers: "Перекази",
  fuel: "Паливо",
  electronics: "Техніка і електроніка",
  household: "Побутова хімія і дім",
  education: "Освіта",
  subscriptions: "Підписки і софт",
  dining: "Кафе і ресторани",
  transport: "Транспорт",
  travel: "Подорожі",
  car: "Авто: сервіс і запчастини",
  entertainment: "Розваги і хобі",
  health: "Здоров'я і аптека",
  clothing: "Одяг і взуття",
  telecom: "Зв'язок та інтернет",
  taxes: "Податки і збори",
  other: "Інше",
};

const PALETTE = [
  "#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948",
  "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac", "#86bcb6", "#d37295",
  "#8cd17d", "#f1ce63", "#a0cbe8", "#ffbe7d", "#d4a6c8", "#79706e",
];
const CODES = Object.keys(CATEGORY_NAMES);
export function categoryColor(code: string): string {
  let i = CODES.indexOf(code);
  if (i < 0) i = [...code].reduce((a, c) => a + c.charCodeAt(0), 0);
  return PALETTE[i % PALETTE.length];
}
export function categoryName(t: { category?: string; category_name?: string }): string {
  return t.category_name || CATEGORY_NAMES[t.category || "other"] || t.category || "Інше";
}

export function parseFinance(text: string): FinanceFile {
  const raw = JSON.parse(text) as Partial<FinanceFile>;
  if (!raw || !Array.isArray(raw.transactions)) throw new Error("У файлі немає масиву transactions");
  const transactions = raw.transactions
    .filter((t) => t && typeof t.date === "string" && isFinite(Number(t.amount)))
    .map((t) => ({ ...t, amount: Math.abs(Number(t.amount)), direction: (t.direction === "credit" ? "credit" : "debit") as Direction }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { ...raw, transactions } as FinanceFile;
}

export const r2 = (n: number): number => Math.round(n * 100) / 100;

export interface CategoryTotal { code: string; name: string; total: number; count: number }
export interface MonthTotal { month: string; spend: number; income: number }
export interface Summary {
  spend: number;
  income: number;
  count: number;
  card: number;
  cash: number;
  withReceipt: number;
  categories: CategoryTotal[];
  monthly: MonthTotal[];
}

export function summarize(txs: Transaction[]): Summary {
  const cats = new Map<string, CategoryTotal>();
  const months = new Map<string, MonthTotal>();
  let spend = 0, income = 0, card = 0, cash = 0, withReceipt = 0;
  for (const t of txs) {
    const m = t.date.slice(0, 7);
    let mt = months.get(m);
    if (!mt) months.set(m, (mt = { month: m, spend: 0, income: 0 }));
    if (t.hasReceipt) withReceipt++;
    if (t.direction === "credit") { income += t.amount; mt.income += t.amount; continue; }
    spend += t.amount; mt.spend += t.amount;
    if (t.payment === "cash") cash += t.amount; else card += t.amount;
    const code = t.category || "other";
    let c = cats.get(code);
    if (!c) cats.set(code, (c = { code, name: categoryName(t), total: 0, count: 0 }));
    c.total += t.amount; c.count++;
  }
  return {
    spend: r2(spend), income: r2(income), count: txs.length, card: r2(card), cash: r2(cash), withReceipt,
    categories: [...cats.values()].map((c) => ({ ...c, total: r2(c.total) })).sort((a, b) => b.total - a.total),
    monthly: [...months.values()].map((m) => ({ ...m, spend: r2(m.spend), income: r2(m.income) })).sort((a, b) => (a.month < b.month ? -1 : 1)),
  };
}

// ---------- Reconciliation ----------
export interface Issue { kind: string; title: string; txs: Transaction[] }

const dayDiff = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const firstWord = (s = ""): string => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/)[0] || "";

export function reconcile(txs: Transaction[], bigAmount = 200): Issue[] {
  const issues: Issue[] = [];
  const debits = txs.filter((t) => t.direction === "debit");

  // Possible duplicates: same merchant, amount ±0.02, date ±1 day. Small tickets (<= 10) are skipped.
  const sorted = [...debits].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (a.amount <= 10) continue;
    for (let j = i + 1; j < sorted.length && dayDiff(a.date, sorted[j].date) <= 1; j++) {
      const b = sorted[j];
      if (Math.abs(a.amount - b.amount) <= 0.02 && firstWord(a.merchant) === firstWord(b.merchant)) {
        issues.push({ kind: "duplicate", title: `Можливий дубль: ${a.merchant || "?"}`, txs: [a, b] });
      }
    }
  }

  // Cash receipts that look like a card operation (same amount, ±2 days, same first word).
  for (const c of debits.filter((t) => t.payment === "cash")) {
    const twin = debits.find((t) => t !== c && t.payment !== "cash" && Math.abs(t.amount - c.amount) <= 0.02
      && dayDiff(t.date, c.date) <= 2 && firstWord(t.merchant) === firstWord(c.merchant));
    if (twin) issues.push({ kind: "cash-card", title: `Готівковий чек схожий на карткову операцію: ${c.merchant || "?"}`, txs: [c, twin] });
  }

  const orphanReceipts = txs.filter((t) => /без відповідної банківської/i.test(t.notes || ""));
  if (orphanReceipts.length) issues.push({ kind: "orphan-receipt", title: "Чеки без банківської операції", txs: orphanReceipts });

  const noReceipt = debits.filter((t) => !t.hasReceipt && t.amount > bigAmount && t.category !== "transfers" && t.category !== "housing");
  if (noReceipt.length) issues.push({ kind: "no-receipt", title: `Операції без чека понад ${bigAmount} zł`, txs: noReceipt });

  const other = debits.filter((t) => (t.category || "other") === "other");
  if (other.length) issues.push({ kind: "other", title: "Без категорії («Інше»)", txs: other });

  const phone = debits.filter((t) => /DOŁADOWANIE TELEFONU/i.test(t.description || "") && t.category !== "telecom");
  if (phone.length) issues.push({ kind: "category", title: "Поповнення телефону не в категорії «Зв'язок»", txs: phone });

  // Gaps: months in range without any operation.
  if (txs.length) {
    const months = new Set(txs.map((t) => t.date.slice(0, 7)));
    const min = txs[txs.length - 1].date.slice(0, 7), max = txs[0].date.slice(0, 7);
    const missing: string[] = [];
    for (let m = min; m <= max; m = nextMonth(m)) if (!months.has(m)) missing.push(m);
    if (missing.length) issues.push({ kind: "gap", title: `Місяці без операцій: ${missing.join(", ")}`, txs: [] });
  }
  return issues;
}

export function nextMonth(m: string): string {
  let [y, mo] = m.split("-").map(Number);
  mo++; if (mo > 12) { mo = 1; y++; }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

const fmt = new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (n: number, cur = "zł"): string => `${fmt.format(n)} ${cur}`;
export const MONTHS_UA = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
export const monthLabel = (m: string): string => `${MONTHS_UA[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;
