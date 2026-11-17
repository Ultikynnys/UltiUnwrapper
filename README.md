# UltiUnwrapper

UltiUnwrapper is an instrumented UV unwrapping studio for input meshes. It runs a six-stage unwrap plan chosen by method, keeps an immutable snapshot of every stage, and lets you step back through the finished run to see where the automatic layout is weak.

Every stage keeps its own UVs, chart ids, seam edges, per-face metrics, atlas placements, issues, and duration. The UI replays those snapshots, so inspection does not rerun the pipeline.

## Features

- Imports FBX, OBJ, glTF, and GLB bundles. Companion textures and `.bin` files can be dropped with the primary model.
- Two unwrap methods with separate stage plans. Smart projection runs condition, project, islands, normalize, pack, validate. LSCM runs condition, segment, parameterize, normalize, pack, validate.
- Island refinement runs a per-model portfolio of growth and mirror variants across cut layouts and merge seeds on worker threads, keeps the best valid layout, and falls back to one thread when workers are unavailable.
- Mirror symmetry is detected from geometry. On-plane edges become clean chart seams, and a symmetry cut can split charts that still cross the mirror plane.
- The packer rotates charts to their smallest axis-aligned bounding box before silhouette packing, improving occupancy without changing density.
- The refinement merge kernel runs in WebAssembly, with a JavaScript fallback and a committed binary for browser, Tauri, and Node.
- 3D viewport with chart colors, seam and cut overlays, angle and area distortion heatmaps, flipped faces, texel-density heatmap, checker material, wireframe, and overlap view.
- 2D pane with the packed atlas for pack and validate, a diagnostic chart gallery for parameterize, normalize, and islands, and a chart inventory for condition, project, and segment.
- Synchronized chart selection: click a chart in 3D or 2D and both panes isolate it.
- Ranked weakness list. Selecting a weakness jumps to validate, isolates the chart, and switches to the matching heatmap.
- Metrics strip, per-stage stat and issue inspector, distortion and density histograms.
- OBJ, geometry-only GLB, and JSON report downloads from the app.
- CLI with presets, per-stage artifact dumps, threshold checks, and JSON output.
- Tauri desktop shell that embeds the same CLI through a hidden webview.

## Quick start

```bash
cd UltiUnwrapper
npm install
npm run dev
```

Open `http://localhost:5173`. Click `Demo cube` for a synthetic six-chart example, or `Import model` to load a model bundle. The unwrap starts automatically after a model loads.

```bash
npm test
npm run test:coverage
npm run typecheck
npm run build
npm run cli -- --help
```

## UI guide

### Stage rail

The left rail lists the stages of the run's method with a headline metric and warning count. Once a run finishes, select any stage to inspect its snapshot. The run summary below the rail shows the model, validation status, chart count, achieved density, occupancy, and overlap.

### View controls

The view menu is stage-specific.

| Stage | Views |
| --- | --- |
| Condition | Clay mesh with boundary edges in amber and non-manifold edges in red |
| Project | Clay mesh with the projected face assignment |
| Islands | Chart colors and clay |
| Segment | Chart colors with seam edges in amber and geodesic cuts in pink |
| Parameterize | Angle distortion, area distortion, flipped faces, charts, clay |
| Normalize | Texel density, checker, area distortion, charts |
| Pack | Checker, charts, area distortion |
| Validate | Overlap, texel density, angle distortion, area distortion, flipped faces, charts |

`Seams` toggles all edge overlays. `Wireframe` draws triangle edges. `Clear chart` removes the current chart isolation.

### 2D pane

- `atlas`: true packed atlas with the overlap mask.
- `gallery`: one diagnostic cell per chart. A single shared scale preserves relative chart size, so density differences remain visible.
- `inventory`: chart count and a note that the stage has no flattened layout yet.

Click a chart in either pane to isolate it. Click empty space or use `Clear chart` to clear it.

### Run settings

Unwrap method, atlas resolution, padding, seam angle, target texel density, 90-degree rotation, fill-atlas, and split-by-object are editable in the inspector. Settings apply on the next `Unwrap` run and are marked as pending until then.

