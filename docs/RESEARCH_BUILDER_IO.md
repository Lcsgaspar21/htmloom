# Research: `@builder.io/html-to-figma` vs HTMLoom

**Date:** 2026-04-23
**Source:** `@builder.io/html-to-figma@0.0.3` (npm), MIT license
**Total engine size:** ~1,000 lines of JS (transpiled from TS)
**Modules read:** `index.js`, `frames.js`, `styles.js`, `text.js`, `dimensions.js`, `svg.js`, `image.js`, `parsers.js`

---

## TL;DR — the unexpected finding

Builder.io's engine and HTMLoom solve **fundamentally different problems**:

| | Builder.io | HTMLoom |
|---|---|---|
| **Goal** | Snapshot the *visual* into Figma layers | Preserve the *design intent* (auto-layout, responsiveness, interactivity) |
| **Strategy** | Flat list of absolute-positioned rectangles + text, then reconstruct hierarchy from geometry | Walk DOM hierarchically, preserve flex/grid → Figma auto-layout |
| **Output is** | Pixel-perfect frozen | Editable, responsive, prototype-ready |
| **Auto-layout** | None (constraints only) | Yes (FILL/HUG/FIXED chain, padding, item spacing, layoutGrow) |
| **Variants & reactions** | None | Yes (`data-figma-variant`, `data-figma-on-click`, SMART_ANIMATE) |
| **Token bindings** | None | Yes (CSS variables ↔ Figma variables) |
| **Gradients** | None | Yes (linear gradient transform) |
| **Grid** | None | Yes (multi-track restructure into nested AL) |

**Builder.io is NOT a treasure trove for our specific bugs.** We can't port their AL chain because they don't have one. We can't port their grid handling because they don't have it either. We can't fix our `.stack=150` bug from their code because they side-step the whole problem class by going absolute.

**What we CAN port:** ~5 tangential wins (per-side borders, SVG outerHTML pass-through, inline text capture, `<use>` inlining, inline-element bbox aggregation). These are improvements, not silver bullets.

---

## How Builder.io actually works (in 4 steps)

```
HTML
  ↓
[1] Flatten ALL elements via querySelectorAll('*')
  ↓
[2] For each element with non-default styles, emit ONE Figma RECTANGLE
    with absolute (x, y, width, height) from getBoundingClientRect.
    Borders that aren't uniform → emit 4 separate stroke rectangles
    (one per side). Border radii applied to the rectangle directly.
  ↓
[3] For each text node found via TreeWalker, emit ONE TEXT layer
    with absolute (x, y), font props, and a width = its bounding box.
  ↓
[4] (optional, with useFrames=true) Reconstruct hierarchy:
    - For each layer L, walk up its DOM ancestors
    - Find the lowest existing parent layer that's also captured
    - Wrap them together into a FRAME with the parent's bbox
    - Apply constraints (CENTER/SCALE/MIN/MAX) inferred from
      auto-margins, text-align, parent flex justify/align
```

Notable details from `index.js:46`:

```js
const appliedStyles = getAppliedComputedStyles(el);
if ((size(appliedStyles) || el instanceof HTMLImageElement || ...))
```

They **only emit a layer if the element has at least one non-default
style applied**. This is a clever optimisation — it skips the wrapper
divs that exist purely for layout. We don't do this; we emit a frame
for every container. (See "Port #6" below.)

---

## What we already do BETTER than them

These confirm our architecture decisions; we shouldn't second-guess them.

1. **Auto-layout from CSS flex/grid** — they don't have it at all. Their output is "frozen pixels", which fails our user's primary use case ("manipulate layouts in Figma to iterate with PMs/devs").
2. **Multi-track grid restructure** — they don't handle CSS Grid at all. Our `restructureMultiTrackGrid` goes further than anything in their code.
3. **Variants + interactive reactions** — they don't have it. This is *the* differentiator that justified building HTMLoom in the first place.
4. **Token bindings** — `--colour-*` and `--space-*` variables map to Figma variables. They don't even consider it.
5. **Gradient parsing** (`linear-gradient(45deg, ...)` → Figma `GRADIENT_LINEAR`) — they ignore gradients entirely.
6. **Component sets from `data-figma-component`** — explicit, intent-driven authoring API. They don't have anything similar.
7. **TypeScript with proper types** — `AxisSizing`, `SizingIntent`, `TriggerSpec`, `BuildContext`, etc. Theirs is JS with looser types from 2019.

---

## What they do BETTER than us — concrete ports

### Port #1 — Per-side border as 4 rectangles (HIGH value)

**Their code** (`styles.js:201-244`):

```js
export function getStrokesRectangle({ dir, rect, computedStyle, el }) {
  const computed = computedStyle["border" + capitalize(dir)];
  // ... parse "1px solid rgb(...)"
  // emit a thin rectangle aligned to that side
}
```

For each side (`top`, `right`, `bottom`, `left`), if a border is
defined, they emit a **separate rectangle** of that thickness
positioned along the side.

