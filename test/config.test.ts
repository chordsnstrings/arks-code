import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  apiKey,
  configFileExists,
  configPath,
  loadConfig,
  saveConfig,
} from '../src/config/config.js';

let tmpHome: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'arks-config-'));
  env = { ARKS_CODE_HOME: tmpHome };
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig(env);
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.defaultModel).toBe('code-fast');
    expect(cfg.compactThreshold).toBe(80_000);
    expect(cfg.pricing['code-fast']).toBeDefined();
    expect(cfg.pricing['code-deep']).toBeDefined();
  });

  it('merges a partial config file over defaults', () => {
    fs.writeFileSync(
      configPath(env),
      JSON.stringify({ baseURL: 'https://gw.arks.internal/v1', alwaysAllow: { shell: true } }),
    );
    const cfg = loadConfig(env);
    expect(cfg.baseURL).toBe('https://gw.arks.internal/v1');
    expect(cfg.alwaysAllow).toEqual({ fileWrite: false, shell: true });
    expect(cfg.defaultModel).toBe('code-fast'); // untouched default
  });

  it('applies env overrides over the file', () => {
    fs.writeFileSync(configPath(env), JSON.stringify({ baseURL: 'https://file/v1', defaultModel: 'code-fast' }));
    const cfg = loadConfig({
      ...env,
      ARKS_LLM_BASE_URL: 'https://env/v1',
      ARKS_LLM_MODEL: 'code-deep',
    });
    expect(cfg.baseURL).toBe('https://env/v1');
    expect(cfg.defaultModel).toBe('code-deep');
  });

  it('throws a readable error on corrupt config', () => {
    fs.writeFileSync(configPath(env), '{not json');
    expect(() => loadConfig(env)).toThrow(/Invalid config/);
  });
});

describe('saveConfig / configFileExists', () => {
  it('round-trips and creates the directory', () => {
    const dir = path.join(tmpHome, 'nested');
    const env2 = { ARKS_CODE_HOME: dir };
    expect(configFileExists(env2)).toBe(false);
    saveConfig({ ...DEFAULT_CONFIG, baseURL: 'https://x/v1' }, env2);
    expect(configFileExists(env2)).toBe(true);
    expect(loadConfig(env2).baseURL).toBe('https://x/v1');
  });
});

describe('apiKey', () => {
  it('reads ARKS_LLM_KEY from env only', () => {
    expect(apiKey({})).toBeUndefined();
    expect(apiKey({ ARKS_LLM_KEY: 'sk-test' })).toBe('sk-test');
  });
});
