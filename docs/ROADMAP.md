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

## Phase 3 — Fidelity boost

- [ ] Linear and radial gradients
- [ ] Box shadows (multi-layer)
- [ ] Mixed text runs (per-span colors / weights inside one paragraph)
- [ ] `background-image` on non-`<img>` elements

## Phase 4 — Design token bridge

- [ ] Optional `data-figma-token="color/brand-500"` mapping
- [ ] Read CSS custom properties and offer to create matching Figma Variables
- [ ] Re-bind solid fills / strokes to Variables when names match

## Phase 1 limits exposed by Phase 2 testing

These are not regressions — they were latent in Phase 1 and only became
visible when authoring richer markup for variants.

- **Mixed text + element children of a single node lose the text runs.**
  Example: `<div>Hello <strong>world</strong>!</div>` keeps only `world`.
  Workaround for now: wrap each text run in its own inline element. Proper
  fix lands in Phase 3 as part of mixed text-run support (single Figma TEXT
  node with per-character styling).
- A non-auto-layout chain three or more levels deep used to position
  grandchildren in root coordinates instead of parent-relative coordinates.
  Fixed during the Phase 2 audit (walker now passes the immediate `el` as
  the recursive root).

## Out of scope (for now)

- JavaScript-driven runtime behavior beyond pre-declared states
- Full CSS engine (we rely on the browser's computed styles)
- Animation curves beyond Figma's built-in easing presets
