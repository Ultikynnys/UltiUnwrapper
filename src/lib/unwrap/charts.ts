import type { FaceGeometry } from './mesh';
import { edgeLength } from './topology';
import type { Chart, ConditionedMesh, Issue, MeshTopology, Segmentation, StageStats } from './types';
import { computeSeams, type SeamOptions, type SeamResult } from './seams';

export type SegmentOptions = SeamOptions & {
  /** Maximum cut attempts per closed chart run. */
  maxClosedChartCuts?: number;
};

export type ChartSet = {
  charts: Chart[];
  chartOfTriangle: Uint32Array;
};

class DisjointSet {
  private readonly parent: Int32Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i += 1) this.parent[i] = i;
  }

  find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root];
    let current = value;
    while (this.parent[current] !== current) {
      const next = this.parent[current];
      this.parent[current] = root;
      current = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

type HeapEntry = { vertex: number; distance: number };

class MinHeap {
  private readonly entries: HeapEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  private less(a: HeapEntry, b: HeapEntry): boolean {
    return a.distance < b.distance || (a.distance === b.distance && a.vertex < b.vertex);
  }

  push(vertex: number, distance: number): void {
    const entry = { vertex, distance };
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.less(entry, this.entries[parent])) break;
      this.entries[index] = this.entries[parent];
      index = parent;
    }
    this.entries[index] = entry;
  }

  pop(): HeapEntry | null {
    if (this.entries.length === 0) return null;
    const root = this.entries[0];
    const last = this.entries.pop()!;
    if (this.entries.length === 0) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.entries.length) break;
      let child = left;
      if (right < this.entries.length && this.less(this.entries[right], this.entries[left])) child = right;
      if (!this.less(this.entries[child], last)) break;
      this.entries[index] = this.entries[child];
      index = child;
    }
    this.entries[index] = last;
    return root;
  }
}

function chartBoundaryLists(
  topology: MeshTopology,
  seamEdge: Uint8Array,
  chartOfTriangle: Uint32Array,
  chartCount: number,
): number[][] {
  const lists: number[][] = Array.from({ length: chartCount }, () => []);
  for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
    const edge = topology.edges[edgeIndex];
    if (!seamEdge[edgeIndex] && !edge.boundary && !edge.nonManifold) continue;
    const chartIds = new Set<number>();
    for (const triangle of edge.triangles) chartIds.add(chartOfTriangle[triangle]);
    for (const chart of chartIds) lists[chart].push(edgeIndex);
  }
  return lists;
}

function analyzeBoundary(
  boundaryEdges: number[],
  topology: MeshTopology,
): { count: number; componentOf: Map<number, number> } {
  const componentOf = new Map<number, number>();
  if (boundaryEdges.length === 0) return { count: 0, componentOf };
  const adjacency = new Map<number, number[]>();
  for (const edgeIndex of boundaryEdges) {
    const edge = topology.edges[edgeIndex];
    const a = adjacency.get(edge.a);
    if (a) a.push(edge.b);
    else adjacency.set(edge.a, [edge.b]);
    const b = adjacency.get(edge.b);
    if (b) b.push(edge.a);
    else adjacency.set(edge.b, [edge.a]);
  }
  let count = 0;
  for (const start of adjacency.keys()) {
    if (componentOf.has(start)) continue;
    const stack = [start];
    componentOf.set(start, count);
    while (stack.length > 0) {
      const vertex = stack.pop()!;
      for (const neighbor of adjacency.get(vertex) ?? []) {
        if (componentOf.has(neighbor)) continue;
        componentOf.set(neighbor, count);
        stack.push(neighbor);
      }
    }
    count += 1;
  }
  return { count, componentOf };
}

