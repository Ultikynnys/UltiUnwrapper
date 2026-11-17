use std::alloc::{alloc as alloc_bytes, dealloc as dealloc_bytes, Layout};
use std::collections::BTreeMap;
use std::slice;

const AREA_EPSILON: f64 = 1e-12;
const FLOAT_EPSILON: f64 = 1.1920929e-7;
const NO_TRIANGLE: u32 = u32::MAX;

#[link(wasm_import_module = "env")]
extern "C" {
    fn now_epoch() -> f64;
}

#[derive(Default)]
pub struct Refiner {
    positions: Vec<f32>,
    indices: Vec<u32>,
    areas: Vec<f32>,
    normals: Vec<f32>,
    edges: Vec<u32>,
    seam: Vec<u8>,
    base_offsets: Vec<u32>,
    base_faces: Vec<u32>,
    base_sums: Vec<[f64; 3]>,
    result_offsets: Vec<u32>,
    result_faces: Vec<u32>,
    result_axes: Vec<f32>,
    merges: u32,
    boundary_edges: u32,
    unresolved: u32,
    timed_out: bool,
}

struct Candidate {
    score: f64,
    order: u32,
    a: u32,
    b: u32,
}

struct Plan {
    a: usize,
    b: usize,
    faces: Vec<u32>,
    sum: [f64; 3],
}

struct Random {
    state: u32,
}

impl Random {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut value = self.state;
        value = (value ^ (value >> 15)).wrapping_mul(value | 1);
        value ^= value.wrapping_add((value ^ (value >> 7)).wrapping_mul(value | 61));
        ((value ^ (value >> 14)) as f64) / 4294967296.0
    }
}

fn ortho_basis(axis: [f64; 3]) -> [f64; 6] {
    let nx = axis[0];
    let ny = axis[1];
    let nz = axis[2];
    let planar = nx * nx + ny * ny;
    if planar > FLOAT_EPSILON {
        let inverse = 1.0 / planar.sqrt();
        let ux = ny * inverse;
        let uy = -nx * inverse;
        let uz = 0.0;
        let vx = -nz * uy;
        let vy = nz * ux;
        let vz = nx * uy - ny * ux;
        [ux, uy, uz, vx, vy, vz]
    } else {
        let ux = if nz < 0.0 { -1.0 } else { 1.0 };
        [ux, 0.0, 0.0, 0.0, 1.0, 0.0]
    }
}

fn signed_area(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 {
    0.5 * ((cx - ax) * (by - ay) - (bx - ax) * (cy - ay))
}

#[no_mangle]
pub extern "C" fn refiner_version() -> u32 {
    2
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let layout = Layout::from_size_align(len.max(1), 8).expect("valid allocation layout");
    unsafe { alloc_bytes(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let layout = Layout::from_size_align(len.max(1), 8).expect("valid allocation layout");
    unsafe { dealloc_bytes(ptr, layout) }
}

#[no_mangle]
pub extern "C" fn refiner_new() -> *mut Refiner {
    Box::into_raw(Box::new(Refiner::default()))
}

#[no_mangle]
pub extern "C" fn refiner_free(ptr: *mut Refiner) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(ptr));
    }
}

