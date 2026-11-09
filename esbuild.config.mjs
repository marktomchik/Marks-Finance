import esbuild from "esbuild";
import builtins from "module";

const prod = process.argv[2] === "production";
const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins.builtinModules],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  outfile: "main.js",
  banner: { js: "/*! Mark Finance (c) 2026 Mark Lysak, MIT. */" },
});
if (prod) { await ctx.rebuild(); process.exit(0); } else { await ctx.watch(); }
