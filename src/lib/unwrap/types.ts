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