#[no_mangle]
pub extern "C" fn refiner_load(
    state: *mut Refiner,
    positions: *const f32,
    positions_len: usize,
    indices: *const u32,
    indices_len: usize,
    areas: *const f32,
    areas_len: usize,
    normals: *const f32,
    normals_len: usize,
    edges: *const u32,
    edge_count: usize,
    seam: *const u8,
    seam_len: usize,
    chart_offsets: *const u32,
    chart_count: usize,
    chart_faces: *const u32,
    chart_face_count: usize,
) -> i32 {
    if state.is_null() {
        return -1;
    }
    if indices_len != areas_len * 3
        || normals_len != areas_len * 3
        || edge_count == 0
        || seam_len != edge_count
        || chart_count == 0
        || chart_offsets.is_null()
    {
        return -1;
    }
    let state = unsafe { &mut *state };
    let offsets = unsafe { slice::from_raw_parts(chart_offsets, chart_count + 1) };
    if offsets[0] != 0 || offsets[chart_count] as usize != chart_face_count {
        return -1;
    }
    for index in 0..chart_count {
        if offsets[index] > offsets[index + 1] || offsets[index + 1] as usize > chart_face_count {
            return -1;
        }
    }
    state.positions = unsafe { slice::from_raw_parts(positions, positions_len) }.to_vec();
    state.indices = unsafe { slice::from_raw_parts(indices, indices_len) }.to_vec();
    state.areas = unsafe { slice::from_raw_parts(areas, areas_len) }.to_vec();
    state.normals = unsafe { slice::from_raw_parts(normals, normals_len) }.to_vec();
    state.edges = unsafe { slice::from_raw_parts(edges, edge_count * 2) }.to_vec();
    state.seam = unsafe { slice::from_raw_parts(seam, seam_len) }.to_vec();
    state.base_offsets = offsets.to_vec();
    state.base_faces = unsafe { slice::from_raw_parts(chart_faces, chart_face_count) }.to_vec();
    state.base_sums = Vec::with_capacity(chart_count);
    for chart in 0..chart_count {
        let start = offsets[chart] as usize;
        let end = offsets[chart + 1] as usize;
        let mut sum = [0.0f64, 0.0, 0.0];
        for &triangle in &state.base_faces[start..end] {
            let base = triangle as usize * 3;
            if base + 2 >= state.normals.len() || triangle as usize >= state.areas.len() {
                return -1;
            }
            let area = state.areas[triangle as usize] as f64;
            sum[0] += state.normals[base] as f64 * area;
            sum[1] += state.normals[base + 1] as f64 * area;
            sum[2] += state.normals[base + 2] as f64 * area;
        }
        state.base_sums.push(sum);
    }
    state.result_offsets.clear();
    state.result_faces.clear();
    state.result_axes.clear();
    state.merges = 0;
    state.boundary_edges = 0;
    state.unresolved = 0;
    state.timed_out = false;
    0
}

impl Refiner {
    fn projection_fits(
        &self,
        first: &[u32],
        second: &[u32],
        axis: [f64; 3],
        tolerance: f64,
    ) -> bool {
        let basis = ortho_basis(axis);
        let ux = basis[0];
        let uy = basis[1];
        let uz = basis[2];
        let vx = basis[3];
        let vy = basis[4];
        let vz = basis[5];
        let limit = (1.0 + tolerance) * (1.0 + tolerance) + 1e-12;
        let mut min_ratio = f64::INFINITY;
        let mut max_ratio = 0.0f64;
        for faces in [first, second] {
            for &triangle in faces {
                let triangle = triangle as usize;
                let world = self.areas[triangle] as f64;
                if world <= AREA_EPSILON {
                    continue;
                }
                let base = triangle * 3;
                let a = self.indices[base] as usize * 3;
                let b = self.indices[base + 1] as usize * 3;
                let c = self.indices[base + 2] as usize * 3;
                let ax = self.positions[a] as f64;
                let ay = self.positions[a + 1] as f64;
                let az = self.positions[a + 2] as f64;
                let bx = self.positions[b] as f64;
                let by = self.positions[b + 1] as f64;
                let bz = self.positions[b + 2] as f64;
                let cx = self.positions[c] as f64;
                let cy = self.positions[c + 1] as f64;
                let cz = self.positions[c + 2] as f64;
                let area = signed_area(
                    ax * ux + ay * uy + az * uz,
                    ax * vx + ay * vy + az * vz,
                    bx * ux + by * uy + bz * uz,
                    bx * vx + by * vy + bz * vz,
                    cx * ux + cy * uy + cz * uz,
                    cx * vx + cy * vy + cz * vz,
                )
                .abs();
                if area <= AREA_EPSILON {
                    return false;
                }
                let ratio = area / world;
                if ratio < min_ratio {
                    min_ratio = ratio;
                }
                if ratio > max_ratio {
                    max_ratio = ratio;
                }
                if max_ratio / min_ratio > limit {
                    return false;
                }
            }
        }
        true
    }

