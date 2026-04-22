# HTMLoom

> Weave HTML files into editable Figma layers — auto-layout aware, prototype-ready, with proper gradients, shadows, and rich text.

HTMLoom is a self-contained Figma plugin. It loads HTML in its own sandboxed iframe (no external service required), walks the live DOM, and creates native Figma frames, text nodes, and images. The intent is to keep prototyping cycles tight: design in HTML, hand it to Figma in seconds, then iterate with PMs and engineers in either tool.

## Status

**Phase 1 — MVP.** Single-state import:

- File drop, file picker, or paste HTML
- DOM → tree capture with computed styles and bounds
- Auto-layout heuristic for `display: flex` (high confidence) and single-track `display: grid`
- Absolute fallback when layout intent is ambiguous
- Text, solid backgrounds, borders, corner radius, opacity
- Inline `<svg>` and `<img>` (data URIs and external URLs)

**Phase 2 — Interactive states.** Component Sets + Reactions from HTML attributes:

- `data-figma-component="<name>"` → Component Set
- Children with `data-figma-variant="<name>"` → one Variant each (`State=<name>` property)
- Triggers via `data-figma-on-click | -on-press | -on-hover | -on-mouse-enter | -on-mouse-leave`
- Inactive variants can use `display: none`; the walker forces visibility only during capture

**Phase 3 — Visual fidelity.** Gradients, shadows, and rich text:

- Linear gradients on any element's background (`linear-gradient(135deg, ...)`)
- Multi-layer `box-shadow` (drop + inset, mapped to Figma effects)
- Mixed text runs — `<p>The <strong>bold</strong> word</p>` becomes a single
  Figma TEXT with per-range font weight, italic, color, size, and decoration

**Phase 4 — Design token bridge.** CSS variables travel into Figma:

- Every `--color-*` custom property on `:root` becomes a Figma Color Variable
  in an `HTMLoom Tokens` collection (created on first import, reused after)
- Solid fills, strokes, and per-run text colours auto-bind to a Variable
  when the value matches a token — edit the token, the design follows
- Radial gradients (`radial-gradient(...)`) and `background-image: url(...)`
  on regular divs (not just `<img>`)
- Nested inline runs: `<p>The <a><strong>bold link</strong></a> here</p>`
  collapses into a single TEXT with three correctly-styled ranges

**Phase 5 — Authoring polish.** The last sharp edges, smoothed:

- Inline `<svg>` is imported as native editable Figma vectors via
  `figma.createNodeFromSvgAsync` (no rasterisation, infinite zoom);
  `currentColor` is resolved before serialisation so icon strokes keep
  their on-page colour
- Linear gradients now respect aspect ratio: a 45° gradient on a wide
  rectangle reads as 45° on screen
- `text-decoration` propagates through nested inline runs
  (`<a><strong>x</strong></a>` keeps the underline on the inner range)
- `<pre>` and `white-space: pre / pre-wrap / pre-line` preserve newlines
  and runs of spaces verbatim
- `--space-*`, `--radius-*` and other non-colour tokens become Number /
  String Variables in the same collection; identifiers become String tokens
- Explicit `data-figma-token-bg | -text | -border="<variable name>"`
  attribute overrides the auto-binder and pins a paint to a Variable by
  name regardless of computed value

**Phase 6 — Responsiveness.** Imported frames now resize the way the source HTML would:

- Per-axis sizing inferred from CSS: `FIXED` / `HUG` / `FILL`. Inline
  elements HUG; `flex-grow > 0` FILLs the primary axis;
  `align-self: stretch` (or default `align-items: stretch`) FILLs the
  cross axis; block-level whose measured width matches the parent
  content box FILLs horizontally; everything else HUGs.
- `min/max-width/height`, `flex-grow → layoutGrow`,
  `align-self: stretch → layoutAlign: STRETCH`,
  `flex-wrap → layoutWrap: WRAP` are all bridged.
- `position: absolute` children get Figma constraints from
  `top/right/bottom/left`. The `left: 50%; transform: translateX(-50%)`
  centring idiom maps to `CENTER` (not `STRETCH`).
- Override per element with `data-figma-sizing-h="fill|hug|fixed"` and
  `data-figma-sizing-v="…"` when the heuristic guesses wrong.

**Phase 7 — Grid, token bindings on layout fields, animated reactions.**

- **Multi-track CSS Grid → nested auto-layouts.** Containers with
  `display: grid` and 2+ visual rows are restructured into a vertical
  stack of horizontal rows. Cells are bucketed by measured Y position
  (so `grid-auto-flow`, `order`, and implicit placement all survive).
  Equal-width tracks (`1fr 1fr 1fr`-style) make every cell `FILL` with
  `layoutGrow=1`, so a 3-column dashboard reflows when you resize the
  outer frame.
- **Layout-field Variable bindings.** `--space-*`, `--radius-*` and any
  numeric token are now bound, not just imported. Padding (per side),
  item spacing, and corner radius (per corner) auto-bind to the matching
  FLOAT Variable when the resolved px value matches a token. Edit the
  Variable, every padding / radius / gap follows.
- **Easing + delays for prototype reactions.** Triggers can now animate.
  Add `data-figma-trigger-duration="280ms"` and
  `data-figma-trigger-easing="ease-out"` to emit a `SMART_ANIMATE`
  transition; `data-figma-trigger-delay="120ms"` extends the dwell time
  on hover triggers. Per-trigger overrides via the inline syntax
  `<variant>@<duration>[+<delay>]:<easing>`.

