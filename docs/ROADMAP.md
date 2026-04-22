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

## Phase 2 — Interactive states

- [ ] Read `data-figma-state="hover|click|expanded|…"` markers from HTML
- [ ] Re-render the same root in each state and capture all variants
- [ ] Emit a Figma Component Set with one Variant per state
- [ ] Build Reactions (`setReactionsAsync`) for declared transitions
  (e.g. `data-figma-trigger="click" data-figma-target="popover"`)

## Phase 3 — Fidelity boost

- [ ] Linear and radial gradients
- [ ] Box shadows (multi-layer)
- [ ] Mixed text runs (per-span colors / weights inside one paragraph)
- [ ] `background-image` on non-`<img>` elements

## Phase 4 — Design token bridge

- [ ] Optional `data-figma-token="color/brand-500"` mapping
- [ ] Read CSS custom properties and offer to create matching Figma Variables
- [ ] Re-bind solid fills / strokes to Variables when names match

## Out of scope (for now)

- JavaScript-driven runtime behavior beyond pre-declared states
- Full CSS engine (we rely on the browser's computed styles)
- Animation curves beyond Figma's built-in easing presets
