// Data model and aggregation. All numbers are recomputed from `transactions`,
// so the plugin works even if the precomputed blocks in the file are stale.

export type Direction = "debit" | "credit";

/** A receipt line: n = name, t = line total (PLN in the file), q = qty, u = unit, c = item category (if it differs
 *  from the transaction's), s = subcategory (set by /finance-check; otherwise derived by keyword rules). */
export interface Item { n: string; t: number; q?: number; u?: string; c?: string; s?: string }

export interface Transaction {
  tx_id: string;
  date: string; // YYYY-MM-DD
  amount: number; // always positive, in the display currency after conversion (PLN in the file)
  direction: Direction;
  currency?: string;
  merchant?: string;
  description?: string;
  category?: string;
  category_name?: string;
  payment?: "card" | "cash" | string;
  account?: string;
  hasReceipt?: boolean;
  receiptUrl?: string | null;
  receiptId?: string;
  notes?: string;
  verified?: boolean;
  /** "transfer" (between own accounts) or "refund" (purchase + refund pair): never counted. */
  excluded?: string;
  orig?: { amount: number; currency: string; fx?: number };
  items?: Item[];
}

export interface Loan { id: string; person: string; direction: string; amount: number; currency: string; dateGiven: string; dateReturned: string | null; status: string; notes?: string }
export interface Note { id: string; text: string; created: string; done: boolean }
export interface PlanItem { id: string; kind: "income" | "expense"; name: string; category: string; amount: number; month: string }
export interface ReviewItem { receiptId: string; date: string; merchant: string; total: number; currency: string; payment?: string; url: string | null; txId: string | null; items?: number }
export interface CategoryDef { code: string; name: string; budget?: number }

export interface FinanceFile {
  meta?: { generatedAt?: string; currency?: string; [k: string]: unknown };
  transactions: Transaction[];
  fx?: Record<string, [string, number][]>;
  categoryDefs?: CategoryDef[];
  loans?: Loan[];
  notes?: Note[];
  plan?: PlanItem[];
  review?: ReviewItem[];
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
  business: "Бізнес-витрати",
  cash_withdrawal: "Зняття готівки",
  alcohol: "Алкоголь",
  family: "Родина",
  school: "Школа",
  internal: "Внутрішні перекази",
  other: "Інше",
};

/** Names from the data file (Categories sheet) take precedence over the built-in list. */
export function setCategoryDefs(defs: CategoryDef[] | undefined): void {
  for (const d of defs ?? []) if (d.code && d.name) CATEGORY_NAMES[d.code] = d.name;
}

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
export function codeName(code: string): string {
  return CATEGORY_NAMES[code] || code || "Інше";
}
export function categoryName(t: { category?: string; category_name?: string }): string {
  return t.category_name || CATEGORY_NAMES[t.category || "other"] || t.category || "Інше";
}

// Internal money movements (cash deposits / ATM withdrawals, currency exchange, transfers between own
// accounts): never spending, never income. Same rule as tools/build-from-sheet.mjs, applied here too so
// older data files are read correctly.
const INTERNAL_RE = /wp[łl]ata got[óo]wki|wp[łl]atomat|wyp[łl]ata w bankomacie|bankomat|wymiana w kantorze|\bkantor|przelew w[łl]asn|w[łl]asny rach|mi[ęe]dzy w[łl]asnymi|власними карт|між власними|внесення готівки|зняття готівки|own account/i;
export function isInternal(t: Partial<Transaction>): boolean {
  if (t.excluded === "internal" || t.category === "internal" || t.category === "cash_withdrawal") return true;
  return INTERNAL_RE.test(`${t.description ?? ""} ${t.merchant ?? ""} ${t.notes ?? ""}`);
}

