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

## Phase 5 — On the table

- [ ] `<pre>` / `white-space: pre` (preserve newlines and runs of spaces)
- [ ] `data-figma-token="color/brand-500"` explicit binding override
- [ ] Number / String Variables for non-colour tokens (`--space-*`, `--radius-*`)
- [ ] UI-side SVG → PNG rasterisation so SVG backgrounds round-trip
- [ ] Aspect-ratio aware linear gradient transform
- [ ] Honour `text-decoration` propagation through nested inline runs

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
