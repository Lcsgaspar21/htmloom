/**
 * Plugin main thread. Hosts the UI iframe, listens for capture payloads,
 * and delegates Figma-side work to `buildFromCapture`.
 */

import { buildFromCapture } from "./builder";
import type { MainToUi, UiToMain } from "./types";

figma.showUI(__html__, { width: 460, height: 620, themeColors: true });

function send(message: MainToUi): void {
  figma.ui.postMessage(message);
}

send({ type: "init" });

figma.ui.onmessage = async (msg: UiToMain) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "ready":
      // UI signals it has rendered; nothing else to do for Phase 1.
      return;

    case "log":
      // Mirror UI logs into Figma's console for easier debugging.
      const tag = `[HTMLoom:${msg.level}]`;
      if (msg.level === "error") console.error(tag, msg.message);
      else if (msg.level === "warn") console.warn(tag, msg.message);
      else console.log(tag, msg.message);
      return;

    case "import":
      try {
        const root = await buildFromCapture(msg.payload);
        send({ type: "import-complete", nodeId: root.id });
        figma.notify(`HTMLoom: imported "${root.name}"`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: "import-error", message });
        figma.notify(`HTMLoom failed: ${message}`, { error: true });
      }
      return;

    case "cancel":
      figma.closePlugin();
      return;
  }
};
