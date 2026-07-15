import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/**
 * Validate a project identifier before it is interpolated into a SQLite path.
 *
 * Project names are persisted as cross-platform filenames. Reject path
 * separators, control characters, Windows-invalid names, and ambiguous
 * trailing characters even when the current host would accept them.
 */
export function validateProjectStorageName(project: string): string {
  if (project.length === 0 || project.length > 128) {
    throw new Error('Invalid project name: expected between 1 and 128 characters');
  }
  if (project !== project.trim()) {
    throw new Error('Invalid project name: leading or trailing whitespace is not allowed');
  }
  if (project.startsWith('-')) {
    throw new Error('Invalid project name: a leading hyphen is not allowed');
  }
  if (project.toLowerCase() === '_config') {
    throw new Error('Invalid project name: _config is reserved for runtime configuration');
  }
  if (project === '.' || project === '..') {
    throw new Error('Invalid project name: dot path segments are not allowed');
  }
  if (INVALID_FILENAME_CHARS.test(project)) {
    throw new Error('Invalid project name: path separators or filename control characters are not allowed');
  }
  if (/[. ]$/u.test(project)) {
    throw new Error('Invalid project name: a trailing dot or space is not allowed');
  }
  if (WINDOWS_RESERVED_NAME.test(project)) {
    throw new Error('Invalid project name: reserved device names are not allowed');
  }
  // `<project>.human.db` is the human-memory partition for `<project>`. A
  // code project ending in `.human` would resolve to that same filename
  // (case-insensitively on Windows/macOS) and could corrupt the other store.
  if (/\.human$/iu.test(project)) {
    throw new Error('Invalid project name: the .human suffix is reserved for the human-memory database');
  }
  // Common filesystems cap a single component at 255 bytes. Validate the
  // longer physical suffix so multibyte Unicode names cannot pass the
  // character-count check and fail later with ENAMETOOLONG.
  if (Buffer.byteLength(`${project}.human.db`, 'utf8') > 255) {
    throw new Error('Invalid project name: database filename exceeds 255 UTF-8 bytes');
  }
  return project;
}

/** Resolve a project database path and prove that it remains in the cache. */
export function resolveProjectStoragePath(
  project: string,
  suffix: '.db' | '.human.db',
  cacheDir = process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
): string {
  const safeProject = validateProjectStorageName(project);
  const storageDir = resolve(cacheDir, 'codebase-memory-mcp');
  const candidate = resolve(storageDir, `${safeProject}${suffix}`);
  const relativeCandidate = relative(storageDir, candidate);

  if (
    relativeCandidate === '..'
    || relativeCandidate.startsWith(`..${sep}`)
    || isAbsolute(relativeCandidate)
  ) {
    throw new Error('Invalid project name: resolved database path escapes the cache directory');
  }

  return candidate;
}
