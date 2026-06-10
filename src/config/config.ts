import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Per-model pricing in USD per 1M tokens. */
export interface ModelPricing {
  /** Cache-miss input price per 1M tokens. */
  input: number;
  /** Output price per 1M tokens. */
  output: number;
  /** Cache-hit input price per 1M tokens. */
  cacheRead: number;
}

export interface AlwaysAllow {
  fileWrite: boolean;
  shell: boolean;
}

export interface Config {
  baseURL: string;
  defaultModel: string;
  compactThreshold: number;
  alwaysAllow: AlwaysAllow;
  pricing: Record<string, ModelPricing>;
}

/**
 * DeepSeek rates verified 2026-06-10 at api-docs.deepseek.com: deepseek-chat /
 * deepseek-reasoner currently map to deepseek-v4-flash — $0.14/1M input
 * (cache miss), $0.0028/1M input (cache hit), $0.28/1M output.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'code-fast': { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  'code-deep': { input: 0.14, output: 0.28, cacheRead: 0.0028 },
};

export const DEFAULT_CONFIG: Config = {
  baseURL: '',
  defaultModel: 'code-fast',
  compactThreshold: 80_000,
  alwaysAllow: { fileWrite: false, shell: false },
  pricing: DEFAULT_PRICING,
};

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ARKS_CODE_HOME ?? path.join(os.homedir(), '.arks-code');
  return home;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'config.json');
}

export function configFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return fs.existsSync(configPath(env));
}

/** Deep-merge a partial config file over the defaults. */
function mergeConfig(base: Config, file: Partial<Config>): Config {
  return {
    baseURL: file.baseURL ?? base.baseURL,
    defaultModel: file.defaultModel ?? base.defaultModel,
    compactThreshold: file.compactThreshold ?? base.compactThreshold,
    alwaysAllow: { ...base.alwaysAllow, ...(file.alwaysAllow ?? {}) },
    pricing: { ...base.pricing, ...(file.pricing ?? {}) },
  };
}

/**
 * Load ~/.arks-code/config.json (if present) over defaults, then apply env
 * overrides: ARKS_LLM_BASE_URL, ARKS_LLM_MODEL. ARKS_LLM_KEY is intentionally
 * NOT part of Config — it is read from env only, at call time (CLAUDE.md §7).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let cfg = DEFAULT_CONFIG;
  const p = configPath(env);
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<Config>;
      cfg = mergeConfig(DEFAULT_CONFIG, raw);
    } catch (err) {
      throw new Error(`Invalid config at ${p}: ${(err as Error).message}`);
    }
  }
  if (env.ARKS_LLM_BASE_URL) cfg = { ...cfg, baseURL: env.ARKS_LLM_BASE_URL };
  if (env.ARKS_LLM_MODEL) cfg = { ...cfg, defaultModel: env.ARKS_LLM_MODEL };
  return cfg;
}

export function saveConfig(cfg: Config, env: NodeJS.ProcessEnv = process.env): void {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(env), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** The gateway API key. Read from env only — never stored in config. */
export function apiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.ARKS_LLM_KEY;
}