function buildLocalVertices(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  seamEdge: Uint8Array,
  chartOfTriangle: Uint32Array,
  chartId: number,
  triangles: Uint32Array,
): { localIndices: Uint32Array; localVertex: Uint32Array } {
  const triangleCount = triangles.length;
  const cornerCount = triangleCount * 3;
  const set = new DisjointSet(cornerCount);
  const localTriangles = new Map<number, number>();
  for (let local = 0; local < triangleCount; local += 1) localTriangles.set(triangles[local], local);

  const cornerOf = (triangle: number, vertex: number): number => {
    const local = localTriangles.get(triangle);
    if (local === undefined) return -1;
    for (let corner = 0; corner < 3; corner += 1) {
      if (mesh.indices[triangle * 3 + corner] === vertex) return local * 3 + corner;
    }
    return -1;
  };

  const edgeIds = new Set<number>();
  for (let local = 0; local < triangleCount; local += 1) {
    const triangle = triangles[local];
    for (let corner = 0; corner < 3; corner += 1) {
      const edge = topology.edgeOfTriangle[triangle * 3 + corner];
      if (edge >= 0) edgeIds.add(edge);
    }
  }
  for (const edgeIndex of edgeIds) {
    const edge = topology.edges[edgeIndex];
    if (edge.boundary || edge.nonManifold || seamEdge[edgeIndex]) continue;
    if (edge.triangles.length !== 2) continue;
    const t0 = edge.triangles[0];
    const t1 = edge.triangles[1];
    if (chartOfTriangle[t0] !== chartId || chartOfTriangle[t1] !== chartId) continue;
    const c0a = cornerOf(t0, edge.a);
    const c1a = cornerOf(t1, edge.a);
    const c0b = cornerOf(t0, edge.b);
    const c1b = cornerOf(t1, edge.b);
    if (c0a >= 0 && c1a >= 0) set.union(c0a, c1a);
    if (c0b >= 0 && c1b >= 0) set.union(c0b, c1b);
  }

  const localIndices = new Uint32Array(cornerCount);
  const localVertex: number[] = [];
  const rootToLocal = new Map<number, number>();
  for (let corner = 0; corner < cornerCount; corner += 1) {
    const root = set.find(corner);
    let local = rootToLocal.get(root);
    if (local === undefined) {
      local = localVertex.length;
      rootToLocal.set(root, local);
      const globalTriangle = triangles[(corner / 3) | 0];
      localVertex.push(mesh.indices[globalTriangle * 3 + (corner % 3)]);
    }
    localIndices[corner] = local;
  }
  return { localIndices, localVertex: new Uint32Array(localVertex) };
}

/** Splits the mesh into connected charts across every non-seam edge. Chart ids
 * are assigned by the lowest triangle index, so results are deterministic. */
export function segmentCharts(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  seamEdge: Uint8Array,
  face: FaceGeometry,
): ChartSet {
  const set = new DisjointSet(mesh.triangleCount);
  for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
    const edge = topology.edges[edgeIndex];
    if (seamEdge[edgeIndex] || edge.boundary || edge.nonManifold) continue;
    if (edge.triangles.length !== 2) continue;
    set.union(edge.triangles[0], edge.triangles[1]);
  }

  const chartOfTriangle = new Uint32Array(mesh.triangleCount);
  const chartTriangles: number[][] = [];
  const rootToChart = new Map<number, number>();
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    const root = set.find(triangle);
    let chart = rootToChart.get(root);
    if (chart === undefined) {
      chart = chartTriangles.length;
      rootToChart.set(root, chart);
      chartTriangles.push([]);
    }
    chartOfTriangle[triangle] = chart;
    chartTriangles[chart].push(triangle);
  }

  const boundaries = chartBoundaryLists(topology, seamEdge, chartOfTriangle, chartTriangles.length);
  const charts: Chart[] = chartTriangles.map((triangles, id) => {
    const indices = new Uint32Array(triangles);
    let worldArea = 0;
    for (const triangle of triangles) worldArea += face.areas[triangle];
    const local = buildLocalVertices(mesh, topology, seamEdge, chartOfTriangle, id, indices);
    const boundary = analyzeBoundary(boundaries[id], topology);
    return {
      id,
      triangles: indices,
      localIndices: local.localIndices,
      localVertex: local.localVertex,
      worldArea,
      boundaryEdges: boundaries[id],
      boundaryComponents: boundary.count,
      closed: boundaries[id].length === 0,
    };
  });
  return { charts, chartOfTriangle };
}