export function parseFinance(text: string): FinanceFile {
  const raw = JSON.parse(text) as Partial<FinanceFile>;
  if (!raw || !Array.isArray(raw.transactions)) throw new Error("У файлі немає масиву transactions");
  const transactions = raw.transactions
    .filter((t) => t && typeof t.date === "string" && isFinite(Number(t.amount)))
    .map((t) => {
      const x = { ...t, amount: Math.abs(Number(t.amount)), direction: (t.direction === "credit" ? "credit" : "debit") as Direction };
      if (isInternal(x)) { x.excluded = "internal"; x.category = "internal"; x.category_name = "Внутрішні перекази"; }
      return x;
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  setCategoryDefs(raw.categoryDefs);
  return { ...raw, transactions } as FinanceFile;
}

export const r2 = (n: number): number => Math.round(n * 100) / 100;

// ---------- Currency ----------
export const CURRENCIES = ["PLN", "EUR", "USD", "UAH"] as const;
export type Currency = typeof CURRENCIES[number];
export const CURRENCY_LABEL: Record<string, string> = { PLN: "zł", EUR: "€", USD: "$", UAH: "₴" };

/** Converts PLN amounts into another currency with NBP mid rates (PLN per unit), nearest earlier date. */
export class Converter {
  private series: [string, number][];
  constructor(readonly target: string, fx: FinanceFile["fx"], private fixedRate = 0) {
    this.series = target === "PLN" ? [] : (fx?.[target] ?? []);
  }
  get ok(): boolean { return this.target === "PLN" || this.series.length > 0 || this.fixedRate > 0; }
  rate(date: string): number {
    if (this.target === "PLN") return 1;
    if (this.fixedRate > 0) return this.fixedRate;
    const s = this.series;
    if (!s.length) return 1;
    let lo = 0, hi = s.length - 1, best = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid][0] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return s[best][1] || 1;
  }
  fromPln(amount: number, date: string): number { return this.target === "PLN" ? amount : amount / this.rate(date); }
  /** Any currency → target, via PLN (uses the same table for the source currency). */
  convert(amount: number, currency: string, date: string, fx: FinanceFile["fx"]): number {
    let pln = amount;
    if (currency !== "PLN") { const c = new Converter(currency, fx); pln = amount * c.rate(date); }
    return this.fromPln(pln, date);
  }
}

/** Transactions in the display currency (a shallow copy; items scaled the same way). */
export function convertTransactions(txs: Transaction[], conv: Converter): Transaction[] {
  if (conv.target === "PLN") return txs;
  return txs.map((t) => {
    const k = 1 / conv.rate(t.date);
    return { ...t, amount: r2(t.amount * k), items: t.items?.map((i) => ({ ...i, t: r2(i.t * k) })) };
  });
}

// ---------- Summary ----------
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
  incomeCategories: CategoryTotal[];
  monthly: MonthTotal[];
}

/** How a debit splits between categories: by receipt line items when there are any (like the web dashboard). */
export function categoryShares(t: Transaction): [string, number][] {
  const base = t.category || "other";
  const its = t.items ?? [];
  const itemsTotal = its.reduce((a, i) => a + (i.t > 0 ? i.t : 0), 0);
  if (!its.length || itemsTotal <= 0) return [[base, t.amount]];
  const m = new Map<string, number>();
  for (const i of its) if (i.t > 0) { const c = i.c || base; m.set(c, (m.get(c) ?? 0) + (t.amount * i.t) / itemsTotal); }
  return [...m.entries()];
}

export function summarize(txs: Transaction[]): Summary {
  const cats = new Map<string, CategoryTotal>();
  const inc = new Map<string, CategoryTotal>();
  const months = new Map<string, MonthTotal>();
  let spend = 0, income = 0, card = 0, cash = 0, withReceipt = 0;
  const bump = (map: Map<string, CategoryTotal>, code: string, v: number, count: boolean) => {
    let c = map.get(code);
    if (!c) map.set(code, (c = { code, name: codeName(code), total: 0, count: 0 }));
    c.total += v; if (count) c.count++;
  };
  for (const t of txs) {
    const m = t.date.slice(0, 7);
    let mt = months.get(m);
    if (!mt) months.set(m, (mt = { month: m, spend: 0, income: 0 }));
    if (t.hasReceipt) withReceipt++;
    if (t.excluded) continue;
    if (t.direction === "credit") { income += t.amount; mt.income += t.amount; bump(inc, t.category || "other", t.amount, true); continue; }
    spend += t.amount; mt.spend += t.amount;
    if (t.payment === "cash") cash += t.amount; else card += t.amount;
    for (const [code, v] of categoryShares(t)) bump(cats, code, v, true);
  }
  const fin = (m: Map<string, CategoryTotal>) => [...m.values()].map((c) => ({ ...c, total: r2(c.total) })).sort((a, b) => b.total - a.total);
  return {
    spend: r2(spend), income: r2(income), count: txs.length, card: r2(card), cash: r2(cash), withReceipt,
    categories: fin(cats), incomeCategories: fin(inc),
    monthly: [...months.values()].map((m) => ({ ...m, spend: r2(m.spend), income: r2(m.income) })).sort((a, b) => (a.month < b.month ? -1 : 1)),
  };
}