**Why this matters for us:** Figma's `strokeWeight` is **uniform**
across all 4 sides. CSS often has only `border-bottom: 1px solid` (e.g.
table rows, dividers between cards) — our current code either picks one
side and applies it everywhere, or skips the border entirely. Both look
wrong.

**Action:** add `applyPerSideBorders` in `builder.ts`. Detect when CSS
has different `border-{top,right,bottom,left}` widths/styles. Fallback
to 4 thin rectangles inside the parent frame.

**Effort:** ~80 LOC. **Visual fidelity gain:** large for any UI with
asymmetric dividers.

---

### Port #2 — Inline-element bounding box aggregation (MEDIUM value)

**Their code** (`dimensions.js:43`):

```js
export function getBoundingClientRect(el) {
  const computed = getComputedStyle(el);
  const display = computed.display;
  if (display.includes("inline") && el.children.length) {
    const elRect = el.getBoundingClientRect();
    const aggregateRect = getAggregateRectOfElements(Array.from(el.children));
    if (elRect.width > aggregateRect.width) {
      return Object.assign({}, aggregateRect, {
        width: elRect.width, left: elRect.left, right: elRect.right,
      });
    }
    return aggregateRect;
  }
  return el.getBoundingClientRect();
}
```

When an inline element wraps onto multiple lines, its
`getBoundingClientRect()` returns the union of all line boxes — which
can include massive horizontal whitespace and produces a useless rect.
Their solution: aggregate the children's rects instead.

**Why this matters for us:** wrapped `<a>` or `<span>` text in a flex
parent currently captures with weird widths. Could be a contributor to
text overflow bugs.

**Action:** wrap our `getBoundingClientRect` calls in `walker.ts` with
this same aggregation logic. Use whenever `display` contains `"inline"`
and the element has children.

**Effort:** ~30 LOC. **Bug fix:** maybe.

---

### Port #3 — SVG via `outerHTML` pass-through (MEDIUM value)

**Their code** (`svg.js:16`):

```js
export const createSvgLayer = (el) => {
  const layer = {
    type: "SVG",
    svg: el.outerHTML,
    x, y, width, height,
  };
  return layer;
};
```

They literally serialize the SVG as `outerHTML` and ship it to the
plugin. The plugin then calls `figma.createNodeFromSvg(layer.svg)` —
exactly what we already do as a fallback.

**Why this matters for us:** we currently do (a) clone, (b) substitute
`currentColor`, (c) defensive `xmlns` injection, (d) Blob URL, (e)
rasterize to PNG fallback. They skip all of that. The reason is
probably: they accept that `currentColor` will look wrong inside
Figma, but they get a real vector node that's editable.

**Action:** make the inline-vector path the primary, not the fallback.
Try `outerHTML → createNodeFromSvgAsync` first, only rasterize if it
throws. Resolves both "pixelated SVG" and "broken inline icons" bug
classes.

**Effort:** small refactor of `walker.ts` SVG capture and `builder.ts`
SVG build. **Bug fix:** likely.

---

### Port #4 — SVG `<use>` symbol inlining (LOW value)

**Their code** (`svg.js:1`):

```js
export const processSvgUseElements = (el) => {
  for (const use of Array.from(el.querySelectorAll("use"))) {
    const symbolSelector = use.href.baseVal;  // e.g. "#icon-add"
    const symbol = document.querySelector(symbolSelector);
    if (symbol) {
      use.outerHTML = symbol.innerHTML;
    }
  }
};
```

If your HTML uses `<svg><use href="#icon-add"/></svg>` (a common
pattern with sprite sheets), the `<use>` is replaced inline with the
referenced `<symbol>`'s contents *before* capture. Otherwise `<use>`
serializes as `<use href="..."/>` with no actual graphic content.

**Why this matters for us:** if any HTML uses sprite sheets we'd
silently lose icons. Cheap to add.

**Effort:** ~20 LOC. **Run preprocessing once at the start of capture.**

---

### Port #5 — Constraints heuristic for absolute children (MEDIUM value)

**Their code** (`styles.js:71-190`): inspects `auto` margins,
parent's `text-align`, parent's `justifyContent`/`alignItems`, and
maps to Figma `constraints: { horizontal: CENTER|MAX|MIN|SCALE,
vertical: ... }`.

**Why this matters for us:** we generate constraints for absolutely
positioned children (popovers, dropdowns) but our heuristic is simple
("infer from `top`/`right`/`bottom`/`left` properties"). Theirs covers
the case where layout intent is encoded as `margin: 0 auto` or
`text-align: center` instead.

**Action:** port `addConstraints` logic into our `extractSizingIntent`
for `position: absolute` nodes. Make it a fallback when explicit
top/right/bottom/left aren't set.

**Effort:** ~60 LOC. **Bug fix:** centred floating elements.

---

### Port #6 — Skip elements with no applied styles (LOW-MEDIUM value)

**Their code** (`styles.js:9-21`):

