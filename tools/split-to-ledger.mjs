// One-time migration: finance-data.json (format v2, from the Google Sheet) → format v3 folder.
//
// Usage: node tools/split-to-ledger.mjs <finance-data.json> <out-dir>
// Writes:
//   <out-dir>/ledger/YYYY-MM.json   one file per month, one transaction per line (written by /finance-check)
//   <out-dir>/meta.json             categoryDefs, loans, review, fx (written by /finance-check)
//   <out-dir>/finance-local.json    plan and notes (edited in the plugin) — only if it does not exist yet
// Computed fields (excluded internal/refund, category_name) are dropped: the plugin recomputes them.
import fs from "node:fs";
import path from "node:path";

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error("usage: node tools/split-to-ledger.mjs <finance-data.json> <out-dir>"); process.exit(1); }
const data = JSON.parse(fs.readFileSync(src, "utf8"));
if (!Array.isArray(data.transactions)) throw new Error("no transactions[] in the input file");

const months = new Map();
for (const t0 of data.transactions) {
  const t = { ...t0 };
  if (t.sheetCategory) { t.category = t.sheetCategory; delete t.sheetCategory; }
  if (t.excluded === "internal" || t.excluded === "refund") delete t.excluded; // recomputed by the plugin
  delete t.category_name;
  if (t.category === "internal") t.category = "transfers";
  const m = t.date.slice(0, 7);
  if (!months.has(m)) months.set(m, []);
  months.get(m).push(t);
}

const now = new Date().toISOString();
const monthFile = (m, txs) => {
  const rows = txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).map((t) => JSON.stringify(t));
  return `{"month":${JSON.stringify(m)},"updatedAt":${JSON.stringify(now)},"transactions":[\n${rows.join(",\n")}\n]}\n`;
};
fs.mkdirSync(path.join(out, "ledger"), { recursive: true });
let count = 0;
for (const [m, txs] of [...months.entries()].sort()) {
  fs.writeFileSync(path.join(out, "ledger", `${m}.json`), monthFile(m, txs));
  count += txs.length;
}

const meta = {
  version: 3,
  source: "/finance-check (ledger/*.json); history migrated from Google Sheet «Finance Tracker — дані»",
  generatedAt: now,
  currency: "PLN",
  categoryDefs: data.categoryDefs ?? [],
  loans: data.loans ?? [],
  review: data.review ?? [],
  fx: data.fx ?? {},
};
fs.writeFileSync(path.join(out, "meta.json"), JSON.stringify(meta, null, 1) + "\n");

const localPath = path.join(out, "finance-local.json");
if (!fs.existsSync(localPath)) {
  fs.writeFileSync(localPath, JSON.stringify({ plan: data.plan ?? [], notes: data.notes ?? [], updatedAt: now }, null, 1) + "\n");
}
console.log(JSON.stringify({ months: months.size, transactions: count, input: data.transactions.length, loans: meta.loans.length, review: meta.review.length }));