Phase 8 (multi-image background stacks, SVG `currentColor` from stylesheets, CSS `aspect-ratio`) is tracked in `docs/ROADMAP.md`.

### Authoring API

**Components & states (Phase 2):**

```html
<div data-figma-component="alert-badge-popover">
  <div data-figma-variant="default">
    <span class="badge" data-figma-on-click="expanded">High priority</span>
  </div>
  <div data-figma-variant="expanded">
    <span class="badge" data-figma-on-click="default">High priority</span>
    <div class="popover">…</div>
  </div>
</div>
```

After import you get a Figma Component Set named `alert-badge-popover` with two
variants and a click reaction wired between them — drop an Instance into a
prototype and it just works.

**Explicit token bindings (Phase 5):**

```html
<!-- Bind this paint to color/brand/500 even though the computed value is grey -->
<span class="pill" data-figma-token-bg="color/brand/500">Bound by name</span>

<!-- Use a foreground / border token instead of an RGBA match -->
<button data-figma-token-text="color/text/inverse"
        data-figma-token-border="color/border/strong">…</button>
```

Useful when several tokens share a value (so the auto-binder can't pick deterministically) or when the literal CSS colour shouldn't constrain the binding.

**Sizing overrides (Phase 6):**

```html
<!-- Force this card to FILL its parent regardless of measured width -->
<div class="card" data-figma-sizing-h="fill">…</div>

<!-- Override the auto-detected HUG to a fixed-width sidebar -->
<aside data-figma-sizing-h="fixed" data-figma-sizing-v="fill">…</aside>
```

The override wins the heuristic. Useful for CMS-driven content whose rendered width happens to coincide with the parent content box (and would otherwise be classified as `FILL`).

**Animated reactions (Phase 7):**

```html
<!-- Click triggers animate when duration > 0 (Smart Animate). -->
<button
  data-figma-on-click="expanded"
  data-figma-trigger-duration="280ms"
  data-figma-trigger-easing="ease-out"
>Open</button>

<!-- Per-trigger overrides via inline syntax: variant@duration[+delay]:easing -->
<button data-figma-on-click="collapsed@200ms:ease-in">Close</button>

<!-- Hover-and-stay reveal — 150 ms dwell, 240 ms gentle interpolation -->
<span
  data-figma-on-mouse-enter="hovered"
  data-figma-trigger-delay="150ms"
  data-figma-trigger-duration="240ms"
  data-figma-trigger-easing="gentle"
>Hover me</span>
```

Easing keywords: `linear`, `ease-in`, `ease-out`, `ease-in-out`, `gentle`. Bare numbers in the duration / delay attributes are treated as milliseconds (`280` ≡ `280ms`).

## Develop

```bash
npm install
npm run build       # one-shot build
npm run watch       # rebuild on change
```

In Figma desktop:

1. `Plugins → Development → Import plugin from manifest…`
2. Pick `manifest.json` at the repo root
3. Run `Plugins → Development → HTMLoom`

## Try it

The repo ships ten examples used during development:

```
examples/alert-priority-wireframe.html   # Phase 1 — static layout
examples/popover-states.html             # Phase 2 — interactive variants
examples/styled-card.html                # Phase 3 — gradients, shadows, runs
examples/tokens-radial.html              # Phase 4 — tokens, radial, bg-url, nested
examples/phase5-fidelity.html            # Phase 5 — SVG, <pre>, gradient, overrides
examples/responsive-card.html            # Phase 6 — HUG/FILL/FIXED, wrap, full-width
examples/responsive-grid.html            # Phase 6 — flex-wrap tile grid that reflows
examples/grid-dashboard.html             # Phase 7 — 3×2 multi-track grid
examples/tokens-binding.html             # Phase 7 — padding/spacing/radius bound
examples/transitions.html                # Phase 7 — Smart Animate variant transitions
```

Drop any of them onto the plugin window to verify your local build. Quick checks:

- **Phase 6** — drag the imported frame's right edge; `responsive-grid.html` should reflow tiles 4-up → 1-up.
- **Phase 7 grid** — `grid-dashboard.html` produces an outer `VERTICAL` auto-layout with two synthesised rows, each a `HORIZONTAL` auto-layout of three cells with `FILL` + `layoutGrow=1`.
- **Phase 7 tokens** — `tokens-binding.html` shows numeric Variables under the `HTMLoom Tokens` collection bound on padding / item-spacing / corner radii of every imported card.
- **Phase 7 reactions** — drop an Instance of `AnimatedPopover` from `transitions.html` into a prototype frame and click "Show details"; the panel should fade/move-in over 280 ms.

## Architecture (one paragraph)

The plugin is split between two contexts. The **UI iframe** has full browser capabilities and runs `src/walker.ts` to capture a `CaptureResult` tree from a sandbox iframe rendering the user's HTML. The **main thread** runs in Figma's sandbox and only knows how to translate a `CaptureResult` into Figma nodes (`src/builder.ts`). All communication is `postMessage` with the typed shapes in `src/types.ts`. Build is two `esbuild` passes plus a tiny inliner so the final `ui.html` is fully self-contained.

## License

MIT — see `LICENSE`.
