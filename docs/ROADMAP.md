# HTMLoom roadmap

Tracks scope per phase. Each phase ends with a published version on Figma Community.

## Phase 1 — MVP (in progress)

- [x] Project scaffold (TypeScript + esbuild + manifest)
- [x] UI: drop / paste / file picker
- [x] DOM walker with computed styles, bounds, padding, borders, opacity
- [x] Auto-layout heuristic (flex high confidence, grid medium, fallback absolute)
- [x] Text node creation with font fallback to Inter
- [x] Image and inline SVG capture (data URI + external URL)
- [ ] First end-to-end test against `examples/alert-priority-wireframe.html`
- [ ] Manual QA on 3 hand-picked HTML pages (light/dark, simple/complex)

## Phase 2 — Interactive states ✓

- [x] Read `data-figma-component` / `data-figma-variant` markers from HTML
- [x] Force-visible inactive variants during capture (designers can use `display: none`)
- [x] Each variant captured as its own root subtree (local coordinates)
- [x] Emit a Figma Component Set with one Variant per state (`State=<name>`)
- [x] Build Reactions (`setReactionsAsync`) for declared transitions:
  - `data-figma-on-click="<variant>"`
  - `data-figma-on-press="<variant>"`
  - `data-figma-on-hover="<variant>"` (alias for MOUSE_ENTER)
  - `data-figma-on-mouse-enter="<variant>"`
  - `data-figma-on-mouse-leave="<variant>"`
- [x] `examples/popover-states.html` covering the click-to-expand pattern

### Known limits to revisit

- A trigger placed on the variant root re-resolves to the resulting Component
  node (handled), but reactions on a node that is itself replaced by Figma's
  variant machinery won't fire — keep triggers on inner elements.
- Only INSTANT transitions are emitted; easing presets land in Phase 3.
- A Component / Component Set inside an auto-layout parent is set to
  `layoutPositioning: ABSOLUTE` to avoid distorting siblings — the side effect
  is that it sits on top of the layout flow rather than reserving space.
- Decorated text leaves (badge, button, pill) become FRAME-with-TEXT pairs
  with a synthesized auto-layout that respects `text-align`. Any pre-existing
  flex layout on the same element wins (the synthesis is a fallback).
- Variant width can grow the resulting Component Set wider than the original
  HTML element box; we deliberately do not resize the set after
  `combineAsVariants` to avoid cropping variants.
- Triggers are deduped by event type (`on-hover` and `on-mouse-enter` collapse
  to a single MOUSE_ENTER reaction). Last attribute on the source element wins.
- `MOUSE_ENTER` / `MOUSE_LEAVE` reactions are emitted with `delay: 0` because
  Figma's typings require the field. Configurable delay lands later.
- A `data-figma-component` with a single variant produces a plain Component
  (not a Component Set) since variants can't switch with no sibling target.

## Phase 3 — Fidelity boost ✓

- [x] Linear gradients (CSS `linear-gradient(...)` with angle / `to <side>` /
      colour stops, auto-distributing missing positions)
- [x] Multi-layer box shadows (drop + inset, mapped to Figma effects)
- [x] Mixed text runs — `<p>The <strong>bold</strong> word</p>` becomes a
      single Figma TEXT with per-range font / color / size / decoration
- [x] Italic and `text-decoration` (underline / line-through) on text and runs
- [x] `examples/styled-card.html` covering gradients + shadows + runs

### Known limits to revisit

- **Radial gradients**: parsed-aware but skipped at build time. Emits no fill
  rather than guessing. Phase 4.
- **`background-image` for non-gradient values** (image URLs on non-`<img>`
  elements): not yet captured. Phase 4.
- **Multi-image stacks**: only the first `linear-gradient` layer is consumed;
  additional stacked backgrounds are ignored.
- **Linear gradient aspect ratio**: the gradient axis is placed in unit
  bounding-box space, so for very wide or very tall boxes the on-screen angle
  drifts slightly from the CSS-rendered gradient. Acceptable for prototypes.
- **Rich-text detection requires a non-flex / non-grid parent**. A `<div
  style="display:flex">` with two `<span>` children stays as a frame with two
  TEXT siblings (correct), not a single rich-text node.
