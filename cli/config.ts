import {
  DEFAULT_CONFIG,
  STAGE_LABELS,
  STAGE_ORDER,
  mergeConfig,
  parsePresetText,
  validateConfig,
  type UnwrapConfig,
  type ValidationThresholds,
} from '../src/lib/unwrap/config';
import type { StageId } from '../src/lib/unwrap/types';
import { cliHost } from './host';

export class CliError extends Error {}

export type CliFormat = 'obj' | 'glb';

export type CliOptions = {
  input: string | null;
  output: string | null;
  format: CliFormat | null;
  report: string | null;
  dumpStages: string | null;
  preset: string | null;
  /** null = not requested; empty string = default path. */
  dumpConfig: string | null;
  json: boolean;
  check: boolean;
  validateOnly: boolean;
  rewrap: boolean;
  stage: StageId | null;
  help: boolean;
  version: boolean;
  listStages: boolean;
  overrides: Partial<Omit<UnwrapConfig, 'thresholds'>>;
  thresholdOverrides: Partial<ValidationThresholds>;
};

function numberValue(flag: string, value: string | undefined, min: number, max: number): number {
  if (value === undefined) throw new CliError(`${flag} needs a value.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new CliError(`${flag} must be a number in ${min}..${max}.`);
  }
  return parsed;
}

function stageValue(flag: string, value: string | undefined): StageId {
  if (value === undefined) throw new CliError(`${flag} needs a stage id.`);
  if (!STAGE_ORDER.includes(value as StageId)) {
    throw new CliError(`${flag} must be one of: ${STAGE_ORDER.join(', ')}.`);
  }
  return value as StageId;
}

/** Parses CLI flags into overrides. Preset loading and the final config merge
 * are async (`buildConfig`) because a preset is read through the CLI host. */
export function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    input: null,
    output: null,
    format: null,
    report: null,
    dumpStages: null,
    preset: null,
    dumpConfig: null,
    json: false,
    check: false,
    validateOnly: false,
    rewrap: false,
    stage: null,
    help: false,
    version: false,
    listStages: false,
    overrides: {},
    thresholdOverrides: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string | undefined => {
      index += 1;
      return argv[index];
    };
    const optional = (): string | undefined => {
      const candidate = argv[index + 1];
      if (candidate !== undefined && !candidate.startsWith('-')) {
        index += 1;
        return candidate;
      }
      return undefined;
    };
    switch (arg) {
      case '-i':
      case '--input':
        options.input = next() ?? (() => { throw new CliError(`${arg} needs a path.`); })();
        break;
      case '-o':
      case '--output':
        options.output = next() ?? (() => { throw new CliError(`${arg} needs a path.`); })();
        break;
      case '--format': {
        const value = next();
        if (value !== 'obj' && value !== 'glb') throw new CliError('--format must be obj or glb.');
        options.format = value;
        break;
      }
      case '--report':
        options.report = next() ?? (() => { throw new CliError('--report needs a path.'); })();
        break;
      case '--dump-stages':
        options.dumpStages = next() ?? (() => { throw new CliError('--dump-stages needs a directory.'); })();
        break;
      case '--preset':
        options.preset = next() ?? (() => { throw new CliError('--preset needs a path.'); })();
        break;
      case '--dump-config':
        options.dumpConfig = optional() ?? '';
        break;
      case '--json':
        options.json = true;
        break;
      case '--check':
        options.check = true;
        break;
      case '--validate-only':
        options.validateOnly = true;
        break;
      case '--rewrap':
        options.rewrap = true;
        break;
      case '--stage':
        options.stage = stageValue(arg, next());
        break;
      case '--list-stages':
        options.listStages = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--atlas':
        options.overrides.atlasResolution = numberValue(arg, next(), 16, 8192);
        break;
      case '--padding':
        options.overrides.padding = numberValue(arg, next(), 0, 256);
        break;
      case '--seam-angle':
        options.overrides.seamAngle = numberValue(arg, next(), 0, 180);
        break;
      case '--texel-density':
        options.overrides.targetTexelDensity = numberValue(arg, next(), 1, 16384);
        break;
      case '--weld-epsilon':
        options.overrides.weldEpsilon = numberValue(arg, next(), 0, 1);
        break;
      case '--tolerance':
        options.overrides.tolerance = numberValue(arg, next(), 1e-14, 1);
        break;
      case '--max-iterations':
        options.overrides.maxIterations = numberValue(arg, next(), 1, 100000);
        break;
      case '--max-flipped-fraction':
        options.overrides.maxFlippedFraction = numberValue(arg, next(), 0, 1);
        break;
      case '--occupancy-resolution':
        options.overrides.occupancyResolution = numberValue(arg, next(), 64, 4096);
        break;
      case '--fit-atlas':
        options.overrides.fitToAtlas = true;
        break;
      case '--no-fit-atlas':
        options.overrides.fitToAtlas = false;
        break;
      case '--pack-rotation':
        options.overrides.allowRotation = true;
        break;
      case '--no-pack-rotation':
        options.overrides.allowRotation = false;
        break;
      case '--split-by-object':
        options.overrides.splitByObject = true;
        break;
      case '--no-split-by-object':
        options.overrides.splitByObject = false;
        break;
      case '--split-by-material':
        options.overrides.splitByMaterial = true;
        break;
      case '--no-split-by-material':
        options.overrides.splitByMaterial = false;
        break;
      case '--max-overlap':
        options.thresholdOverrides.maxOverlapFraction = numberValue(arg, next(), 0, 1);
        break;
      case '--max-angle-p95':
        options.thresholdOverrides.maxAngleP95 = numberValue(arg, next(), 0, 180);
        break;
      case '--max-density-spread':
        options.thresholdOverrides.maxDensitySpread = numberValue(arg, next(), 0, 100);
        break;
      case '--max-flipped':
        options.thresholdOverrides.maxFlipped = numberValue(arg, next(), 0, 1_000_000_000);
        break;
      case '--min-occupancy':
        options.thresholdOverrides.minOccupancy = numberValue(arg, next(), 0, 1);
        break;
      default:
        throw new CliError(`Unknown argument "${arg}". Try --help.`);
    }
  }
  return options;
}

export async function buildConfig(options: CliOptions): Promise<UnwrapConfig> {
  let config = DEFAULT_CONFIG;
  if (options.preset) {
    const host = cliHost();
    let text: string;
    try {
      text = await host.readFileText(host.resolvePath(options.preset));
    } catch (error) {
      throw new CliError(`Could not read preset: ${(error as Error).message}`);
    }
    try {
      config = parsePresetText(text).config;
    } catch (error) {
      throw new CliError((error as Error).message);
    }
  }
  config = mergeConfig(config, {
    ...options.overrides,
    thresholds: {
      ...config.thresholds,
      ...options.thresholdOverrides,
    },
  });
  const errors = validateConfig(config);
  if (errors.length > 0) throw new CliError(`Invalid settings: ${errors.join(' ')}`);
  return config;
}

export function configHelp(): string {
  const d = DEFAULT_CONFIG;
  return `  --atlas <n>                Atlas resolution in pixels [${d.atlasResolution}]
  --padding <n>              Minimum chart gap in pixels [${d.padding}]
  --seam-angle <deg>         Dihedral seam threshold [${d.seamAngle}]
  --texel-density <px/u>     Target texel density [${d.targetTexelDensity}]
  --weld-epsilon <f>         Weld tolerance / bbox diagonal [${d.weldEpsilon}]
  --tolerance <f>            LSCM relative residual [${d.tolerance}]
  --max-iterations <n>       LSCM iteration cap [${d.maxIterations}]
  --max-flipped-fraction <f> LSCM fallback threshold [${d.maxFlippedFraction}]
  --occupancy-resolution <n> Raster occupancy resolution [${d.occupancyResolution}]
  --fit-atlas                Grow charts to fill the atlas [on]
  --no-fit-atlas             Hold the target texel density
  --pack-rotation            Allow 90 degree chart rotation [on]
  --no-pack-rotation         Disable chart rotation
  --split-by-object          Separate source objects into charts [on]
  --no-split-by-object       Merge source objects where possible
  --split-by-material        Separate material groups into charts [off]
  --max-overlap <f>          Check: max overlap fraction [${d.thresholds.maxOverlapFraction}]
  --max-angle-p95 <deg>      Check: max angle p95 [${d.thresholds.maxAngleP95}]
  --max-density-spread <f>   Check: max density spread [${d.thresholds.maxDensitySpread}]
  --max-flipped <n>          Check: max flipped triangles [${d.thresholds.maxFlipped}]
  --min-occupancy <f>        Check: minimum atlas occupancy [${d.thresholds.minOccupancy}]
  --preset <file>            Load an unwrap preset JSON
  --dump-config [<file>]     Write the resolved settings and exit
  --report <file>            Write the JSON report
  --dump-stages <dir>        Write per-stage JSON, OBJ, and SVG artifacts
  --stage <id>               Stop writing after this stage (${STAGE_ORDER.join(', ')})
  --validate-only            Run all stages but skip the mesh export
  --json                     Print a machine-readable summary
  --check                    Exit 1 when validation crosses a threshold
  --list-stages              List stage ids and exit
  --version                  Print the version and exit
  -h, --help                 Show this help`;
}

export function stageHelp(): string {
  return STAGE_ORDER.map((stage, index) => `  ${index + 1}. ${stage.padEnd(14)} ${STAGE_LABELS[stage]}`).join('\n');
}
