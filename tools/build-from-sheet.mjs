// Builds finance-data.json (format v2) from table dumps of the "Finance Tracker" Google Sheet.
//
// Usage: node tools/build-from-sheet.mjs <dump-dir> <out.json>
//   <dump-dir> holds one JSON file per sheet: Transactions.json, Receipts.json, ReceiptItems.json,
//   Categories.json, Loans.json, Notes.json, Plan.json — each an array of rows, the first row being the header.
//
// The logic mirrors the web dashboard (buildDashboardPayload_):
//   * amounts are converted to PLN with the row's fx_rate_pln (non-PLN rows keep the original in `orig`);
//   * source "transfer" rows and debit/credit "refund pairs" (same merchant key and PLN amount, one debit +
//     one credit within 90 days) are marked `excluded` and never counted as spending or income;
//   * card vs cash: account "cash", or source "receipt_cash" when there is no account;
//   * a receipt's line items are attached to the transaction so the plugin can split it by item category.
// NBP mid rates (table A) for EUR, USD and UAH are fetched for the whole date range (PLN per 1 unit).
import fs from "node:fs";
import path from "node:path";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error("usage: node tools/build-from-sheet.mjs <dump-dir> <out.json>"); process.exit(1); }

const load = (name) => {
  const p = path.join(dir, `${name}.json`);
  if (!fs.existsSync(p)) return [];
  const rows = JSON.parse(fs.readFileSync(p, "utf8"));
  const head = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] ?? "").trim()])));
};
const num = (s) => { const n = Number(String(s).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const yes = (s) => /^(✔|true|так|1|yes)$/i.test(s);

const T = load("Transactions"), R = load("Receipts"), I = load("ReceiptItems"), C = load("Categories");
const LO = load("Loans"), N = load("Notes"), P = load("Plan");

const catName = Object.fromEntries(C.filter((c) => c.code).map((c) => [c.code, c.name_ua || c.code]));
const receiptByTx = new Map(), receiptById = new Map();
for (const r of R) { receiptById.set(r.receipt_id, r); if (r.tx_id) receiptByTx.set(r.tx_id, r); }
const itemsByReceipt = new Map();
for (const it of I) {
  if (!it.receipt_id) continue;
  if (!itemsByReceipt.has(it.receipt_id)) itemsByReceipt.set(it.receipt_id, []);
  itemsByReceipt.get(it.receipt_id).push(it);
}

// Refund pairs (web dashboard: REFUND_PAIR_WINDOW_DAYS_ = 90).
const merchantKey = (s) => String(s || "").toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]/g, "");
const cancelled = new Set();
{
  const groups = new Map();
  for (const t of T) {
    if (t.source === "transfer" || !t.tx_id) continue;
    const key = merchantKey(t.merchant) || merchantKey(t.raw_description);
    if (!key) continue;
    const g = `${key}|${Math.round(num(t.amount) * (num(t.fx_rate_pln) || 1) * 100)}`;
    if (!groups.has(g)) groups.set(g, { d: [], c: [] });
    groups.get(g)[t.direction === "debit" ? "d" : "c"].push(t);
  }
  for (const g of groups.values()) {
    if (g.d.length !== 1 || g.c.length !== 1) continue;
    if (Math.abs(Date.parse(g.d[0].date) - Date.parse(g.c[0].date)) > 90 * 86400000) continue;
    cancelled.add(g.d[0].tx_id); cancelled.add(g.c[0].tx_id);
  }
}

const seen = new Set();
const transactions = [];
for (const [rowNo, t] of T.entries()) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(t.date) || !(num(t.amount) || t.tx_id)) continue;
  let id = t.tx_id || `row-${rowNo + 2}`;
  if (seen.has(id)) id = `${id}-${transactions.length}`;
  seen.add(id);
  const currency = t.currency || "PLN";
  const fx = num(t.fx_rate_pln) || 1;
  const amountOrig = Math.abs(num(t.amount));
  const receipt = (t.receipt_id && receiptById.get(t.receipt_id)) || receiptByTx.get(t.tx_id) || null;
  const category = t.category || (receipt && receipt.category) || "other";
  const account = t.account || "";
  const cash = account ? account === "cash" : t.source === "receipt_cash";
  const tx = {
    tx_id: id,
    date: t.date.slice(0, 10),
    amount: r2(currency === "PLN" ? amountOrig : amountOrig * fx),
    direction: t.direction === "credit" ? "credit" : "debit",
    currency: "PLN",
    merchant: t.merchant || "",
    description: t.raw_description || "",
    category,
    category_name: catName[category] || "",
    payment: cash ? "cash" : "card",
    account,
    source: t.source || "",
    hasReceipt: !!receipt,
    receiptUrl: receipt?.drive_url || null,
    notes: t.notes || "",
    verified: yes(t.verified),
  };
  if (currency !== "PLN") tx.orig = { amount: amountOrig, currency, fx };
  if (t.source === "transfer") tx.excluded = "transfer";
  else if (cancelled.has(t.tx_id)) tx.excluded = "refund";
  if (receipt) {
    tx.receiptId = receipt.receipt_id;
    const its = (itemsByReceipt.get(receipt.receipt_id) || []).sort((a, b) => num(a.line_no) - num(b.line_no));
    if (its.length) {
      tx.items = its.map((it) => {
        const o = { n: it.name_clean || it.name_raw || "?", t: r2(num(it.line_total)) };
        const q = num(it.qty); if (q && q !== 1) o.q = q;
        if (it.unit && it.unit !== "szt") o.u = it.unit;
        if (it.item_category && it.item_category !== category) o.c = it.item_category;
        if (it.subcategory) o.s = it.subcategory;
        return o;
      });
    }
  }
  transactions.push(tx);
}
transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

