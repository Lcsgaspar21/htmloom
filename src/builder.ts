/**
 * Builder: receives a CaptureResult from the UI thread and writes Figma
 * nodes for it. Designed to be deterministic and incremental — every node
 * goes through `createNodeFor` exactly once, so we can later add memoization
 * without restructuring the traversal.
 */

import type {
  AutoLayoutHint,
  CaptureResult,
  CapturedNode,
  RGBA,
  TextStyle,
} from "./types";

const FALLBACK_FONT: FontName = { family: "Inter", style: "Regular" };
const loadedFonts = new Set<string>();

export async function buildFromCapture(capture: CaptureResult): Promise<FrameNode> {
  await figma.loadFontAsync(FALLBACK_FONT);
  loadedFonts.add(fontKey(FALLBACK_FONT));

  await preloadFonts(capture.tree);

  const root = await createNodeFor(capture.tree, true);
  root.name = capture.rootName || "HTMLoom Import";

  // Drop the import next to the viewport so the user finds it immediately.
  const viewport = figma.viewport.center;
  root.x = Math.round(viewport.x - root.width / 2);
  root.y = Math.round(viewport.y - root.height / 2);

  figma.currentPage.appendChild(root);
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);
  return root as FrameNode;
}

async function preloadFonts(node: CapturedNode): Promise<void> {
  if (node.text) {
    const font = pickFont(node.text);
    const key = fontKey(font);
    if (!loadedFonts.has(key)) {
      try {
        await figma.loadFontAsync(font);
        loadedFonts.add(key);
      } catch {
        // Fall back silently — buildText will use FALLBACK_FONT.
      }
    }
  }
  for (const child of node.children) await preloadFonts(child);
}

async function createNodeFor(node: CapturedNode, isRoot = false): Promise<SceneNode> {
  switch (node.kind) {
    case "TEXT":
      return buildText(node);
    case "IMAGE":
      return await buildImage(node);
    case "RECT":
      return buildRect(node);
    case "FRAME":
    default:
      return await buildFrame(node, isRoot);
  }
}

async function buildFrame(node: CapturedNode, isRoot: boolean): Promise<FrameNode> {
  const frame = figma.createFrame();
  frame.name = node.label || node.tag;
  frame.resize(Math.max(1, node.box.width), Math.max(1, node.box.height));
  applyVisuals(frame, node);

  const useAutoLayout = node.layout.mode !== "NONE" && node.layout.confidence >= 0.6;
  if (useAutoLayout) {
    frame.layoutMode = node.layout.mode;
    frame.primaryAxisAlignItems = node.layout.primary;
    frame.counterAxisAlignItems = node.layout.cross === "BASELINE" ? "MIN" : node.layout.cross;
    frame.itemSpacing = node.layout.itemSpacing;
    frame.paddingTop = node.padding.top;
    frame.paddingRight = node.padding.right;
    frame.paddingBottom = node.padding.bottom;
    frame.paddingLeft = node.padding.left;
    frame.primaryAxisSizingMode = "FIXED";
    frame.counterAxisSizingMode = "FIXED";
  }

  for (const child of node.children) {
    const built = await createNodeFor(child);
    frame.appendChild(built);
    if (!useAutoLayout) {
      built.x = child.box.x;
      built.y = child.box.y;
    }
  }

  if (isRoot) {
    frame.x = 0;
    frame.y = 0;
  }
  return frame;
}

function buildText(node: CapturedNode): TextNode {
  const t = node.text!;
  const text = figma.createText();
  const font = pickFont(t);
  text.fontName = loadedFonts.has(fontKey(font)) ? font : FALLBACK_FONT;
  text.characters = t.characters;
  text.fontSize = t.fontSize;
  text.textAlignHorizontal = t.textAlign === "JUSTIFIED" ? "JUSTIFIED" : t.textAlign;
  if (t.lineHeight) text.lineHeight = { value: t.lineHeight, unit: "PIXELS" };
  if (t.letterSpacing) text.letterSpacing = { value: t.letterSpacing, unit: "PIXELS" };
  text.fills = [{ type: "SOLID", color: rgb(t.color), opacity: t.color.a }];
  text.name = node.label || "text";
  text.resize(Math.max(1, node.box.width), Math.max(1, node.box.height));
  return text;
}

async function buildImage(node: CapturedNode): Promise<SceneNode> {
  const rect = figma.createRectangle();
  rect.name = node.label || "image";
  rect.resize(Math.max(1, node.box.width), Math.max(1, node.box.height));
  applyCornerRadius(rect, node);

  if (node.imageSrc) {
    try {
      const bytes = await fetchImageBytes(node.imageSrc);
      const image = figma.createImage(bytes);
      rect.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: image.hash }];
      return rect;
    } catch {
      // Fall through to placeholder fill.
    }
  }
  rect.fills = [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }];
  return rect;
}

function buildRect(node: CapturedNode): RectangleNode {
  const rect = figma.createRectangle();
  rect.name = node.label || "rect";
  rect.resize(Math.max(1, node.box.width), Math.max(1, node.box.height));
  applyVisuals(rect, node);
  return rect;
}

/* ---------- shared visuals ---------- */

function applyVisuals(node: FrameNode | RectangleNode, source: CapturedNode): void {
  if (source.background) {
    (node as FrameNode).fills = [
      { type: "SOLID", color: rgb(source.background), opacity: source.background.a },
    ];
  } else {
    (node as FrameNode).fills = [];
  }

  if (source.border.width > 0 && source.border.color) {
    (node as FrameNode).strokes = [
      { type: "SOLID", color: rgb(source.border.color), opacity: source.border.color.a },
    ];
    (node as FrameNode).strokeWeight = source.border.width;
  }

  applyCornerRadius(node, source);
  node.opacity = source.opacity;
}

function applyCornerRadius(node: FrameNode | RectangleNode, source: CapturedNode): void {
  const r = source.border.radius;
  if (r.tl === r.tr && r.tr === r.br && r.br === r.bl) {
    node.cornerRadius = r.tl;
  } else {
    (node as RectangleNode).topLeftRadius = r.tl;
    (node as RectangleNode).topRightRadius = r.tr;
    (node as RectangleNode).bottomRightRadius = r.br;
    (node as RectangleNode).bottomLeftRadius = r.bl;
  }
}

function rgb(c: RGBA): RGB {
  return { r: c.r, g: c.g, b: c.b };
}

function pickFont(t: TextStyle): FontName {
  const style = weightToStyle(t.fontWeight);
  return { family: t.fontFamily, style };
}

function weightToStyle(w: number): string {
  if (w >= 800) return "Bold";
  if (w >= 700) return "Bold";
  if (w >= 600) return "Semi Bold";
  if (w >= 500) return "Medium";
  if (w <= 300) return "Light";
  return "Regular";
}

function fontKey(f: FontName): string {
  return `${f.family}::${f.style}`;
}

async function fetchImageBytes(src: string): Promise<Uint8Array> {
  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    const meta = src.slice(0, comma);
    const data = src.slice(comma + 1);
    if (meta.includes(";base64")) {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    const decoded = decodeURIComponent(data);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  }
  const res = await fetch(src);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