## Stages

Each method has its own stage plan. Both plans share condition, normalize, pack, and validate.

### Smart projection (default)

| # | Stage | Work | Snapshot | Visualization |
| --- | --- | --- | --- | --- |
| 1 | Condition | World-space flatten, weld, degenerate removal, edge topology | Welded mesh, source map, boundary and non-manifold edges | Clay mesh, amber boundary, red non-manifold |
| 2 | Project | Cluster face normals into projector axes and assign every face its best axis | Projector assignment, projected UVs, normal dot products, zero-area faces | Clay mesh, projected face assignment |
| 3 | Islands | Detect mirror symmetry, grow projected faces into edge-connected islands across tight, balanced, wide, and mirror-seam variants, merge compatible neighbours, split at object and material boundaries, cut islands whose texel density still varies more than the threshold, cut charts on the mirror plane, then merge neighbours back while the density stays inside the budget | Island charts, chart ids, seam edges, density rounds, cuts, merges, variant and mirror stats | Chart colors, chart gallery |
| 4 | Normalize | Equalize every island to one nominal texel density before packing | Density scale range, density before and after, required atlas area | Density heatmap, checker, area heatmap |
| 5 | Pack | Concave silhouette packing with padding, optional 90-degree rotation, fail on overflow | Placements, atlas UVs, occupancy, achieved density | Atlas, occupancy, checker |
| 6 | Validate | Interior raster overlap, percentile metrics, weakness ranking, pass/warn/error | Overlap mask, ranked weaknesses, summary | Overlap mask, weakness list, click-to-isolate |

### LSCM

| # | Stage | Work | Snapshot | Visualization |
| --- | --- | --- | --- | --- |
| 1 | Condition | World-space flatten, weld, degenerate removal, edge topology | Welded mesh, source map, boundary and non-manifold edges | Clay mesh, amber boundary, red non-manifold |
| 2 | Segment | Dihedral, object, material, and non-manifold seams; flood-fill charts; geodesic cuts for closed charts; density-budget refinement | Seam edges, chart ids, cut paths, chart areas | Chart colors, seam lines, cut lines |
| 3 | Parameterize | Per-chart local frame, pinned LSCM, harmonic initialization, winding correction, projection fallback | Chart-local UVs, angle and area distortion, flipped flags | Heatmaps, flipped faces, chart gallery |
| 4 | Normalize | Scale every chart to the target texel density | Per-chart scales, density before and after, required atlas area | Density heatmap, checker, area heatmap |
| 5 | Pack | Concave silhouette packing with padding, optional 90-degree rotation, fail on overflow | Placements, atlas UVs, occupancy, achieved density | Atlas, occupancy, checker |
| 6 | Validate | Interior raster overlap, percentile metrics, weakness ranking, pass/warn/error | Overlap mask, ranked weaknesses, summary | Overlap mask, weakness list, click-to-isolate |

Texel density is `sqrt(uvArea * atlasResolution^2 / worldArea)` in pixels per world unit. In the LSCM plan stage 4 scales every chart to the target. The smart plan detects mirror planes by reflecting sampled vertices onto a spatial hash, applies tight, balanced, and wide growth variants plus a mirror-seam variant, and keeps the best valid layout. Stage 3 cuts islands until each island's density variation is below the threshold, including a symmetry cut for charts that still cross the detected plane, then stage 4 equalizes every island to one nominal density before packing. Once every variant has an initial result, the pool stops early when no layout improves for a stagnation window instead of repeating the same seeds. Stage 5 fails the run when the charts cannot be placed at the requested density and `fitToAtlas` is off. With `fitToAtlas` on, the packer first grows the layout to fill the atlas. Sparse first-fit layouts are repacked at larger scales so the atlas height is used as well as its width. When the requested density still does not fit, the packer emits a `density-fitted` warning and places the layout at the largest scale that fits. Charts are first rotated to their smallest axis-aligned bounding box, following xatlas's chart-to-axis alignment, then rasterized as silhouettes. Their bounding boxes may overlap while their triangles do not. The packer tries multiple insertion orders and the requested rotations, and the run fails instead of falling back to rectangular bounds.