type DijkstraResult = {
  distances: Float64Array;
  parentVertex: Int32Array;
  parentEdge: Int32Array;
  farthest: number;
};

function dijkstra(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  chartTriangles: Set<number>,
  seamEdge: Uint8Array,
  source: number,
): DijkstraResult {
  const distances = new Float64Array(mesh.vertexCount).fill(Infinity);
  const parentVertex = new Int32Array(mesh.vertexCount).fill(-1);
  const parentEdge = new Int32Array(mesh.vertexCount).fill(-1);
  const visited = new Uint8Array(mesh.vertexCount);
  const heap = new MinHeap();
  distances[source] = 0;
  heap.push(source, 0);
  let farthest = source;

  while (heap.size > 0) {
    const entry = heap.pop()!;
    if (visited[entry.vertex]) continue;
    if (entry.distance > distances[entry.vertex]) continue;
    visited[entry.vertex] = 1;
    if (
      entry.distance > distances[farthest]
      || (entry.distance === distances[farthest] && entry.vertex < farthest)
    ) {
      farthest = entry.vertex;
    }
    for (const edgeIndex of topology.vertexEdges[entry.vertex]) {
      const edge = topology.edges[edgeIndex];
      if (edge.boundary || edge.nonManifold || seamEdge[edgeIndex]) continue;
      if (edge.triangles.length !== 2) continue;
      if (!chartTriangles.has(edge.triangles[0]) || !chartTriangles.has(edge.triangles[1])) continue;
      const neighbor = edge.a === entry.vertex ? edge.b : edge.a;
      if (visited[neighbor]) continue;
      const next = entry.distance + edgeLength(mesh, edge);
      if (next < distances[neighbor] - 1e-12) {
        distances[neighbor] = next;
        parentVertex[neighbor] = entry.vertex;
        parentEdge[neighbor] = edgeIndex;
        heap.push(neighbor, next);
      }
    }
  }

  return { distances, parentVertex, parentEdge, farthest };
}

/** Finds a geodesic cut between two extreme vertices of a closed chart. The
 * path opens the chart into a disk without adding a second disconnected
 * island. Returns the edge ids to mark as seams. */
export function findClosedChartCut(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  chart: Chart,
  seamEdge: Uint8Array,
): number[] {
  if (!chart.closed || chart.triangles.length === 0) return [];
  const chartTriangles = new Set<number>(chart.triangles);
  const source = mesh.indices[chart.triangles[0] * 3];
  const first = dijkstra(mesh, topology, chartTriangles, seamEdge, source);
  if (first.farthest === source) return [];
  const second = dijkstra(mesh, topology, chartTriangles, seamEdge, first.farthest);
  const target = second.farthest;
  if (target === first.farthest) return [];

  const path: number[] = [];
  let vertex = target;
  while (vertex !== first.farthest) {
    const edge = second.parentEdge[vertex];
    const parent = second.parentVertex[vertex];
    if (edge < 0 || parent < 0) return [];
    path.push(edge);
    vertex = parent;
    if (path.length > mesh.vertexCount) return [];
  }
  return path;
}

/** Cuts an open disk chart between two far-apart boundary vertices. The
 * interior path splits one large island into two without touching unrelated
 * charts. */
