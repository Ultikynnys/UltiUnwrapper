/** Shared, three-independent types for the unwrap core. */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type StageId =
  | 'condition'
  | 'segment'
  | 'parameterize'
  | 'normalize'
  | 'pack'
  | 'validate';

export type IssueSeverity = 'info' | 'warn' | 'error';

export type Issue = {
  stage: StageId;
  severity: IssueSeverity;
  code: string;
  message: string;
  chart?: number;
  triangle?: number;
  value?: number;
  threshold?: number;
};

export type StageStats = Record<string, number | string | boolean | null>;

/** A flattened scene: world-space triangles plus provenance for reports and
 * object-boundary seams. The core never imports three.js. */
export type RawMesh = {
  /** 3 floats per vertex, already transformed into world space. */
  positions: Float32Array;
  /** 3 vertex indices per triangle. */
  indices: Uint32Array;
  /** Source object index per triangle. */
  objectOfTriangle: Uint32Array;
  /** Source material/group index per triangle, or -1 when unavailable. */
  materialOfTriangle: Int32Array;
  /** Triangle index inside the source geometry. */
  sourceTriangle: Uint32Array;
  /** Source vertex index for each flattened vertex. */
  sourceVertex: Uint32Array;
  /** 6 floats per triangle in source corner order, when every source mesh
   * supplied UVs. Used to preserve artist seams before re-parameterizing. */
  triangleUvs?: Float32Array;
  /** Human-readable object names, indexed by `objectOfTriangle`. */
  objectNames: string[];
};

export type ConditionOptions = {
  /** Weld tolerance as a fraction of the mesh bounding-box diagonal. */
  weldEpsilon: number;
};

export type ConditionedMesh = {
  /** 3 floats per welded vertex, world space. */
  positions: Float32Array;
  /** 3 floats per welded vertex, area-weighted. */
  normals: Float32Array;
  /** 3 welded vertex indices per triangle. */
  indices: Uint32Array;
  objectOfTriangle: Uint32Array;
  materialOfTriangle: Int32Array;
  sourceTriangle: Uint32Array;
  /** Source vertex index of the first source vertex that mapped here. */
  sourceVertex: Uint32Array;
  /** 6 source UV floats per retained triangle, aligned with `indices`. */
  triangleUvs?: Float32Array;
  objectNames: string[];
  vertexCount: number;
  triangleCount: number;
};

export type ConditionResult = {
  mesh: ConditionedMesh;
  stats: StageStats;
  issues: Issue[];
};

export type MeshEdge = {
  a: number;
  b: number;
  /** Triangles sharing the undirected edge, in triangle order. */
  triangles: number[];
  boundary: boolean;
  nonManifold: boolean;
};

export type MeshTopology = {
  edges: MeshEdge[];
  /** Edge index for each triangle corner, or -1 for a degenerate corner. */
  edgeOfTriangle: Int32Array;
  boundaryEdges: number[];
  nonManifoldEdges: number[];
  /** Edge indices touching each vertex. */
  vertexEdges: number[][];
};

/** One connected UV island. `localIndices` splits vertices along seams, so
 * triangle corners that meet only at a cut are distinct chart vertices. */
export type Chart = {
  id: number;
  /** Global triangle indices, ascending. */
  triangles: Uint32Array;
  /** 3 chart-local vertex indices per triangle. */
  localIndices: Uint32Array;
  /** Global welded vertex id for each chart-local vertex. */
  localVertex: Uint32Array;
  worldArea: number;
  /** Edge ids on the chart border (model boundary, seam, or non-manifold). */
  boundaryEdges: number[];
  /** Connected components of the boundary graph; 0 means closed. */
  boundaryComponents: number;
  closed: boolean;
};

export type Segmentation = {
  /** 1 for every chart border edge, including model boundaries. */
  seamEdge: Uint8Array;
  /** Edge ids added by closed-chart geodesic cuts. */
  cutEdgeIndices: Uint32Array;
  charts: Chart[];
  chartOfTriangle: Uint32Array;
  stats: StageStats;
  issues: Issue[];
};

export type ChartFailure =
  | 'degenerate'
  | 'not-disk'
  | 'no-boundary-loop'
  | 'embedding-failed'
  | 'solve-diverged'
  | 'folded-solution';

