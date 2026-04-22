/**
 * DOM walker: turns a rendered HTML document into a CaptureResult tree.
 *
 * Runs inside the plugin's UI iframe (a real browser context), so it has
 * access to `getComputedStyle` and `getBoundingClientRect`. Anything more
 * complex than basic element + text + image lives behind explicit rules
 * here; we deliberately avoid trying to "understand" arbitrary CSS.
 */

import type {
  AutoLayoutHint,
  BoxModel,
  CaptureResult,
  CapturedNode,
  ComponentSpec,
  NodeKind,
  Padding,
  RGBA,
  TextStyle,
  TriggerEvent,
  TriggerSpec,
  VariantSpec,
} from "./types";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "NOSCRIPT", "HEAD"]);
const TEXT_TAGS = new Set([
  "P", "SPAN", "A", "STRONG", "EM", "B", "I", "LABEL", "SMALL", "CODE",
  "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TD", "TH", "FIGCAPTION",
]);

export function captureDocument(doc: Document, rootSelector = "body"): CaptureResult {
  const root = doc.querySelector(rootSelector) as HTMLElement | null;
  if (!root) throw new Error(`HTMLoom: root element not found for selector "${rootSelector}"`);

  const viewport = {
    width: doc.documentElement.clientWidth,
    height: doc.documentElement.clientHeight,
  };

  const tree = walk(root, root, "0");
  if (!tree) throw new Error("HTMLoom: root element produced no captured node");

  return {
    rootName: doc.title || "HTMLoom Import",
    viewport,
    tree,
  };
}

function walk(el: HTMLElement, root: HTMLElement, path: string): CapturedNode | null {
  if (SKIP_TAGS.has(el.tagName)) return null;

  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return null;

  const rect = el.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();

  const box: BoxModel = {
    x: rect.left - rootRect.left,
    y: rect.top - rootRect.top,
    width: rect.width,
    height: rect.height,
  };

  // Reject zero-area, non-text containers — they rarely produce useful Figma nodes.
  const directText = directTextContent(el);
  if (box.width === 0 && box.height === 0 && !directText) return null;

  const componentName = el.getAttribute("data-figma-component");
  const kind = inferKind(el, directText);
  const layout = detectAutoLayout(el, style);

  const node: CapturedNode = {
    id: path,
    kind: componentName ? "FRAME" : kind,
    tag: el.tagName.toLowerCase(),
    label: componentName || pickLabel(el),
    box,
    padding: parsePadding(style),
    background: parseBackground(style),
    border: {
      width: parsePx(style.borderTopWidth),
      color: parseColor(style.borderTopColor),
      radius: {
        tl: parsePx(style.borderTopLeftRadius),
        tr: parsePx(style.borderTopRightRadius),
        br: parsePx(style.borderBottomRightRadius),
        bl: parsePx(style.borderBottomLeftRadius),
      },
    },
    opacity: parseFloat(style.opacity || "1"),
    layout,
    text: kind === "TEXT" && !componentName ? buildTextStyle(el, style, directText) : null,
    imageSrc: kind === "IMAGE" && !componentName ? resolveImageSrc(el) : null,
    children: [],
    component: componentName ? captureComponent(el, componentName, path) : null,
    triggers: parseTriggers(el),
  };

  // Components are driven by their variants; ignore raw children.
  if (kind === "FRAME" && !componentName) {
    let i = 0;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const captured = walk(child, root, `${path}.${i++}`);
      if (captured) node.children.push(captured);
    }
  }

  return node;
}

/**
 * Walks `data-figma-variant` children of a component element, capturing each
 * variant as its own root subtree. Forces variant elements visible during
 * capture so designers are free to hide inactive variants with `display:none`.
 */
function captureComponent(el: HTMLElement, name: string, path: string): ComponentSpec {
  const variants: VariantSpec[] = [];
  let i = 0;
  for (const child of Array.from(el.children) as HTMLElement[]) {
    const variantName = child.getAttribute("data-figma-variant");
    if (!variantName) continue;

    const restore = forceVisible(child);
    try {
      // Each variant is its own root so child boxes are local to it.
      const tree = walk(child, child, `${path}/c=${name}/v=${variantName}`);
      if (tree) variants.push({ name: variantName, tree });
    } finally {
      restore();
    }
    i++;
  }
  if (variants.length === 0) {
    throw new Error(
      `HTMLoom: component "${name}" has no children with data-figma-variant`,
    );
  }
  return { name, variants };
}

function forceVisible(el: HTMLElement): () => void {
  const prevDisplay = el.style.display;
  const prevVisibility = el.style.visibility;
  const prevOpacity = el.style.opacity;
  const computed = window.getComputedStyle(el);
  if (computed.display === "none") el.style.display = "block";
  if (computed.visibility === "hidden") el.style.visibility = "visible";
  if (computed.opacity === "0") el.style.opacity = "1";
  // Force a synchronous layout flush before the caller measures.
  void el.offsetHeight;
  return () => {
    el.style.display = prevDisplay;
    el.style.visibility = prevVisibility;
    el.style.opacity = prevOpacity;
  };
}

/* ---------- triggers ---------- */

const TRIGGER_ATTRS: Array<[string, TriggerEvent]> = [
  ["data-figma-on-click", "ON_CLICK"],
  ["data-figma-on-press", "ON_PRESS"],
  ["data-figma-on-hover", "MOUSE_ENTER"],
  ["data-figma-on-mouse-enter", "MOUSE_ENTER"],
  ["data-figma-on-mouse-leave", "MOUSE_LEAVE"],
];

