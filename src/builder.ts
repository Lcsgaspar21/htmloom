/**
 * Builder: receives a CaptureResult from the UI thread and writes Figma
 * nodes for it. Designed to be deterministic and incremental — every node
 * goes through `createNodeFor` exactly once, so we can later add memoization
 * without restructuring the traversal.
 */

import type {
  AutoLayoutHint,
  AxisSizing,
  CaptureResult,
  CapturedNode,
  ComponentSpec,
  DesignToken,
  Gradient,
  RGBA,
  Shadow,
  SizingIntent,
  TextRun,
  TextStyle,
  TriggerEvent,
  TriggerSpec,
} from "./types";

interface TokenIndex {
  /** RGBA key → Variable, used for the implicit auto-binder. */
  byColor: Map<string, Variable>;
  /** Variable name (e.g. `color/brand/500`) → Variable, used for explicit `data-figma-token-*` overrides. */
  byName: Map<string, Variable>;
}

const FALLBACK_FONT: FontName = { family: "Inter", style: "Regular" };
const TOKEN_COLLECTION_NAME = "HTMLoom Tokens";
const loadedFonts = new Set<string>();

interface BuildContext {
  /** Maps CapturedNode.id → the Figma SceneNode we materialised for it. */
  nodeIdMap: Map<string, SceneNode>;
  /**
   * For each CapturedNode that owns a component (the Component Set parent),
   * the variant components keyed by variant name — used to resolve trigger
   * targets in the post-pass.
   */
  variantSets: Map<string, Map<string, ComponentNode>>;
  /**
   * Token lookup tables built from the page's CSS custom properties:
   * - `byColor` powers the implicit auto-binder (matching RGBA → bound paint)
   * - `byName`  powers explicit `data-figma-token-*` overrides
   * Built once per import so subsequent fills reuse the same Variables.
   */
  tokens: TokenIndex;
}

export async function buildFromCapture(capture: CaptureResult): Promise<SceneNode> {
  await figma.loadFontAsync(FALLBACK_FONT);
  loadedFonts.add(fontKey(FALLBACK_FONT));

  await preloadFonts(capture.tree);

  const ctx: BuildContext = {
    nodeIdMap: new Map(),
    variantSets: new Map(),
    tokens: await buildTokenIndex(capture.tokens),
  };

  const root = await createNodeFor(capture.tree, true, ctx);
  root.name = capture.rootName || "HTMLoom Import";

  // Wire prototype reactions only after every variant component exists, so
  // trigger targets resolve in a single deterministic pass.
  await wireReactions(capture.tree, null, ctx);

  // Drop the import next to the viewport so the user finds it immediately.
  const viewport = figma.viewport.center;
  if ("x" in root && "y" in root && "width" in root && "height" in root) {
    root.x = Math.round(viewport.x - (root as FrameNode).width / 2);
    root.y = Math.round(viewport.y - (root as FrameNode).height / 2);
  }

  figma.currentPage.appendChild(root);
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);
  return root;
}

async function preloadFonts(node: CapturedNode): Promise<void> {
  if (node.text) {
    await loadFont({ family: node.text.fontFamily, style: weightStyle(node.text.fontWeight, node.text.italic) });
    if (node.text.runs) {
      for (const run of node.text.runs) {
        await loadFont({ family: run.fontFamily, style: weightStyle(run.fontWeight, run.italic) });
      }
    }
  }
  if (node.component) {
    for (const variant of node.component.variants) await preloadFonts(variant.tree);
  }
  for (const child of node.children) await preloadFonts(child);
}

async function loadFont(font: FontName): Promise<void> {
  const key = fontKey(font);
  if (loadedFonts.has(key)) return;
  try {
    await figma.loadFontAsync(font);
    loadedFonts.add(key);
  } catch {
    // Silently fall back — buildText resolves missing fonts to FALLBACK_FONT.
  }
}

async function createNodeFor(
  node: CapturedNode,
  isRoot: boolean,
  ctx: BuildContext,
): Promise<SceneNode> {
  if (node.component) {
    const set = await buildComponentSet(node, node.component, ctx);
    ctx.nodeIdMap.set(node.id, set);
    return set;
  }
  let scene: SceneNode;
  switch (node.kind) {
    case "TEXT":
      scene = buildText(node, ctx);
      break;
    case "IMAGE":
      scene = await buildImage(node);
      break;
    case "RECT":
      scene = await buildRect(node, ctx);
      break;
    case "FRAME":
    default:
      scene = await buildFrame(node, isRoot, ctx);
      break;
  }
  ctx.nodeIdMap.set(node.id, scene);
  return scene;
}

