# HTMLoom

> Weave HTML files into editable Figma layers — auto-layout aware, with prototype state support coming next.

HTMLoom is a self-contained Figma plugin. It loads HTML in its own sandboxed iframe (no external service required), walks the live DOM, and creates native Figma frames, text nodes, and images. The intent is to keep prototyping cycles tight: design in HTML, hand it to Figma in seconds, then iterate with PMs and engineers in either tool.

## Status

**Phase 1 — MVP (current).** Single-state import:

- File drop, file picker, or paste HTML
- DOM → tree capture with computed styles and bounds
- Auto-layout heuristic for `display: flex` (high confidence) and single-track `display: grid`
- Absolute fallback when layout intent is ambiguous
- Text, solid backgrounds, borders, corner radius, opacity
- Inline `<svg>` and `<img>` (data URIs and external URLs)

Phases 2–4 (interactive states with Variants + Reactions, gradients, advanced typography, design-token import) are planned in `docs/ROADMAP.md`.

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

The repo ships an example file used during development:

```
examples/alert-priority-wireframe.html
```

Drop it onto the plugin window to verify your local build.

## Architecture (one paragraph)

The plugin is split between two contexts. The **UI iframe** has full browser capabilities and runs `src/walker.ts` to capture a `CaptureResult` tree from a sandbox iframe rendering the user's HTML. The **main thread** runs in Figma's sandbox and only knows how to translate a `CaptureResult` into Figma nodes (`src/builder.ts`). All communication is `postMessage` with the typed shapes in `src/types.ts`. Build is two `esbuild` passes plus a tiny inliner so the final `ui.html` is fully self-contained.

## License

MIT — see `LICENSE`.
