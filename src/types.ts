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

export interface TextStyle {
  characters: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: number | null;
  letterSpacing: number;
  color: RGBA;
  textAlign: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
}

export type NodeKind = "FRAME" | "TEXT" | "RECT" | "IMAGE";

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
  children: CapturedNode[];
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