async function buildFrame(
  node: CapturedNode,
  isRoot: boolean,
  ctx: BuildContext,
): Promise<FrameNode> {
  const frame = figma.createFrame();
  frame.name = node.label || node.tag;
  frame.resize(Math.max(1, node.box.width), Math.max(1, node.box.height));
  await applyVisuals(frame, node, ctx);

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
    // Default to FIXED — the child loop and applyContainerOwnSizing below
    // promote axes to HUG / FILL based on the captured sizing intent.
    frame.primaryAxisSizingMode = "FIXED";
    frame.counterAxisSizingMode = "FIXED";
    // Wrap is only meaningful on horizontal flex containers.
    if (node.sizing.flexWrap && node.layout.mode === "HORIZONTAL") {
      try {
        (frame as unknown as { layoutWrap: "NO_WRAP" | "WRAP" }).layoutWrap = "WRAP";
      } catch {
        // Older Figma runtimes ignore layoutWrap — silently skip.
      }
    }
  }

  applyMinMax(frame, node.sizing);

  for (const child of node.children) {
    const built = await createNodeFor(child, false, ctx);
    frame.appendChild(built);
    // Components and ComponentSets sit on top of an auto-layout parent with
    // absolute positioning so their natural size doesn't distort siblings.
    const isComponentLike = built.type === "COMPONENT" || built.type === "COMPONENT_SET";
    const isAbsoluteAnchored = child.sizing.absoluteAnchors !== null;

    if (isComponentLike) {
      if (useAutoLayout && "layoutPositioning" in built) {
        (built as unknown as { layoutPositioning: "AUTO" | "ABSOLUTE" }).layoutPositioning = "ABSOLUTE";
      }
      built.x = child.box.x;
      built.y = child.box.y;
    } else if (useAutoLayout && isAbsoluteAnchored) {
      // CSS `position: absolute` inside an auto-layout container — opt out
      // of the layout flow so the child stays anchored to a corner /
      // centre regardless of sibling reflow.
      if ("layoutPositioning" in built) {
        (built as unknown as { layoutPositioning: "AUTO" | "ABSOLUTE" }).layoutPositioning = "ABSOLUTE";
      }
      built.x = child.box.x;
      built.y = child.box.y;
      applyConstraints(built, child);
      applyMinMax(built, child.sizing);
    } else if (useAutoLayout) {
      // Regular auto-layout flow child: apply modern responsive sizing.
      applyChildSizing(built, child);
      applyMinMax(built, child.sizing);
    } else {
      built.x = child.box.x;
      built.y = child.box.y;
      applyConstraints(built, child);
      applyMinMax(built, child.sizing);
    }
  }

  if (useAutoLayout) {
    // FILL on this container is handled by the PARENT's loop (it needs a
    // parent with auto-layout). HUG, however, is intrinsic to the AL
    // container itself — applied here so single-pass HUG works even when
    // the root is built standalone.
    applyContainerOwnHug(frame, node);
  }

  if (isRoot) {
    frame.x = 0;
    frame.y = 0;
  }
  return frame;
}

/* ---------- Phase 6 sizing helpers ---------- */

/**
 * Pushes a captured sizing intent onto a Figma node that is already
 * appended to an auto-layout parent. Order matters:
 *
 *   1. Horizontal layoutSizing  (FILL needs the parent to be auto-layout)
 *   2. Vertical layoutSizing
 *   3. layoutGrow on the primary axis when `flex-grow > 0`
 *   4. layoutAlign = STRETCH for `align-self: stretch`
 *
 * We guard each setter because Figma rejects HUG on rectangles / images
 * and the typings claim availability that the runtime doesn't always
 * honour.
 */
function applyChildSizing(built: SceneNode, child: CapturedNode): void {
  setLayoutSizing(built, "horizontal", child.sizing.widthMode);
  setLayoutSizing(built, "vertical", child.sizing.heightMode);

  if (child.sizing.flexGrow > 0 && "layoutGrow" in built) {
    try {
      (built as unknown as { layoutGrow: number }).layoutGrow = child.sizing.flexGrow;
    } catch {
      // ignore
    }
  }
  if (child.sizing.alignSelfStretch && "layoutAlign" in built) {
    try {
      (built as unknown as { layoutAlign: "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX" }).layoutAlign =
        "STRETCH";
    } catch {
      // ignore
    }
  }
}

/**
 * Per-axis layoutSizing setter with capability detection.
 *
 * - HUG is only valid on auto-layout frames and text nodes; for plain
 *   rectangles or vector frames we silently fall back to FIXED.
 * - FILL requires the parent to be auto-layout — callers must guarantee
 *   that before invoking. We don't double-check here to avoid a costly
 *   parent traversal on every child.
 */