export function findChartBisection(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  chart: Chart,
  seamEdge: Uint8Array,
): number[] {
  if (chart.closed || chart.boundaryComponents !== 1 || chart.triangles.length < 2) return [];
  const boundaryVertices = new Set<number>();
  for (const edgeIndex of chart.boundaryEdges) {
    const edge = topology.edges[edgeIndex];
    if (!edge) continue;
    boundaryVertices.add(edge.a);
    boundaryVertices.add(edge.b);
  }
  if (boundaryVertices.size < 2) return [];

  const chartTriangles = new Set<number>(chart.triangles);
  const interiorDegree = (vertex: number): number => {
    let degree = 0;
    for (const edgeIndex of topology.vertexEdges[vertex]) {
      const edge = topology.edges[edgeIndex];
      if (!edge || edge.boundary || edge.nonManifold || seamEdge[edgeIndex]) continue;
      if (edge.triangles.length !== 2) continue;
      if (!chartTriangles.has(edge.triangles[0]) || !chartTriangles.has(edge.triangles[1])) continue;
      degree += 1;
    }
    return degree;
  };
  const sources = [...boundaryVertices]
    .sort((a, b) => interiorDegree(b) - interiorDegree(a))
    .slice(0, 12);

  for (const source of sources) {
    const first = dijkstra(mesh, topology, chartTriangles, seamEdge, source);
    let target = -1;
    let farthest = -1;
    for (const vertex of boundaryVertices) {
      if (vertex === source) continue;
      const distance = first.distances[vertex];
      if (!Number.isFinite(distance)) continue;
      if (distance > farthest) {
        farthest = distance;
        target = vertex;
      }
    }
    if (target < 0 || target === source) continue;

    const second = dijkstra(mesh, topology, chartTriangles, seamEdge, target);
    if (!Number.isFinite(second.distances[source])) continue;
    const path: number[] = [];
    let vertex = source;
    while (vertex !== target) {
      const edge = second.parentEdge[vertex];
      const parent = second.parentVertex[vertex];
      if (edge < 0 || parent < 0) {
        path.length = 0;
        break;
      }
      path.push(edge);
      vertex = parent;
      if (path.length > mesh.vertexCount) {
        path.length = 0;
        break;
      }
    }
    if (path.length > 0) return path;
  }
  return [];
}

/** Connects two separate boundary loops of an open chart. The shortest
 * interior path between the loops turns an annulus-like chart into a disk. */
export function findBoundaryCut(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  chart: Chart,
  seamEdge: Uint8Array,
): number[] {
  if (chart.closed || chart.boundaryComponents <= 1) return [];
  const boundary = analyzeBoundary(chart.boundaryEdges, topology);
  if (boundary.count <= 1) return [];
  const chartTriangles = new Set<number>(chart.triangles);
  const sources: number[] = [];
  for (const [vertex, component] of boundary.componentOf) {
    if (component === 0) sources.push(vertex);
  }
  if (sources.length === 0) return [];

  const distances = new Float64Array(mesh.vertexCount).fill(Infinity);
  const parentVertex = new Int32Array(mesh.vertexCount).fill(-1);
  const parentEdge = new Int32Array(mesh.vertexCount).fill(-1);
  const visited = new Uint8Array(mesh.vertexCount);
  const heap = new MinHeap();
  for (const source of sources) {
    distances[source] = 0;
    heap.push(source, 0);
  }
  let target = -1;
  while (heap.size > 0) {
    const entry = heap.pop()!;
    if (visited[entry.vertex]) continue;
    if (entry.distance > distances[entry.vertex]) continue;
    visited[entry.vertex] = 1;
    const component = boundary.componentOf.get(entry.vertex);
    if (component !== undefined && component !== 0 && entry.distance > 0) {
      target = entry.vertex;
      break;
    }
    for (const edgeIndex of topology.vertexEdges[entry.vertex]) {
      const edge = topology.edges[edgeIndex];
      if (edge.boundary || edge.nonManifold || seamEdge[edgeIndex]) continue;
      if (edge.triangles.length !== 2) continue;
      if (!chartTriangles.has(edge.triangles[0]) || !chartTriangles.has(edge.triangles[1])) continue;
      const neighbor = edge.a === entry.vertex ? edge.b : edge.a;
      if (visited[neighbor]) continue;
      const next = entry.distance + edgeLength(mesh, edge);
      if (next < distances[neighbor] - 1e-12) {
        distances[neighbor] = next;
        parentVertex[neighbor] = entry.vertex;
        parentEdge[neighbor] = edgeIndex;
        heap.push(neighbor, next);
      }
    }
  }
  if (target < 0) return [];

  const path: number[] = [];
  let vertex = target;
  while (parentEdge[vertex] >= 0) {
    path.push(parentEdge[vertex]);
    vertex = parentVertex[vertex];
    if (path.length > mesh.vertexCount) return [];
  }
  return path;
}

export type CutResult = {
  seamEdge: Uint8Array;
  cutEdgeIndices: Uint32Array;
  cutLength: number;
  closedBefore: number;
  nonDiskBefore: number;
  cutsAdded: number;
  issues: Issue[];
};

