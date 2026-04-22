/**
 * DOM walker: turns a rendered HTML document into a CaptureResult tree.
 *
 * Runs inside the plugin's UI iframe (a real browser context), so it has
 * access to `getComputedStyle` and `getBoundingClientRect`. Anything more
 * complex than basic element + text + image lives behind explicit rules
 * here; we deliberately avoid trying to "understand" arbitrary CSS.
 */

import type {
  AbsoluteAnchors,
  AutoLayoutHint,
  AxisSizing,
  BoxModel,
  CaptureResult,
  CapturedNode,
  ColorStop,
  ComponentSpec,
  DesignToken,
  Gradient,
  NodeKind,
  Padding,
  RGBA,
  Shadow,
  SizingIntent,
  TextDecoration,
  TextRun,
  TextStyle,
  TokenBindings,
  TokenKind,
  TriggerEvent,
  TriggerSpec,
  VariantSpec,
} from "./types";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "NOSCRIPT", "HEAD"]);
const TEXT_TAGS = new Set([
  "P", "SPAN", "A", "STRONG", "EM", "B", "I", "LABEL", "SMALL", "CODE",
  "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TD", "TH", "FIGCAPTION",
]);
/** Inline-level tags that are valid as children of a rich-text container. */
const INLINE_TAGS = new Set([
  "SPAN", "STRONG", "EM", "B", "I", "A", "CODE", "SMALL", "U",
  "MARK", "INS", "DEL", "Q", "ABBR", "SUB", "SUP",
]);

export async function captureDocument(
  doc: Document,
  rootSelector = "body",
): Promise<CaptureResult> {
  const root = doc.querySelector(rootSelector) as HTMLElement | null;
  if (!root) throw new Error(`HTMLoom: root element not found for selector "${rootSelector}"`);

  const viewport = {
    width: doc.documentElement.clientWidth,
    height: doc.documentElement.clientHeight,
  };

  const tree = walk(root, root, "0");
  if (!tree) throw new Error("HTMLoom: root element produced no captured node");

  const tokens = captureTokens(doc);

  // Async post-pass: rasterise any SVG payloads we captured (inline `<svg>`
  // and `background-image: url(*.svg)`) into PNG data URIs so Figma's
  // `createImage` accepts them.
  await rasterizeSvgs(tree);

  return {
    rootName: doc.title || "HTMLoom Import",
    viewport,
    tree,
    tokens,
  };
}

/**
 * Walks `:root`'s computed style for CSS custom properties. The browser
 * already resolves `var(--a)` chains, so the values we surface here are the
 * final concrete strings (`#6e56cf`, `rgb(110, 86, 207)`, `12px`, ...).
 */
function captureTokens(doc: Document): DesignToken[] {
  const cs = window.getComputedStyle(doc.documentElement);
  const out: DesignToken[] = [];
  for (let i = 0; i < cs.length; i++) {
    const prop = cs.item(i);
    if (!prop || !prop.startsWith("--")) continue;
    const value = cs.getPropertyValue(prop).trim();
    if (!value) continue;
    const classified = classifyTokenValue(value);
    if (classified.kind === "SKIP") continue;
    out.push({
      name: tokenName(prop),
      cssName: prop,
      value,
      kind: classified.kind,
      resolvedColor: classified.kind === "COLOR" ? parseColor(value) : null,
      numericValue: classified.numericValue ?? null,
      stringValue: classified.stringValue ?? null,
    });
  }
  return out;
}

function tokenName(cssProp: string): string {
  // `--color-brand-500` -> `color/brand/500`. Custom slashes already in the
  // name (rare but legal in CSS via escaping) survive as-is.
  return cssProp.replace(/^--/, "").replace(/-/g, "/");
}

/**
 * Decides which Variable type a CSS custom property maps to. Numeric values
 * with px/rem/em units fold into NUMBER (rem/em assume a 16px base). Plain
 * identifier-like strings fold into STRING. Anything else is left aside —
 * the user can still see the value in `cssName` for debugging.
 */