function setLayoutSizing(
  node: SceneNode,
  axis: "horizontal" | "vertical",
  mode: AxisSizing,
): void {
  if (!("layoutSizingHorizontal" in node)) return;
  if (mode === "HUG") {
    const isText = node.type === "TEXT";
    const isAutoLayoutFrame =
      node.type === "FRAME" && (node as FrameNode).layoutMode !== "NONE";
    if (!isText && !isAutoLayoutFrame) return;
  }
  try {
    if (axis === "horizontal") {
      (node as unknown as { layoutSizingHorizontal: AxisSizing }).layoutSizingHorizontal = mode;
    } else {
      (node as unknown as { layoutSizingVertical: AxisSizing }).layoutSizingVertical = mode;
    }
  } catch (err) {
    console.warn(
      `[HTMLoom] layoutSizing${axis === "horizontal" ? "Horizontal" : "Vertical"} = ${mode} failed for "${node.name}":`,
      err,
    );
  }
}

/**
 * Promotes the container's own auto-layout axes from FIXED to HUG when
 * the captured CSS suggests content-driven sizing. Skipped for FILL —
 * that's the parent's responsibility because it needs the parent itself
 * to be auto-layout.
 */
function applyContainerOwnHug(frame: FrameNode, node: CapturedNode): void {
  if (node.sizing.widthMode === "HUG") {
    try {
      (frame as unknown as { layoutSizingHorizontal: AxisSizing }).layoutSizingHorizontal = "HUG";
    } catch {
      // ignore
    }
  }
  if (node.sizing.heightMode === "HUG") {
    try {
      (frame as unknown as { layoutSizingVertical: AxisSizing }).layoutSizingVertical = "HUG";
    } catch {
      // ignore
    }
  }
}

function applyMinMax(node: SceneNode, sizing: SizingIntent): void {
  const set = (key: "minWidth" | "maxWidth" | "minHeight" | "maxHeight", value: number | null) => {
    if (value === null) return;
    if (!(key in node)) return;
    try {
      (node as unknown as Record<string, number | null>)[key] = value;
    } catch {
      // Older runtimes lack min/max — silently skip.
    }
  };
  set("minWidth", sizing.minWidth);
  set("maxWidth", sizing.maxWidth);
  set("minHeight", sizing.minHeight);
  set("maxHeight", sizing.maxHeight);
}

/**
 * Maps captured `position: absolute` anchors to Figma's per-axis
 * constraints. The constraint says how the child's edges relate to the
 * parent's edges when the parent resizes:
 *
 *   - left only            → MIN (left edge tracks parent left)
 *   - right only           → MAX (right edge tracks parent right)
 *   - both left + right    → STRETCH (both edges tracked, child grows)
 *   - left:50% + transform → CENTER (centre tracks parent centre)
 *
 * We don't emit SCALE — proportional resize is rarely what the source
 * CSS intended.
 */
function applyConstraints(node: SceneNode, child: CapturedNode): void {
  const anchors = child.sizing.absoluteAnchors;
  if (!anchors) return;
  if (!("constraints" in node)) return;

  type ConstraintAxis = "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE";
  let horizontal: ConstraintAxis = "MIN";
  let vertical: ConstraintAxis = "MIN";

  if (anchors.centerH) horizontal = "CENTER";
  else if (anchors.left !== null && anchors.right !== null) horizontal = "STRETCH";
  else if (anchors.right !== null && anchors.left === null) horizontal = "MAX";

  if (anchors.centerV) vertical = "CENTER";
  else if (anchors.top !== null && anchors.bottom !== null) vertical = "STRETCH";
  else if (anchors.bottom !== null && anchors.top === null) vertical = "MAX";

  try {
    (node as unknown as { constraints: { horizontal: ConstraintAxis; vertical: ConstraintAxis } }).constraints = {
      horizontal,
      vertical,
    };
  } catch {
    // Frames in some runtimes reject constraint writes on absolute children;
    // fail-soft so the rest of the tree still imports.
  }
}

/**
 * Builds a Figma Component (or Component Set when there are 2+ variants) from
 * a CapturedNode flagged as a component. Each variant subtree becomes its own
 * Component, then `combineAsVariants` merges them. Variant names appear under
 * the "State" property in Figma.
 *
 * NOTE: we deliberately do NOT resize the resulting set — `combineAsVariants`
 * already sizes it to fit all variants plus the system padding, and overriding
 * that crops the variants.
 */
