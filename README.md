# Фінанси Марка (Obsidian plugin)

Offline personal finance dashboard for Obsidian (desktop and Android), with the same features as the author's Google Apps Script finance tracker.
Mobile-first: the month switcher and tabs are at the top, so nothing sits under Obsidian's mobile toolbar. Lists are paginated and line items load only when you open them, which keeps memory use low.

It reads one JSON file from the vault and shows six tabs:

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

**Currency:** PLN, EUR, USD or UAH (settings). Amounts are converted with NBP mid rates for each transaction date, which are stored in the data file; a fixed rate can be set instead. Transfers between own accounts and purchase+refund pairs are shown but never counted.

**Plan and notes** are saved to a second vault file (default `Фінанси/finance-local.json`), so they sync to other devices with the vault. The first time, they are seeded from the data file.

## Data file

Default path: `Фінанси/finance-data.json` (configurable). The plugin re-renders when sync replaces the file. See [`example/finance-data.example.json`](example/finance-data.example.json) (all values invented).

```json
{
  "meta": { "generatedAt": "2025-05-01T10:00:00.000Z", "currency": "PLN" },
  "fx": { "EUR": [["2025-04-01", 4.28]], "USD": [], "UAH": [] },
  "transactions": [
    {
      "tx_id": "ex-1", "date": "2025-04-12", "amount": 42.5, "direction": "debit",
      "merchant": "Sklep Przykład", "category": "groceries", "payment": "card",
      "hasReceipt": true, "receiptUrl": "https://drive.google.com/file/d/<id>/view",
      "items": [{ "n": "Mleko 3,2%", "t": 4.2 }, { "n": "Chleb", "t": 6.5, "s": "bread" }]
    }
  ],
  "plan": [{ "id": "p1", "kind": "expense", "name": "Продукти", "category": "groceries", "amount": 900, "month": "2025-05" }],
  "notes": [], "loans": [], "review": [], "categoryDefs": []
}
```

Field notes:
- `amount` is always positive and in PLN.
- `direction` is `debit` (spend) or `credit` (income).
- `orig` keeps a foreign-currency original.
- `excluded: "transfer" | "refund"` keeps a row out of the totals.
- Item fields:
  - `n` is the name and `t` the total;
  - `q` and `u` are the quantity and unit;
  - `c` is the item category, when it differs from the transaction's;
  - `s` is the subcategory (optional; otherwise derived from keywords).

Keep receipt photos **out** of the synced folder: link them with `receiptUrl` so mobile sync stays light.

`tools/build-from-sheet.mjs` builds this file from table dumps of a Google Sheet (Transactions, Receipts, ReceiptItems, Categories, Loans, Notes, Plan) and fetches NBP rates.

## Build and install

```bash
npm install
npm run build
VAULT_PLUGIN_DIR="<vault>/.obsidian/plugins/mark-finance" npm run install-vault
```

Or download `main.js`, `manifest.json`, `styles.css` from the latest release into `<vault>/.obsidian/plugins/mark-finance/` and enable **Фінанси Марка** in Community plugins. Open it with the wallet icon in the ribbon or the command **Відкрити фінанси**.

## License

MIT