function classifyTokenValue(value: string): {
  kind: TokenKind;
  numericValue?: number;
  stringValue?: string;
} {
  if (parseColor(value)) return { kind: "COLOR" };

  const numMatch = value.match(/^(-?\d+(?:\.\d+)?)\s*(px|rem|em)?$/);
  if (numMatch) {
    let n = parseFloat(numMatch[1]);
    const unit = numMatch[2];
    if (unit === "rem" || unit === "em") n *= 16;
    return { kind: "NUMBER", numericValue: n };
  }

  // Treat short identifier-ish strings as STRING tokens (font families,
  // keywords like `bold`, `inherit`, etc.). We deliberately skip anything
  // with parentheses, semicolons, or url(...) — those rarely round-trip.
  if (/^[\w\s.,'"#/-]{1,80}$/.test(value)) {
    return { kind: "STRING", stringValue: value.replace(/['"]/g, "").trim() };
  }

  return { kind: "SKIP" };
}

/* ---------- SVG rasterisation post-pass ---------- */

async function rasterizeSvgs(node: CapturedNode): Promise<void> {
  if (node.imageSrc && isSvgSource(node.imageSrc)) {
    const png = await tryRasterizeSvg(node.imageSrc, node.box.width, node.box.height);
    if (png) node.imageSrc = png;
  }
  if (node.backgroundImageUrl && isSvgSource(node.backgroundImageUrl)) {
    const png = await tryRasterizeSvg(
      node.backgroundImageUrl,
      node.box.width,
      node.box.height,
    );
    if (png) node.backgroundImageUrl = png;
  }
  if (node.component) {
    for (const variant of node.component.variants) await rasterizeSvgs(variant.tree);
  }
  for (const child of node.children) await rasterizeSvgs(child);
}

function isSvgSource(src: string): boolean {
  return src.startsWith("data:image/svg") || /\.svg(?:\?|#|$)/i.test(src);
}

async function tryRasterizeSvg(
  src: string,
  width: number,
  height: number,
): Promise<string | null> {
  try {
    return await rasterizeSvg(src, width, height);
  } catch (err) {
    // Surface to console so users can see why an icon ended up as a grey
    // placeholder instead of silently swallowing.
    console.warn(
      `[HTMLoom] SVG rasterisation failed (size=${width}×${height}, src=${src.slice(0, 80)}…):`,
      err,
    );
    return null;
  }
}

/**
 * Loads an SVG (data URI or remote URL) into an `<img>`, draws it onto a
 * 2x-scaled canvas, and exports a PNG data URI.
 *
 * For SVG data URIs we re-wrap the markup as a `Blob` and load via
 * `URL.createObjectURL`. Some browsers (and most plugin sandboxes) refuse
 * to render `<img src="data:image/svg+xml;...">` for security reasons,
 * even though the data is same-origin — the Blob URL bypasses the heuristic.
 *
 * Remote URLs require either same-origin or CORS-friendly headers; when
 * CORS taints the canvas, `toDataURL` throws and we fall back to the
 * original (broken) source.
 */
async function rasterizeSvg(src: string, width: number, height: number): Promise<string> {
  const targetW = Math.max(1, Math.round(width || 32));
  const targetH = Math.max(1, Math.round(height || 32));

  let loadSrc = src;
  let revoke: (() => void) | null = null;
  if (src.startsWith("data:image/svg")) {
    const svgText = decodeSvgDataUri(src);
    const blob = new Blob([svgText], { type: "image/svg+xml" });
    loadSrc = URL.createObjectURL(blob);
    revoke = () => URL.revokeObjectURL(loadSrc);
  }

  try {
    const img = new Image();
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (e) =>
        reject(
          new Error(
            `image load failed (${typeof e === "string" ? e : "onerror"}): ${src.slice(0, 80)}…`,
          ),
        );
      img.src = loadSrc;
    });
    // 2x scale so SVG icons stay sharp at the captured layer's native size.
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = targetW * scale;
    canvas.height = targetH * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    if (revoke) revoke();
  }
}

function decodeSvgDataUri(src: string): string {
  const comma = src.indexOf(",");
  const meta = src.slice(0, comma);
  const data = src.slice(comma + 1);
  if (meta.includes(";base64")) return atob(data);
  return decodeURIComponent(data);
}

function walk(el: HTMLElement, root: HTMLElement, path: string): CapturedNode | null {
  if (SKIP_TAGS.has(el.tagName)) return null;

  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return null;

  // The recursion passes the immediate parent in `root` (the parameter is
  // misnamed for historical reasons — see Phase 2 hotfix). Treat the
  // topmost call (where `el === root`) as having no parent so sizing
  // inference doesn't mis-classify the document body.
  const parent = el === root ? null : root;
  const parentStyle = parent ? window.getComputedStyle(parent) : null;

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
  const padding = parsePadding(style);
  const background = parseBackground(style);
  const gradient = parseGradient(style.backgroundImage);
  // Skip URL parsing when a gradient was found — CSS allows both, but we
  // pick gradient as the dominant fill to keep paint stacks short.
  const backgroundImageUrl = gradient ? null : parseBackgroundImageUrl(style.backgroundImage);
  const shadows = parseShadows(style.boxShadow);
  const borderWidth = parsePx(style.borderTopWidth);
  const hasDecoration =
    background !== null ||
    gradient !== null ||
    backgroundImageUrl !== null ||
    shadows.length > 0 ||
    borderWidth > 0 ||
    padding.top + padding.right + padding.bottom + padding.left > 0;

  // Decide whether this element produces text content. For elements that
  // hold inline runs (e.g. `<p>The <strong>bold</strong> word</p>`), we
  // capture a single TextStyle with multiple TextRun ranges so Figma keeps
  // the paragraph as one TEXT node.
  const textSpec = !componentName ? extractTextSpec(el, style, directText) : null;

  const isDecoratedTextLeaf = textSpec !== null && hasDecoration;

  const rawKind = inferKind(el, directText);
  const kind: NodeKind = componentName
    ? "FRAME"
    : isDecoratedTextLeaf
      ? "FRAME"
      : textSpec
        ? "TEXT"
        : rawKind;
  const layout = decideLayout(el, style, isDecoratedTextLeaf);

  const node: CapturedNode = {
    id: path,
    kind,
    tag: el.tagName.toLowerCase(),
    label: componentName || pickLabel(el),
    box,
    padding,
    background,
    border: {
      width: borderWidth,
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
    text: kind === "TEXT" && !componentName ? textSpec : null,
    imageSrc: kind === "IMAGE" && !componentName ? resolveImageSrc(el) : null,
    svgMarkup: kind === "IMAGE" && !componentName ? serializeInlineSvg(el) : null,
    gradient,
    backgroundImageUrl,
    shadows,
    children: [],
    component: componentName ? captureComponent(el, componentName, path) : null,
    triggers: parseTriggers(el),
    tokenBindings: parseTokenBindings(el),
    sizing: extractSizingIntent(el, style, parent, parentStyle),
  };

  if (isDecoratedTextLeaf && !componentName) {
    node.children.push(synthesizeTextChild(textSpec!, path, node.tokenBindings.text));
  } else if (kind === "FRAME" && !componentName) {
    // Components are driven by their variants; ignore raw children.
    // Pass `el` as the new root so child boxes are PARENT-relative — passing
    // the original root would leave grandchildren in root coords, breaking
    // absolute positioning whenever a non-auto-layout frame contains another
    // non-auto-layout frame.
    let i = 0;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const captured = walk(child, el, `${path}.${i++}`);
      if (captured) node.children.push(captured);
    }
  }

  return node;
}

/**
 * For a decorated text leaf (e.g. `<span class="badge">High</span>`), emit
 * a TEXT child that lives inside the frame's padding. The text node itself
 * carries no decoration — that's all on the parent.
 */
function synthesizeTextChild(
  text: TextStyle,
  parentPath: string,
  inheritedTextToken: string | null,
): CapturedNode {
  return {
    id: `${parentPath}.t`,
    kind: "TEXT",
    tag: "_text",
    label: "text",
    // Box is computed by the parent's auto-layout; values here are just a hint.
    box: { x: 0, y: 0, width: 0, height: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    background: null,
    border: { width: 0, color: null, radius: { tl: 0, tr: 0, br: 0, bl: 0 } },
    opacity: 1,
    layout: { mode: "NONE", primary: "MIN", cross: "MIN", itemSpacing: 0, confidence: 0 },
    text,
    imageSrc: null,
    svgMarkup: null,
    gradient: null,
    backgroundImageUrl: null,
    shadows: [],
    children: [],
    component: null,
    triggers: [],
    // Decorated text leaves can carry `data-figma-token-text` on the parent;
    // forward it so the synthesised TEXT child can bind its fill.
    tokenBindings: { background: null, text: inheritedTextToken, border: null },
    // The synthesised text inherits HUG sizing — it's the inner span of a
    // badge / button and should fit its characters, never grow beyond them.
    sizing: defaultSizingIntent("HUG", "HUG"),
  };
}

/** Convenience constructor used for synthesised nodes (no DOM source). */
function defaultSizingIntent(widthMode: AxisSizing, heightMode: AxisSizing): SizingIntent {
  return {
    widthMode,
    heightMode,
    minWidth: null,
    maxWidth: null,
    minHeight: null,
    maxHeight: null,
    flexGrow: 0,
    flexWrap: false,
    alignSelfStretch: false,
    absoluteAnchors: null,
  };
}

/**
 * Layout decision. Decorated text leaves get a HORIZONTAL auto-layout that
 * respects `text-align`, so badges/buttons hug their text and centre it
 * naturally. Everything else goes through the regular heuristic.
 */
function decideLayout(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  isDecoratedTextLeaf: boolean,
): AutoLayoutHint {
  const detected = detectAutoLayout(el, style);
  if (!isDecoratedTextLeaf) return detected;
  if (detected.mode !== "NONE") return detected;
  const align = (style.textAlign || "left").toLowerCase();
  return {
    mode: "HORIZONTAL",
    primary: align === "center" ? "CENTER" : align === "right" ? "MAX" : "MIN",
    cross: "CENTER",
    itemSpacing: 0,
    confidence: 0.85,
  };
}

/**
 * Walks `data-figma-variant` children of a component element, capturing each
 * variant as its own root subtree. Forces variant elements visible during
 * capture so designers are free to hide inactive variants with `display:none`.
 */
function captureComponent(el: HTMLElement, name: string, path: string): ComponentSpec {
  const variants: VariantSpec[] = [];
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
  // Dedupe by event so `on-hover` + `on-mouse-enter` on the same element
  // don't produce two competing MOUSE_ENTER reactions. Last attribute wins.
  const byEvent = new Map<TriggerEvent, string>();
  for (const [attr, event] of TRIGGER_ATTRS) {
    const target = el.getAttribute(attr);
    if (target) byEvent.set(event, target);
  }
  return Array.from(byEvent, ([event, targetVariant]) => ({ event, targetVariant }));
}

/**
 * Reads `data-figma-token-bg`, `-text` and `-border` attributes. These let
 * authors override the auto-binder when the resolved RGBA isn't unique
 * (e.g. when both `--surface` and `--canvas` resolve to `#fff`) or when
 * they want the binding regardless of computed colour.
 *
 * Convenience aliases: `data-figma-token` and `-fill` map to background.
 */
function parseTokenBindings(el: HTMLElement): TokenBindings {
  const bg =
    el.getAttribute("data-figma-token-bg") ??
    el.getAttribute("data-figma-token-fill") ??
    el.getAttribute("data-figma-token");
  const text = el.getAttribute("data-figma-token-text");
  const border =
    el.getAttribute("data-figma-token-border") ??
    el.getAttribute("data-figma-token-stroke");
  return {
    background: bg || null,
    text: text || null,
    border: border || null,
  };
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
  const trimmed = input.trim();
  if (trimmed === "transparent") return null;

  const rgbMatch = trimmed.match(/rgba?\(([^)]+)\)/);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((p) => parseFloat(p.trim()));
    if (parts.length < 3) return null;
    const [r, g, b, a = 1] = parts;
    if (a === 0) return null;
    return { r: r / 255, g: g / 255, b: b / 255, a };
  }

  // Defensive hex fallback for cases where computed values keep #abc / #aabbcc.
  const hex = trimmed.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    const h = hex[1];
    const expand = (s: string) => parseInt(s.length === 1 ? s + s : s, 16) / 255;
    if (h.length === 3 || h.length === 4) {
      const a = h.length === 4 ? expand(h[3]) : 1;
      if (a === 0) return null;
      return { r: expand(h[0]), g: expand(h[1]), b: expand(h[2]), a };
    }
    if (h.length === 6 || h.length === 8) {
      const a = h.length === 8 ? expand(h.slice(6, 8)) : 1;
      if (a === 0) return null;
      return { r: expand(h.slice(0, 2)), g: expand(h.slice(2, 4)), b: expand(h.slice(4, 6)), a };
    }
  }

  return null;
}

function parseBackground(s: CSSStyleDeclaration): RGBA | null {
  // Solid `background-color` only — gradients are handled separately and stack on top.
  return parseColor(s.backgroundColor);
}

/**
 * Returns a TextStyle if the element produces text content, with `runs`
 * populated when child inline elements introduce styling changes. Returns
 * null for elements that aren't text-bearing leaves or rich-text containers.
 */
function extractTextSpec(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  directText: string,
): TextStyle | null {
  if (el.children.length === 0) {
    if (!directText) return null;
    const ws = style.whiteSpace;
    // For non-pre whitespace modes we MUST collapse — `directText` is the raw
    // DOM text including HTML source-level newlines / indentation, which the
    // browser would normally fold to single spaces. Without this, paragraphs
    // hand-formatted across multiple lines render with stray indentation in
    // Figma (Phase 5 hotfix bug).
    const characters = preservesWhitespace(ws)
      ? trimByPreMode(directText, ws)
      : collapseWhitespace(directText).trim();
    if (!characters) return null;
    return buildTextStyle(characters, style, [
      makeRun(0, characters.length, style, parseDecoration(style)),
    ]);
  }
  if (!isRichTextCandidate(el, style)) return null;
  const { characters, runs } = collectRichText(el, style);
  if (!characters) return null;
  return buildTextStyle(characters, style, runs);
}

function buildTextStyle(
  characters: string,
  s: CSSStyleDeclaration,
  runs: TextRun[],
): TextStyle {
  const lh = s.lineHeight === "normal" ? null : parsePx(s.lineHeight);
  const align = (s.textAlign || "left").toUpperCase();
  const mappedAlign = (["LEFT", "CENTER", "RIGHT", "JUSTIFY"].includes(align)
    ? align === "JUSTIFY" ? "JUSTIFIED" : align
    : "LEFT") as TextStyle["textAlign"];

  return {
    characters,
    fontFamily: pickFontFamily(s),
    fontWeight: Number(s.fontWeight) || 400,
    italic: isItalic(s),
    fontSize: parsePx(s.fontSize) || 14,
    lineHeight: lh,
    letterSpacing: parsePx(s.letterSpacing),
    color: parseColor(s.color) || { r: 0, g: 0, b: 0, a: 1 },
    textAlign: mappedAlign,
    textDecoration: parseDecoration(s),
    runs: runs.length > 1 ? runs : null,
    preserveWhitespace: preservesWhitespace(s.whiteSpace),
  };
}

/* ---------- rich text ---------- */

function isRichTextCandidate(el: HTMLElement, style: CSSStyleDeclaration): boolean {
  if (el.children.length === 0) return false;
  // Flex/grid parents render children as block-like items, not inline runs.
  // Treat them as regular containers even if their children are inline tags.
  const display = style.display;
  if (display !== "block" && display !== "inline" && display !== "inline-block") {
    return false;
  }
  return allDescendantsInline(el);
}

/**
 * True when every element descendant is an inline tag, displays inline, and
 * its own descendants pass the same test. Lets `<p>The <a><strong>bold
 * link</strong></a> here</p>` collapse into one TEXT with three runs.
 */
function allDescendantsInline(el: HTMLElement): boolean {
  for (const child of Array.from(el.children) as HTMLElement[]) {
    if (!INLINE_TAGS.has(child.tagName)) return false;
    const childDisplay = window.getComputedStyle(child).display;
    if (childDisplay !== "inline" && childDisplay !== "inline-block") return false;
    if (!allDescendantsInline(child)) return false;
  }
  return true;
}

interface RichTextItem {
  text: string;
  style: CSSStyleDeclaration;
  /**
   * Decoration accumulated from every ancestor in the inline chain. CSS
   * doesn't inherit `text-decoration-line` to a child's computed style, so
   * we propagate it manually — otherwise `<a><strong>x</strong></a>` would
   * lose the underline on the inner range.
   */
  decoration: TextDecoration;
}

function collectRichText(
  el: HTMLElement,
  parentStyle: CSSStyleDeclaration,
): { characters: string; runs: TextRun[] } {
  const items: RichTextItem[] = [];
  const preserveWhitespace = preservesWhitespace(parentStyle.whiteSpace);
  collectRichTextInto(el, parentStyle, parseDecoration(parentStyle), items, preserveWhitespace);

  // Trim leading whitespace of the first run and trailing of the last,
  // matching how CSS strips boundary whitespace inside text containers.
  // Skip when the container preserves whitespace (`pre`, `pre-wrap`, ...).
  if (!preserveWhitespace && items.length > 0) {
    items[0].text = items[0].text.replace(/^\s+/, "");
    items[items.length - 1].text = items[items.length - 1].text.replace(/\s+$/, "");
  }

  let characters = "";
  const runs: TextRun[] = [];
  for (const item of items) {
    if (!item.text) continue;
    const start = characters.length;
    characters += item.text;
    runs.push(makeRun(start, characters.length, item.style, item.decoration));
  }
  return { characters, runs };
}

/**
 * Walks an inline subtree and pushes one `RichTextItem` per text node, using
 * the deepest element's style for that range. Recursion lets
 * `<a><strong>bold link</strong></a>` contribute the strong style for the
 * inner text while still being detected as one inline run.
 */
function collectRichTextInto(
  el: HTMLElement,
  currentStyle: CSSStyleDeclaration,
  ambientDecoration: TextDecoration,
  items: RichTextItem[],
  preserveWhitespace: boolean,
): void {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent || "";
      const txt = preserveWhitespace ? raw : collapseWhitespace(raw);
      if (!txt) continue;
      items.push({ text: txt, style: currentStyle, decoration: ambientDecoration });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as HTMLElement;
    const childStyle = window.getComputedStyle(child);
    if (childStyle.display === "none") continue;
    const childDecoration = mergeDecoration(ambientDecoration, parseDecoration(childStyle));
    if (child.children.length === 0) {
      const raw = child.textContent || "";
      const txt = preserveWhitespace ? raw : collapseWhitespace(raw);
      if (!txt) continue;
      items.push({ text: txt, style: childStyle, decoration: childDecoration });
    } else {
      collectRichTextInto(child, childStyle, childDecoration, items, preserveWhitespace);
    }
  }
}

