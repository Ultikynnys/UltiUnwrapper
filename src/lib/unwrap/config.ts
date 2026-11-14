import type { StageId } from './types';

export type ValidationThresholds = {
  maxOverlapFraction: number;
  maxAngleP95: number;
  maxDensitySpread: number;
  maxFlipped: number;
  minOccupancy: number;
};

export type UnwrapConfig = {
  atlasResolution: number;
  padding: number;
  seamAngle: number;
  targetTexelDensity: number;
  weldEpsilon: number;
  splitByObject: boolean;
  splitByMaterial: boolean;
  allowRotation: boolean;
  fitToAtlas: boolean;
  tolerance: number;
  maxIterations: number;
  maxFlippedFraction: number;
  occupancyResolution: number;
  thresholds: ValidationThresholds;
};

export const CONFIG_VERSION = 1;

export const STAGE_ORDER: StageId[] = [
  'condition',
  'segment',
  'parameterize',
  'normalize',
  'inflate',
  'pack',
  'validate',
];

export const STAGE_LABELS: Record<StageId, string> = {
  condition: 'Condition',
  segment: 'Segment',
  parameterize: 'Parameterize',
  normalize: 'Normalize density',
  inflate: 'Inflate density',
  pack: 'Pack atlas',
  validate: 'Validate',
};

export const DEFAULT_CONFIG: UnwrapConfig = {
  atlasResolution: 2048,
  padding: 8,
  seamAngle: 66,
  targetTexelDensity: 256,
  weldEpsilon: 1e-5,
  splitByObject: true,
  splitByMaterial: false,
  allowRotation: true,
  fitToAtlas: true,
  tolerance: 1e-10,
  maxIterations: 2000,
  maxFlippedFraction: 0,
  occupancyResolution: 1024,
  thresholds: {
    maxOverlapFraction: 0.001,
    maxAngleP95: 20,
    maxDensitySpread: 0.1,
    maxFlipped: 0,
    minOccupancy: 0.3,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Returns a list of human-readable validation errors; an empty list means the
 * value is a complete `UnwrapConfig`. */
export function validateConfig(value: unknown): string[] {
  if (!isRecord(value)) return ['Config must be a JSON object.'];
  const errors: string[] = [];
  if (!inRange(value.atlasResolution, 16, 8192)) errors.push('atlasResolution must be 16..8192.');
  if (!inRange(value.padding, 0, 256)) errors.push('padding must be 0..256.');
  if (!inRange(value.seamAngle, 0, 180)) errors.push('seamAngle must be 0..180.');
  if (!inRange(value.targetTexelDensity, 1, 16384)) errors.push('targetTexelDensity must be 1..16384.');
  if (!inRange(value.weldEpsilon, 0, 1)) errors.push('weldEpsilon must be 0..1.');
  if (!isBoolean(value.splitByObject)) errors.push('splitByObject must be a boolean.');
  if (!isBoolean(value.splitByMaterial)) errors.push('splitByMaterial must be a boolean.');
  if (!isBoolean(value.allowRotation)) errors.push('allowRotation must be a boolean.');
  if (!isBoolean(value.fitToAtlas)) errors.push('fitToAtlas must be a boolean.');
  if (!inRange(value.tolerance, 1e-14, 1)) errors.push('tolerance must be 1e-14..1.');
  if (!inRange(value.maxIterations, 1, 100000)) errors.push('maxIterations must be 1..100000.');
  if (!inRange(value.maxFlippedFraction, 0, 1)) errors.push('maxFlippedFraction must be 0..1.');
  if (!inRange(value.occupancyResolution, 64, 4096)) errors.push('occupancyResolution must be 64..4096.');
  if (!isRecord(value.thresholds)) {
    errors.push('thresholds must be an object.');
    return errors;
  }
  const thresholds = value.thresholds;
  if (!inRange(thresholds.maxOverlapFraction, 0, 1)) errors.push('maxOverlapFraction must be 0..1.');
  if (!inRange(thresholds.maxAngleP95, 0, 180)) errors.push('maxAngleP95 must be 0..180.');
  if (!inRange(thresholds.maxDensitySpread, 0, 100)) errors.push('maxDensitySpread must be 0..100.');
  if (!inRange(thresholds.maxFlipped, 0, 1_000_000_000)) errors.push('maxFlipped must be non-negative.');
  if (!inRange(thresholds.minOccupancy, 0, 1)) errors.push('minOccupancy must be 0..1.');
  return errors;
}

export type ConfigOverrides = Omit<Partial<UnwrapConfig>, 'thresholds'> & {
  thresholds?: Partial<ValidationThresholds>;
};

export function mergeConfig(base: UnwrapConfig, overrides: ConfigOverrides): UnwrapConfig {
  return {
    ...base,
    ...overrides,
    thresholds: {
      ...base.thresholds,
      ...(overrides.thresholds ?? {}),
    },
  };
}

export type PresetFile = {
  version: number;
  name: string;
  description: string;
  config: UnwrapConfig;
};

export function parsePresetText(text: string): PresetFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Preset is not valid JSON.');
  }
  if (!isRecord(parsed)) throw new Error('Preset must be a JSON object.');
  const candidate = isRecord(parsed.config) ? parsed.config : parsed;
  const errors = validateConfig(candidate);
  if (errors.length > 0) throw new Error(`Invalid preset: ${errors.join(' ')}`);
  return {
    version: typeof parsed.version === 'number' ? parsed.version : CONFIG_VERSION,
    name: typeof parsed.name === 'string' ? parsed.name : 'preset',
    description: typeof parsed.description === 'string' ? parsed.description : '',
    config: candidate as UnwrapConfig,
  };
}

export function serializePreset(config: UnwrapConfig, name: string, description = ''): string {
  const preset: PresetFile = { version: CONFIG_VERSION, name, description, config };
  return `${JSON.stringify(preset, null, 2)}\n`;
}

export function stageIndex(stage: StageId): number {
  return STAGE_ORDER.indexOf(stage);
}
