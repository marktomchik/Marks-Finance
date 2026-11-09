# Фінанси Марка (Obsidian plugin)

Offline personal finance dashboard for Obsidian (desktop and Android).
It reads one lightweight JSON file from the vault and shows:

- **Огляд**: spend / income / balance, monthly bar chart, card vs cash, categories (tap one to see its operations), latest operations.
- **Операції**: search, filter by category and direction, paginated list (light on mobile memory).
- **Звірка** (reconciliation): possible duplicates, cash receipts that look like card payments, receipts without a bank operation, big spends without a receipt, uncategorised items, gaps between months.

Every total is recomputed from the `transactions` array, so the period picker (all time, month, year, custom range) works offline.

## Data file

Default path: `Фінанси/finance-data.json` (configurable in settings). The plugin re-renders automatically when sync replaces the file.

Minimal format (see [`example/finance-data.example.json`](example/finance-data.example.json), all values invented):

```json
{
  "meta": { "generatedAt": "2025-05-01T10:00:00.000Z", "currency": "PLN" },
  "transactions": [
    {
      "tx_id": "ex-1", "date": "2025-04-12", "amount": 42.5, "direction": "debit",
      "merchant": "Sklep Przykład", "description": "…", "category": "groceries",
      "category_name": "Продукти", "payment": "card", "hasReceipt": true,
      "receiptUrl": null, "notes": "", "verified": false
    }
  ]
}
```

`amount` is always positive; `direction` is `debit` (spend) or `credit` (income). Extra top-level keys (`monthly`, `categories`, …) are ignored.

Keep receipt photos **out** of the synced folder: link them with `receiptUrl` instead, so mobile sync stays light.

## Build and install

```bash
npm install
npm run build
VAULT_PLUGIN_DIR="<vault>/.obsidian/plugins/mark-finance" npm run install-vault
```

Or download `main.js`, `manifest.json`, `styles.css` from the latest release into `<vault>/.obsidian/plugins/mark-finance/` and enable **Фінанси Марка** in Community plugins. Open it with the wallet icon in the ribbon or the command **Відкрити фінанси**.

## License

MIT
