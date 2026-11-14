# Changelog

## 0.1.9

- Added the step-inspector UI: worker-driven unwraps, selectable stage rail, 3D viewport, 2D atlas and chart gallery, synchronized chart isolation, metrics, histograms, weakness ranking, settings, demo mesh, model bundles, and OBJ/GLB/report downloads.
- Added stage-specific 3D views for boundary and non-manifold edges, chart colors, seams, geodesic cuts, angle and area distortion, flipped faces, texel density, checker material, wireframe, and overlap.
- Added chart-gallery layout with shared scaling so relative chart density remains visible.
- Added 2D and 3D chart picking, browser model loading for FBX/OBJ/glTF/GLB, and FBX/OBJ world-axis handling.
- Completed the shared CLI with presets, resolved-config dumps, stage artifact dumps, JSON summaries, `--check` thresholds, and OBJ/GLB output.
- Added validation reports, overlap masks, ranked weaknesses, and stage snapshots for every pipeline step.
- Added test coverage for colors, CLI parsing and config, report fallbacks, conditioning edge cases, segmentation limits, density clamps, packing overflow, solver failures, and UI state.
- Stamped the git-count version into the Vite app badge, CLI, and Tauri installer.

## 0.1.0

- Initial repository: application shell, CLI host split, desktop bridge, and git-count versioning.
