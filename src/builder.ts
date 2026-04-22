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
  ComponentSpec,
  DesignToken,
  Gradient,
  RGBA,
  Shadow,
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
    frame.primaryAxisSizingMode = "FIXED";
    frame.counterAxisSizingMode = "FIXED";
  }

  for (const child of node.children) {
    const built = await createNodeFor(child, false, ctx);
    frame.appendChild(built);
    // Components and ComponentSets sit on top of an auto-layout parent with
    // absolute positioning so their natural size doesn't distort siblings.
    const isComponentLike = built.type === "COMPONENT" || built.type === "COMPONENT_SET";
    if (!useAutoLayout || isComponentLike) {
      if (useAutoLayout && isComponentLike && "layoutPositioning" in built) {
        (built as unknown as { layoutPositioning: "AUTO" | "ABSOLUTE" }).layoutPositioning = "ABSOLUTE";
      }
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
 * CSS spec: the gradient line passes through the box centre at the given
 * angle, and its length is `|w·sin(θ)| + |h·cos(θ)|` so the perpendiculars
 * from each corner land exactly on the line. We compute start/end in pixel
 * space, normalise to unit-bbox, and pack them into Figma's transform.
 *
 * Caveat: this snapshot uses the captured HTML element's dimensions. If the
 * user resizes the frame in Figma, the visual angle drifts because Figma
 * keeps the unit-bbox transform constant.
 */
function linearGradientTransform(angleDeg: number, width: number, height: number): Transform {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const length = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = w / 2;
  const cy = h / 2;
  const startPx = { x: cx - (length / 2) * dx, y: cy - (length / 2) * dy };
  const endPx = { x: cx + (length / 2) * dx, y: cy + (length / 2) * dy };
  const startX = startPx.x / w;
  const startY = startPx.y / h;
  const endX = endPx.x / w;
  const endY = endPx.y / h;
  const a = endX - startX;
  const b = endY - startY;
  return [
    [a, -b, startX],
    [b, a, startY],
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
