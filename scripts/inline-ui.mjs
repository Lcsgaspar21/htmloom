/**
 * Figma plugins ship a single ui.html file with all script/style inlined.
 * This script reads build/ui.js + src/ui.html and writes build/ui.html
 * with the JS embedded as a <script> block (no external src needed).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "src/ui.html"), "utf8");
const jsPath = resolve(root, "build/ui.js");

if (!existsSync(jsPath)) {
  console.error("[inline-ui] build/ui.js not found — run build:ui first.");
  process.exit(1);
}

const js = readFileSync(jsPath, "utf8");
const inlined = html.replace(
  /<script src="\.\/ui\.js"><\/script>/,
  `<script>${js}</script>`,
);

writeFileSync(resolve(root, "build/ui.html"), inlined, "utf8");
console.log(`[inline-ui] wrote build/ui.html (${inlined.length} bytes)`);
