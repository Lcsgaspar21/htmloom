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
}

export type NodeKind = "FRAME" | "TEXT" | "RECT" | "IMAGE";

export interface ColorStop {
  /** 0..1 along the gradient line. */
  position: number;
  color: RGBA;
}

/**
 * Linear gradient parsed from a CSS `background-image: linear-gradient(...)`.
 * Radial gradients are detected but not yet emitted (Phase 4).
 */
export interface Gradient {
  type: "LINEAR";
  /** CSS angle convention: 0 = "to top", 90 = "to right". */
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

export interface TriggerSpec {
  event: TriggerEvent;
  /** Variant name (within the enclosing component) to switch to. */
  targetVariant: string;
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
  /** Linear gradient parsed from `background-image`; takes priority over `background`. */
  gradient: Gradient | null;
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
}

export interface CaptureResult {
  rootName: string;
  viewport: { width: number; height: number };
  tree: CapturedNode;
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