function makeRun(
  start: number,
  end: number,
  s: CSSStyleDeclaration,
  decoration: TextDecoration,
): TextRun {
  return {
    start,
    end,
    fontFamily: pickFontFamily(s),
    fontWeight: Number(s.fontWeight) || 400,
    italic: isItalic(s),
    fontSize: parsePx(s.fontSize) || 14,
    color: parseColor(s.color) || { r: 0, g: 0, b: 0, a: 1 },
    textDecoration: decoration,
  };
}

function collapseWhitespace(s: string): string {
  // CSS would collapse runs of whitespace to a single space and trim newlines
  // around block boundaries. For inline runs we keep internal single spaces.
  return s.replace(/\s+/g, " ");
}

function preservesWhitespace(whiteSpace: string | null | undefined): boolean {
  if (!whiteSpace) return false;
  return whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "pre-line";
}

/**
 * For `pre` / `pre-wrap` we keep all whitespace and newlines verbatim.
 * `pre-line` collapses runs of horizontal spaces but preserves newlines.
 */
function trimByPreMode(s: string, whiteSpace: string): string {
  if (whiteSpace === "pre-line") return s.replace(/[ \t]+/g, " ");
  return s;
}

/**
 * `text-decoration-line` is the only field we surface today. Any non-NONE
 * ancestor wins; child overrides are ignored when the ancestor already
 * decorates the run (matching how the underline visually paints over the
 * descendant glyphs in CSS).
 */