export type ChartUv = {
  chart: number;
  /** Global triangle indices, aligned with `localIndices`. */
  triangles: Uint32Array;
  /** 3 chart-local vertex indices per triangle. */
  localIndices: Uint32Array;
  /** Global welded vertex id per chart-local vertex. */
  localVertex: Uint32Array;
  /** 2 floats per chart-local vertex. */
  uvs: Float32Array;
  worldArea: number;
  uvArea: number;
  bbox: { minU: number; minV: number; maxU: number; maxV: number };
  solverIterations: number;
  solverResidual: number;
  solverConverged: boolean;
  initialization: 'projection' | 'harmonic' | 'source' | 'none';
  /** True when the chart could not be flattened; `failure` names the reason. */
  failed: boolean;
  failure: ChartFailure | null;
};

export type ParameterizeOptions = {
  /** Relative residual target for the LSCM solve. */
  tolerance?: number;
  /** Hard cap on conjugate-gradient iterations. */
  maxIterations?: number;
  /** Largest share of flipped triangles a solve may have and still be used. */
  maxFlippedFraction?: number;
  /** Best texel density the atlas can deliver, in pixels per world unit.
   * Overlaps that stay below one texel at this density are ignored. */
  texelDensity?: number;
  /** Reuse the source UV layout instead of solving a new flattening. */
  sourceUvs?: boolean;
  /** Per-triangle mask. Charts containing any set triangle are solved
   * instead of reusing the source UV layout. */
  reparameterizeMask?: Uint8Array;
};

export type ParameterizeResult = {
  charts: ChartUv[];
  /** 6 floats per global triangle: u0,v0,u1,v1,u2,v2. */
  triangleUvs: Float32Array;
  angleDistortion: Float32Array;
  areaDistortion: Float32Array;
  flipped: Uint8Array;
  stats: StageStats;
  issues: Issue[];
};

export type DensityOptions = {
  /** Atlas edge length in texels. */
  atlasResolution: number;
  /** Target texel density in pixels per world unit. */
  targetTexelDensity: number;
  minChartScale?: number;
  maxChartScale?: number;
};

export type DensityResult = {
  charts: ChartUv[];
  /** 6 floats per global triangle in atlas-fraction UV units. */
  triangleUvs: Float32Array;
  /** Per-face texel density in pixels per world unit. */
  faceTexelDensity: Float32Array;
  /** Per-face density divided by the target. */
  densityRatio: Float32Array;
  /** Per-chart normalization scale, indexed by chart id. */
  chartScales: Float32Array;
  stats: StageStats;
  issues: Issue[];
};

export type ChartPlacement = {
  chart: number;
  /** Chart bounds in atlas texels, bottom-left origin. Concave packing may
   * make these bounds overlap while the chart triangles do not. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
};

export type PackedChart = ChartUv & {
  placement: ChartPlacement;
};

export type WeaknessKind = 'overlap' | 'angle' | 'area' | 'density' | 'flipped';

export type Weakness = {
  chart: number;
  kind: WeaknessKind;
  value: number;
  threshold: number;
  severity: 'warn' | 'error';
  message: string;
  score: number;
};

export type AtlasInfo = {
  resolution: number;
  padding: number;
  scale: number;
  occupancy: number;
  placements: ChartPlacement[];
};

export type PackResult = {
  charts: PackedChart[];
  /** 6 floats per global triangle, atlas UVs in [0,1]. */
  triangleUvs: Float32Array;
  placements: ChartPlacement[];
  /** Uniform chart scale applied by the packer: 1 unless fill grows the
   * layout to the atlas. */
  scale: number;
  achievedTexelDensity: number;
  faceTexelDensity: Float32Array;
  /** Rasterized triangle coverage over the atlas area. */
  occupancy: number;
  stats: StageStats;
  issues: Issue[];
};

export type StageStatus = 'ok' | 'warn' | 'error';

export type StageSnapshot = {
  id: StageId;
  index: number;
  label: string;
  durationMs: number;
  status: StageStatus;
  stats: StageStats;
  issues: Issue[];
  /** 6 floats per global triangle, null before parameterization. */
  uvs: Float32Array | null;
  chartOfTriangle: Uint32Array | null;
  chartCount: number;
  /** Edge ids on the chart border, including model boundaries and cuts. */
  seamEdges: Uint32Array | null;
  /** Edge ids added by geodesic cuts. */
  cutEdges: Uint32Array | null;
  charts: ChartUv[] | null;
  atlas: AtlasInfo | null;
  face: {
    angleDistortion?: Float32Array;
    areaDistortion?: Float32Array;
    texelDensity?: Float32Array;
    densityRatio?: Float32Array;
    flipped?: Uint8Array;
  };
  overlapMask: Uint8Array | null;
  overlapWidth: number;
  overlapHeight: number;
  weaknesses: Weakness[];
};