async function buildComponentSet(
  owner: CapturedNode,
  spec: ComponentSpec,
  ctx: BuildContext,
): Promise<SceneNode> {
  const variantMap = new Map<string, ComponentNode>();
  const components: ComponentNode[] = [];

  for (const variant of spec.variants) {
    const variantFrame = await buildFrame(variant.tree, true, ctx);
    figma.currentPage.appendChild(variantFrame);

    const component = figma.createComponentFromNode(variantFrame);
    components.push(component);
    variantMap.set(variant.name, component);

    // The captured root id of the variant now refers to the (now-replaced)
    // frame; remap it to the resulting Component so triggers on the variant
    // root resolve correctly.
    ctx.nodeIdMap.set(variant.tree.id, component);
  }

  ctx.variantSets.set(owner.id, variantMap);

  // Single-variant component: just a Component, no Set. Reactions still
  // register but have nowhere to navigate — wireReactions silently skips
  // missing targets, which is the correct behaviour here.
  if (components.length === 1) {
    components[0].name = spec.name;
    return components[0];
  }

  for (let i = 0; i < components.length; i++) {
    components[i].name = `State=${spec.variants[i].name}`;
  }
  const set = figma.combineAsVariants(components, figma.currentPage);
  set.name = spec.name;
  return set;
}

/* ---------- prototype reactions (post-pass) ---------- */

async function wireReactions(
  node: CapturedNode,
  ambientComponentId: string | null,
  ctx: BuildContext,
): Promise<void> {
  if (node.triggers.length > 0 && ambientComponentId) {
    await applyReactions(node, ambientComponentId, ctx);
  }

  if (node.component) {
    for (const variant of node.component.variants) {
      // Triggers inside a variant resolve against the owning component's variant set.
      await wireReactions(variant.tree, node.id, ctx);
    }
    return;
  }

  for (const child of node.children) {
    await wireReactions(child, ambientComponentId, ctx);
  }
}

async function applyReactions(
  node: CapturedNode,
  ambientComponentId: string,
  ctx: BuildContext,
): Promise<void> {
  const variantMap = ctx.variantSets.get(ambientComponentId);
  const sceneNode = ctx.nodeIdMap.get(node.id);
  if (!variantMap || !sceneNode) return;
  if (!("setReactionsAsync" in sceneNode)) return;

  const reactions: Reaction[] = [];
  for (const trigger of node.triggers) {
    const dest = variantMap.get(trigger.targetVariant);
    if (!dest) {
      console.warn(
        `[HTMLoom] Trigger target variant "${trigger.targetVariant}" not found; skipping.`,
      );
      continue;
    }
    reactions.push(buildReaction(trigger.event, dest.id));
  }
  if (reactions.length > 0) {
    await (sceneNode as SceneNode & {
      setReactionsAsync: (r: Reaction[]) => Promise<void>;
    }).setReactionsAsync(reactions);
  }
}

function buildReaction(event: TriggerEvent, destinationId: string): Reaction {
  return {
    trigger: buildTrigger(event),
    actions: [
      {
        type: "NODE",
        destinationId,
        navigation: "CHANGE_TO",
        transition: null,
        preserveScrollPosition: false,
      } as Action,
    ],
  } as Reaction;
}

/**
 * MOUSE_ENTER and MOUSE_LEAVE require a `delay` field per Figma's typings;
 * the other trigger types only need `type`. Without the delay, Figma either
 * throws or treats the reaction as malformed.
 */
function buildTrigger(event: TriggerEvent): Trigger {
  if (event === "MOUSE_ENTER" || event === "MOUSE_LEAVE") {
    return { type: event, delay: 0 } as Trigger;
  }
  return { type: event } as Trigger;
}

function buildText(node: CapturedNode, ctx: BuildContext): TextNode {
  const t = node.text!;
  const explicitTextToken = node.tokenBindings.text;
  const text = figma.createText();
  const baseFont = resolveFont(t.fontFamily, t.fontWeight, t.italic);
  text.fontName = baseFont;
  text.characters = t.characters;
  text.fontSize = t.fontSize;
  text.textAlignHorizontal = t.textAlign === "JUSTIFIED" ? "JUSTIFIED" : t.textAlign;
  if (t.lineHeight) text.lineHeight = { value: t.lineHeight, unit: "PIXELS" };
  if (t.letterSpacing) text.letterSpacing = { value: t.letterSpacing, unit: "PIXELS" };
  text.fills = [bindSolid(t.color, ctx, explicitTextToken)];
  if (t.textDecoration !== "NONE") text.textDecoration = t.textDecoration;
  text.name = node.label || "text";
  applyTextSizing(text, node, t);
  if (t.runs) applyTextRuns(text, t.runs, ctx, explicitTextToken);
  return text;
}

