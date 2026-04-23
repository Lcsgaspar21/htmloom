/**
 * UI thread. Renders the picker, loads user-provided HTML into a sandboxed
 * iframe, runs the DOM walker against it, and sends the captured tree to
 * the plugin main thread.
 */

import { captureDocument } from "./walker";
import type { CaptureResult, ImportStats, MainToUi, UiToMain } from "./types";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const fileInput = $<HTMLInputElement>("#file");
const dropZone = $<HTMLDivElement>("#drop");
const pasteArea = $<HTMLTextAreaElement>("#paste");
const importBtn = $<HTMLButtonElement>("#import");
const statusEl = $<HTMLDivElement>("#status");
const sandbox = $<HTMLIFrameElement>("#sandbox");

let pendingHtml: string | null = null;

function send(msg: UiToMain): void {
  parent.postMessage({ pluginMessage: msg }, "*");
}

function setStatus(text: string, tone: "info" | "ok" | "error" = "info"): void {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function setHtml(html: string, source: string): void {
  pendingHtml = html;
  importBtn.disabled = false;
  setStatus(`Ready to weave: ${source}`, "ok");
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  setHtml(text, file.name);
});

["dragenter", "dragover"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("drop--hover");
  }),
);
["dragleave", "drop"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove("drop--hover");
  }),
);
dropZone.addEventListener("drop", async (e) => {
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (!file) return;
  const text = await file.text();
  setHtml(text, file.name);
});

pasteArea.addEventListener("input", () => {
  const v = pasteArea.value.trim();
  if (v.length > 50) setHtml(v, "pasted snippet");
  else {
    pendingHtml = null;
    importBtn.disabled = true;
    setStatus("Paste at least 50 chars of HTML.");
  }
});

importBtn.addEventListener("click", async () => {
  if (!pendingHtml) return;
  importBtn.disabled = true;
  setStatus("Rendering HTML in sandbox…");
  try {
    const capture = await renderAndCapture(pendingHtml);
    setStatus(`Captured ${countNodes(capture.tree)} nodes — sending to Figma…`);
    send({ type: "import", payload: capture });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`Capture failed: ${message}`, "error");
    send({ type: "log", level: "error", message });
    importBtn.disabled = false;
  }
});

async function renderAndCapture(html: string): Promise<CaptureResult> {
  return new Promise<CaptureResult>((resolve, reject) => {
    const onLoad = () => {
      sandbox.removeEventListener("load", onLoad);
      try {
        const doc = sandbox.contentDocument;
        if (!doc) throw new Error("Sandbox iframe has no document");
        // Wait one frame so layout settles before measuring, then run the
        // (now async) capture pipeline — SVG rasterisation lives there.
        requestAnimationFrame(() => {
          captureDocument(doc, "body").then(resolve, reject);
        });
      } catch (e) {
        reject(e);
      }
    };
    sandbox.addEventListener("load", onLoad);
    sandbox.srcdoc = html;
  });
}

function countNodes(node: { children: unknown[] }): number {
  let n = 1;
  for (const child of node.children as { children: unknown[] }[]) n += countNodes(child);
  return n;
}

/**
 * Builds the post-import status line. The base "Imported!" message is
 * extended with per-feature hints that point the author at the Figma
 * surface where their authored work lives — variants land in the
 * Component panel, reactions only fire in prototype mode, and tokens
 * are buried under a Variables collection. Without these hints users
 * routinely ask "where did my prototype go?".
 */
function buildImportSummary(stats: ImportStats): string {
  const parts: string[] = ["Imported! Check your Figma canvas."];
  if (stats.componentSetCount > 0 || stats.componentCount > 0) {
    const total = stats.componentSetCount + stats.componentCount;
    const label = total === 1 ? "component" : "components";
    parts.push(`${total} ${label} created.`);
  }
  if (stats.reactionCount > 0) {
    const r = stats.reactionCount;
    const noun = r === 1 ? "reaction" : "reactions";
    parts.push(`${r} ${noun} wired — switch to Prototype mode (top-right toolbar) and press ▶ to test.`);
  }
  if (stats.variableCount > 0) {
    const v = stats.variableCount;
    const noun = v === 1 ? "Variable" : "Variables";
    parts.push(`${v} ${noun} synced under "HTMLoom Tokens".`);
  }
  return parts.join(" ");
}

window.addEventListener("message", (event) => {
  const msg = event.data?.pluginMessage as MainToUi | undefined;
  if (!msg) return;
  switch (msg.type) {
    case "init":
      send({ type: "ready" });
      return;
    case "import-complete":
      setStatus(buildImportSummary(msg.stats), "ok");
      importBtn.disabled = false;
      return;
    case "import-error":
      setStatus(`Figma error: ${msg.message}`, "error");
      importBtn.disabled = false;
      return;
  }
});

setStatus("Drop an HTML file, paste HTML, or pick a file.");