```js
const list = ["opacity", "backgroundColor", "border", ...];
// ... for each style in list, if it differs from the default, keep it
// If the resulting object is empty AND the element isn't an image/video → skip
```

**Why this matters for us:** wrapper `<div>`s that exist purely for CSS
grid placement become extra Figma frames in our output. Bloats the layer
list and slows the plugin.

**Caveat:** we sometimes *need* these wrappers (they may have padding
or be the boundary for our grid restructure). Use cautiously, only for
empty-style + empty-padding + empty-children-with-content wrappers.

**Effort:** small, but high risk of regression. **Skip for now**, mark
as backlog.

---

## What they DON'T have that we'd have to build alone

These are areas where Builder.io provides zero leverage — we're on
our own:

1. **Auto-layout chain** (HUG/FILL/FIXED, layoutGrow, alignSelf,
   layoutWrap) — our entire Phase 6.
2. **Multi-track CSS Grid restructure** — our Phase 7.
3. **CSS variables → Figma variables** binding — our Phase 4 + 7.
4. **Component sets from `data-figma-component`** with variants and
   reactions — our Phase 5.
5. **SMART_ANIMATE transitions with configurable timing/easing** —
   our Phase 7.
6. **Linear gradient transforms** (the matrix conversion) — our
   Phase 4.

Our `.stack=150` bug, `body p` text wrapping issues, card overflow —
all these live in our auto-layout chain. **There is no port that fixes
them.** It's local debugging.

---

## Revised recommendation

The original "Caminho 1: port from Builder.io" was based on a wrong
assumption — that they had solved problems similar to ours. They
haven't; they side-stepped them by going absolute.

### What we should actually do

**Phase 7.1 — Tangential ports from Builder.io** ✅ (landed 2026-04-22):
- ✅ Per-side border rectangles → `appendPerSideBorders` in `builder.ts`,
  `parseBorder` in `walker.ts`, type extension in `BorderStyle.sides`.
  Uniform borders still go through Figma's stroke; mixed borders (e.g.
  `border-bottom: 1px solid`) are emitted as 4 absolutely-positioned
  rectangles with edge constraints.
- ✅ SVG `<use>` inlining → `inlineSvgUseElements` runs once before walk,
  rewrites `<use href="#sym">` with the referenced symbol's `innerHTML`
  so sprite-sheet icons survive serialisation.
- ✅ SVG outerHTML pass-through as primary path → `tryRecoverSvgMarkup`
  decodes `data:image/svg+xml` URIs and (best-effort) fetches `.svg`
  URLs into `node.svgMarkup`, so they go through `createNodeFromSvgAsync`
  as crisp vectors instead of being rasterised.
- ⏸ Inline-element bbox aggregation — skipped: low ROI for our typical
  examples (mostly short inline labels in flex containers; the
  multi-line wrap edge case isn't currently breaking imports).
- ⏸ Line-height correction — skipped: our walker already passes through
  the captured px value when CSS resolves it, and falls back to
  Figma's intrinsic line-height when CSS leaves it `normal`. That
  behaviour matches modern browsers within a few percent.

**Phase 7.2 — Local debugging of our AL chain** (~1-2 days, no
external help):
- Diagnose `.stack=150` regression (likely an interaction between block
  stack promotion and `applyContainerOwnHug` for max-width parents)
- Audit text wrapping in HUG/FILL chain (text node `textAutoResize`
  ordering vs `layoutSizingHorizontal=FILL`)
- Verify card child auto-layout chain end-to-end with a unit-test-style
  fixture

**Phase 7.3 — Document the "screenshot mode" trade-off**:
- Add an option to HTMLoom UI: `[ ] Capture as flat absolute layers
  (snapshot mode)`. When checked, switch to a Builder.io-style
  flattening. This gives users a fallback when our AL chain inevitably
  fails on some input — they get a frozen-but-correct version instead
  of a broken AL version.

---

## Cherry-picked code references for follow-up

Bookmarks (read in `/tmp/htmloom-research/h2f-pkg/package/dist/lib/html-to-figma/`):

- `index.js:46` — the "skip empty-style elements" check
- `index.js:81-93` — the per-side border emission orchestrator
- `frames.js:27-204` — the `makeTree` LCD reconstruction algorithm
- `styles.js:71-190` — the full constraints heuristic
- `dimensions.js:43-55` — inline-element bbox aggregation
- `svg.js:1-30` — `<use>` inlining + outerHTML pass-through
- `text.js:21-25` — line-height correction trick (rect.height < lineHeight → grow upward)

The `text.js:21-25` line-height correction is interesting too:

```js
if (lineHeight && rect.height < lineHeight.value) {
  const delta = lineHeight.value - rect.height;
  rect.top -= delta / 2;
  rect.height = lineHeight.value;
}
```

Their text rect is the *content box* but they want the *line box* (so
text vertical position matches what users saw). Worth copying into
our `walker.ts:extractTextSpec` if we see vertical drift in text.
