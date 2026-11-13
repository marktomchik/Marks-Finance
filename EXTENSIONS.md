# Extensions API (mark-finance ≥ 1.3.0, API version 1)

Other Obsidian plugins can do two things in «Фінанси Марка»:
- add a tab to the finance view;
- write plan lines into «План».

The first user is `mark-workdays` («Робочі дні»).

## Getting the API

```ts
const api = (this.app as any).plugins.plugins["mark-finance"]?.api; // undefined until mark-finance has loaded
```

When the API is ready, mark-finance fires a workspace event. It fires each time mark-finance loads, including after the user disables and re-enables it or updates it. So listen with `registerEvent` for as long as your plugin runs, not just once:

```ts
onload() {
  const attach = (api: MarkFinanceApi) => {
    if (api?.version !== 1) return;
    api.registerTab({ ... });
  };
  this.registerEvent((this.app.workspace as any).on("mark-finance:ready", attach));
  this.app.workspace.onLayoutReady(() => {
    const api = (this.app as any).plugins.plugins["mark-finance"]?.api;
    if (api) attach(api); // mark-finance was already loaded
  });
}
onunload() {
  (this.app as any).plugins.plugins["mark-finance"]?.api?.unregisterTab("mark-workdays");
}
```

Calling `registerTab` twice with the same id replaces the tab, so attaching twice is harmless.

The event fires after mark-finance has read the saved plan lines from the vault. From then on, `getPlanEntries` returns what is stored.

## `api.version`

The number `1`. Breaking changes will bump it.

## `api.registerTab(tab)`

```ts
interface ExtensionTab {
  id: string;            // /^[a-z0-9][a-z0-9._-]{0,63}$/i, e.g. "mark-workdays"
  title: string;         // tab label, e.g. "Робочі дні"
  icon: string;          // Lucide icon name (Obsidian setIcon), default "puzzle"
  order?: number;        // sort among extension tabs, default 100; they always come after the 6 built-in tabs
  render(containerEl: HTMLElement, ctx: TabContext): void | (() => void);
}
interface TabContext {
  readonly month: string;                                   // "YYYY-MM", always the current value (getter)
  currency: string;                                         // display currency: "PLN" | "EUR" | "USD" | "UAH"
  formatMoney(n: number): string;                           // n must already be in `currency`, e.g. "1 234,50 zł"
  onMonthChange(cb: (month: string) => void): () => void;   // returns an unsubscribe function
}
```

The tab button appears in the top tab row. On phones the tabs sit in rows of three at the top of the screen, never at the bottom.

**What happens when the tab is open:**
- `render` runs **once**, when the user opens the tab. The container lives inside the finance view's scroll area.
- Changing the month (arrows or swipe) does **not** call `render` again. The finance view keeps your DOM and calls the `onMonthChange` callbacks.
- In an extension tab, the period is always a single month, and it may go into the future (like «План»).

**When the tab is closed:**
- The returned cleanup function runs, and all `onMonthChange` callbacks are dropped. This happens when the user switches to another tab, when the view closes, or after `unregisterTab`.
- The next time the user opens the tab, `render` runs again with a fresh container.

**If `render` throws,** the tab shows an error message instead.

## `api.unregisterTab(id)`

Removes the tab. If it is open, cleanup runs and the view switches to «Огляд». Call it in `onunload`.

## `api.setPlanEntries(sourceId, entries): Promise<void>`

```ts
interface ExternalPlanEntry {
  id: string;
  month: string;                 // "YYYY-MM" (required, otherwise the entry is dropped)
  kind: "income" | "expense";    // anything else → "income"
  title: string;
  amount: number;                // must be finite; stored as its absolute value
  currency: string;              // "PLN" expected; another code (EUR, USD, UAH) is converted to PLN
                                 // with the NBP rate in the data file for the 15th of that month
  status: "planned" | "confirmed"; // anything else → "planned"
  meta?: Record<string, unknown>;  // stored as is, not shown
}
```

- **Replaces** all entries of `sourceId`, which follows the same pattern as tab ids. Pass `[]` to clear.
- Writes the vault file `Фінанси/plan-external/<sourceId>.json`. The folder can be changed in data.json as `externalPlanDir`. The file has the form `{ "sourceId", "updatedAt", "entries": [...] }`.
- The file is a normal vault file, so it syncs to other devices. mark-finance re-reads the folder when any file in it changes.
- **Entries stay visible in «План» even when the extension is disabled or uninstalled.** Only the tab disappears.

**How the entries show in «План»** (the plan view is in PLN):
- They appear under «Доходи» or «Витрати» for their month.
- Each shows the source label (the tab title, or `sourceId` if the extension is not loaded) and «очікується» or «підтверджено».
- They count towards the plan totals.
- They are read-only there. Tapping one opens the extension's tab, or shows a hint if the extension is not loaded.

## `api.getPlanEntries(sourceId): ExternalPlanEntry[]`

Synchronous. Returns a copy of the stored entries for `sourceId`, or `[]`.

## Changes from the original spec

- `onMonthChange` returns an unsubscribe function. You can ignore it: everything is dropped on cleanup anyway.
- `ctx.month` is a live getter, so it always holds the current month.
- `setPlanEntries` returns a Promise. It validates and normalises entries and drops invalid ones without an error.
- The events fire on every load of mark-finance, so extensions must keep listening (see above).