- **Nested inline elements** inside a rich-text container (e.g.
  `<p>The <a><strong>bold link</strong></a> here</p>`) collapse to the outer
  element's text content; no per-character style for the nested branch.
  Phase 4.
- **Whitespace**: leading and trailing whitespace inside a rich-text container
  is trimmed; internal runs of whitespace collapse to a single space, matching
  the default CSS `white-space: normal`. `<pre>` is not yet honoured.
- Italic fonts fall back to the upright weight if Figma can't resolve the
  italic style for the requested family (e.g. some monospace fonts have no
  italic variant).

## Phase 4 — Design token bridge ✓

- [x] Read CSS custom properties from `:root` and create matching colour
      Variables in an `HTMLoom Tokens` collection
- [x] Auto-bind solid fills, strokes, and text-run fills to Variables when
      the colour value matches a token
- [x] Reuse the collection and existing variables on re-import (sync, never
      duplicate)
- [x] Radial gradients (`radial-gradient(...)`) emitted as `GRADIENT_RADIAL`
- [x] `background-image: url(...)` on non-`<img>` elements
- [x] Nested inline runs (`<a><strong>bold link</strong></a>` inside a
      paragraph) recursed into a single TEXT with one run per leaf
- [x] `examples/tokens-radial.html` covering tokens, radial fills, URL
      backgrounds, and nested runs

### Known limits to revisit

- **`figma.createImage` only accepts raster bytes** (PNG / JPG / GIF / WebP).
  SVG `background-image` URLs (or data URIs) are skipped at build time —
  the surface fill remains, but the pattern is dropped. Workaround: convert
  SVG to PNG ahead of import. Proper fix needs a UI-side rasterisation
  pass (canvas) and is on Phase 5.
- **Radial gradients always render as a centered closest-side ellipse.**
  Source `circle`, `farthest-corner`, `at top right` etc. are parsed but
  ignored — Figma's gradient handles always sit at the box centre.
- **First token wins on duplicate colour values.** If `--color-text` and
  `--color-muted` both resolve to the same RGBA, only the first one is
  bound. Fills with that colour resolve to the first token deterministically.
- **Only colour tokens are bridged.** `--space-md: 8px` and other value
  tokens are captured but not turned into Number / String Variables yet.
- **Nested inline runs lose `text-decoration` from outer elements.** CSS
  doesn't inherit `text-decoration-line`, so `<a><strong>x</strong></a>`
  loses the underline on `x`. Workaround: add `text-decoration: inherit`
  on the inner element, or apply the underline inside.
- **Variable name collisions across pages** are resolved by reuse (same
  collection + same name → updated value). Re-importing different HTML with
  the same `--color-brand` value mutates the shared variable on purpose.

## Phase 5 — Authoring polish ✓

- [x] **UI-side SVG → PNG rasterisation** so inline `<svg>` icons and
      `background-image: url(*.svg)` round-trip into Figma. Done in the UI
      iframe via a `<canvas>` 2x-scale draw before sending the bytes.
- [x] **Aspect-ratio aware linear gradient transform**. The on-screen
      gradient angle now matches the CSS angle for non-square boxes.
- [x] **Nested `text-decoration` propagation**. `<a><strong>x</strong></a>`
      keeps the underline on the inner range.
- [x] **`<pre>` / `white-space: pre / pre-wrap / pre-line`** — preserves
      newlines and runs of spaces verbatim (or only newlines for `pre-line`).
- [x] **Number and String Variables** for non-colour tokens. `--space-md: 8px`
      becomes a `FLOAT` Variable (rem/em normalised to a 16px base);
      identifier-like values become `STRING` Variables. Created in the
      `HTMLoom Tokens` collection but not auto-bound — see explicit override.
- [x] **Explicit `data-figma-token-*` binding override**. Three flavours:
      `data-figma-token-bg` (alias `data-figma-token`, `-fill`),
      `data-figma-token-text`, and `data-figma-token-border` (alias
      `-stroke`). Forces the binding by Variable name even when the
      computed RGBA wouldn't match the token value.
- [x] `examples/phase5-fidelity.html` covering SVG icons, `<pre>`, the
      aspect-ratio gradient, and explicit token overrides.

### Known limits to revisit