/** Debit transactions that put money into `code` (directly or via one of their receipt lines). */
export function inCategory(t: Transaction, code: string): boolean {
  return t.direction === "debit" && !t.excluded && categoryShares(t).some(([c]) => c === code);
}

// ---------- Category drill-down (second level) ----------
export const SUBCATS: Record<string, string> = {
  vegetables: "Овочі", fruits: "Фрукти", dairy: "Молочне і яйця", meat: "М'ясо і риба", bread: "Хліб і випічка",
  grains: "Крупи, борошно, макарони", pantry: "Бакалія і соуси", drinks: "Напої", coffee: "Кава і чай",
  sweets: "Солодощі і снеки", frozen: "Заморожене", ready: "Готова їжа", deposit: "Тара і кауція",
  household: "Побутове", other: "Інше",
};
// First match wins, so more specific groups come first ("jogurt ananas" is dairy, "napój kawowy" is coffee).
const RULES: [string, RegExp][] = [
  ["deposit", /kaucj|opakowan|butelk|torb|reklam/i],
  ["household", /foli|papier|ręcznik|recznik|płyn|plyn|worki|gąbk|gabk|zmywak|chusteczk|plastelin|korektor|patyczk/i],
  ["frozen", /mrożon|mrozon|frytki|pierogi mro/i],
  ["sweets", /baton|mars|snickers|twix|czekolad|cukierk|lody|guma|chips|chrup|przekąsk|przekask|wafel|wafl|ciastk|żelk|zelk|niespodzian|paluszk|orzesz|bob snail|krakers|draż|draz|lizak|delicj|kinder|deser|budyń|budyn|ptasie|donut|pralin|raffaello|milka|rodzynk|herbatnik|orzech/i],
  ["coffee", /kaw[aoy]|kawow|herbat|lipton|cappucc|latte|espresso/i],
  ["dairy", /mlek|mleczn|jogurt|\bser\b|serek|sera|twaróg|twarog|kefir|masło|maslo|masełk|maselk|śmietan|smietan|maślank|maslank|jaj|skyr|mozzarell|kremówk|actimel|activia|danone/i],
  ["meat", /kurczak|kurcz|gyros|kiełbas|kielbas|parówk|parowk|szynk|boczek|mięs|wieprz|wołow|wolow|indyk|filet|mielon|tuńczyk|tunczyk|łosoś|losos|ryb|śledź|sledz|kabanos|pasztet|salami|schab|karków|karkow|udko|skrzyd|krewet|konserw|tofu/i],
  ["bread", /chleb|bułk|bulk|bagiet|chałk|chalk|rogal|tortill|piadin|pieczyw|drożdżów|drozdzow|pączek|paczek|croissant|bajgiel|kajzer|grahamk|ciabat|spody do pizz/i],
  ["grains", /mąk|maka |ryż|ryz|makaron|kasz|płatki|platki|owsian|tapiok|rurki|spaghetti|penne|kuskus|musli|granol|gryczan/i],
  ["pantry", /cukier|\bsól\b|\bsol\b|olej|oliw|\bsos|przypraw|ketchup|majonez|musztard|ocet|miód|miod|dżem|dzem|konfitur|pesto|bulion|drożdż|drozdz|kakao|nutell|syrop|proszek|skrobi/i],
  ["drinks", /napój|napoj|wod[ay]|\bsok|cola|pepsi|fanta|sprite|piwo|energetyk|tiger|red bull|monster|lemoniad|oranżad|oranzad|izotonik|kompot/i],
  ["vegetables", /pomidor|ogór|ogor|ziemniak|papryk|cebul|marchew|kapust|sałat|salat|czosn|brokuł|brokul|cukini|warzyw|pieczark|burak|\bpor\b|rzodkiew|kalafior|kukurydz|szpinak|dyni|fasol|groszek|seler|natk|koperek|pietruszk|bakłażan|baklazan|awokado|avocado|włoszczyzn|wloszczyzn/i],
  ["fruits", /banan|jabł|jabl|arbuz|melon|gruszk|pomarańcz|pomarancz|mandaryn|cytryn|limonk|winogr|truskaw|malin|borówk|borowk|kiwi|ananas|owoc|śliwk|sliwk|brzoskw|nektaryn|morel|grejpfrut|wiśni|wisni|czereśn|czeresn/i],
  ["ready", /zup[ay]|vifon|pizza|kanapk|sałatk|salatk|hot.?dog|zapiekank|pierog|gotow|danie|burger|kebab|sushi|wrap/i],
];
export function subcategoryOf(item: Item, category: string): string {
  if (item.s) return item.s;
  if (category !== "groceries" && category !== "dining" && category !== "alcohol") return "";
  for (const [code, re] of RULES) if (re.test(item.n)) return code;
  return "other";
}
export function subcategoryName(code: string): string { return SUBCATS[code] || code; }

