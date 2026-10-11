# Spike: stepped Equal Earth → Mercator transition

Date: 2026-10-10/11 · Spec: `docs/superpowers/specs/2026-09-28-equal-earth-v5-v6-state-of-the-art-design.md` §4
Page (throwaway, never committed): `demo/spike/bands.html`, MapLibre 6.6.0, OpenFreeMap Liberty.
Human judgement in Chrome on the developer's machine; timings from a headless Chrome (SwiftShader)
harness driven over CDP, and from Node against live OpenFreeMap tiles.

## Setup
- Worker path: `dist/worker.mjs` via `importScriptInWorkers` (400 512 B). The dev server had to
  exclude `maplibre-gl` from Vite's dependency pre-bundling, or v6's `import.meta.url`-relative
  worker never loaded (`vite.config.ts`, committed with this document).
- Layers: 111 → 354 (3 steps) · 599 (6) · 851 (9) · 1091 (12). The spec's estimate of 250–300
  was for 3 steps without parse overlap.
- First idle, 3 steps: 3.7 s on the developer's machine (cold), 4.2 s headless.

## What the spike found, in the order it found it

1. **Labels misplaced** (Germany in Asian Russia). Cause: world-copy geometry beyond ±180° in the
   source tiles plus geojson-vt's `wrap()`, which shifts it by a world; Equal Earth is not
   periodic in longitude. Fixed in production code: clip to the real world before warping
   (`src/math/antimeridian.ts`, commits `3910dd7`, `f9700b5`). Live sweep z0–3: 0 of 3271 labels
   off.
2. **The view jumped sideways at every crossing** (Guadalajara, San Francisco 3.7° off). Cause:
   `BandCamera` was edge-triggered against the wrong model of MapLibre's requested camera state.
   Fixed in production code by converting relative to a baseline band and handling v6's
   `moveend` asymmetry (`2ec1984`, `8313168`, `f6c6b1e`; CLAUDE.md "ThresholdCamera: why it
   looks the way it does"). Verified in real Chrome: the geographic centre is unchanged through
   every wheel step and cross button (0.000° drift at Tokyo and San Francisco).
3. **Blank map at each crossing (~2 s).** Cause: MapLibre's worker parses a layer into a tile only
   when `floor(minzoom) <= z < maxzoom`, so a band whose layers begin exactly at its boundary has
   nothing drawable in the tiles prefetched before it. The spec's hidden prefetch layers do not
   help. Fix ("parse early, show late"): each band's fill/line layers get a zoom range widened by
   one band spacing on both sides and a zoom-gated opacity; symbols keep exact ranges. The new
   band is then drawn 17–41 ms after the crossing instead of ~2 s.
4. **With more steps the map was often empty, or showed only water.** Cause: throughput, not
   errors (0 map errors in a full 9-step zoom). Every step is its own tile pyramid; one band tile
   costs 100–750 ms to warp (Node) plus up to 1.6 s to fetch cold; a screen is 12–20 tiles; and
   MapLibre v6 runs **one** tile worker by default (except Safari), so all warping queues on one
   thread. Water tiles are cheap and finish first.
5. **"Switch only when the next step is ready"** (prototyped in the spike at the human's request).
   The shown band becomes a runtime state driven through `global-state`: fill/line opacity flips
   on the main thread; symbol `visibility` flips via a visibility expression (invisible labels
   would still collide), which re-parses — not re-warps — the two affected sources. The camera
   converts in the same hook frame that switches. Headless at 9 steps: no holes while a band is
   held; the remaining holes are forced switches (the held band's parse range ran out) and
   newly revealed edges on zoom-out. Labels blink off for the re-parse at every switch.
   Gotchas: `map.isStyleLoaded()` is false while *any* tile loads, so it must not gate switching;
   the page's overlay panel swallowed wheel events (`pointer-events`).

## Crossings

Centre drift: 0.00 px at every crossing, every city (requirement ≤ 1 px: met).

Off-centre geometry snap, 300 px from the centre, per crossing. It is the same at every zoom to
first order (the centre is pinned, so what remains is the local Jacobian difference between the
two blends) and scales as 1/steps:

| City | 3 steps | 9 steps | 9 steps after zoom+bearing compensation (shear only) | whole transition |
|---|---|---|---|---|
| Zürich | 33–44 px | 10–15 px | 3–5 px | scale 1.27× (0.35 zoom), rotation ≈ 0 |
| San Francisco | 56–65 px | 18–22 px | 9–11 px | scale 1.09×, rotation −16° |
| Anchorage | 105–253 px | 29–84 px | 12–43 px | scale 1.82× (0.87 zoom), rotation −34° |
| Singapore | 26–31 px | 9–11 px | 4–6 px | scale 0.86×, rotation ≈ 0 |

Human judgement: 3 steps "really good" at Tokyo once the camera was fixed, but "the geometry
changes are obvious" once the blank gap was gone; "we need more steps". The table shows why more
steps cannot finish the job: 1 px would need 100+ steps. About half of each snap is a similarity
(rotation + isotropic scale) that the camera can absorb as a *continuous* function of zoom; the
rest is shear, which only a cross-fade can soften.

## Prefetch
Hidden prefetch layers load tiles but cannot make them drawable (finding 3). Parse overlap
replaces them. Cost: up to three band sources warped per tile position inside the transition
range; the network cost is shared through the source-tile cache, the CPU cost is not.

## Seams (z2–4)
Not reported by the human at 1× DPR during two days of use. 2× DPR not measured. No mitigation
scheduled; revisit if reported.

## Decision
- [x] **GO, amended** — the band design stays, with these changes to spec §3–§4, §6, §9:
  1. Switching is **ready-gated** (finding 5), with hysteresis and a minimum dwell.
  2. The camera absorbs the **similarity part** of every step continuously (zoom and bearing
     offsets); the shear residual is **cross-faded** through paint transitions.
  3. Layer visibility per band is driven by **global state**, not by zoom ranges; zoom ranges
     only bound what is parsed (one band spacing of overlap).
  4. Default `equal` transition: **6 steps over z4–z8**, configurable; the step count is a
     trade-off between snap size (∝ 1/N) and label blinks (∝ N), decided by the human in the demo.
  5. **Tile throughput** becomes a first-class requirement: more workers by default, decoded
     source tiles shared across bands, and a direct clip instead of geojson-vt.
- [ ] NO-GO

A truly imperceptible transition needs per-vertex interpolation in the renderer (MapLibre
#8330 or a fork following the globe-transition pattern). The polyfill approaches it; it cannot
reach it. This is recorded for the product decision, separately from Plan 2.

Notes for Plan 2/3: layer count 599 at 6 steps; no seam mitigation; the spec's hidden prefetch
layers are dropped; demos must not load the worker from `dist/` through Vite's transform
pipeline (stale after a rebuild); the spike's gated prototype (`demo/spike/gated-camera.ts`,
selector in `bands.ts`) stays on disk, untracked, as the implementers' reference until the
Plan 2 demo replaces it.