- **Inline SVG `currentColor` is not resolved before rasterisation.** The
  `XMLSerializer` snapshot doesn't carry the parent text colour, so SVG
  strokes / fills authored as `currentColor` fall back to black in the
  rasterised PNG. Workaround: hardcode the colour in the SVG or replace
  `currentColor` with the resolved value before import.
- **External SVG URLs require CORS-friendly headers.** When the canvas
  ends up tainted, we log a warning and the original (broken) source is
  retained so Figma still surfaces a placeholder rather than crashing.
- **Number / String tokens are not auto-bound.** Use
  `data-figma-token-*` to bind paints by name; spacing / radius tokens
  remain editable in Figma but not wired to padding / corner radius
  fields. (Variable types for those layout fields land in a future phase.)
- **A non-`COLOR` token name reused for an explicit `data-figma-token-bg`
  binding is ignored** with a console warning. The binding API requires
  the destination Variable to resolve to `COLOR`.
- **Re-import with a token whose `kind` changed across runs is skipped**
  (e.g., `--foo: 8px` → `--foo: #fff`). The original Variable type wins
  to avoid silently breaking existing bindings; rename the token to free
  the slot.
- **Aspect-ratio aware gradient uses the captured HTML element's
  dimensions.** If the user resizes the resulting Figma frame, the
  gradient's visual angle drifts because Figma keeps the unit-bbox
  transform constant. CSS-Figma fundamental mismatch.
- **`text-decoration` ancestor wins on combination.** Figma TextNode
  supports one decoration per range, so `<u>foo<s>bar</s>baz</u>` keeps
  the outer underline across the entire range; the inner strikethrough
  is dropped.

### Phase 5 hotfixes (post-release patch)

- [x] **Leaf text whitespace** — non-pre text nodes with raw HTML source
      newlines / indentation now collapse to single spaces (matches the CSS
      `white-space: normal` default). Without this, hand-formatted paragraphs
      rendered with stray indentation in Figma.
- [x] **Text clipping** — paragraphs and titles now use `textAutoResize:
      HEIGHT` so the box grows when Figma's font metrics wrap a line earlier
      than the source iframe. `<pre>` and synthesised badge text use
      `WIDTH_AND_HEIGHT` so newlines render and parent auto-layout hugs.
- [x] **SVG `currentColor`** — substituted with the captured element's
      computed `color` before the SVG markup is serialised, so icon strokes
      / fills don't fall back to black when the canvas rasteriser loads
      the SVG out of context. Inline `style="..."` mentions are rewritten
      too. Stylesheet-driven `currentColor` remains unsupported.

## Phase 6 — On the table

- [ ] **Responsive sizing** — opt-in `data-figma-fill="horizontal | vertical |
      both"` attribute (or a heuristic on `width: 100%` / `flex: 1` children)
      that emits `layoutSizingHorizontal: FILL_CONTAINER` so resizing the
      imported root in Figma reflows children. Today every node has a fixed
      captured size, which is why diminishing the root width does nothing.
- [ ] Layout-field Variable bindings (padding, item spacing, corner radius)
      that consume the new Number tokens automatically.
- [ ] Easing presets and configurable trigger delays for prototype reactions.
- [ ] Multi-image `background` stacks (currently only the first layer wins).
- [ ] Per-corner radius support for the auto-bind path.
- [ ] SVG `currentColor` resolution from stylesheet selectors (currently only
      attribute / inline-style references are rewritten).

## Phase 1 limits exposed by Phase 2 testing

These are not regressions — they were latent in Phase 1 and only became
visible when authoring richer markup for variants.

- **Mixed text + element children of a single node**: fixed in Phase 3 via
  rich-text runs. `<p>Hello <strong>world</strong>!</p>` now becomes a single
  Figma TEXT node with the correct ranges.
- A non-auto-layout chain three or more levels deep used to position
  grandchildren in root coordinates instead of parent-relative coordinates.
  Fixed during the Phase 2 audit (walker now passes the immediate `el` as
  the recursive root).

## Out of scope (for now)

- JavaScript-driven runtime behavior beyond pre-declared states
- Full CSS engine (we rely on the browser's computed styles)
- Animation curves beyond Figma's built-in easing presets
