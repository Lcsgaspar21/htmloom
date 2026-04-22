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

Phase 5 (SVG-as-image rasterisation, value tokens, `<pre>`) is tracked in `docs/ROADMAP.md`.

### Authoring API (Phase 2)

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

The repo ships four examples used during development:

```
examples/alert-priority-wireframe.html   # Phase 1 — static layout
examples/popover-states.html             # Phase 2 — interactive variants
examples/styled-card.html                # Phase 3 — gradients, shadows, runs
examples/tokens-radial.html              # Phase 4 — tokens, radial, bg-url, nested
```

Drop either onto the plugin window to verify your local build.

## Architecture (one paragraph)

The plugin is split between two contexts. The **UI iframe** has full browser capabilities and runs `src/walker.ts` to capture a `CaptureResult` tree from a sandbox iframe rendering the user's HTML. The **main thread** runs in Figma's sandbox and only knows how to translate a `CaptureResult` into Figma nodes (`src/builder.ts`). All communication is `postMessage` with the typed shapes in `src/types.ts`. Build is two `esbuild` passes plus a tiny inliner so the final `ui.html` is fully self-contained.

## License

MIT — see `LICENSE`.