/** Cuts charts until every one is a disk or the retry budget runs out. One
 * round cuts every chart that still has a hole or no boundary at all, so the
 * default budget is derived from the loop counts rather than a fixed number.
 * The returned seam mask includes every original seam plus the new cuts. */
export function cutClosedCharts(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  face: FaceGeometry,
  seamEdge: Uint8Array,
  options: SegmentOptions,
): CutResult {
  const working = new Uint8Array(seamEdge);
  const cutEdges: number[] = [];
  const issues: Issue[] = [];
  let closedBefore = 0;
  let nonDiskBefore = 0;
  let cutLength = 0;

  const initial = segmentCharts(mesh, topology, working, face);
  let loopBudget = 8;
  for (const chart of initial.charts) {
    loopBudget += Math.max(0, chart.boundaryComponents - 1) + (chart.closed ? 1 : 0);
  }
  const maxRounds = Math.max(1, options.maxClosedChartCuts ?? loopBudget);

  for (let round = 0; round < maxRounds; round += 1) {
    const current = segmentCharts(mesh, topology, working, face);
    const needsCut = current.charts.filter((chart) => chart.closed || chart.boundaryComponents > 1);
    if (round === 0) {
      closedBefore = current.charts.filter((chart) => chart.closed).length;
      nonDiskBefore = needsCut.length;
    }
    if (needsCut.length === 0) break;
    let addedThisRound = 0;
    for (const chart of needsCut) {
      const path = chart.closed
        ? findClosedChartCut(mesh, topology, chart, working)
        : findBoundaryCut(mesh, topology, chart, working);
      if (path.length === 0) {
        issues.push({
          stage: 'segment',
          severity: 'warn',
          code: chart.closed ? 'closed-chart-cut-failed' : 'non-disk-cut-failed',
          message: chart.closed
            ? `Chart ${chart.id} is closed and no cut path could be found.`
            : `Chart ${chart.id} has ${chart.boundaryComponents} boundary loops and no connection path could be found.`,
          chart: chart.id,
        });
        continue;
      }
      for (const edgeIndex of path) {
        if (working[edgeIndex]) continue;
        working[edgeIndex] = 1;
        cutEdges.push(edgeIndex);
        cutLength += edgeLength(mesh, topology.edges[edgeIndex]);
        addedThisRound += 1;
      }
    }
    if (addedThisRound === 0) break;
  }

  return {
    seamEdge: working,
    cutEdgeIndices: new Uint32Array(cutEdges),
    cutLength,
    closedBefore,
    nonDiskBefore,
    cutsAdded: cutEdges.length,
    issues,
  };
}

/** Builds the segmentation for an explicit seam mask. Closed charts and
 * charts with holes are cut until they are disks, then chart stats and issues
 * are derived from the final mask. */