export interface DetailItem { tx: Transaction; item: Item; amount: number }
export interface DetailGroup { key: string; name: string; total: number; items: DetailItem[] }
export interface CategoryDetail {
  code: string;
  total: number; // category total (allocated)
  groups: DetailGroup[]; // by subcategory (groceries) or by item name (other categories)
  diff: number; // allocated share minus sum of listed lines: discounts, deposits paid back, rounding
  diffTxs: Transaction[];
  noDetail: { txs: Transaction[]; total: number; noReceipt: number; noItems: number };
}

export function categoryDetail(txs: Transaction[], code: string): CategoryDetail {
  const groups = new Map<string, DetailGroup>();
  let total = 0, diff = 0;
  const diffTxs: Transaction[] = [];
  const noDetail = { txs: [] as Transaction[], total: 0, noReceipt: 0, noItems: 0 };
  for (const t of txs) {
    if (!inCategory(t, code)) continue;
    const share = categoryShares(t).find(([c]) => c === code)?.[1] ?? 0;
    total += share;
    const its = (t.items ?? []).filter((i) => (i.c || t.category || "other") === code);
    if (!its.length) {
      noDetail.txs.push(t); noDetail.total += share;
      if (t.hasReceipt) noDetail.noItems++; else noDetail.noReceipt++;
      continue;
    }
    let lines = 0;
    for (const i of its) {
      const sub = subcategoryOf(i, code);
      const key = sub || i.n.toLowerCase().replace(/\s+\d.*$/, "").trim() || "?";
      const name = sub ? subcategoryName(sub) : i.n;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, name, total: 0, items: [] }));
      g.total += i.t; g.items.push({ tx: t, item: i, amount: i.t });
      lines += i.t;
    }
    const d = share - lines;
    if (Math.abs(d) >= 0.01) { diff += d; diffTxs.push(t); }
  }
  return {
    code, total: r2(total), diff: r2(diff), diffTxs,
    groups: [...groups.values()].map((g) => ({ ...g, total: r2(g.total) })).sort((a, b) => b.total - a.total),
    noDetail: { ...noDetail, total: r2(noDetail.total) },
  };
}

// ---------- Loans ----------
/** borrowed = I owe the person; lent = the person owes me. */
export function loanSign(l: Loan): 1 | -1 { return /lent|gave|дав/i.test(l.direction) ? 1 : -1; }
export const loanActive = (l: Loan): boolean => !/closed|returned|paid|закрит/i.test(l.status);

// ---------- Reconciliation ----------
export interface Issue { kind: string; title: string; txs: Transaction[] }

const dayDiff = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const firstWord = (s = ""): string => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/)[0] || "";

export function reconcile(all: Transaction[], bigAmount = 200, cur = "zł"): Issue[] {
  const txs = all.filter((t) => !t.excluded);
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
  if (noReceipt.length) issues.push({ kind: "no-receipt", title: `Операції без чека понад ${bigAmount} ${cur}`, txs: noReceipt });

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
export function prevMonth(m: string): string {
  let [y, mo] = m.split("-").map(Number);
  mo--; if (mo < 1) { mo = 12; y--; }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

const fmt = new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (n: number, cur = "zł"): string => `${fmt.format(n)} ${cur}`;
export const MONTHS_UA = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
export const monthLabel = (m: string): string => `${MONTHS_UA[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

export const CATEGORY_ICONS: Record<string, string> = {
  groceries: "shopping-cart", housing: "home", transfers: "arrow-left-right", fuel: "fuel",
  electronics: "laptop", household: "spray-can", education: "graduation-cap", subscriptions: "repeat",
  dining: "utensils", transport: "bus", travel: "plane", car: "car", entertainment: "gamepad-2",
  health: "heart-pulse", clothing: "shirt", telecom: "smartphone", taxes: "landmark", other: "circle-dot",
  business: "briefcase", cash_withdrawal: "banknote", alcohol: "wine", family: "users", school: "school",
  internal: "repeat-2",
};