/**
 * Resolves the text node's auto-resize mode and dimensions:
 *
 * - `preserveWhitespace` (pre / pre-wrap / pre-line) → WIDTH_AND_HEIGHT so
 *   each `\n` becomes a Figma line break and runs of spaces aren't reflowed.
 * - Synthesized text children (`box.width === 0`) inside a decorated leaf →
 *   WIDTH_AND_HEIGHT so the parent auto-layout hugs the text.
 * - Anything else with a known captured width → HEIGHT, locking the column
 *   width so wrapping matches the source while letting the text grow taller
 *   when Figma's font metrics differ from the iframe (avoids the "PNG
 *   gets clipped on the second line" Phase 5 bug).
 */
function applyTextSizing(text: TextNode, node: CapturedNode, t: TextStyle): void {
  const width = node.box.width;
  const hasNewlines = t.characters.includes("\n");
  if (t.preserveWhitespace || width <= 0 || hasNewlines) {
    text.textAutoResize = "WIDTH_AND_HEIGHT";
    return;
  }
  text.textAutoResize = "HEIGHT";
  // With HEIGHT mode Figma overwrites the height to fit content; we still
  // need to set the width so the wrap point matches what was captured.
  text.resize(Math.max(1, width), Math.max(1, node.box.height));
}

function applyTextRuns(
  text: TextNode,
  runs: TextRun[],
  ctx: BuildContext,
  explicitTextToken: string | null,
): void {
  for (const run of runs) {
    if (run.start >= run.end) continue;
    const font = resolveFont(run.fontFamily, run.fontWeight, run.italic);
    try {
      text.setRangeFontName(run.start, run.end, font);
    } catch {
      // Font not loaded for this range — leave as the base font.
    }
    text.setRangeFontSize(run.start, run.end, run.fontSize);
    // The explicit token applies to every run — `data-figma-token-text` is a
    // node-level override, so per-run colours all bind to the same Variable.
    text.setRangeFills(run.start, run.end, [bindSolid(run.color, ctx, explicitTextToken)]);
    if (run.textDecoration !== "NONE") {
      text.setRangeTextDecoration(run.start, run.end, run.textDecoration);
    }
  }
}

/** Returns a loaded font for the given specs; falls back to FALLBACK_FONT. */
function resolveFont(family: string, weight: number, italic: boolean): FontName {
  const candidate: FontName = { family, style: weightStyle(weight, italic) };
  if (loadedFonts.has(fontKey(candidate))) return candidate;
  // Try without italic if italic variant is missing.
  if (italic) {
    const noItalic: FontName = { family, style: weightStyle(weight, false) };
    if (loadedFonts.has(fontKey(noItalic))) return noItalic;
  }
  return FALLBACK_FONT;
}

async function buildImage(node: CapturedNode): Promise<SceneNode> {
  // Inline SVGs become real Figma vector frames so they stay crisp at any
  // zoom and remain editable. We only fall back to the raster path for
  // <img> tags that point at PNG / JPEG / GIF resources.
  if (node.svgMarkup) {
    const vector = await buildSvgVector(node);
    if (vector) return vector;
  }

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
    } catch (err) {
      console.warn(
        `[HTMLoom] image creation failed for "${node.label || node.tag}" (src=${node.imageSrc.slice(0, 80)}…):`,
        err,
      );
    }
  }
  rect.fills = [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }];
  return rect;
}

/**
 * Builds a Figma vector frame from inline SVG markup. Prefers the async
 * variant when present (Figma added `createNodeFromSvgAsync` in plugin
 * runtime v1; the sync version is still supported and acts as a fallback
 * for older typings).
 *
 * `rescale` is used instead of `resize` so the inner vector children scale
 * with the frame; raw `resize` would only stretch the frame, leaving the
 * paths at their intrinsic size.
 */