export function segmentFromSeams(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  face: FaceGeometry,
  seamEdge: Uint8Array,
  options: SegmentOptions,
  seams?: SeamResult,
): Segmentation {
  const cuts = cutClosedCharts(mesh, topology, face, seamEdge, options);
  const finalCharts = segmentCharts(mesh, topology, cuts.seamEdge, face);
  const counts = seams ?? countSeams(mesh, topology, cuts.seamEdge);
  const issues: Issue[] = [...(seams?.issues ?? []), ...cuts.issues];

  let chartTrianglesMin = Infinity;
  let chartTrianglesMax = 0;
  let chartAreaMin = Infinity;
  let chartAreaMax = 0;
  for (const chart of finalCharts.charts) {
    chartTrianglesMin = Math.min(chartTrianglesMin, chart.triangles.length);
    chartTrianglesMax = Math.max(chartTrianglesMax, chart.triangles.length);
    chartAreaMin = Math.min(chartAreaMin, chart.worldArea);
    chartAreaMax = Math.max(chartAreaMax, chart.worldArea);
  }
  const remainingNonDisk = finalCharts.charts.filter(
    (chart) => chart.closed || chart.boundaryComponents > 1,
  ).length;
  if (remainingNonDisk > 0) {
    issues.push({
      stage: 'segment',
      severity: 'warn',
      code: 'non-disk-charts-remain',
      message: `${remainingNonDisk} chart${remainingNonDisk === 1 ? '' : 's'} still have no disk topology.`,
      value: remainingNonDisk,
    });
  }
  if (finalCharts.charts.length === 0) {
    issues.push({
      stage: 'segment',
      severity: 'error',
      code: 'no-charts',
      message: 'The mesh produced no charts.',
    });
  } else if (finalCharts.charts.length > 512) {
    issues.push({
      stage: 'segment',
      severity: 'warn',
      code: 'many-charts',
      message: `${finalCharts.charts.length} charts may be expensive to pack and paint.`,
      value: finalCharts.charts.length,
      threshold: 512,
    });
  }

  const stats: StageStats = {
    charts: finalCharts.charts.length,
    seamEdges: counts.interiorSeamCount + counts.nonManifoldCount + cuts.cutsAdded,
    seamLength: Number((counts.interiorSeamLength + cuts.cutLength).toFixed(4)),
    boundaryEdges: counts.boundaryCount,
    nonManifoldEdges: counts.nonManifoldCount,
    objectSeams: counts.objectSeamCount,
    materialSeams: counts.materialSeamCount,
    dihedralSeams: counts.dihedralSeamCount,
    uvSeams: counts.uvSeamCount ?? 0,
    closedChartsBeforeCuts: cuts.closedBefore,
    nonDiskChartsBeforeCuts: cuts.nonDiskBefore,
    cutsAdded: cuts.cutsAdded,
    chartTrianglesMin: Number.isFinite(chartTrianglesMin) ? chartTrianglesMin : 0,
    chartTrianglesMax,
    chartAreaMin: Number.isFinite(chartAreaMin) ? Number(chartAreaMin.toFixed(6)) : 0,
    chartAreaMax: Number(chartAreaMax.toFixed(6)),
  };

  return {
    seamEdge: cuts.seamEdge,
    cutEdgeIndices: cuts.cutEdgeIndices,
    charts: finalCharts.charts,
    chartOfTriangle: finalCharts.chartOfTriangle,
    stats,
    issues,
  };
}

/** Seam counts derived from a mask alone, used when the caller supplies no
 * precomputed seam result. Category counts that the mask cannot express stay
 * at zero. */
function countSeams(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  seamEdge: Uint8Array,
): SeamResult {
  let interiorSeamCount = 0;
  let interiorSeamLength = 0;
  let boundaryCount = 0;
  let nonManifoldCount = 0;
  const seamEdgeResult = new Uint8Array(topology.edges.length);
  for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex += 1) {
    const edge = topology.edges[edgeIndex];
    if (seamEdge[edgeIndex]) seamEdgeResult[edgeIndex] = 1;
    if (edge.boundary) {
      boundaryCount += 1;
      continue;
    }
    if (edge.nonManifold) {
      nonManifoldCount += 1;
      continue;
    }
    if (!seamEdge[edgeIndex]) continue;
    interiorSeamCount += 1;
    interiorSeamLength += Math.hypot(
      mesh.positions[edge.b * 3] - mesh.positions[edge.a * 3],
      mesh.positions[edge.b * 3 + 1] - mesh.positions[edge.a * 3 + 1],
      mesh.positions[edge.b * 3 + 2] - mesh.positions[edge.a * 3 + 2],
    );
  }
  return {
    seamEdge: seamEdgeResult,
    interiorSeamCount,
    interiorSeamLength,
    boundaryCount,
    nonManifoldCount,
    objectSeamCount: 0,
    materialSeamCount: 0,
    dihedralSeamCount: 0,
    uvSeamCount: 0,
    issues: [],
  };
}

/** Full segmentation stage: seams, closed-chart cuts, and final chart stats. */
export function segmentMesh(
  mesh: ConditionedMesh,
  topology: MeshTopology,
  face: FaceGeometry,
  options: SegmentOptions,
): Segmentation {
  const seams = computeSeams(mesh, topology, face, options);
  return segmentFromSeams(mesh, topology, face, seams.seamEdge, options, seams);
}
