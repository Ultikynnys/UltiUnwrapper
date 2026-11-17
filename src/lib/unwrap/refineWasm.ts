import { REFINE_WASM_BASE64 } from './refineWasmBinary';
import { buildChartFromFaces } from './smartProject';
import type { RefineTaskInput, CutLayout } from './refineTask';
import type { ChartUv } from './types';

const NO_TRIANGLE = 0xffffffff;

type WasmExports = {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  refiner_new(): number;
  refiner_free(state: number): void;
  refiner_load(
    state: number,
    positions: number,
    positionsLen: number,
    indices: number,
    indicesLen: number,
    areas: number,
    areasLen: number,
    normals: number,
    normalsLen: number,
    edges: number,
    edgeCount: number,
    seam: number,
    seamLen: number,
    chartOffsets: number,
    chartCount: number,
    chartFaces: number,
    chartFaceCount: number,
  ): number;
  refiner_run(
    state: number,
    seed: number,
    deadline: number,
    tolerance: number,
    mergeCos: number,
    axisMergeCos: number,
  ): number;
  refiner_result_chart_count(state: number): number;
  refiner_result_offsets(state: number): number;
  refiner_result_faces(state: number): number;
  refiner_result_axes(state: number): number;
  refiner_result_merges(state: number): number;
  refiner_result_boundary_edges(state: number): number;
  refiner_result_unresolved(state: number): number;
  refiner_result_timed_out(state: number): number;
};

export type WasmLayout = {
  offsets: Uint32Array;
  faces: Uint32Array;
  axes: Float32Array;
  chartCount: number;
  merges: number;
  boundaryEdges: number;
  unresolved: number;
  timedOut: boolean;
};

export type WasmRefiner = {
  run(seed: number, deadline: number): WasmLayout;
  materialize(layout: WasmLayout): ChartUv[];
  dispose(): void;
};

let modulePromise: Promise<WebAssembly.Module> | null = null;

function wasmBytes(): Uint8Array {
  if (typeof atob !== 'function') {
    throw new Error('This environment cannot decode the embedded refinement WASM.');
  }
  const binary = atob(REFINE_WASM_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function compiledModule(): Promise<WebAssembly.Module> {
  modulePromise ??= WebAssembly.compile(wasmBytes() as unknown as BufferSource);
  return modulePromise;
}

function upload(
  exports: WasmExports,
  view: Float32Array | Uint32Array | Uint8Array,
): { ptr: number; byteLength: number } {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const ptr = exports.alloc(bytes.byteLength);
  if (!ptr) throw new Error('The refinement WASM could not allocate input memory.');
  new Uint8Array(exports.memory.buffer, ptr, bytes.byteLength).set(bytes);
  return { ptr, byteLength: bytes.byteLength };
}

export async function createWasmRefiner(
  input: RefineTaskInput,
  cut: CutLayout,
): Promise<WasmRefiner> {
  const module = await compiledModule();
  const instance = await WebAssembly.instantiate(module, {
    env: {
      now_epoch: () => performance.timeOrigin + performance.now(),
    },
  });
  const exports = instance.exports as unknown as WasmExports;
  const state = exports.refiner_new();
  if (!state) throw new Error('The refinement WASM could not create state.');

  const chartCount = cut.charts.length;
  const offsets = new Uint32Array(chartCount + 1);
  let faceCount = 0;
  for (let chart = 0; chart < chartCount; chart += 1) {
    offsets[chart] = faceCount;
    faceCount += cut.charts[chart].triangles.length;
  }
  offsets[chartCount] = faceCount;
  const faces = new Uint32Array(faceCount);
  let faceOffset = 0;
  for (const chart of cut.charts) {
    faces.set(chart.triangles, faceOffset);
    faceOffset += chart.triangles.length;
  }

  const edgeCount = input.topology.edges.length;
  const edges = new Uint32Array(edgeCount * 2);
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const triangles = input.topology.edges[edge].triangles;
    edges[edge * 2] = triangles[0] ?? NO_TRIANGLE;
    edges[edge * 2 + 1] = triangles[1] ?? NO_TRIANGLE;
  }

  const uploads: Array<{ ptr: number; byteLength: number }> = [];
  try {
    const positions = upload(exports, input.mesh.positions);
    const indices = upload(exports, input.mesh.indices);
    const areas = upload(exports, input.face.areas);
    const normals = upload(exports, input.face.normals);
    const edgeUpload = upload(exports, edges);
    const seam = upload(exports, input.seamEdge);
    const offsetUpload = upload(exports, offsets);
    const faceUpload = upload(exports, faces);
    uploads.push(positions, indices, areas, normals, edgeUpload, seam, offsetUpload, faceUpload);

    const status = exports.refiner_load(
      state,
      positions.ptr,
      input.mesh.positions.length,
      indices.ptr,
      input.mesh.indices.length,
      areas.ptr,
      input.face.areas.length,
      normals.ptr,
      input.face.normals.length,
      edgeUpload.ptr,
      edgeCount,
      seam.ptr,
      input.seamEdge.length,
      offsetUpload.ptr,
      chartCount,
      faceUpload.ptr,
      faceCount,
    );
    if (status !== 0) throw new Error(`The refinement WASM rejected its input (${status}).`);
  } catch (error) {
    exports.refiner_free(state);
    throw error;
  } finally {
    for (const entry of uploads) exports.dealloc(entry.ptr, entry.byteLength);
  }

  let disposed = false;
  return {
    run(seed: number, deadline: number): WasmLayout {
      if (disposed) throw new Error('The refinement WASM was disposed.');
      const status = exports.refiner_run(
        state,
        seed >>> 0,
        deadline,
        input.tolerance,
        input.mergeCos,
        input.axisMergeCos,
      );
      if (status !== 0) throw new Error(`The refinement WASM failed to run (${status}).`);
      const count = exports.refiner_result_chart_count(state);
      const offsetsPtr = exports.refiner_result_offsets(state);
      const facesPtr = exports.refiner_result_faces(state);
      const axesPtr = exports.refiner_result_axes(state);
      const resultOffsets = new Uint32Array(
        exports.memory.buffer,
        offsetsPtr,
        count + 1,
      ).slice();
      const resultFaceCount = resultOffsets[count];
      const resultFaces = new Uint32Array(
        exports.memory.buffer,
        facesPtr,
        resultFaceCount,
      ).slice();
      const axes = new Float32Array(exports.memory.buffer, axesPtr, count * 3).slice();
      return {
        offsets: resultOffsets,
        faces: resultFaces,
        axes,
        chartCount: count,
        merges: exports.refiner_result_merges(state),
        boundaryEdges: exports.refiner_result_boundary_edges(state),
        unresolved: exports.refiner_result_unresolved(state),
        timedOut: exports.refiner_result_timed_out(state) === 1,
      };
    },
    materialize(layout: WasmLayout): ChartUv[] {
      const charts: ChartUv[] = [];
      for (let chart = 0; chart < layout.chartCount; chart += 1) {
        const start = layout.offsets[chart];
        const end = layout.offsets[chart + 1];
        const faces = Array.from(layout.faces.subarray(start, end));
        const axis = [
          layout.axes[chart * 3],
          layout.axes[chart * 3 + 1],
          layout.axes[chart * 3 + 2],
        ];
        charts.push(buildChartFromFaces(input.mesh, input.face, chart, faces, axis));
      }
      return charts;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      exports.refiner_free(state);
    },
  };
}