async function buildSvgVector(node: CapturedNode): Promise<FrameNode | null> {
  if (!node.svgMarkup) return null;
  try {
    // Cast so we can pick the async API when the runtime exposes it. The
    // typings shipped with @figma/plugin-typings vary in version across
    // installs, so we feature-detect rather than relying on the type.
    const api = figma as unknown as {
      createNodeFromSvgAsync?: (svg: string) => Promise<FrameNode>;
      createNodeFromSvg: (svg: string) => FrameNode;
    };
    const frame = api.createNodeFromSvgAsync
      ? await api.createNodeFromSvgAsync(node.svgMarkup)
      : api.createNodeFromSvg(node.svgMarkup);
    frame.name = node.label || "svg";
    const targetW = Math.max(1, node.box.width);
    const targetH = Math.max(1, node.box.height);
    const currW = frame.width;
    const currH = frame.height;
    if (currW > 0 && currH > 0) {
      // Use the smaller axis ratio to preserve the SVG's aspect — avoids
      // squashing the icon when the captured box was rounded by the
      // browser to a non-square rectangle.
      const scale = Math.min(targetW / currW, targetH / currH);
      // Figma rejects rescale calls below 0.01 — fall back to a plain
      // resize for those (vector children stay at their natural size,
      // which is acceptable for sub-pixel icons).
      if (scale >= 0.01 && Math.abs(scale - 1) > 0.001) {
        frame.rescale(scale);
      } else if (scale < 0.01) {
        frame.resize(targetW, targetH);
      }
    }
    return frame;
  } catch (err) {
    console.warn(
      `[HTMLoom] createNodeFromSvgAsync failed for "${node.label || node.tag}":`,
      err,
    );
    return null;
  }
}

async function buildRect(node: CapturedNode, ctx: BuildContext): Promise<RectangleNode> {
  const rect = figma.createRectangle();
  rect.name = node.label || "rect";
  rect.resize(Math.max(1, node.box.width), Math.max(1, node.box.height));
  await applyVisuals(rect, node, ctx);
  return rect;
}

/* ---------- shared visuals ---------- */

async function applyVisuals(
  node: FrameNode | RectangleNode,
  source: CapturedNode,
  ctx: BuildContext,
): Promise<void> {
  const fills: Paint[] = [];
  if (source.background) {
    fills.push(bindSolid(source.background, ctx, source.tokenBindings.background));
  }
  if (source.gradient) {
    fills.push(buildGradientPaint(source.gradient, source.box.width, source.box.height));
  }
  if (source.backgroundImageUrl) {
    const imagePaint = await buildImagePaint(source.backgroundImageUrl);
    if (imagePaint) fills.push(imagePaint);
  }
  (node as FrameNode).fills = fills;

  if (source.border.width > 0 && source.border.color) {
    (node as FrameNode).strokes = [
      bindSolid(source.border.color, ctx, source.tokenBindings.border),
    ];
    (node as FrameNode).strokeWeight = source.border.width;
  }

  if (source.shadows.length > 0) {
    (node as FrameNode).effects = source.shadows.map(buildShadowEffect);
  }

  applyCornerRadius(node, source);
  node.opacity = source.opacity;
}

/* ---------- design token bridge ---------- */

/**
 * Walks the captured tokens, ensures the `HTMLoom Tokens` collection exists,
 * and creates one Variable per token. Colour tokens drop into the
 * RGBA-keyed `byColor` map so `bindSolid` can auto-bind matching fills.
 * Number / string tokens are created but not auto-bound — they're available
 * by name for explicit `data-figma-token-*` overrides only.
 */
async function buildTokenIndex(tokens: DesignToken[]): Promise<TokenIndex> {
  const empty: TokenIndex = { byColor: new Map(), byName: new Map() };
  const usable = tokens.filter((t) => t.kind !== "SKIP");
  if (usable.length === 0) return empty;

  const collection = await getOrCreateCollection(TOKEN_COLLECTION_NAME);
  const modeId = collection.defaultModeId || collection.modes[0].modeId;

  // Index existing variables across all relevant types to avoid duplicates
  // when the user re-imports or runs multiple HTMLoom imports per file.
  const existing = new Map<string, Variable>();
  for (const type of ["COLOR", "FLOAT", "STRING"] as const) {
    const list = await figma.variables.getLocalVariablesAsync(type);
    for (const v of list) {
      if (v.variableCollectionId === collection.id) existing.set(v.name, v);
    }
  }

  const out: TokenIndex = { byColor: new Map(), byName: new Map() };
  for (const token of usable) {
    const variable = upsertVariable(token, collection, modeId, existing);
    if (!variable) continue;
    out.byName.set(token.name, variable);
    if (token.kind === "COLOR" && token.resolvedColor) {
      const key = colorKey(token.resolvedColor);
      // First token to claim a colour wins — deterministic when multiple
      // tokens share the same value (e.g. semantic + primitive aliases).
      if (!out.byColor.has(key)) out.byColor.set(key, variable);
    }
  }
  return out;
}