### Island strategy portfolio

The smart islands stage detects mirror symmetry from geometry, then builds tight, balanced, and wide growth variants. When a mirror plane is found, it adds a mirror-seam variant whose on-plane edges are chart borders and whose cut strategy can split charts that still cross the plane. All variant bases are sent to the refinement workers, and `(variant, cut strategy, seed)` tasks run in parallel. The winning layout is selected by unresolved density, island count, and a bounding-box packability tie-break.

The stage reports `strategyVariants`, `strategyAttempts`, `bestVariant`, `bestStrategy`, `mirrorPlaneScore`, `mirrorDetectedSeams`, `symmetrySeams`, and `refineStoppedEarly`. Once every strategy has a result, the pool stops early when no layout improves for a stagnation window instead of repeating seeds until the full budget expires.

On the bundled `Model1.fbx` and `Model2.fbx` at 10 seconds and four threads, the portfolio reaches 142 islands, 9.97% density spread, 60.2% occupancy, and zero overlap. Axis alignment reduces the total chart bounding-box area by about 15% on both models, which is what lets the packer hold the target density at scale 1 instead of shrinking to 0.975. A single-thread 10 second run on `Model1.fbx` reaches 145 islands.

A closed chart cannot be flattened as a disk. In the LSCM plan stage 2 runs up to 24 cut-and-flatten rounds, finds a geodesic cut path for a failing chart, marks it as a seam, and resegments. The cut is shown in pink and counted in `cutsAdded`.

When the input has UVs, the LSCM plan starts from its UV islands and existing flattening by default, cuts and re-solves charts that exceed the density budget, then normalizes density and repacks them. This preserves a usable artist layout while still refining sparse or stretched islands. Use `--rewrap` in the CLI to ignore source UVs and generate new seams; models without UVs always use the automatic path.

## CLI

The CLI uses the same pipeline and report format as the app.

```bash
npm run cli -- -i prop.fbx -o prop_unwrapped.glb \
  --report prop.unwrap.json --check
```

Common flags:

| Flag | Meaning |
| --- | --- |
| `-i, --input <file>` | FBX, OBJ, glTF, or GLB input |
| `-o, --output <file>` | Output mesh; default `<input>_unwrapped.obj` |
| `--format <obj\|glb>` | Output format; inferred from the output extension |
| `--report <file>` | Write the JSON report |
| `--dump-stages <dir>` | Per-stage JSON plus OBJ and SVG where available |
| `--stage <id>` | Stop writing after a stage; earlier stages still run |
| `--validate-only` | Run every stage but skip mesh export |
| `--method <smart\|lscm>` | Unwrap method; smart projects faces first, lscm segments and parameterizes |
| `--projection-angle <deg>` | Smart projection angle limit between neighbouring faces |
| `--projection-area-weight <f>` | Smart projection area weighting from 0 to 1 |
| `--refine-budget <s>` | Island density cut and merge budget in seconds |
| `--refine-threads <n>` | Refinement threads; 0 chooses up to four automatically, 1 runs single-threaded |
| `--rewrap` | Ignore input UVs and generate new seams |
| `--atlas`, `--padding`, `--seam-angle`, `--texel-density` | Core layout settings |
| `--fit-atlas`, `--no-fit-atlas` | Grow charts to fill the atlas, or hold the target density |
| `--preset <file>` | Load an unwrap preset |
| `--dump-config [<file>]` | Write resolved settings and exit |
| `--json` | Print a machine-readable summary |
| `--check` | Exit 1 when validation status is error |
| `--list-stages`, `--version`, `-h, --help` | Information commands |

Run `npm run cli -- --help` for every setting and threshold flag.

Exit codes:

- `0`: success, including warnings unless `--check` sees an error.
- `1`: `--check` failed a validation threshold.
- `2`: argument, preset, model, or file error.

### Stage artifacts

`--dump-stages <dir>` writes:

- one JSON per stage in the method plan, for example `stage-02-project.json` for smart or `stage-02-segment.json` for LSCM.
- one OBJ for every stage with UVs, named after the stage, for example `stage-02-project.obj` or `stage-03-parameterize.obj`.
- one SVG for every stage with charts, packed as an atlas for pack and validate and as a chart gallery otherwise.

### Report

The JSON report includes tool version, input and output paths, the resolved config, mesh counts, per-stage duration/stats/issues, and a summary with atlas, texel density, distortion, overlap, and ranked weaknesses.

## Configuration

Defaults:

| Setting | Default |
| --- | --- |
| Unwrap method | smart |
| Atlas resolution | 2048 px |
| Padding | 8 px |
| Seam angle | 66 deg |
| Projection angle limit | 66 deg |
| Projection area weight | 0 |
| Target texel density | 256 px per world unit |
| Island refinement budget | 10 s |
| Refinement threads | auto, up to 4 |
| Weld epsilon | 1e-5 of the bounding-box diagonal |
| Split by object | on |
| Split by material | off |
| Allow chart rotation | on |
| Occupancy raster | 1024 px |
| Max overlap fraction | 0.001 |
| Max angle p95 | 20 deg |
| Max density spread | 0.1 |
| Max flipped triangles | 0 |
| Minimum occupancy | 0.3 |

Threaded refinement uses up to four workers when `refineThreads` is 0. The merge kernel runs as a committed WebAssembly module; if it cannot load, the JavaScript kernel runs instead. On the bundled `examples/Model1.fbx` with a 10 s budget, one thread runs the sequential JavaScript search at about 40 tasks, while two and four threads run roughly 2,800 and 3,000 to 4,600 WASM tasks. The JavaScript fallback runs about 900 and 1,800 to 2,000 tasks at the same budgets. Both reach the same 142-island, 60.2% occupancy layout.

## Model intake and limits

- FBX and OBJ are oriented as Z-up sources by default. glTF and GLB are Y-up and are not rotated.
- USDZ is not supported by the bundled loaders. Convert it to GLB or FBX.
- Skinned meshes are unwrapped in their current world pose. Animations are ignored.
- Output GLB contains geometry and UVs only. Materials and textures are not preserved.
- No manual seam painting, UV editing, UDIM, lightmap channels, or texture rebaking in this version.
- Validation rasterization is capped at 2048 px. The UI uses the configured occupancy resolution up to that cap.

## Development

```bash
npm run dev
npm run cli -- --help
npm test
npm run test:coverage
npm run typecheck
npm run build
npm run build:wasm
```

`npm run build:wasm` requires Rust with the `wasm32-unknown-unknown` target. The generated module is committed, so normal app and CLI builds do not require Rust.

Coverage covers `src/lib/unwrap/**` plus `cli/config.ts` and `cli/main.ts`. The gate is 95% lines and statements, 100% functions, and 85% branches. UI and platform loaders are excluded.

The step-inspector UI is covered by pure state, layout, metric, and report tests plus Playwright smoke runs during development. No automated visual-regression suite is checked in.

### Versioning

The version is `0.1.<git commit count>`. It is stamped into:

- the topbar badge by `vite.config.ts`,
- the CLI `--version` output by `src/lib/buildInfo.ts`,
- the Tauri installer by `scripts/write-tauri-version.mjs`.

No version is hardcoded in the app, installer config, or CLI.

### Desktop

```bash
npm run tauri:dev
npm run tauri:build
```

The desktop binary opens the app when launched without arguments. Any argument opens the hidden CLI webview, so the installer and CLI ship as one executable.

## Layout

```text
src/lib/unwrap/      pipeline, smart projection, segmentation, parameterization, density, packing, validation
src/lib/             model loading, viewport, atlas, metrics, demo mesh, worker
src/ui/              app shell, step inspector, pure UI state helpers
cli/                 shared CLI core and Node host
src/cli/             hidden-webview CLI host
src-tauri/           desktop shell, CLI bridge, icons
tests/               pipeline, CLI, export, UI state, and layout tests
```

## License

MIT. Portions are derived from UltiPixelizer; see `NOTICE`.