function parseTriggers(el: HTMLElement): TriggerSpec[] {
  const out: TriggerSpec[] = [];
  for (const [attr, event] of TRIGGER_ATTRS) {
    const target = el.getAttribute(attr);
    if (target) out.push({ event, targetVariant: target });
  }
  return out;
}

/* ---------- helpers ---------- */

function inferKind(el: HTMLElement, directText: string): NodeKind {
  if (el.tagName === "IMG") return "IMAGE";
  if (el.tagName === "SVG" || el.tagName === "svg") return "IMAGE";
  if (TEXT_TAGS.has(el.tagName) && directText && el.children.length === 0) return "TEXT";
  if (el.children.length === 0 && directText) return "TEXT";
  return "FRAME";
}

function directTextContent(el: HTMLElement): string {
  let text = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent || "";
  }
  return text.trim();
}

function pickLabel(el: HTMLElement): string {
  const cls = el.className && typeof el.className === "string" ? el.className.split(/\s+/)[0] : "";
  return cls || el.id || el.tagName.toLowerCase();
}

function parsePx(v: string | null | undefined): number {
  if (!v) return 0;
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

function parsePadding(s: CSSStyleDeclaration): Padding {
  return {
    top: parsePx(s.paddingTop),
    right: parsePx(s.paddingRight),
    bottom: parsePx(s.paddingBottom),
    left: parsePx(s.paddingLeft),
  };
}

function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  const m = input.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
  if (parts.length < 3) return null;
  const [r, g, b, a = 1] = parts;
  if (a === 0) return null;
  return { r: r / 255, g: g / 255, b: b / 255, a };
}

function parseBackground(s: CSSStyleDeclaration): RGBA | null {
  // Only solid background-color for Phase 1; gradients land in Phase 2.
  return parseColor(s.backgroundColor);
}

function buildTextStyle(el: HTMLElement, s: CSSStyleDeclaration, directText: string): TextStyle {
  const lh = s.lineHeight === "normal" ? null : parsePx(s.lineHeight);
  const align = (s.textAlign || "left").toUpperCase();
  const mappedAlign = (["LEFT", "CENTER", "RIGHT", "JUSTIFY"].includes(align)
    ? align === "JUSTIFY" ? "JUSTIFIED" : align
    : "LEFT") as TextStyle["textAlign"];

  return {
    characters: directText || el.textContent?.trim() || "",
    fontFamily: (s.fontFamily || "Inter").split(",")[0].replace(/['"]/g, "").trim() || "Inter",
    fontWeight: Number(s.fontWeight) || 400,
    fontSize: parsePx(s.fontSize) || 14,
    lineHeight: lh,
    letterSpacing: parsePx(s.letterSpacing),
    color: parseColor(s.color) || { r: 0, g: 0, b: 0, a: 1 },
    textAlign: mappedAlign,
  };
}

function resolveImageSrc(el: HTMLElement): string | null {
  if (el instanceof HTMLImageElement) return el.currentSrc || el.src || null;
  if (el.tagName.toLowerCase() === "svg") {
    const serializer = new XMLSerializer();
    const xml = serializer.serializeToString(el);
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;
  }
  return null;
}

/**
 * Auto-layout heuristic. We trust:
 *   - display: flex with row/column         -> high confidence
 *   - display: grid with a single track     -> medium confidence
 * Everything else stays absolute (NONE) so the builder positions children
 * by their captured x/y.
 */
function detectAutoLayout(el: HTMLElement, s: CSSStyleDeclaration): AutoLayoutHint {
  const def: AutoLayoutHint = {
    mode: "NONE",
    primary: "MIN",
    cross: "MIN",
    itemSpacing: 0,
    confidence: 0,
  };

  if (s.display === "flex" || s.display === "inline-flex") {
    const dir = s.flexDirection || "row";
    const mode = dir.startsWith("column") ? "VERTICAL" : "HORIZONTAL";
    return {
      mode,
      primary: mapJustify(s.justifyContent),
      cross: mapAlign(s.alignItems),
      itemSpacing: parsePx(s.rowGap) || parsePx(s.columnGap) || parsePx(s.gap),
      confidence: 0.9,
    };
  }

  if (s.display === "grid") {
    const rows = (s.gridTemplateRows || "").split(" ").filter(Boolean).length;
    const cols = (s.gridTemplateColumns || "").split(" ").filter(Boolean).length;
    if (rows <= 1 || cols <= 1) {
      return {
        mode: rows > cols ? "VERTICAL" : "HORIZONTAL",
        primary: "MIN",
        cross: "MIN",
        itemSpacing: parsePx(s.rowGap) || parsePx(s.columnGap) || parsePx(s.gap),
        confidence: 0.65,
      };
    }
  }

  return def;
}

function mapJustify(v: string): AutoLayoutHint["primary"] {
  switch (v) {
    case "flex-end":
    case "end":
      return "MAX";
    case "center":
      return "CENTER";
    case "space-between":
    case "space-around":
    case "space-evenly":
      return "SPACE_BETWEEN";
    default:
      return "MIN";
  }
}

function mapAlign(v: string): AutoLayoutHint["cross"] {
  switch (v) {
    case "flex-end":
    case "end":
      return "MAX";
    case "center":
      return "CENTER";
    case "baseline":
      return "BASELINE";
    default:
      return "MIN";
  }
}
