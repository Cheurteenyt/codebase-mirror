// v2/tests/config.test.ts
// Tests for the config loader.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, deriveProjectName, DEFAULT_CONFIG } from '../src/config.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('config loader', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cbm-v2-config-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('deriveProjectName', () => {
    it('returns the basename of cwd', () => {
      // Use the tmpDir basename (mkdtempSync adds a suffix to the prefix).
      const name = deriveProjectName(tmpDir);
      expect(name).toBeTruthy();
      expect(name).toBe(tmpDir.split(/[\\/]/).pop());
    });

    it('returns "default" for root /', () => {
      // Hard to test "/" directly on all platforms; test the basename fallback.
      expect(deriveProjectName('/')).toBe('default');
    });

    it('handles trailing slash via basename', () => {
      // basename('/foo/bar/') === 'bar' (basename handles trailing slash).
      expect(deriveProjectName('/foo/bar/')).toBe('bar');
    });
  });

  describe('loadConfig', () => {
    it('returns defaults when no config file exists', () => {
      const config = loadConfig(tmpDir);
      expect(config.v2.enabled).toBe(DEFAULT_CONFIG.v2.enabled);
      expect(config.v2.obsidian.vaultPath).toBe(DEFAULT_CONFIG.v2.obsidian.vaultPath);
      expect(config.v2.obsidian.backupBeforeWrite).toBe(true);
      expect(config.projectName).toBeTruthy();
    });

    it('loads config from .codebase-memory.json', () => {
      writeFileSync(
        join(tmpDir, '.codebase-memory.json'),
        JSON.stringify({
          projectName: 'my-custom-project',
          v2: {
            obsidian: { vaultPath: '/custom/vault', backupBeforeWrite: false },
          },
        })
      );
      const config = loadConfig(tmpDir);
      expect(config.projectName).toBe('my-custom-project');
      expect(config.v2.obsidian.vaultPath).toBe('/custom/vault');
      expect(config.v2.obsidian.backupBeforeWrite).toBe(false);
    });

    it('deep-merges with defaults (fills missing keys)', () => {
      writeFileSync(
        join(tmpDir, '.codebase-memory.json'),
        JSON.stringify({
          projectName: 'partial',
          v2: {
            obsidian: { vaultPath: '/custom/vault' },
          },
        })
      );
      const config = loadConfig(tmpDir);
      expect(config.v2.obsidian.vaultPath).toBe('/custom/vault');
      // Other keys should be filled from defaults.
      expect(config.v2.obsidian.backupBeforeWrite).toBe(true);
      expect(config.v2.obsidian.minDegreeForModuleNote).toBe(20);
      expect(config.v2.mcp.exposeV2Tools).toBe(true);
    });

    it('falls back gracefully on malformed JSON', () => {
      writeFileSync(join(tmpDir, '.codebase-memory.json'), '{ malformed json');
      const config = loadConfig(tmpDir);
      // Should not throw — should return defaults.
      expect(config.v2.enabled).toBe(true);
    });
  });
});
