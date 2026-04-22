/**
 * Shared types between the UI thread (DOM walker) and the main thread
 * (Figma node builder). Keep this surface small — every field travels
 * through `postMessage` and is part of the plugin's internal contract.
 */

export type LayoutMode = "NONE" | "HORIZONTAL" | "VERTICAL";
export type PrimaryAxisAlign = "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
export type CrossAxisAlign = "MIN" | "CENTER" | "MAX" | "BASELINE";
export type SizingMode = "FIXED" | "AUTO" | "FILL";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface BoxModel {
  /** Position relative to the parent's content box, in CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BorderStyle {
  width: number;
  color: RGBA | null;
  radius: { tl: number; tr: number; br: number; bl: number };
}

/**
 * Auto-layout hint computed from the DOM. The walker emits its best
 * guess plus a confidence score so the builder can fall back to
 * absolute positioning when the heuristic is uncertain.
 */
export interface AutoLayoutHint {
  mode: LayoutMode;
  primary: PrimaryAxisAlign;
  cross: CrossAxisAlign;
  itemSpacing: number;
  /** 0..1; below 0.6 we prefer absolute positioning. */
  confidence: number;
}

export type TextDecoration = "NONE" | "UNDERLINE" | "STRIKETHROUGH";

/**
 * One styled segment within a TextStyle. Per-character ranges are applied
 * to a single Figma TEXT node so `<p>The <strong>bold</strong> word</p>`
 * stays as one paragraph instead of being broken into siblings.
 */
export interface TextRun {
  start: number;
  end: number;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  color: RGBA;
  textDecoration: TextDecoration;
}

export interface TextStyle {
  characters: string;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  lineHeight: number | null;
  letterSpacing: number;
  color: RGBA;
  textAlign: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  textDecoration: TextDecoration;
  /**
   * When set with 2+ entries, the builder applies per-range styling and the
   * top-level font/colour fields act as a fallback for ranges that omit them.
   */
  runs: TextRun[] | null;
  /**
   * True when the source CSS declared `white-space: pre / pre-wrap / pre-line`.
   * The builder uses this to disable wrapping (WIDTH_AND_HEIGHT auto-resize)
   * so newlines render as Figma line breaks instead of being clipped.
   */
  preserveWhitespace: boolean;
}

export type NodeKind = "FRAME" | "TEXT" | "RECT" | "IMAGE";

export interface ColorStop {
  /** 0..1 along the gradient line. */
  position: number;
  color: RGBA;
}

/**
 * Gradient parsed from a CSS `background-image`. Linear and radial are
 * supported; radial uses closest-side / centered semantics regardless of
 * the source CSS shape and position keywords.
 */
export interface Gradient {
  type: "LINEAR" | "RADIAL";
  /** CSS angle convention: 0 = "to top", 90 = "to right". Ignored for RADIAL. */
  angleDeg: number;
  stops: ColorStop[];
}

/** Single CSS box-shadow layer. */
export interface Shadow {
  inset: boolean;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: RGBA;
}

/** Trigger events we map onto Figma's prototype Reaction triggers. */
export type TriggerEvent =
  | "ON_CLICK"
  | "ON_PRESS"
  | "MOUSE_ENTER"
  | "MOUSE_LEAVE";

/**
 * Animation easing for prototype reactions. Mirrors a subset of Figma's
 * easing types so authors can pick a curve via `data-figma-trigger-easing`
 * without remembering the all-caps API names.
 */
export type TriggerEasing =
  | "LINEAR"
  | "EASE_IN"
  | "EASE_OUT"
  | "EASE_IN_AND_OUT"
  | "GENTLE";

export interface TriggerSpec {
  event: TriggerEvent;
  /** Variant name (within the enclosing component) to switch to. */
  targetVariant: string;
  /**
   * Hover-trigger delay in milliseconds. Only used for MOUSE_ENTER /
   * MOUSE_LEAVE; click triggers ignore it. Defaults to 0.
   */
  delayMs: number;
  /**
   * Transition duration in milliseconds. When > 0 the builder emits a
   * SMART_ANIMATE transition between variants instead of an instant
   * variant switch. Defaults to 0 (instant).
   */
  durationMs: number;
  /** Easing curve for the transition. Ignored when `durationMs === 0`. */
  easing: TriggerEasing;
}

export interface VariantSpec {
  name: string;
  tree: CapturedNode;
}

export interface ComponentSpec {
  /** Becomes the Component Set's name in Figma. */
  name: string;
  variants: VariantSpec[];
}

export interface CapturedNode {
  /** Stable id derived from the DOM path, used for prototype targets later. */
  id: string;
  kind: NodeKind;
  /** Original tag name, kept for debugging and naming Figma layers. */
  tag: string;
  /** First class name, used to label the Figma layer. */
  label: string;
  box: BoxModel;
  padding: Padding;
  background: RGBA | null;
  border: BorderStyle;
  opacity: number;
  layout: AutoLayoutHint;
  text: TextStyle | null;
  /** Resolved absolute URL when kind === "IMAGE". */
  imageSrc: string | null;
  /**
   * Serialized SVG markup for inline `<svg>` elements. When present the
   * builder uses `figma.createNodeFromSvgAsync` to produce native editable
   * vectors instead of rasterising — keeps icons crisp at any zoom level
   * and lets users tweak paths/colours after import.
   */
  svgMarkup: string | null;
  /** Linear or radial gradient parsed from `background-image`. */
  gradient: Gradient | null;
  /** URL from `background-image: url(...)` on a non-img element; layers above gradient/solid. */
  backgroundImageUrl: string | null;
  /** Multi-layer CSS box-shadows mapped to Figma effects. */
  shadows: Shadow[];
  children: CapturedNode[];
  /**
   * Set when the source element carried `data-figma-component`. The builder
   * turns this node into a Figma Component Set instead of a regular Frame.
   * `children` is ignored for component nodes — variants drive the build.
   */
  component: ComponentSpec | null;
  /** Triggers declared via `data-figma-on-*` attributes. */
  triggers: TriggerSpec[];
  /** Explicit `data-figma-token-*` overrides; `null` fields fall back to the auto-binder. */
  tokenBindings: TokenBindings;
  /**
   * Sizing intent (FIXED / HUG / FILL per axis) plus min/max, flex-grow,
   * wrap, and absolute-anchor data. The builder uses these to emit
   * Figma's modern `layoutSizingHorizontal/Vertical`, `layoutGrow`,
   * `layoutAlign`, `layoutWrap`, `min/maxWidth/Height`, and `constraints`
   * properties so the imported tree resizes the way the source CSS would.
   */
  sizing: SizingIntent;
}

export type TokenKind = "COLOR" | "NUMBER" | "STRING" | "SKIP";

/**
 * One CSS custom property (`--brand: #6e56cf`) discovered on `:root`. The
 * builder turns each typed token into a matching Figma Variable inside the
 * `HTMLoom Tokens` collection. Colour tokens auto-bind to fills with the
 * same RGBA; number / string tokens are created but not auto-bound.
 */
export interface DesignToken {
  /** Variable name in Figma (CSS `-` becomes `/` so `--color-brand-500` -> `color/brand/500`). */
  name: string;
  /** Original CSS property name, kept for debugging (e.g. `--brand`). */
  cssName: string;
  /** Raw resolved value as returned by `getComputedStyle`. */
  value: string;
  /** Classification used by the builder to pick the Variable type. */
  kind: TokenKind;
  /** Set when kind === "COLOR". */
  resolvedColor: RGBA | null;
  /** Set when kind === "NUMBER" — px-equivalent value (rem/em normalised to a 16px base). */
  numericValue: number | null;
  /** Set when kind === "STRING". */
  stringValue: string | null;
}

/**
 * Explicit `data-figma-token-*` overrides authored on an HTML element.
 * When set, the builder binds the matching paint to the named Variable
 * regardless of whether the colour value matches by RGBA.
 */
export interface TokenBindings {
  background: string | null;
  text: string | null;
  border: string | null;
}

/**
 * Per-axis sizing mode for the imported Figma node.
 *
 * - `FIXED` — keep the captured pixel size; never reflows.
 * - `HUG`   — wrap to children (Figma's "Hug contents"). For containers
 *             with auto-layout this becomes `primary/counterAxisSizingMode
 *             = AUTO`. For text it maps to `WIDTH_AND_HEIGHT` resize.
 * - `FILL`  — stretch to fill the parent's available axis (`layoutSizing*
 *             = "FILL"` plus `layoutGrow = 1` on the primary axis when
 *             relevant). Requires the parent to have auto-layout.
 */
export type AxisSizing = "FIXED" | "HUG" | "FILL";

/**
 * Constraints for an absolutely-positioned child relative to its
 * positioned ancestor. Each axis is a tuple `[start, end]` in CSS pixels;
 * `null` means the corresponding edge was not declared, which Figma maps
 * to a single-edge constraint (LEFT-only, RIGHT-only, etc.).
 *
 * `centerH` / `centerV` flag the common `left: 50%; transform:
 * translateX(-50%)` centering pattern so the builder can emit a CENTER
 * constraint instead of LEFT_RIGHT.
 */
export interface AbsoluteAnchors {
  top: number | null;
  right: number | null;
  bottom: number | null;
  left: number | null;
  centerH: boolean;
  centerV: boolean;
}

/**
 * Sizing intent extracted from CSS (or `data-figma-sizing-h/v` overrides).
 * Decoupled from `BoxModel` so the captured pixel rect remains the
 * fallback for `FIXED` axes while responsive intent drives auto-layout
 * sizing.
 */
export interface SizingIntent {
  widthMode: AxisSizing;
  heightMode: AxisSizing;
  /** CSS `min-width` in pixels when explicitly declared. */
  minWidth: number | null;
  maxWidth: number | null;
  minHeight: number | null;
  maxHeight: number | null;
  /** CSS `flex-grow`. Maps to Figma's `layoutGrow` on the primary axis. */
  flexGrow: number;
  /** True when the source CSS sets `flex-wrap: wrap` (or `wrap-reverse`). */
  flexWrap: boolean;
  /**
   * `align-self: stretch` makes the child fill the cross axis of its
   * auto-layout parent. Captured separately because it overrides the
   * parent's `align-items`.
   */
  alignSelfStretch: boolean;
  /**
   * Set when `position: absolute | fixed` — the builder uses these edges
   * to pick Figma constraints. `null` keeps the default LEFT/TOP.
   */
  absoluteAnchors: AbsoluteAnchors | null;
}

export interface CaptureResult {
  rootName: string;
  viewport: { width: number; height: number };
  tree: CapturedNode;
  /** CSS custom properties found on `:root`; empty when the page declares none. */
  tokens: DesignToken[];
}

/** Messages flowing UI -> main. */
export type UiToMain =
  | { type: "ready" }
  | { type: "import"; payload: CaptureResult }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "cancel" };

/** Messages flowing main -> UI. */
export type MainToUi =
  | { type: "init" }
  | { type: "import-complete"; nodeId: string }
  | { type: "import-error"; message: string };
