import { describe, expect, it } from 'vitest';
import {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  mergeConfig,
  parsePresetText,
  serializePreset,
  stageIndex,
  validateConfig,
} from '../src/lib/unwrap/config';

describe('unwrap config', () => {
  it('accepts the defaults', () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual([]);
  });

  it('rejects incomplete and out-of-range settings', () => {
    const errors = validateConfig({});
    expect(errors.length).toBeGreaterThan(5);
    expect(errors.some((error) => error.includes('atlasResolution'))).toBe(true);
    expect(validateConfig({ ...DEFAULT_CONFIG, thresholds: null }).some((error) => error.includes('thresholds'))).toBe(true);
    expect(validateConfig({ ...DEFAULT_CONFIG, seamAngle: 200 }).some((error) => error.includes('seamAngle'))).toBe(true);
  });

  it('merges overrides without losing the threshold block', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      padding: 4,
      thresholds: { maxAngleP95: 5 },
    });
    expect(merged.padding).toBe(4);
    expect(merged.thresholds.maxAngleP95).toBe(5);
    expect(merged.thresholds.maxOverlapFraction).toBe(DEFAULT_CONFIG.thresholds.maxOverlapFraction);
  });

  it('round-trips a preset', () => {
    const text = serializePreset(DEFAULT_CONFIG, 'cube', 'A cube preset');
    const parsed = parsePresetText(text);
    expect(parsed.version).toBe(CONFIG_VERSION);
    expect(parsed.name).toBe('cube');
    expect(parsed.description).toBe('A cube preset');
    expect(parsed.config).toEqual(DEFAULT_CONFIG);
  });

  it('rejects malformed presets', () => {
    expect(() => parsePresetText('not json')).toThrow('not valid JSON');
    expect(() => parsePresetText(JSON.stringify({ config: { atlasResolution: 1 } }))).toThrow('Invalid preset');
  });

  it('orders the stages', () => {
    expect(stageIndex('condition')).toBe(0);
    expect(stageIndex('pack')).toBe(4);
    expect(stageIndex('validate')).toBe(5);
  });
});