function upsertVariable(
  token: DesignToken,
  collection: VariableCollection,
  modeId: string,
  existing: Map<string, Variable>,
): Variable | null {
  const figmaType: VariableResolvedDataType =
    token.kind === "COLOR" ? "COLOR" : token.kind === "NUMBER" ? "FLOAT" : "STRING";

  let variable = existing.get(token.name);
  if (variable && variable.resolvedType !== figmaType) {
    // A variable with this name already exists but with a different type.
    // Renaming or recreating it could break user bindings, so leave it alone
    // and skip — the user will see a console warning.
    console.warn(
      `[HTMLoom] Variable "${token.name}" already exists with type ${variable.resolvedType}; skipping ${figmaType} import.`,
    );
    return null;
  }
  if (!variable) {
    variable = figma.variables.createVariable(token.name, collection, figmaType);
  }

  if (token.kind === "COLOR" && token.resolvedColor) {
    variable.setValueForMode(modeId, {
      r: token.resolvedColor.r,
      g: token.resolvedColor.g,
      b: token.resolvedColor.b,
      a: token.resolvedColor.a,
    });
  } else if (token.kind === "NUMBER" && token.numericValue !== null) {
    variable.setValueForMode(modeId, token.numericValue);
  } else if (token.kind === "STRING" && token.stringValue !== null) {
    variable.setValueForMode(modeId, token.stringValue);
  }
  return variable;
}

async function getOrCreateCollection(name: string): Promise<VariableCollection> {
  const all = await figma.variables.getLocalVariableCollectionsAsync();
  const existing = all.find((c) => c.name === name);
  if (existing) return existing;
  return figma.variables.createVariableCollection(name);
}

/**
 * Returns a SolidPaint for the given colour. Resolution order:
 *  1. `explicitTokenName` (from `data-figma-token-*`) — bind if it exists
 *     and resolves to a COLOR variable, regardless of RGBA match.
 *  2. RGBA auto-bind via `tokens.byColor`.
 *  3. Plain literal SolidPaint.
 */
function bindSolid(
  color: RGBA,
  ctx: BuildContext,
  explicitTokenName: string | null = null,
): SolidPaint {
  const paint: SolidPaint = { type: "SOLID", color: rgb(color), opacity: color.a };
  if (explicitTokenName) {
    const explicit = ctx.tokens.byName.get(explicitTokenName);
    if (explicit && explicit.resolvedType === "COLOR") {
      return figma.variables.setBoundVariableForPaint(paint, "color", explicit);
    }
    if (!explicit) {
      console.warn(`[HTMLoom] Explicit token "${explicitTokenName}" not found in collection.`);
    }
  }
  const variable = ctx.tokens.byColor.get(colorKey(color));
  if (!variable) return paint;
  return figma.variables.setBoundVariableForPaint(paint, "color", variable);
}

function colorKey(c: RGBA): string {
  return `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a.toFixed(3)}`;
}

async function buildImagePaint(url: string): Promise<ImagePaint | null> {
  try {
    const bytes = await fetchImageBytes(url);
    const image = figma.createImage(bytes);
    return { type: "IMAGE", scaleMode: "FILL", imageHash: image.hash };
  } catch (err) {
    console.warn(`[HTMLoom] background-image fetch failed for ${url}:`, err);
    return null;
  }
}

function buildGradientPaint(g: Gradient, width: number, height: number): GradientPaint {
  const stops = g.stops.map((s) => ({
    position: clamp01(s.position),
    color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
  }));
  if (g.type === "RADIAL") {
    return {
      type: "GRADIENT_RADIAL",
      gradientTransform: radialGradientTransform(),
      gradientStops: stops,
    };
  }
  return {
    type: "GRADIENT_LINEAR",
    gradientTransform: linearGradientTransform(g.angleDeg, width, height),
    gradientStops: stops,
  };
}

/**
 * Builds the 2x3 affine matrix that maps Figma's gradient unit space onto
 * the fill's bounding box, while keeping the on-screen gradient angle
 * matching the CSS `linear-gradient(<deg>, ...)` regardless of the box's
 * aspect ratio.
 *
 * Strategy: work in PIXEL space (where angles are visually meaningful),
 * compute start/end and a perpendicular vector there, and only then
 * normalise to unit-bbox per axis. Doing the perpendicular computation
 * in unit space (e.g. swapping with [-b, a]) fails on non-square boxes
 * because the unit space is anisotropic — `width / height` distorts any
 * 90° rotation.
 *
 * CSS spec: the gradient line passes through the centre at the given
 * angle, and its length is `|w·sin(θ)| + |h·cos(θ)|` so the perpendiculars
 * from each corner land exactly on the line.
 *
 * Caveat: this snapshot uses the captured HTML element's dimensions. If
 * the user resizes the frame in Figma, the visual angle drifts because
 * Figma keeps the unit-bbox transform constant.
 */