    fn run(
        &mut self,
        seed: u32,
        deadline: f64,
        tolerance: f64,
        merge_cos: f64,
        axis_merge_cos: f64,
    ) -> i32 {
        let triangle_count = self.areas.len();
        let mut charts: Vec<Vec<u32>> = Vec::with_capacity(self.base_offsets.len() - 1);
        for chart in 0..self.base_offsets.len() - 1 {
            let start = self.base_offsets[chart] as usize;
            let end = self.base_offsets[chart + 1] as usize;
            charts.push(self.base_faces[start..end].to_vec());
        }
        let mut sums = self.base_sums.clone();
        let mut merges = 0u32;
        let mut timed_out = false;
        let mut checks = 0u32;

        while charts.len() > 1 {
            if unsafe { now_epoch() } >= deadline {
                timed_out = true;
                break;
            }
            let mut chart_of = vec![-1i32; triangle_count];
            for (chart, faces) in charts.iter().enumerate() {
                for &triangle in faces {
                    chart_of[triangle as usize] = chart as i32;
                }
            }
            let mut borders: BTreeMap<u64, (u32, u32, u32, u32)> = BTreeMap::new();
            let mut border_order = 0u32;
            for edge in 0..self.seam.len() {
                if self.seam[edge] != 0 {
                    continue;
                }
                let first = self.edges[edge * 2];
                let second = self.edges[edge * 2 + 1];
                if first == NO_TRIANGLE || second == NO_TRIANGLE {
                    continue;
                }
                let a = chart_of[first as usize];
                let b = chart_of[second as usize];
                if a < 0 || b < 0 || a == b {
                    continue;
                }
                let low = a.min(b) as u32;
                let high = a.max(b) as u32;
                let key = ((low as u64) << 32) | high as u64;
                let entry = borders.entry(key).or_insert_with(|| {
                    let order = border_order;
                    border_order += 1;
                    (low, high, 0, order)
                });
                entry.2 += 1;
            }
            let mut random = Random::new(seed);
            let mut candidates: Vec<Candidate> = borders
                .iter()
                .map(|(_, (a, b, count, order))| Candidate {
                    score: if seed == 0 {
                        *count as f64
                    } else {
                        *count as f64 * (0.5 + random.next())
                    },
                    order: *order,
                    a: *a,
                    b: *b,
                })
                .collect();
            candidates.sort_by(|left, right| {
                right
                    .score
                    .partial_cmp(&left.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(left.order.cmp(&right.order))
            });

            let mut used = vec![false; charts.len()];
            let mut plans: Vec<Plan> = Vec::new();
            for candidate in candidates {
                checks += 1;
                if checks % 16 == 0 && unsafe { now_epoch() } >= deadline {
                    timed_out = true;
                    break;
                }
                let a = candidate.a as usize;
                let b = candidate.b as usize;
                if used[a] || used[b] {
                    continue;
                }
                let first = &charts[a];
                let second = &charts[b];
                let first_sum = sums[a];
                let second_sum = sums[b];
                let first_length =
                    (first_sum[0] * first_sum[0] + first_sum[1] * first_sum[1] + first_sum[2] * first_sum[2]).sqrt();
                let second_length =
                    (second_sum[0] * second_sum[0] + second_sum[1] * second_sum[1] + second_sum[2] * second_sum[2]).sqrt();
                if first_length == 0.0 || second_length == 0.0 {
                    continue;
                }
                let axis_dot = (first_sum[0] * second_sum[0]
                    + first_sum[1] * second_sum[1]
                    + first_sum[2] * second_sum[2])
                    / (first_length * second_length);
                if axis_dot < axis_merge_cos {
                    continue;
                }
                let sum = [
                    first_sum[0] + second_sum[0],
                    first_sum[1] + second_sum[1],
                    first_sum[2] + second_sum[2],
                ];
                let length = (sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]).sqrt();
                if length == 0.0 {
                    continue;
                }
                let axis = [sum[0] / length, sum[1] / length, sum[2] / length];
                let mut fits = true;
                for faces in [first, second] {
                    for &triangle in faces {
                        let base = triangle as usize * 3;
                        let dot = self.normals[base] as f64 * axis[0]
                            + self.normals[base + 1] as f64 * axis[1]
                            + self.normals[base + 2] as f64 * axis[2];
                        if dot < merge_cos - 1e-9 {
                            fits = false;
                            break;
                        }
                    }
                    if !fits {
                        break;
                    }
                }
                if !fits {
                    continue;
                }
                if !self.projection_fits(first, second, axis, tolerance) {
                    continue;
                }
                used[a] = true;
                used[b] = true;
                let mut faces = Vec::with_capacity(first.len() + second.len());
                faces.extend_from_slice(first);
                faces.extend_from_slice(second);
                plans.push(Plan { a, b, faces, sum });
            }

            if plans.is_empty() {
                break;
            }
            let mut plan_by_first = vec![usize::MAX; charts.len()];
            let mut removed = vec![false; charts.len()];
            for (index, plan) in plans.iter().enumerate() {
                plan_by_first[plan.a] = index;
                removed[plan.b] = true;
            }
            let mut next_charts: Vec<Vec<u32>> = Vec::new();
            let mut next_sums: Vec<[f64; 3]> = Vec::new();
            for chart in 0..charts.len() {
                if removed[chart] {
                    continue;
                }
                let plan = plan_by_first[chart];
                if plan != usize::MAX {
                    next_charts.push(plans[plan].faces.clone());
                    next_sums.push(plans[plan].sum);
                } else {
                    next_charts.push(charts[chart].clone());
                    next_sums.push(sums[chart]);
                }
            }
            charts = next_charts;
            sums = next_sums;
            merges += plans.len() as u32;
            if timed_out {
                break;
            }
        }

        self.result_offsets.clear();
        self.result_faces.clear();
        self.result_axes.clear();
        self.result_offsets.push(0);
        for (chart, faces) in charts.iter().enumerate() {
            self.result_faces.extend_from_slice(faces);
            self.result_offsets.push(self.result_faces.len() as u32);
            let sum = sums[chart];
            let length = (sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]).sqrt();
            if length > 0.0 {
                self.result_axes.push((sum[0] / length) as f32);
                self.result_axes.push((sum[1] / length) as f32);
                self.result_axes.push((sum[2] / length) as f32);
            } else {
                self.result_axes.push(0.0);
                self.result_axes.push(0.0);
                self.result_axes.push(1.0);
            }
        }
        let mut final_of_triangle = vec![-1i32; triangle_count];
        for (chart, faces) in charts.iter().enumerate() {
            for &triangle in faces {
                final_of_triangle[triangle as usize] = chart as i32;
            }
        }
        let mut boundary_edges = 0u32;
        for edge in 0..self.seam.len() {
            if self.seam[edge] != 0 {
                continue;
            }
            let first = self.edges[edge * 2];
            let second = self.edges[edge * 2 + 1];
            if first == NO_TRIANGLE || second == NO_TRIANGLE {
                continue;
            }
            if final_of_triangle[first as usize] != final_of_triangle[second as usize] {
                boundary_edges += 1;
            }
        }
        let mut unresolved = 0u32;
        for chart in 0..charts.len() {
            let sum = sums[chart];
            let length =
                (sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]).sqrt();
            let axis = if length > 0.0 {
                [sum[0] / length, sum[1] / length, sum[2] / length]
            } else {
                [0.0, 0.0, 1.0]
            };
            if !self.projection_fits(&charts[chart], &[], axis, tolerance) {
                unresolved += 1;
            }
        }
        self.merges = merges;
        self.boundary_edges = boundary_edges;
        self.unresolved = unresolved;
        self.timed_out = timed_out;
        0
    }
}