// ---- NBP mid rates ----
const dates = transactions.map((t) => t.date).sort();
const from = new Date(Date.parse(dates[0]) - 10 * 86400000).toISOString().slice(0, 10);
const to = new Date().toISOString().slice(0, 10);
const fx = {};
for (const cur of ["EUR", "USD", "UAH"]) {
  const pts = [];
  for (let a = from; a <= to;) {
    const bDate = new Date(Math.min(Date.parse(a) + 360 * 86400000, Date.parse(to))).toISOString().slice(0, 10);
    const res = await fetch(`https://api.nbp.pl/api/exchangerates/rates/a/${cur.toLowerCase()}/${a}/${bDate}/?format=json`, { headers: { Accept: "application/json" } });
    if (res.ok) for (const r of (await res.json()).rates) pts.push([r.effectiveDate, r.mid]);
    a = new Date(Date.parse(bDate) + 86400000).toISOString().slice(0, 10);
  }
  fx[cur] = pts;
}

// ---- aggregates (PLN, transfers/refund pairs excluded) ----
const counted = transactions.filter((t) => !t.excluded);
const deb = counted.filter((t) => t.direction === "debit"), cre = counted.filter((t) => t.direction === "credit");
const months = [...new Set(transactions.map((t) => t.date.slice(0, 7)))].sort();
const sum = (a) => r2(a.reduce((s, t) => s + t.amount, 0));

const data = {
  meta: {
    version: 2,
    source: "Google Sheet «Finance Tracker — дані»",
    generatedAt: new Date().toISOString(),
    totalTransactions: transactions.length,
    dateFrom: dates[0], dateTo: dates.at(-1),
    totalSpend: sum(deb), totalIncome: sum(cre),
    currency: "PLN",
  },
  monthly: months.map((m) => ({ month: m, spend: sum(deb.filter((t) => t.date.startsWith(m))), income: sum(cre.filter((t) => t.date.startsWith(m))) })),
  paymentSplit: { card: sum(deb.filter((t) => t.payment !== "cash")), cash: sum(deb.filter((t) => t.payment === "cash")) },
  categoryDefs: C.filter((c) => c.code && c.active !== "FALSE").map((c) => ({ code: c.code, name: c.name_ua || c.code, ...(num(c.monthly_budget) ? { budget: num(c.monthly_budget) } : {}) })),
  fx,
  loans: LO.filter((l) => l.loan_id).map((l) => ({
    id: l.loan_id, person: l.person, direction: l.direction, amount: num(l.amount), currency: l.currency || "PLN",
    dateGiven: l.date_given.slice(0, 10), dateReturned: l.date_returned.slice(0, 10) || null, status: l.status || "active", notes: l.notes || "",
  })),
  notes: N.filter((n) => n.note_id).map((n) => ({ id: n.note_id, text: n.text, created: n.created_at.replace("T", " ").slice(0, 16), done: yes(n.done) })),
  plan: P.filter((p) => p.plan_id).map((p) => ({ id: p.plan_id, kind: p.kind === "income" ? "income" : "expense", name: p.name, category: p.category, amount: num(p.amount), month: p.month.slice(0, 7) })),
  review: R.filter((r) => r.match_status === "review").map((r) => ({
    receiptId: r.receipt_id, date: r.receipt_date.slice(0, 10), merchant: r.merchant, total: num(r.total), currency: r.currency || "PLN",
    payment: r.payment_method, url: r.drive_url || null, txId: r.tx_id || null, items: num(r.items_count),
  })),
  transactions,
};
fs.writeFileSync(out, JSON.stringify(data));
console.log(JSON.stringify({ ...data.meta, excluded: transactions.filter((t) => t.excluded).length, withItems: transactions.filter((t) => t.items).length, receiptLinks: transactions.filter((t) => t.receiptUrl).length, fx: Object.fromEntries(Object.entries(fx).map(([k, v]) => [k, v.length])), bytes: fs.statSync(out).size }, null, 1));
