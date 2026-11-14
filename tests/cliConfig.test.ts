import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError, buildConfig, configHelp, parseCli, stageHelp } from '../cli/config';
import { setCliHost, type CliHost } from '../cli/host';
import { DEFAULT_CONFIG, serializePreset } from '../src/lib/unwrap/config';

const files = new Map<string, string>();

const host: CliHost = {
  async readFileBytes(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFileText(path));
  },
  async readFileText(path: string): Promise<string> {
    const text = files.get(path);
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  },
  async writeFileBytes(): Promise<void> {},
  resolvePath(path: string): string {
    return path;
  },
  log(): void {},
  error(): void {},
  async flush(): Promise<void> {},
};

beforeEach(() => {
  files.clear();
  setCliHost(host);
});

afterEach(() => {
  setCliHost(host);
});

describe('CLI parsing', () => {
  it('parses every option family', () => {
    const options = parseCli([
      '-i', 'in.obj', '-o', 'out.glb', '--format', 'glb',
      '--report', 'report.json', '--dump-stages', 'stages',
      '--preset', 'preset.json', '--dump-config', 'resolved.json',
      '--json', '--check', '--validate-only', '--rewrap', '--stage', 'pack',
      '--atlas', '1024', '--padding', '4', '--seam-angle', '30',
      '--texel-density', '512', '--weld-epsilon', '0.001',
      '--tolerance', '1e-6', '--max-iterations', '100',
      '--max-flipped-fraction', '0.2', '--occupancy-resolution', '128',
      '--no-pack-rotation', '--no-split-by-object', '--split-by-material',
      '--max-overlap', '0.01', '--max-angle-p95', '10',
      '--max-density-spread', '5', '--max-flipped', '2', '--min-occupancy', '0.2',
    ]);
    expect(options.input).toBe('in.obj');
    expect(options.output).toBe('out.glb');
    expect(options.format).toBe('glb');
    expect(options.report).toBe('report.json');
    expect(options.dumpStages).toBe('stages');
    expect(options.preset).toBe('preset.json');
    expect(options.dumpConfig).toBe('resolved.json');
    expect(options.json).toBe(true);
    expect(options.check).toBe(true);
    expect(options.validateOnly).toBe(true);
    expect(options.rewrap).toBe(true);
    expect(options.stage).toBe('pack');
    expect(options.overrides).toMatchObject({
      atlasResolution: 1024,
      padding: 4,
      seamAngle: 30,
      targetTexelDensity: 512,
      weldEpsilon: 0.001,
      tolerance: 1e-6,
      maxIterations: 100,
      maxFlippedFraction: 0.2,
      occupancyResolution: 128,
      allowRotation: false,
      splitByObject: false,
      splitByMaterial: true,
    });
    expect(options.thresholdOverrides).toEqual({
      maxOverlapFraction: 0.01,
      maxAngleP95: 10,
      maxDensitySpread: 5,
      maxFlipped: 2,
      minOccupancy: 0.2,
    });
  });

  it('supports optional dump-config and boolean flags', () => {
    expect(parseCli(['--dump-config']).dumpConfig).toBe('');
    expect(parseCli(['--dump-config', '--json']).dumpConfig).toBe('');
    expect(parseCli(['--pack-rotation', '--split-by-object', '--no-split-by-material']).overrides).toMatchObject({
      allowRotation: true,
      splitByObject: true,
      splitByMaterial: false,
    });
    expect(parseCli(['--list-stages']).listStages).toBe(true);
    expect(parseCli(['--version']).version).toBe(true);
    expect(parseCli(['-h']).help).toBe(true);
    expect(parseCli(['--help']).help).toBe(true);
  });

  it('rejects malformed and out-of-range arguments', () => {
    expect(() => parseCli(['--format', 'fbx'])).toThrow(CliError);
    expect(() => parseCli(['--atlas'])).toThrow(/--atlas needs a value/);
    expect(() => parseCli(['--atlas', '99999'])).toThrow(/in 16..8192/);
    expect(() => parseCli(['--padding', '-1'])).toThrow(/in 0..256/);
    expect(() => parseCli(['--stage'])).toThrow(/needs a stage id/);
    expect(() => parseCli(['--stage', 'nope'])).toThrow(/must be one of/);
    expect(() => parseCli(['-i'])).toThrow(/needs a path/);
    expect(() => parseCli(['-o'])).toThrow(/needs a path/);
    expect(() => parseCli(['--report'])).toThrow(/needs a path/);
    expect(() => parseCli(['--dump-stages'])).toThrow(/needs a directory/);
    expect(() => parseCli(['--preset'])).toThrow(/needs a path/);
    expect(() => parseCli(['--wat'])).toThrow(/Unknown argument/);
  });
});

describe('CLI config building', () => {
  it('merges overrides and thresholds over defaults', async () => {
    const options = parseCli(['--atlas', '1024', '--max-angle-p95', '12']);
    const config = await buildConfig(options);
    expect(config.atlasResolution).toBe(1024);
    expect(config.thresholds.maxAngleP95).toBe(12);
    expect(config.padding).toBe(DEFAULT_CONFIG.padding);
  });

  it('loads a preset and applies overrides on top', async () => {
    files.set('preset.json', serializePreset(
      { ...DEFAULT_CONFIG, atlasResolution: 512, padding: 2 },
      'test',
    ));
    const config = await buildConfig(parseCli(['--preset', 'preset.json', '--atlas', '1024']));
    expect(config.atlasResolution).toBe(1024);
    expect(config.padding).toBe(2);
  });

  it('reports unreadable and invalid presets', async () => {
    await expect(buildConfig(parseCli(['--preset', 'missing.json']))).rejects.toThrow(/Could not read preset/);
    files.set('bad.json', '{ nope');
    await expect(buildConfig(parseCli(['--preset', 'bad.json']))).rejects.toThrow(/not valid JSON/);
    files.set('invalid.json', serializePreset(DEFAULT_CONFIG, 'x').replace('2048', '1'));
    await expect(buildConfig(parseCli(['--preset', 'invalid.json']))).rejects.toThrow(/Invalid preset/);
  });

  it('rejects a merged config outside the allowed ranges', async () => {
    const options = parseCli([]);
    options.overrides.atlasResolution = 1;
    await expect(buildConfig(options)).rejects.toThrow(/Invalid settings/);
  });

  it('prints flag and stage help', () => {
    expect(configHelp()).toContain('--atlas');
    expect(configHelp()).toContain('--min-occupancy');
    expect(stageHelp()).toContain('condition');
    expect(stageHelp()).toContain('validate');
  });
});