#[no_mangle]
pub extern "C" fn refiner_run(
    state: *mut Refiner,
    seed: u32,
    deadline: f64,
    tolerance: f64,
    merge_cos: f64,
    axis_merge_cos: f64,
) -> i32 {
    if state.is_null() {
        return -1;
    }
    let state = unsafe { &mut *state };
    state.run(seed, deadline, tolerance, merge_cos, axis_merge_cos)
}

#[no_mangle]
pub extern "C" fn refiner_result_chart_count(state: *const Refiner) -> u32 {
    if state.is_null() {
        return 0;
    }
    unsafe { (*state).result_offsets.len().saturating_sub(1) as u32 }
}

#[no_mangle]
pub extern "C" fn refiner_result_offsets(state: *const Refiner) -> *const u32 {
    if state.is_null() {
        return std::ptr::null();
    }
    unsafe { (*state).result_offsets.as_ptr() }
}

#[no_mangle]
pub extern "C" fn refiner_result_faces(state: *const Refiner) -> *const u32 {
    if state.is_null() {
        return std::ptr::null();
    }
    unsafe { (*state).result_faces.as_ptr() }
}

#[no_mangle]
pub extern "C" fn refiner_result_axes(state: *const Refiner) -> *const f32 {
    if state.is_null() {
        return std::ptr::null();
    }
    unsafe { (*state).result_axes.as_ptr() }
}

#[no_mangle]
pub extern "C" fn refiner_result_merges(state: *const Refiner) -> u32 {
    if state.is_null() {
        return 0;
    }
    unsafe { (*state).merges }
}

#[no_mangle]
pub extern "C" fn refiner_result_boundary_edges(state: *const Refiner) -> u32 {
    if state.is_null() {
        return 0;
    }
    unsafe { (*state).boundary_edges }
}

#[no_mangle]
pub extern "C" fn refiner_result_unresolved(state: *const Refiner) -> u32 {
    if state.is_null() {
        return 0;
    }
    unsafe { (*state).unresolved }
}

#[no_mangle]
pub extern "C" fn refiner_result_timed_out(state: *const Refiner) -> u32 {
    if state.is_null() {
        return 0;
    }
    unsafe { if (*state).timed_out { 1 } else { 0 } }
}
