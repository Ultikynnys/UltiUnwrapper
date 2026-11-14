import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  PerspectiveCamera,
  Raycaster,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { chartColor, densityColor, heatColor } from './unwrap/colors';
import type { ConditionedMesh, MeshTopology, StageSnapshot } from './unwrap/types';

export type StageViewMode = 'clay' | 'charts' | 'distortion' | 'area' | 'flipped' | 'density' | 'densityDelta' | 'checker' | 'overlap';

export type ViewportState = {
  stage: StageSnapshot | null;
  mesh: ConditionedMesh | null;
  topology: MeshTopology | null;
  mode: StageViewMode;
  selectedChart: number | null;
  showSeams: boolean;
  showWireframe: boolean;
  faceOverlap: Uint8Array | null;
};

const CHECKER_SIZE = 512;
const CHECKER_CELLS = 8;
const CAMERA_DIRECTION = new Vector3(0.9, 0.65, 1.1).normalize();

function createCheckerTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CHECKER_SIZE;
  canvas.height = CHECKER_SIZE;
  const context = canvas.getContext('2d');
  if (context) {
    const cell = CHECKER_SIZE / CHECKER_CELLS;
    for (let y = 0; y < CHECKER_CELLS; y += 1) {
      for (let x = 0; x < CHECKER_CELLS; x += 1) {
        context.fillStyle = (x + y) % 2 === 0 ? '#d7d3c8' : '#2dd4bf';
        context.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    context.strokeStyle = 'rgba(23, 23, 22, 0.55)';
    context.lineWidth = 2;
    context.strokeRect(0, 0, CHECKER_SIZE, CHECKER_SIZE);
  }
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function luminance([r, g, b]: [number, number, number], amount: number): [number, number, number] {
  return [
    Math.round(r * amount),
    Math.round(g * amount),
    Math.round(b * amount),
  ];
}

function srgbToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export class Viewport3D {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(42, 1, 0.01, 10000);
  private readonly controls: OrbitControls;
  private readonly content = new Group();
  private readonly grid = new GridHelper(10, 10, 0x41413d, 0x292927);
  private readonly checker = createCheckerTexture();
  private readonly resizeObserver: ResizeObserver;
  private state: ViewportState | null = null;
  private fittedStage = '';
  private frameId = 0;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private pickStart: { x: number; y: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onSelectChart?: (chart: number | null) => void,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600, false);
    this.scene.background = new Color(0x0d0d0c);
    this.scene.add(new AmbientLight(0xffffff, 1.4));
    const sun = new DirectionalLight(0xffffff, 2.1);
    sun.position.set(4, 7, 5);
    this.scene.add(sun);
    const fill = new DirectionalLight(0xa9c9d8, 0.7);
    fill.position.set(-5, 2, -4);
    this.scene.add(fill);
    this.grid.position.set(0, -1, 0);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.28;
    this.scene.add(this.grid);
    this.scene.add(this.content);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.05;
    this.controls.maxDistance = 5000;
    this.camera.position.set(4, 3, 5);
    this.controls.target.set(0, 0, 0);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerCancel);
    this.frameId = requestAnimationFrame(this.animate);
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.pickStart = { x: event.clientX, y: event.clientY };
  };

  private handlePointerCancel = (): void => {
    this.pickStart = null;
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const start = this.pickStart;
    this.pickStart = null;
    if (!start || event.button !== 0) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    this.pickChart(event);
  };

  private pickChart(event: PointerEvent): void {
    const stage = this.state?.stage;
    const mesh = this.content.children.find((child) => child instanceof Mesh);
    if (!stage || !mesh) {
      this.onSelectChart?.(null);
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(mesh, false)[0];
    if (!hit || hit.faceIndex == null || !stage.chartOfTriangle) {
      this.onSelectChart?.(null);
      return;
    }
    this.onSelectChart?.(stage.chartOfTriangle[hit.faceIndex] ?? null);
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private resize(): void {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private disposeContent(): void {
    this.content.traverse((child) => {
      if (child instanceof Mesh || child instanceof LineSegments) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          if (material instanceof MeshBasicMaterial && material.map === this.checker) {
            material.dispose();
            continue;
          }
          material.dispose();
        }
      }
    });
    this.content.clear();
  }

  private colorFor(triangle: number, chart: number | null): [number, number, number] {
    const stage = this.state?.stage;
    if (!stage) return [180, 180, 170];
    const selected = this.state?.selectedChart ?? null;
    const dim = selected !== null && chart !== selected ? 0.2 : 1;
    if (this.state?.mode === 'overlap') {
      if (this.state.faceOverlap?.[triangle]) return [255, 62, 62];
      if (selected !== null) {
        return chart === selected
          ? luminance(chartColor(chart), 0.9)
          : luminance([90, 90, 84], 0.5);
      }
      return luminance([130, 130, 120], 0.65);
    }
    if (this.state?.mode === 'flipped') {
      return stage.face.flipped?.[triangle]
        ? [255, 45, 210]
        : luminance([115, 115, 108], 0.55);
    }
    if (chart === null) return luminance([150, 150, 140], dim);
    if (this.state?.mode === 'distortion') {
      const angle = stage.face.angleDistortion?.[triangle] ?? 0;
      return luminance(heatColor(angle, 30), dim);
    }
    if (this.state?.mode === 'area') {
      const area = stage.face.areaDistortion?.[triangle] ?? 0;
      return luminance(heatColor(area, 3), dim);
    }
    if (this.state?.mode === 'density') {
      const density = stage.face.texelDensity?.[triangle] ?? 0;
      const reference = Number(
        stage.stats.achievedDensity
        ?? stage.stats.targetDensity
        ?? stage.stats.densityP50
        ?? 1,
      ) || 1;
      return luminance(densityColor(density / reference), dim);
    }
    if (this.state?.mode === 'densityDelta') {
      const before = stage.face.texelDensityBefore?.[triangle] ?? 0;
      const after = stage.face.texelDensity?.[triangle] ?? before;
      const delta = before > 0 ? after / before - 1 : 0;
      return luminance(heatColor(Math.max(0, delta), 0.2), dim);
    }
    return luminance(chartColor(chart), dim);
  }

  private buildGeometry(): void {
    const state = this.state;
    const mesh = state?.mesh;
    const stage = state?.stage;
    if (!mesh || !stage) {
      this.disposeContent();
      return;
    }
    const cornerCount = mesh.triangleCount * 3;
    const positions = new Float32Array(cornerCount * 3);
    const normals = new Float32Array(cornerCount * 3);
    const colors = new Float32Array(cornerCount * 3);
    const uvs = new Float32Array(cornerCount * 2);
    const chartOfTriangle = stage.chartOfTriangle;

    for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
      const chart = chartOfTriangle ? chartOfTriangle[triangle] : null;
      const color = this.colorFor(triangle, chart);
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = mesh.indices[triangle * 3 + corner];
        const target = triangle * 3 + corner;
        positions[target * 3] = mesh.positions[vertex * 3];
        positions[target * 3 + 1] = mesh.positions[vertex * 3 + 1];
        positions[target * 3 + 2] = mesh.positions[vertex * 3 + 2];
        normals[target * 3] = mesh.normals[vertex * 3];
        normals[target * 3 + 1] = mesh.normals[vertex * 3 + 1];
        normals[target * 3 + 2] = mesh.normals[vertex * 3 + 2];
        colors[target * 3] = srgbToLinear(color[0]);
        colors[target * 3 + 1] = srgbToLinear(color[1]);
        colors[target * 3 + 2] = srgbToLinear(color[2]);
        uvs[target * 2] = stage.uvs ? stage.uvs[triangle * 6 + corner * 2] : 0;
        uvs[target * 2 + 1] = stage.uvs ? stage.uvs[triangle * 6 + corner * 2 + 1] : 0;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    let material: MeshLambertMaterial | MeshBasicMaterial;
    if (state.mode === 'clay' || !stage.uvs && state.mode === 'checker') {
      material = new MeshLambertMaterial({
        color: 0xcfcabc,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
    } else if (state.mode === 'checker') {
      material = new MeshBasicMaterial({
        map: this.checker,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
    } else {
      material = new MeshBasicMaterial({
        vertexColors: true,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
    }
    material.toneMapped = false;
    const meshObject = new Mesh(geometry, material);
    meshObject.frustumCulled = false;
    this.content.add(meshObject);

    const box = geometry.boundingBox ?? new Box3();
    const diagonal = box.getSize(new Vector3()).length() || 1;
    const offset = Math.max(diagonal * 0.0015, 1e-5);

    if (state.showSeams && state.topology) {
      const topology = state.topology;
      const cut = new Set<number>(stage.cutEdges ? Array.from(stage.cutEdges) : []);
      const bad = new Set<number>(topology.nonManifoldEdges);
      const boundary: number[] = [];
      const normalSeam: number[] = [];
      const cutSeam: number[] = [];
      const badEdges: number[] = [];
      const edgeList = stage.seamEdges
        ?? (stage.id === 'condition' ? [...topology.boundaryEdges, ...topology.nonManifoldEdges] : []);
      const pushEdge = (points: number[], edgeIndex: number): void => {
        const edge = topology.edges[edgeIndex];
        if (!edge) return;
        for (const vertex of [edge.a, edge.b]) {
          points.push(
            mesh.positions[vertex * 3] + mesh.normals[vertex * 3] * offset,
            mesh.positions[vertex * 3 + 1] + mesh.normals[vertex * 3 + 1] * offset,
            mesh.positions[vertex * 3 + 2] + mesh.normals[vertex * 3 + 2] * offset,
          );
        }
      };
      for (const edgeIndex of edgeList) {
        if (bad.has(edgeIndex)) {
          pushEdge(badEdges, edgeIndex);
        } else if (cut.has(edgeIndex)) {
          pushEdge(cutSeam, edgeIndex);
        } else if (stage.id === 'condition') {
          pushEdge(boundary, edgeIndex);
        } else {
          pushEdge(normalSeam, edgeIndex);
        }
      }
      const addLines = (points: number[], color: number, opacity: number): void => {
        if (points.length === 0) return;
        const lineGeometry = new BufferGeometry();
        lineGeometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
        const line = new LineSegments(
          lineGeometry,
          new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }),
        );
        line.renderOrder = 4;
        this.content.add(line);
      };
      addLines(boundary, 0xf0b429, 0.95);
      addLines(normalSeam, 0xf0b429, 0.95);
      addLines(cutSeam, 0xff5bb5, 0.95);
      addLines(badEdges, 0xff4747, 1);
    }

    if (state.showWireframe) {
      const points: number[] = [];
      for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
        for (let corner = 0; corner < 3; corner += 1) {
          const a = mesh.indices[triangle * 3 + corner];
          const b = mesh.indices[triangle * 3 + ((corner + 1) % 3)];
          points.push(
            mesh.positions[a * 3] + mesh.normals[a * 3] * offset,
            mesh.positions[a * 3 + 1] + mesh.normals[a * 3 + 1] * offset,
            mesh.positions[a * 3 + 2] + mesh.normals[a * 3 + 2] * offset,
            mesh.positions[b * 3] + mesh.normals[b * 3] * offset,
            mesh.positions[b * 3 + 1] + mesh.normals[b * 3 + 1] * offset,
            mesh.positions[b * 3 + 2] + mesh.normals[b * 3 + 2] * offset,
          );
        }
      }
      const lineGeometry = new BufferGeometry();
      lineGeometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
      const lines = new LineSegments(
        lineGeometry,
        new LineBasicMaterial({ color: 0x9fe8e0, transparent: true, opacity: 0.32 }),
      );
      this.content.add(lines);
    }

    this.scene.add(this.content);
    if (this.fittedStage !== 'ready') {
      this.fittedStage = 'ready';
      const center = box.getCenter(new Vector3());
      const radius = Math.max(box.getSize(new Vector3()).length() * 0.5, 0.25);
      const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.25;
      this.camera.near = Math.max(radius * 0.001, 0.001);
      this.camera.far = Math.max(radius * 50, 100);
      this.camera.updateProjectionMatrix();
      this.camera.position.copy(center).addScaledVector(CAMERA_DIRECTION, distance);
      this.controls.target.copy(center);
      this.grid.position.set(center.x, box.min.y - radius * 0.01, center.z);
      this.grid.scale.setScalar(Math.max(1, radius * 0.4));
      this.controls.update();
    }
  }

  setState(state: ViewportState): void {
    const previous = this.state;
    this.state = state;
    if (previous?.mesh !== state.mesh) this.fittedStage = '';
    const selectionChanged = previous?.selectedChart !== state.selectedChart;
    const stageChanged = previous?.stage?.id !== state.stage?.id;
    if (!stageChanged && !selectionChanged && previous) {
      const modeChanged = previous.mode !== state.mode;
      const seamsChanged = previous.showSeams !== state.showSeams;
      const wireChanged = previous.showWireframe !== state.showWireframe;
      if (!modeChanged && !seamsChanged && !wireChanged && previous.mesh === state.mesh) return;
    }
    this.disposeContent();
    this.buildGeometry();
  }

  resetCamera(): void {
    this.fittedStage = '';
    this.disposeContent();
    this.buildGeometry();
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    this.controls.dispose();
    this.disposeContent();
    this.checker.dispose();
    this.renderer.dispose();
  }
}
