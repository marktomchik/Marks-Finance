// Copies the built plugin into an Obsidian vault.
// Usage: VAULT_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/mark-finance" npm run install-vault
import fs from "fs";
import path from "path";
const target = process.env.VAULT_PLUGIN_DIR;
if (!target) {
  console.error("Set VAULT_PLUGIN_DIR to <your vault>/.obsidian/plugins/mark-finance");
  process.exit(1);
}
fs.mkdirSync(target, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  fs.copyFileSync(f, path.join(target, f));
  console.log("copied", f, "->", target);
}
