// v2/src/config.ts
// Loader for `.codebase-memory.json` project configuration.
// Provides typed access to all V2 options with sensible defaults.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { basename } from 'node:path';

export interface V2Config {
  projectName: string;
  root: string;
  exclude: string[];
  v2: {
    enabled: boolean;
    humanMemory: {
      enabled: boolean;
      dbPath?: string;       // template with {project}
    };
    obsidian: {
      enabled: boolean;
      vaultPath: string;
      preserveHumanSections: boolean;
      autoGenerateModuleNotes: boolean;
      autoGenerateRouteNotes: boolean;
      minDegreeForModuleNote: number;
      backupBeforeWrite: boolean;
    };
    ui: {
      defaultView: string;
      maxInitialNodes: number;
    };
    privacy: {
      localOnly: boolean;
      telemetry: boolean;
    };
    mcp: {
      exposeV2Tools: boolean;
      maxContextNodes: number;
    };
  };
}

export const DEFAULT_CONFIG: V2Config = {
  projectName: '',
  root: '.',
  exclude: ['node_modules', 'dist', '.git'],
  v2: {
    enabled: true,
    humanMemory: { enabled: true },
    obsidian: {
      enabled: true,
      vaultPath: '.codebase-memory-vault',
      preserveHumanSections: true,
      autoGenerateModuleNotes: true,
      autoGenerateRouteNotes: true,
      minDegreeForModuleNote: 20,
      backupBeforeWrite: true,
    },
    ui: {
      defaultView: 'architecture-dashboard',
      maxInitialNodes: 500,
    },
    privacy: {
      localOnly: true,
      telemetry: false,
    },
    mcp: {
      exposeV2Tools: true,
      maxContextNodes: 200,
    },
  },
};

/**
 * Derive a project name from the current working directory.
 * Uses basename() to handle trailing slashes correctly.
 */
export function deriveProjectName(cwd: string = process.cwd()): string {
  const name = basename(cwd);
  return name || 'default';
}

/**
 * Deep-merge two objects. Arrays are replaced (not merged).
 */
export function deepMerge<T>(base: T, override: any): T {
  if (override == null) return base;
  if (typeof base !== 'object' || base === null) return override as T;
  if (Array.isArray(base)) return (Array.isArray(override) ? override : base) as T;
  const result: any = { ...base };
  for (const key of Object.keys(override)) {
    if (typeof (base as any)[key] === 'object' && (base as any)[key] !== null && typeof override[key] === 'object' && override[key] !== null) {
      result[key] = deepMerge((base as any)[key], override[key]);
    } else if (override[key] !== undefined) {
      result[key] = override[key];
    }
  }
  return result as T;
}

/**
 * Load and validate `.codebase-memory.json` from `cwd`. Returns the merged config.
 * Falls back to defaults (with projectName derived from cwd) if the file is missing
 * or malformed.
 */
export function loadConfig(cwd: string = process.cwd()): V2Config {
  const configPath = join(cwd, '.codebase-memory.json');
  let userConfig: any = {};
  if (existsSync(configPath)) {
    try {
      userConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (e: any) {
      process.stderr.write(`[cbm-v2] Warning: .codebase-memory.json is malformed (${e.message}). Using defaults.\n`);
      userConfig = {};
    }
  }
  const merged = deepMerge(DEFAULT_CONFIG, userConfig);
  // Fill in derived project name if not set.
  if (!merged.projectName) {
    merged.projectName = deriveProjectName(cwd);
  }
  return merged as V2Config;
}

/**
 * Render a path template that may contain `{project}` placeholder.
 */
export function renderTemplate(template: string, project: string): string {
  return template.replace(/\{project\}/g, project);
}
