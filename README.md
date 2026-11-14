# UltiUnwrapper

UltiUnwrapper is an instrumented UV unwrapping studio for input meshes. It runs a seven-stage unwrap, keeps an immutable snapshot of every stage, and lets you step back through the finished run to see where the automatic layout is weak.

Every stage keeps its own UVs, chart ids, seam edges, per-face metrics, atlas placements, issues, and duration. The UI replays those snapshots, so inspection does not rerun the pipeline.

## Features

- Imports FBX, OBJ, glTF, and GLB bundles. Companion textures and `.bin` files can be dropped with the primary model.
- Seven named stages: condition, segment, parameterize, normalize, inflate, pack, validate.
- 3D viewport with chart colors, seam and cut overlays, angle and area distortion heatmaps, flipped faces, texel-density heatmap, checker material, wireframe, and overlap view.
- 2D pane with the packed atlas for pack and validate, a diagnostic chart gallery for parameterize, normalize, and inflate, and a chart inventory for condition and segment.
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

The left rail lists all seven stages with a headline metric and warning count. Once a run finishes, select any stage to inspect its snapshot. The run summary below the rail shows the model, validation status, chart count, achieved density, occupancy, and overlap.

### View controls

The view menu is stage-specific.

| Stage | Views |
| --- | --- |
| Condition | Clay mesh with boundary edges in amber and non-manifold edges in red |
| Segment | Chart colors with seam edges in amber and geodesic cuts in pink |
| Parameterize | Angle distortion, area distortion, flipped faces, charts, clay |
| Normalize | Texel density, checker, area distortion, charts |
| Inflate | Density change, texel density, checker, area distortion, charts |
| Pack | Checker, charts, area distortion |
| Validate | Overlap, texel density, angle distortion, area distortion, flipped faces, charts |

`Seams` toggles all edge overlays. `Wireframe` draws triangle edges. `Clear chart` removes the current chart isolation.

### 2D pane

- `atlas`: true packed atlas with padding outlines and the overlap mask.
- `gallery`: one diagnostic cell per chart. A single shared scale preserves relative chart size, so density differences remain visible. In the inflate stage the normalized outline is dashed and the inflated outline is solid.
- `inventory`: chart count and a note that the stage has no flattened layout yet.

Click a chart in either pane to isolate it. Click empty space or use `Clear chart` to clear it.

### Run settings

Atlas resolution, padding, seam angle, target texel density, 90-degree rotation, fill-atlas, and split-by-object are editable in the inspector. Settings apply on the next `Unwrap` run and are marked as pending until then.

## Stages

| # | Stage | Work | Snapshot | Visualization |
| --- | --- | --- | --- | --- |
| 1 | Condition | World-space flatten, weld, degenerate removal, edge topology | Welded mesh, source map, boundary and non-manifold edges | Clay mesh, amber boundary, red non-manifold |
| 2 | Segment | Dihedral, object, material, and non-manifold seams; flood-fill charts; geodesic cuts for closed charts | Seam edges, chart ids, cut paths, chart areas | Chart colors, seam lines, cut lines |
| 3 | Parameterize | Per-chart local frame, pinned LSCM, harmonic initialization, winding correction, projection fallback | Chart-local UVs, angle and area distortion, flipped flags | Heatmaps, flipped faces, chart gallery |
| 4 | Normalize | Scale every chart to the target texel density | Per-chart scales, density before and after, required atlas area | Density heatmap, checker, area heatmap |
| 5 | Inflate | Raise faces below the reference density with a smoothed falloff; dense faces are pinned and charts are never shrunk | Inflation steps, attempted and inflated charts, density before and after | Density heatmap, checker, area heatmap |
| 6 | Pack | MaxRects packing with padding, optional 90-degree rotation, binary-search fit scaling | Placements, atlas UVs, occupancy, achieved density | Atlas, padding outlines, occupancy, checker |
| 7 | Validate | Interior raster overlap, percentile metrics, weakness ranking, pass/warn/error | Overlap mask, ranked weaknesses, summary | Overlap mask, weakness list, click-to-isolate |

Texel density is `sqrt(uvArea * atlasResolution^2 / worldArea)` in pixels per world unit. Stage 4 makes every chart reach the target when possible. Stage 5 then inflates individual faces below the reference density, pinning dense vertices, smoothing the displacement, and applying small steps; it never shrinks a chart. A step is rejected when it folds a triangle or lets the chart spread grow beyond 2%. The stage shows before and after spread, the number of inflated charts, and an optional density-change view. Stage 6 may reduce all charts uniformly when the target does not fit and reports the achieved density. With `fitToAtlas` enabled it instead grows every chart uniformly until the atlas is full, and reports the resulting higher density. Charts with large concave silhouettes use rasterized silhouette packing, so their bounding boxes may overlap while their triangles do not. Simpler chart sets use MaxRects with four free-rectangle heuristics, four item orders, and optional 90-degree rotation.

A closed chart cannot be flattened as a disk. Stage 2 finds a geodesic cut path, marks it as a seam, and resegments. The cut is shown in pink and counted in `cutsAdded`.

When the input has UVs, the pipeline reuses its UV islands and existing flattening by default, then normalizes density, inflates sparse faces, and repacks them. This avoids destroying a usable artist layout. Use `--rewrap` in the CLI to ignore source UVs and generate new seams; models without UVs always use the automatic path.

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

- `stage-01-condition.json` through `stage-07-validate.json` always.
- `stage-03` onward: OBJ with that stage's UVs.
- `stage-03` onward: SVG chart or atlas diagram. Pack and validate SVGs include padding outlines.

### Report

The JSON report includes tool version, input and output paths, the resolved config, mesh counts, per-stage duration/stats/issues, and a summary with atlas, texel density, distortion, overlap, and ranked weaknesses.

## Configuration

Defaults:

| Setting | Default |
| --- | --- |
| Atlas resolution | 2048 px |
| Padding | 8 px |
| Seam angle | 66 deg |
| Target texel density | 256 px per world unit |
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
```

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
src/lib/unwrap/      pipeline, segmentation, parameterization, density, inflation, packing, validation
src/lib/             model loading, viewport, atlas, metrics, demo mesh, worker
src/ui/              app shell, step inspector, pure UI state helpers
cli/                 shared CLI core and Node host
src/cli/             hidden-webview CLI host
src-tauri/           desktop shell, CLI bridge, icons
tests/               pipeline, CLI, export, UI state, and layout tests
```

## License

MIT. Portions are derived from UltiPixelizer; see `NOTICE`.
