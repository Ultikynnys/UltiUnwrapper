# UltiUnwrapper

UltiUnwrapper is an instrumented UV unwrapping studio. It runs a staged unwrap, keeps every stage's result, and lets you step back through the run to see where the automated layout got weak.

## Stages

| # | Stage | What it leaves behind |
| --- | --- | --- |
| 1 | Condition | Welded world-space mesh, topology issues |
| 2 | Segment | Seam edges, chart ids, closed-chart cuts |
| 3 | Parameterize | Chart-local UVs, angle and area distortion |
| 4 | Normalize density | Uniform texel density per chart |
| 5 | Pack atlas | Atlas UVs, padding, occupancy, achieved density |
| 6 | Validate | Overlap mask, percentile metrics, ranked weaknesses |

## Development

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

The CLI development entry is `npm run cli -- --help`. The desktop binary uses the same pipeline through a hidden webview.

## Versioning

The version is `0.1.<git commit count>`. The in-app badge, the Tauri installer, and the CLI `--version` output derive from the same script.

## License

MIT. Portions derived from UltiPixelizer; see `NOTICE`.
