# Фінанси Марка (Obsidian plugin)

Offline personal finance dashboard for Obsidian (desktop and Android), with the same features as the author's Google Apps Script finance tracker.
Mobile-first: the month switcher and tabs are at the top, so nothing sits under Obsidian's mobile toolbar. Lists are paginated and line items load only when you open them, which keeps memory use low.

It reads monthly ledger files from the vault (see below) and shows six tabs. The **+** button (view header and the Операції tab) adds an operation by hand — handy for cash on the phone:

- **Огляд** (overview):
  - spending with the change from the previous period;
  - income and balance;
  - a monthly chart (tap a month to open it);
  - spending and income by category, card vs cash, latest operations.
  - **Category drill-down.** Tap a category to see what it is made of.
    - Groceries split into subcategories built from receipt line items (vegetables, fruit, dairy, meat and fish, bread, drinks, sweets, …). Other categories list their items.
    - Tap a subcategory to see the individual items, each with a button that opens the receipt.
    - A coverage block shows how much of the category is explained by receipts. Purchases without a receipt or without line items are listed separately, with count, sum and share. The difference between the line items and the receipt total (discounts, deposits) is shown as «Інше / знижки».
- **Операції** (transactions):
  - search, including receipt items;
  - filter chips;
  - day groups.
  - Details show the original currency, line items and a button that opens the receipt photo in Google Drive. Nothing is downloaded into the vault.
- **План** (plan): a monthly income and expense plan, in PLN.
  - Each line shows progress against actual spending, plus the last two months for reference.
  - Spending that has no plan line is listed, so you can add it to the plan with one tap.
  - You can copy the previous month's plan. Future months are allowed.
- **Борги** (debts): active and closed loans per person, totals converted to the display currency.
- **Нотатки** (notes): add, edit and tick off notes.
- **Перевірка** (review):
  - recognised receipts still waiting to be matched;
  - possible duplicates;
  - cash receipts that look like card payments;
  - big spends without a receipt, uncategorised items, gaps between months.

Period: month (swipe or arrows), year, all time, or a custom range.

**Internal movements** are never spending or income: cash deposits and ATM withdrawals, currency exchange (for example PLN→EUR to set rent money aside, and back), and transfers between own accounts. They get the service category `internal` (from `tools/build-from-sheet.mjs` or the same keyword rule in the plugin). They are left out of every total and chart, shown greyed in lists and in a collapsed «Внутрішні рухи» block.

**Currency:** PLN, EUR, USD or UAH (settings). Amounts are converted with NBP mid rates for each transaction date, which are stored in the data file; a fixed rate can be set instead. Transfers between own accounts and purchase+refund pairs are shown but never counted.

**Plan and notes** are saved to a second vault file (default `Фінанси/finance-local.json`), so they sync to other devices with the vault. The first time, they are seeded from the data file.

## Data (format v3: monthly ledger)

Everything lives in one vault folder (default `Фінанси/`, configurable). Each file has **one writer**, so phone, laptop and `/finance-check` never edit the same file and sync stays conflict-free:

| File | Written by | What |
|---|---|---|
| `ledger/YYYY-MM.json` | `/finance-check` | bank statements and receipts for one month, one transaction per line |
| `manual/YYYY-MM.json` | the plugin | operations added with **+** (cash by default), editable and deletable |
| `overrides.json` | the plugin | your changes to ledger rows: category, note, "not counted" |
| `meta.json` | `/finance-check` | category names and budgets, loans, receipts waiting for review, NBP rates |
| `finance-local.json` | the plugin | plan and notes |

Month file:

```json
{"month":"2026-10","updatedAt":"2026-11-13T15:00:00.000Z","transactions":[
{"tx_id":"8a377af1f87739af","date":"2026-10-08","amount":101.36,"direction":"debit","currency":"PLN","merchant":"Shell","description":"ZAKUP PRZY UŻYCIU KARTY | SHELL 09 Krakow PL","category":"fuel","payment":"card","hasReceipt":true,"receiptUrl":"https://drive.google.com/file/d/<id>/view","items":[{"n":"Benzyna Shell FuelSave 95","t":101.36,"q":14.04,"u":"l"}]}
]}
```

- A ledger row with `"replaces":"<manual tx_id>"` hides that manual row (e.g. the receipt photo for cash you already entered by hand).
- Internal money movements and purchase+refund pairs are detected by the plugin; the files store plain facts.
- Missing NBP rates (EUR, USD, UAH) are fetched by the plugin and cached in its settings.
- If `ledger/` does not exist, the plugin reads the old single file `Фінанси/finance-data.json` (format v2, fields below).

`tools/split-to-ledger.mjs` converts a v2 file into the v3 folder once. `tools/build-from-sheet.mjs` builds a v2 file from the old Google Sheet.

### Transaction fields

```json
{
  "tx_id": "ex-1", "date": "2025-04-12", "amount": 42.5, "direction": "debit",
  "merchant": "Sklep Przykład", "category": "groceries", "payment": "card",
  "hasReceipt": true, "receiptUrl": "https://drive.google.com/file/d/<id>/view",
  "items": [{ "n": "Mleko 3,2%", "t": 4.2 }, { "n": "Chleb", "t": 6.5, "s": "bread" }]
}
```

Field notes:
- `amount` is always positive and in PLN.
- `direction` is `debit` (spend) or `credit` (income).
- `orig` keeps a foreign-currency original.
- `excluded: "transfer" | "manual"` keeps a row out of the totals (`internal` and `refund` are computed).
- Item fields:
  - `n` is the name and `t` the total;
  - `q` and `u` are the quantity and unit;
  - `c` is the item category, when it differs from the transaction's;
  - `s` is the subcategory (optional; otherwise derived from keywords).

Keep receipt photos **out** of the synced folder: link them with `receiptUrl` so mobile sync stays light.

## Extensions API

Other plugins can add a tab to the finance view and write plan lines into «План». The API is `app.plugins.plugins["mark-finance"].api` (version 1), and the workspace event `mark-finance:ready` announces it.

- `registerTab({ id, title, icon, order?, render(containerEl, ctx) => cleanup? })` adds a tab next to the built-in ones.
  - `ctx` is `{ month, currency, formatMoney(n), onMonthChange(cb) }`.
  - `render` runs once. Month changes arrive through `onMonthChange`.
- `unregisterTab(id)` removes the tab. Call it in your `onunload`.
- `setPlanEntries(sourceId, entries)` replaces that source's plan lines.
  - Each entry is `{ id, month: "YYYY-MM", kind: "income" | "expense", title, amount, currency: "PLN", status: "planned" | "confirmed", meta? }`.
  - Lines are stored in `Фінанси/plan-external/<sourceId>.json` and shown in «План» with the source label. They stay visible when the extension is disabled.
- `getPlanEntries(sourceId)` returns the stored lines.

Full contract, lifecycle and an example: [EXTENSIONS.md](EXTENSIONS.md).

## Build and install

```bash
npm install
npm run build
VAULT_PLUGIN_DIR="<vault>/.obsidian/plugins/mark-finance" npm run install-vault
```

Or download `main.js`, `manifest.json`, `styles.css` from the latest release into `<vault>/.obsidian/plugins/mark-finance/` and enable **Фінанси Марка** in Community plugins. Open it with the wallet icon in the ribbon or the command **Відкрити фінанси**.

## License

MIT