function linearGradientTransform(angleDeg: number, width: number, height: number): Transform {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const length = Math.abs(w * dx) + Math.abs(h * dy);
  // Direction vector in PIXEL space, scaled to span the full gradient line.
  const dirPxX = length * dx;
  const dirPxY = length * dy;
  // Perpendicular in PIXEL space (90° rotation). Its magnitude is the
  // same as the gradient line's; that gives Figma a sane third handle
  // even though linear gradients ignore the perpendicular extent visually.
  const perpPxX = -dirPxY;
  const perpPxY = dirPxX;
  // Start point of the gradient line in pixel space, centred on the bbox.
  const startPxX = w / 2 - dirPxX / 2;
  const startPxY = h / 2 - dirPxY / 2;
  // Now collapse pixel space → unit-bbox by dividing each component by
  // its own axis. This is where aspect ratio is correctly accounted for.
  const startX = startPxX / w;
  const startY = startPxY / h;
  const a = dirPxX / w;
  const d = dirPxY / h;
  const b = perpPxX / w;
  const e = perpPxY / h;
  return [
    [a, b, startX],
    [d, e, startY],
  ];
}

/**
 * Closest-side ellipse centered on the fill bbox: gradient unit (0,0) is
 * the box centre, (1,0) is the right midpoint, (0,1) is the bottom midpoint.
 * CSS shape / size / position keywords are intentionally not honoured.
 */
function radialGradientTransform(): Transform {
  return [
    [0.5, 0, 0.5],
    [0, 0.5, 0.5],
  ];
}

function buildShadowEffect(s: Shadow): Effect {
  const base = {
    color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
    offset: { x: s.offsetX, y: s.offsetY },
    radius: Math.max(0, s.blur),
    spread: Math.max(0, s.spread),
    visible: true,
    blendMode: "NORMAL" as BlendMode,
  };
  if (s.inset) {
    return { type: "INNER_SHADOW", ...base } as InnerShadowEffect;
  }
  return { type: "DROP_SHADOW", ...base, showShadowBehindNode: false } as DropShadowEffect;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
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

function weightStyle(weight: number, italic: boolean): string {
  const base = weightBase(weight);
  if (!italic) return base;
  return base === "Regular" ? "Italic" : `${base} Italic`;
}

function weightBase(w: number): string {
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
    if (meta.includes(";base64")) return decodeBase64(data);
    const decoded = decodeURIComponent(data);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  }
  const res = await fetch(src);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Decodes a standard base64 string to bytes WITHOUT relying on `atob`.
 *
 * The Figma plugin main thread runs in a heavily restricted sandbox that
 * does NOT expose `atob` / `btoa`, even though the browser typings claim
 * they exist. Using them here throws `TypeError: 'not a function'` and
 * reaches users as the grey `buildImage` placeholder.
 *
 * Implementation: lookup-table-driven walk over 4-char chunks with
 * explicit padding handling. Whitespace and the URL-safe alphabet (`-_`)
 * are tolerated; invalid characters are skipped (matches `atob` lenience).
 */
const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = (() => {
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < BASE64_CHARS.length; i++) {
    lookup[BASE64_CHARS.charCodeAt(i)] = i;
  }
  // URL-safe alphabet aliases
  lookup["-".charCodeAt(0)] = 62;
  lookup["_".charCodeAt(0)] = 63;
  return lookup;
})();

function decodeBase64(input: string): Uint8Array {
  // Strip any whitespace / line breaks that PNG / data URI authors add.
  let clean = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    clean += input[i];
  }
  let pad = 0;
  if (clean.endsWith("==")) pad = 2;
  else if (clean.endsWith("=")) pad = 1;
  const len = clean.length;
  const byteLen = Math.floor((len * 3) / 4) - pad;
  const bytes = new Uint8Array(byteLen);
  let bIdx = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = BASE64_LOOKUP[clean.charCodeAt(i)];
    const c1 = BASE64_LOOKUP[clean.charCodeAt(i + 1)];
    const c2Char = clean.charCodeAt(i + 2);
    const c3Char = clean.charCodeAt(i + 3);
    const c2 = c2Char === 0x3d ? 0 : BASE64_LOOKUP[c2Char]; // '='
    const c3 = c3Char === 0x3d ? 0 : BASE64_LOOKUP[c3Char];
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) continue;
    bytes[bIdx++] = (c0 << 2) | (c1 >> 4);
    if (bIdx < byteLen) bytes[bIdx++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (bIdx < byteLen) bytes[bIdx++] = ((c2 & 0x03) << 6) | c3;
  }
  return bytes;
}
