import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../cli/main';
import { setCliHost, type CliHost } from '../cli/host';
import { nodeCliHost } from '../cli/hostNode';
import { parsePresetText } from '../src/lib/unwrap/config';
import type { RawMesh } from '../src/lib/unwrap/types';
import { makeSphere } from './helpers/meshes';

const fixture = fileURLToPath(new URL('./fixtures/cube.obj', import.meta.url));
const logs: string[] = [];
const errors: string[] = [];
const host: CliHost = {
  ...nodeCliHost,
  log(text: string): void {
    logs.push(text);
  },
  error(text: string): void {
    errors.push(text);
  },
};

let directory = '';

async function writeRawObj(mesh: RawMesh, path: string): Promise<void> {
  const lines: string[] = ['o Mesh'];
  for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += 1) {
    lines.push(`v ${mesh.positions[vertex * 3]} ${mesh.positions[vertex * 3 + 1]} ${mesh.positions[vertex * 3 + 2]}`);
  }
  for (let triangle = 0; triangle < mesh.indices.length / 3; triangle += 1) {
    lines.push(`f ${mesh.indices[triangle * 3] + 1} ${mesh.indices[triangle * 3 + 1] + 1} ${mesh.indices[triangle * 3 + 2] + 1}`);
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

beforeEach(async () => {
  setCliHost(host);
  logs.length = 0;
  errors.length = 0;
  if (!directory) directory = await mkdtemp(join(tmpdir(), 'ultiunwrapper-'));
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('CLI', () => {
  it('unwraps a cube and writes OBJ plus report', async () => {
    const output = join(directory, 'cube_unwrapped.obj');
    const report = join(directory, 'cube.unwrap.json');
    const code = await runCli(['-i', fixture, '-o', output, '--report', report, '--json']);
    expect(code).toBe(0);
    const obj = await readFile(output, 'utf8');
    expect(obj).toContain('vt ');
    expect(obj).toContain('f ');
    const parsed = JSON.parse(await readFile(report, 'utf8'));
    expect(parsed.tool).toBe('UltiUnwrapper');
    expect(parsed.summary.status).toBe('pass');
    expect(parsed.summary.charts).toBe(6);
    const json = JSON.parse(logs.join(''));
    expect(json.status).toBe('pass');
    expect(json.charts).toBe(6);
  });

  it('dumps every stage artifact', async () => {
    const stages = join(directory, 'stages');
    const code = await runCli(['-i', fixture, '--dump-stages', stages, '--validate-only']);
    expect(code).toBe(0);
    expect(await readFile(join(stages, 'stage-01-condition.json'), 'utf8')).toContain('inputTriangles');
    expect(await readFile(join(stages, 'stage-02-segment.json'), 'utf8')).toContain('charts');
    expect(await readFile(join(stages, 'stage-03-parameterize.json'), 'utf8')).toContain('angleP95');
    expect(await readFile(join(stages, 'stage-03-parameterize.obj'), 'utf8')).toContain('vt ');
    expect(await readFile(join(stages, 'stage-03-parameterize.svg'), 'utf8')).toContain('<svg');
    expect(await readFile(join(stages, 'stage-05-pack.svg'), 'utf8')).toContain('<polygon');
    expect(await readFile(join(stages, 'stage-06-validate.json'), 'utf8')).toContain('overlapFraction');
  });

  it('fails check thresholds on a distorted sphere', async () => {
    const sphere = join(directory, 'sphere.obj');
    await writeRawObj(makeSphere(12, 6, 1), sphere);
    const code = await runCli([
      '-i', sphere,
      '--max-angle-p95', '0.001',
      '--check',
      '--validate-only',
    ]);
    expect(code).toBe(1);
    expect(errors.join('')).toContain('check:');
  });

  it('rejects bad arguments and missing inputs', async () => {
    expect(await runCli(['--atlas', 'abc'])).toBe(2);
    expect(errors.join('')).toContain('--atlas');
    errors.length = 0;
    expect(await runCli([])).toBe(2);
    expect(errors.join('')).toContain('--input');
    errors.length = 0;
    expect(await runCli(['-i', join(directory, 'missing.obj')])).toBe(2);
    expect(errors.join('')).toContain('error:');
  });

  it('prints version, stages, and help', async () => {
    expect(await runCli(['--version'])).toBe(0);
    expect(logs.join('')).toContain('UltiUnwrapper');
    logs.length = 0;
    expect(await runCli(['--list-stages'])).toBe(0);
    expect(logs.join('')).toContain('parameterize');
    logs.length = 0;
    expect(await runCli(['--help'])).toBe(0);
    expect(logs.join('')).toContain('Usage:');
  });

  it('round-trips a preset through --dump-config and --preset', async () => {
    const preset = join(directory, 'cube.unwrap.preset.json');
    expect(await runCli(['--dump-config', preset])).toBe(0);
    const parsed = parsePresetText(await readFile(preset, 'utf8'));
    expect(parsed.config.atlasResolution).toBe(2048);
    const output = join(directory, 'preset_unwrapped.obj');
    expect(await runCli(['-i', fixture, '-o', output, '--preset', preset])).toBe(0);
    expect((await readFile(output, 'utf8')).length).toBeGreaterThan(100);
  });

  it('writes a GLB when requested', async () => {
    const output = join(directory, 'cube_unwrapped.glb');
    expect(await runCli(['-i', fixture, '-o', output])).toBe(0);
    const bytes = await readFile(output);
    expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
    expect(bytes.readUInt32LE(4)).toBe(2);
  });
});
