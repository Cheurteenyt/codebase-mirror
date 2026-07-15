import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import { defaultHumanDbPath } from '../../src/human/store.js';
import {
  resolveProjectStoragePath,
  validateProjectStorageName,
} from '../../src/storage/project-path.js';

describe('project database path confinement', () => {
  it.each(['codebase-mirror', 'D-Mycodex', 'release.v2', 'equipe_2', '_private'])(
    'accepts the portable project name %s',
    (project) => {
      expect(validateProjectStorageName(project)).toBe(project);
    },
  );

  it.each([
    '',
    ' ../escape',
    '../escape',
    '..\\escape',
    '/absolute',
    'C:\\absolute',
    '-leading-option',
    '_config',
    'trailing.',
    'trailing ',
    'CON',
    'nul.backup',
    'foo.human',
    'foo.HuMaN',
    'line\nbreak',
  ])('rejects the unsafe project name %j', (project) => {
    expect(() => validateProjectStorageName(project)).toThrow(/Invalid project name/);
  });

  it('keeps code and human databases directly inside the cache directory', () => {
    const cacheDir = join(tmpdir(), 'cbm-project-path-test');
    const storageDir = resolve(cacheDir, 'codebase-memory-mcp');
    const codePath = resolveProjectStoragePath('codebase-mirror', '.db', cacheDir);
    const humanPath = resolveProjectStoragePath('codebase-mirror', '.human.db', cacheDir);

    expect(dirname(codePath)).toBe(storageDir);
    expect(dirname(humanPath)).toBe(storageDir);
    expect(basename(codePath)).toBe('codebase-mirror.db');
    expect(basename(humanPath)).toBe('codebase-mirror.human.db');
  });

  it('protects both public default path helpers', () => {
    expect(() => defaultCodeDbPath('../escape')).toThrow(/Invalid project name/);
    expect(() => defaultHumanDbPath('..\\escape')).toThrow(/Invalid project name/);
  });

  it('keeps code and human database namespaces disjoint', () => {
    expect(() => defaultCodeDbPath('foo.human')).toThrow(/\.human suffix is reserved/);
    expect(defaultCodeDbPath('foo')).not.toBe(defaultHumanDbPath('foo'));
  });

  it('includes the database suffix when enforcing the portable filename byte limit', () => {
    expect(validateProjectStorageName('é'.repeat(120))).toBe('é'.repeat(120));
    expect(() => validateProjectStorageName('é'.repeat(128))).toThrow(/255 UTF-8 bytes/);
  });
});