function mergeDecoration(ambient: TextDecoration, own: TextDecoration): TextDecoration {
  if (ambient !== "NONE") return ambient;
  return own;
}

function pickFontFamily(s: CSSStyleDeclaration): string {
  return (s.fontFamily || "Inter").split(",")[0].replace(/['"]/g, "").trim() || "Inter";
}

function isItalic(s: CSSStyleDeclaration): boolean {
  return s.fontStyle === "italic" || s.fontStyle === "oblique";
}

function parseDecoration(s: CSSStyleDeclaration): TextDecoration {
  const line = (s as unknown as { textDecorationLine?: string }).textDecorationLine
    || s.textDecoration
    || "";
  if (line.includes("underline")) return "UNDERLINE";
  if (line.includes("line-through")) return "STRIKETHROUGH";
  return "NONE";
}

/* ---------- gradients ---------- */

function parseGradient(backgroundImage: string | null | undefined): Gradient | null {
  if (!backgroundImage || backgroundImage === "none") return null;
  const extracted = extractFirstFunction(backgroundImage);
  if (!extracted) return null;
  if (extracted.name === "linear-gradient") return parseLinear(extracted.body);
  if (extracted.name === "radial-gradient") return parseRadial(extracted.body);
  return null;
}

/**
 * Reads the first `name(...)` from a CSS value with proper paren balancing,
 * so nested `rgba(...)` calls don't fool the regex used for stacked-image lists.
 */
function extractFirstFunction(s: string): { name: string; body: string } | null {
  const m = s.match(/^([a-zA-Z-]+)\(/);
  if (!m) return null;
  const name = m[1];
  const start = m[0].length;
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return { name, body: s.slice(start, i) };
    }
  }
  return null;
}

function parseLinear(body: string): Gradient | null {
  const parts = splitTopLevelCommas(body);
  if (parts.length < 2) return null;

  let angleDeg = 180;
  let stopsStart = 0;
  const first = parts[0].trim();
  const angleMatch = first.match(/^(-?\d*\.?\d+)deg$/);
  if (angleMatch) {
    angleDeg = parseFloat(angleMatch[1]);
    stopsStart = 1;
  } else if (/^to\s/i.test(first)) {
    angleDeg = parseDirection(first);
    stopsStart = 1;
  }

  const stops = collectStops(parts.slice(stopsStart));
  if (stops.length < 2) return null;
  return { type: "LINEAR", angleDeg, stops };
}

function parseRadial(body: string): Gradient | null {
  const parts = splitTopLevelCommas(body);
  if (parts.length < 2) return null;

  // CSS radial syntax allows an optional shape/size/position prefix before
  // the colour stops (e.g. `circle at top right`). We skip any leading
  // segment that doesn't start with a colour token. Shape and position are
  // not honoured — the builder always emits a centered closest-side ellipse.
  const stopParts: string[] = [];
  let leadingHandled = false;
  for (const part of parts) {
    if (!leadingHandled) {
      if (looksLikeColorStop(part.trim())) leadingHandled = true;
      else continue;
    }
    stopParts.push(part);
  }

  const stops = collectStops(stopParts.length > 0 ? stopParts : parts);
  if (stops.length < 2) return null;
  return { type: "RADIAL", angleDeg: 0, stops };
}

function looksLikeColorStop(s: string): boolean {
  return /^(rgba?\(|#|[a-zA-Z]+\s*[\d%.\s]*$)/.test(s);
}

function collectStops(parts: string[]): ColorStop[] {
  const stops: ColorStop[] = [];
  for (const part of parts) {
    const stop = parseColorStop(part.trim());
    if (stop) stops.push(stop);
  }
  fillMissingPositions(stops);
  return stops;
}

function parseBackgroundImageUrl(backgroundImage: string | null | undefined): string | null {
  if (!backgroundImage || backgroundImage === "none") return null;
  // Try each quoting style independently so URL contents can include the
  // characters that the other styles use as delimiters (e.g. a double-quoted
  // data URI may carry single quotes inside an inline SVG attribute).
  let m = backgroundImage.match(/url\(\s*"([^"]*)"\s*\)/);
  if (m) return m[1];
  m = backgroundImage.match(/url\(\s*'([^']*)'\s*\)/);
  if (m) return m[1];
  m = backgroundImage.match(/url\(\s*([^)]+?)\s*\)/);
  return m ? m[1] : null;
}

function parseDirection(dir: string): number {
  const map: Record<string, number> = {
    "to top": 0, "to top right": 45, "to right top": 45,
    "to right": 90, "to bottom right": 135, "to right bottom": 135,
    "to bottom": 180, "to bottom left": 225, "to left bottom": 225,
    "to left": 270, "to top left": 315, "to left top": 315,
  };
  return map[dir.trim().toLowerCase()] ?? 180;
}

function parseColorStop(s: string): ColorStop | null {
  const colorMatch = s.match(/^(rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/);
  if (!colorMatch) return null;
  const color = parseColor(colorMatch[0]);
  if (!color) return null;
  const remaining = s.slice(colorMatch[0].length).trim();
  let position = NaN;
  const posMatch = remaining.match(/(-?\d*\.?\d+)\s*%/);
  if (posMatch) position = parseFloat(posMatch[1]) / 100;
  return { position, color };
}

function fillMissingPositions(stops: ColorStop[]): void {
  if (stops.length === 0) return;
  if (isNaN(stops[0].position)) stops[0].position = 0;
  if (isNaN(stops[stops.length - 1].position)) stops[stops.length - 1].position = 1;
  let lastKnown = 0;
  for (let i = 1; i < stops.length - 1; i++) {
    if (!isNaN(stops[i].position)) {
      lastKnown = i;
      continue;
    }
    let nextKnown = stops.length - 1;
    for (let j = i + 1; j < stops.length; j++) {
      if (!isNaN(stops[j].position)) { nextKnown = j; break; }
    }
    const span = nextKnown - lastKnown;
    const step = (stops[nextKnown].position - stops[lastKnown].position) / span;
    stops[i].position = stops[lastKnown].position + step * (i - lastKnown);
  }
}

/* ---------- shadows ---------- */

function parseShadows(value: string | null | undefined): Shadow[] {
  if (!value || value === "none") return [];
  const layers = splitTopLevelCommas(value);
  const out: Shadow[] = [];
  for (const layer of layers) {
    const parsed = parseShadowLayer(layer);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseShadowLayer(s: string): Shadow | null {
  const inset = /\binset\b/i.test(s);
  const cleaned = s.replace(/\binset\b/i, "").trim();
  const colorMatch = cleaned.match(/(rgba?\([^)]+\)|#[0-9a-fA-F]{3,8})/);
  if (!colorMatch) return null;
  const color = parseColor(colorMatch[0]);
  if (!color) return null;
  const remaining = cleaned.replace(colorMatch[0], "").trim();
  const nums = (remaining.match(/-?\d*\.?\d+/g) || []).map((n) => parseFloat(n));
  if (nums.length < 2) return null;
  return {
    inset,
    offsetX: nums[0],
    offsetY: nums[1],
    blur: nums[2] ?? 0,
    spread: nums[3] ?? 0,
    color,
  };
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      if (buf.trim()) out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function resolveImageSrc(el: HTMLElement): string | null {
  if (el instanceof HTMLImageElement) return el.currentSrc || el.src || null;
  // Inline `<svg>` is handled separately via `serializeInlineSvg` so the
  // builder can produce native editable vectors instead of a raster fallback.
  return null;
}

/**
 * Serialise an inline `<svg>` to standalone XML markup, ready to feed into
 * `figma.createNodeFromSvgAsync` on the main thread. Performs three fixes
 * that the raw `XMLSerializer` output otherwise misses:
 *
 *  1. Snapshots the rendered `color` and substitutes `currentColor` paint
 *     references — once the SVG leaves the DOM, `currentColor` resolves to
 *     the UA default (black), washing out coloured icons.
 *  2. Adds the SVG namespace declaration if missing, since serialising from
 *     within an HTML document occasionally drops it and Figma rejects the
 *     payload.
 *  3. Backfills `width`/`height` from `viewBox` when authors rely on CSS
 *     sizing, so the imported vector frame has a sensible intrinsic size.
 */
function serializeInlineSvg(el: HTMLElement): string | null {
  if (el.tagName.toLowerCase() !== "svg") return null;
  const resolvedColor = window.getComputedStyle(el).color || "currentColor";
  const cloned = el.cloneNode(true) as SVGElement;

  if (!cloned.getAttribute("xmlns")) {
    cloned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  if (!cloned.getAttribute("width") || !cloned.getAttribute("height")) {
    const vb = cloned.getAttribute("viewBox");
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(parseFloat);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        cloned.setAttribute("width", String(parts[2]));
        cloned.setAttribute("height", String(parts[3]));
      }
    }
  }

  substituteCurrentColor(cloned, resolvedColor);
  return new XMLSerializer().serializeToString(cloned);
}

/**
 * Walks an SVG subtree and rewrites every `currentColor` reference (in the
 * common paint attributes) to the supplied concrete colour. Doesn't touch
 * inline `style="..."` declarations or stylesheet-driven colours — those
 * remain a known limitation.
 */
function substituteCurrentColor(el: Element, color: string): void {
  const PAINT_ATTRS = [
    "fill",
    "stroke",
    "color",
    "stop-color",
    "flood-color",
    "lighting-color",
  ];
  for (const attr of PAINT_ATTRS) {
    const value = el.getAttribute(attr);
    if (value && /^currentcolor$/i.test(value.trim())) {
      el.setAttribute(attr, color);
    }
  }
  // `style="fill: currentColor"` — handle the inline-style case too.
  const inline = el.getAttribute("style");
  if (inline && /currentcolor/i.test(inline)) {
    el.setAttribute("style", inline.replace(/currentcolor/gi, color));
  }
  for (const child of Array.from(el.children)) {
    substituteCurrentColor(child, color);
  }
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

/* ---------- Sizing intent (Phase 6) ---------- */

/**
 * Derives FIXED / HUG / FILL per axis plus min/max, flex-grow, wrap and
 * absolute anchors. Strategy: explicit `data-figma-sizing-h/v` overrides
 * always win; otherwise we combine the element's own display + position
 * + width/height intent with the parent's auto-layout context.
 *
 * Heuristic philosophy (hybrid + aggressive — see Phase 6 plan):
 *   - inline / inline-block      → HUG
 *   - position: absolute / fixed → FIXED (constraints handle anchoring)
 *   - flex child with grow > 0   → FILL on the parent's main axis
 *   - flex child + cross-axis stretch (explicit or default) and no
 *     declared cross size → FILL on the cross axis
 *   - block-level whose measured width matches the parent's content box
 *     within a 1px slack → FILL (default block fills its container)
 *   - block-level otherwise → HUG horizontally if content-sized, FIXED
 *     when an explicit width is detected
 *   - vertical default for blocks → HUG (CSS height: auto)
 *
 * The measured-fill-vs-parent check is what catches `width: 100%`,
 * `width: auto + display: block`, and `flex: 1 1 auto` without us having
 * to parse the original CSS source — the browser already resolved them.
 */
function extractSizingIntent(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  parent: HTMLElement | null,
  parentStyle: CSSStyleDeclaration | null,
): SizingIntent {
  const overrideH = parseSizingOverride(el.getAttribute("data-figma-sizing-h"));
  const overrideV = parseSizingOverride(el.getAttribute("data-figma-sizing-v"));

  const minWidth = parsePxOrNull(style.minWidth);
  const maxWidth = parsePxOrNull(style.maxWidth);
  const minHeight = parsePxOrNull(style.minHeight);
  const maxHeight = parsePxOrNull(style.maxHeight);

  const flexGrow = parseFloat(style.flexGrow || "0") || 0;
  const flexWrap = style.flexWrap === "wrap" || style.flexWrap === "wrap-reverse";
  const alignSelfStretch = style.alignSelf === "stretch";

  const position = style.position;
  const isAbsolute = position === "absolute" || position === "fixed";
  const absoluteAnchors = isAbsolute ? extractAbsoluteAnchors(el, style) : null;

  const widthMode = overrideH ?? inferAxisMode(el, style, parent, parentStyle, "horizontal");
  const heightMode = overrideV ?? inferAxisMode(el, style, parent, parentStyle, "vertical");

  return {
    widthMode,
    heightMode,
    minWidth,
    maxWidth,
    minHeight,
    maxHeight,
    flexGrow,
    flexWrap,
    alignSelfStretch,
    absoluteAnchors,
  };
}

function parseSizingOverride(value: string | null): AxisSizing | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "fill" || v === "fill_container") return "FILL";
  if (v === "hug" || v === "hug_contents") return "HUG";
  if (v === "fixed") return "FIXED";
  return null;
}

function parsePxOrNull(value: string): number | null {
  if (!value || value === "none" || value === "auto" || value === "normal") return null;
  const n = parseFloat(value);
  if (!isFinite(n) || n <= 0) return null;
  return n;
}

function inferAxisMode(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  parent: HTMLElement | null,
  parentStyle: CSSStyleDeclaration | null,
  axis: "horizontal" | "vertical",
): AxisSizing {
  const display = style.display;
  const position = style.position;

  // Absolute / fixed elements keep their captured size; constraints handle
  // anchoring. This is the only safe default — FILL would require knowing
  // both edges and a stretching parent.
  if (position === "absolute" || position === "fixed") return "FIXED";

  // Inline-level elements size to content on both axes.
  if (
    display === "inline" ||
    display === "inline-block" ||
    display === "inline-flex" ||
    display === "inline-grid" ||
    display === "contents"
  ) {
    return "HUG";
  }

  // SVG / IMG without an explicit dimension on the requested axis → FIXED
  // (their intrinsic aspect-ratio is captured in the box and we don't want
  // HUG to distort them).
  if (el.tagName === "IMG" || el.tagName === "SVG" || el.tagName === "svg") {
    return "FIXED";
  }

  const parentLayoutIsFlex =
    parentStyle?.display === "flex" || parentStyle?.display === "inline-flex";
  const parentDir =
    parentLayoutIsFlex && parentStyle
      ? (parentStyle.flexDirection || "row").startsWith("column")
        ? "column"
        : "row"
      : null;
  // "Primary" axis is the parent flex direction; "cross" is its perpendicular.
  const isPrimary =
    parentDir &&
    ((axis === "horizontal" && parentDir === "row") ||
      (axis === "vertical" && parentDir === "column"));
  const isCross = parentDir && !isPrimary;

  // Primary axis with flex-grow > 0 → FILL. Most common responsive signal.
  const flexGrow = parseFloat(style.flexGrow || "0") || 0;
  if (parentLayoutIsFlex && isPrimary && flexGrow > 0) return "FILL";

  // Cross-axis stretch (explicit `align-self: stretch` OR parent's default
  // `align-items: stretch`) with no declared cross size → FILL.
  if (parentLayoutIsFlex && isCross) {
    const align = parentStyle!.alignItems || "stretch";
    const elAlign = style.alignSelf;
    const stretches =
      elAlign === "stretch" ||
      (elAlign === "auto" && (align === "stretch" || align === "normal"));
    if (stretches && !axisHasExplicitSize(style, axis)) return "FILL";
  }

  // Block / flex / grid containers: FILL when measured width matches the
  // parent's content area; HUG vertically by default (CSS `height: auto`).
  if (
    display === "block" ||
    display === "flex" ||
    display === "grid" ||
    display === "list-item" ||
    display === "flow-root" ||
    display === "table"
  ) {
    if (axis === "horizontal") {
      if (parent && parentStyle && fillsParentContentBox(el, parent, parentStyle, "width")) {
        return "FILL";
      }
      return axisHasExplicitSize(style, "horizontal") ? "FIXED" : "HUG";
    }
    // Vertical: CSS height defaults to auto → HUG. FIXED only when an
    // explicit height was declared.
    return axisHasExplicitSize(style, "vertical") ? "FIXED" : "HUG";
  }

  return "FIXED";
}

/**
 * `getComputedStyle().width` always returns px, so we infer "explicit
 * width was declared" by checking the inline style first and then by
 * comparing computed width to the natural fit. Imperfect, but combined
 * with the fill-vs-parent check it covers the vast majority of authored
 * CSS without misclassification.
 */
function axisHasExplicitSize(style: CSSStyleDeclaration, axis: "horizontal" | "vertical"): boolean {
  if (axis === "horizontal") {
    if (style.maxWidth && style.maxWidth !== "none") return true;
    if (style.minWidth && style.minWidth !== "0px" && style.minWidth !== "auto") return true;
    // Width is "auto" on default block elements; any concrete px hints at
    // an authored width or `flex-basis`. We treat both as FIXED candidates.
    return style.width !== "auto" && style.width !== "" && !style.width.endsWith("%");
  }
  if (style.maxHeight && style.maxHeight !== "none") return true;
  if (style.minHeight && style.minHeight !== "0px" && style.minHeight !== "auto") return true;
  return style.height !== "auto" && style.height !== "" && !style.height.endsWith("%");
}

/**
 * True when the element's measured size on the given axis matches the
 * parent's content box (within 1px tolerance to absorb sub-pixel rounding).
 * This is the fingerprint of `width: 100%` / `width: auto + display:
 * block` / `align-self: stretch` etc., regardless of how it was authored.
 */
function fillsParentContentBox(
  el: HTMLElement,
  parent: HTMLElement,
  parentStyle: CSSStyleDeclaration,
  axis: "width" | "height",
): boolean {
  const parentRect = parent.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  if (axis === "width") {
    const contentW =
      parentRect.width -
      parsePx(parentStyle.paddingLeft) -
      parsePx(parentStyle.paddingRight) -
      parsePx(parentStyle.borderLeftWidth) -
      parsePx(parentStyle.borderRightWidth);
    return Math.abs(elRect.width - contentW) <= 1;
  }
  const contentH =
    parentRect.height -
    parsePx(parentStyle.paddingTop) -
    parsePx(parentStyle.paddingBottom) -
    parsePx(parentStyle.borderTopWidth) -
    parsePx(parentStyle.borderBottomWidth);
  return Math.abs(elRect.height - contentH) <= 1;
}

/**
 * Reads CSS positional offsets (`top` / `right` / `bottom` / `left`) for
 * an absolutely-positioned element. Also detects the "stay centred"
 * pattern `left: 50%; transform: translate(-50%, ...)` and surfaces it
 * via `centerH` / `centerV` so the builder can pick CENTER constraints
 * instead of LEFT_RIGHT (which would stretch the node).
 */
function extractAbsoluteAnchors(el: HTMLElement, style: CSSStyleDeclaration): AbsoluteAnchors {
  const top = parsePxOrNull(style.top);
  const right = parsePxOrNull(style.right);
  const bottom = parsePxOrNull(style.bottom);
  const left = parsePxOrNull(style.left);

  // `transform: translate(-50%, -50%)` (or single-axis variants) is the
  // canonical way to "centre on this percentage anchor" in CSS. We detect
  // it from the matrix Stylesheet exposes — `matrix(a, b, c, d, tx, ty)`
  // — by checking whether the negative tx / ty equals half the element's
  // measured size.
  const transform = style.transform;
  let centerH = false;
  let centerV = false;
  if (transform && transform !== "none") {
    const m = transform.match(/matrix\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
      if (parts.length === 6) {
        const tx = parts[4];
        const ty = parts[5];
        const rect = el.getBoundingClientRect();
        const halfW = rect.width / 2;
        const halfH = rect.height / 2;
        // Negative tx of ~half-width combined with a percentage anchor is
        // the centre-on-x pattern; same logic for vertical.
        if (left !== null && Math.abs(tx + halfW) <= 1 && tx < 0) centerH = true;
        if (top !== null && Math.abs(ty + halfH) <= 1 && ty < 0) centerV = true;
      }
    }
  }

  return { top, right, bottom, left, centerH, centerV };
}
