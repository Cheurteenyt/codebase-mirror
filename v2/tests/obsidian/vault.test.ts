// v2/tests/obsidian/vault.test.ts
// Tests for vault filesystem helpers (path traversal, walk, backup rotation).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensureVaultDirs, readNote, writeNote, walkVault, deleteNote } from '../../src/obsidian/vault.js';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('vault helpers', () => {
  let vaultPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cbm-v2-vault-'));
    vaultPath = join(tmpDir, 'vault');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ensureVaultDirs', () => {
    it('creates all expected directories', () => {
      ensureVaultDirs(vaultPath);
      const dirs = readdirSync(vaultPath);
      expect(dirs).toContain('Architecture');
      expect(dirs).toContain('ADR');
      expect(dirs).toContain('Modules');
      expect(dirs).toContain('Routes');
      expect(dirs).toContain('Refactor');
      expect(dirs).toContain('Bugs');
      expect(dirs).toContain('Legacy');
      expect(dirs).toContain('Conventions');
      expect(dirs).toContain('Prompts');
      expect(dirs).toContain('Journal');
    });

    it('is idempotent', () => {
      ensureVaultDirs(vaultPath);
      ensureVaultDirs(vaultPath); // second call should not throw
      expect(existsSync(join(vaultPath, 'ADR'))).toBe(true);
    });
  });

  describe('readNote / writeNote', () => {
    it('writes and reads a note', () => {
      ensureVaultDirs(vaultPath);
      writeNote(vaultPath, 'ADR/test.md', '---\n---\nbody');
      expect(readNote(vaultPath, 'ADR/test.md')).toBe('---\n---\nbody');
    });

    it('returns null for missing note', () => {
      expect(readNote(vaultPath, 'ADR/missing.md')).toBeNull();
    });

    it('returns written:false when content is identical', () => {
      ensureVaultDirs(vaultPath);
      writeNote(vaultPath, 'ADR/test.md', 'content');
      const result = writeNote(vaultPath, 'ADR/test.md', 'content');
      expect(result.written).toBe(false);
    });

    it('rejects path traversal with ..', () => {
      expect(() => readNote(vaultPath, '../../etc/passwd')).toThrow(/path traversal/i);
      expect(() => writeNote(vaultPath, '../../etc/passwd', 'evil')).toThrow(/path traversal/i);
      expect(() => deleteNote(vaultPath, '../../etc/passwd')).toThrow(/path traversal/i);
    });

    it('rejects path traversal with backslashes', () => {
      expect(() => readNote(vaultPath, '..\\\\..\\\\etc\\\\passwd')).toThrow(/path traversal/i);
    });

    it('R55 (Part A): rejects symlink escape via assertPathInsideRoot (SEC-5)', () => {
      // Create a symlink inside the vault pointing outside (e.g. to /tmp).
      // Before R51 (SEC-5), this would let readNote/writeNote escape the vault.
      // R55 (Part A) moved the check to the shared assertPathInsideRoot utility —
      // this test confirms the shared utility still catches the escape.
      ensureVaultDirs(vaultPath);
      const outsideTarget = join(tmpDir, 'outside-target');
      mkdirSync(outsideTarget);
      writeFileSync(join(outsideTarget, 'secret.md'), 'sensitive content');
      // Create symlink: vault/escape-link -> outsideTarget/secret.md
      symlinkSync(join(outsideTarget, 'secret.md'), join(vaultPath, 'escape-link.md'));
      // readNote should reject because the symlink resolves outside the vault.
      expect(() => readNote(vaultPath, 'escape-link.md')).toThrow(/path traversal/i);
      // writeNote should also reject.
      expect(() => writeNote(vaultPath, 'escape-link.md', 'evil')).toThrow(/path traversal/i);
      // deleteNote should also reject.
      expect(() => deleteNote(vaultPath, 'escape-link.md')).toThrow(/path traversal/i);
    });

    it('R55 (Part A): allows symlinks that stay inside the vault', () => {
      // A symlink inside the vault pointing to another location inside the vault
      // is legitimate (e.g. alias notes). The shared assertPathInsideRoot must
      // not over-block these.
      ensureVaultDirs(vaultPath);
      writeFileSync(join(vaultPath, 'original.md'), 'hello');
      symlinkSync(join(vaultPath, 'original.md'), join(vaultPath, 'alias.md'));
      // readNote via the symlink should work and return the target's content.
      const content = readNote(vaultPath, 'alias.md');
      expect(content).toBe('hello');
    });
  });

  describe('backup rotation', () => {
    it('creates a backup before overwriting when backupBeforeWrite is true', () => {
      ensureVaultDirs(vaultPath);
      writeNote(vaultPath, 'ADR/test.md', 'original');
      const result = writeNote(vaultPath, 'ADR/test.md', 'modified', { backupBeforeWrite: true });
      expect(result.backupPath).not.toBeNull();
      expect(existsSync(result.backupPath!)).toBe(true);
    });

    it('does not create backup when backupBeforeWrite is false', () => {
      ensureVaultDirs(vaultPath);
      writeNote(vaultPath, 'ADR/test.md', 'original');
      const result = writeNote(vaultPath, 'ADR/test.md', 'modified', { backupBeforeWrite: false });
      expect(result.backupPath).toBeNull();
    });

    it('prunes old backups beyond MAX_BACKUPS_PER_FILE (5)', () => {
      ensureVaultDirs(vaultPath);
      writeNote(vaultPath, 'ADR/test.md', 'v0');
      // Force 10 backups by writing different content 10 times.
      for (let i = 1; i <= 10; i++) {
        writeNote(vaultPath, 'ADR/test.md', `v${i}`, { backupBeforeWrite: true });
      }
      const backups = readdirSync(join(vaultPath, 'ADR')).filter((f) => f.startsWith('test.md.bak.'));
      // Should be capped at MAX_BACKUPS_PER_FILE = 5.
      expect(backups.length).toBeLessThanOrEqual(5);
    });
  });

  describe('walkVault', () => {
    it('walks an empty vault', () => {
      ensureVaultDirs(vaultPath);
      const files = walkVault(vaultPath);
      expect(files).toEqual([]);
    });

    it('finds .md files recursively', () => {
      ensureVaultDirs(vaultPath);
      writeFileSync(join(vaultPath, 'ADR', 'a.md'), 'a');
      writeFileSync(join(vaultPath, 'Modules', 'b.md'), 'b');
      writeFileSync(join(vaultPath, 'root.md'), 'r');
      const files = walkVault(vaultPath);
      expect(files.sort()).toEqual(['ADR/a.md', 'Modules/b.md', 'root.md'].sort());
    });

    it('skips .obsidian directory', () => {
      ensureVaultDirs(vaultPath);
      mkdirSync(join(vaultPath, '.obsidian'), { recursive: true });
      writeFileSync(join(vaultPath, '.obsidian', 'config.md'), 'config');
      writeFileSync(join(vaultPath, 'visible.md'), 'v');
      const files = walkVault(vaultPath);
      expect(files).toEqual(['visible.md']);
    });

    it('skips .git directory', () => {
      ensureVaultDirs(vaultPath);
      mkdirSync(join(vaultPath, '.git'), { recursive: true });
      writeFileSync(join(vaultPath, '.git', 'config.md'), 'config');
      writeFileSync(join(vaultPath, 'visible.md'), 'v');
      const files = walkVault(vaultPath);
      expect(files).toEqual(['visible.md']);
    });

    it('skips backup files (.bak.*)', () => {
      ensureVaultDirs(vaultPath);
      writeFileSync(join(vaultPath, 'ADR', 'a.md'), 'a');
      writeFileSync(join(vaultPath, 'ADR', 'a.md.bak.1234567890'), 'backup');
      const files = walkVault(vaultPath);
      expect(files).toEqual(['ADR/a.md']);
    });

    it('skips deleted files (.deleted.*)', () => {
      ensureVaultDirs(vaultPath);
      writeFileSync(join(vaultPath, 'ADR', 'a.md'), 'a');
      writeFileSync(join(vaultPath, 'ADR', 'a.md.deleted.1234567890'), 'deleted');
      const files = walkVault(vaultPath);
      expect(files).toEqual(['ADR/a.md']);
    });

    it('handles symlink loops without infinite recursion', () => {
      ensureVaultDirs(vaultPath);
      // Create a symlink loop: vault/loop -> vault
      try {
        symlinkSync(vaultPath, join(vaultPath, 'loop'), 'dir');
      } catch {
        // Symlinks may not be supported on all platforms; skip test.
        return;
      }
      writeFileSync(join(vaultPath, 'visible.md'), 'v');
      // Should not hang.
      const files = walkVault(vaultPath);
      expect(files).toContain('visible.md');
    });
  });
});
