import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodeGraphReader, defaultCodeDbPath } from '../bridge/sqlite-ro.js';
import { HumanMemoryStore, defaultHumanDbPath } from '../human/store.js';
import { validateProjectStorageName } from '../storage/project-path.js';
import { getNotifyHub } from './notify-hub.js';

export function isValidProjectName(project: string): boolean {
  try {
    return validateProjectStorageName(project) === project;
  } catch {
    return false;
  }
}

export interface ProjectStores {
  project: string;
  humanStore: HumanMemoryStore;
  codeReader: CodeGraphReader | undefined;
  humanDbPath: string;
  codeDbPath: string;
}

interface StoreEntry {
  project: string;
  humanStoreHandle: HumanMemoryStore | undefined;
  codeReaderHandle: CodeGraphReader | undefined;
  codeReaderInitialized: boolean;
  humanDbPath: string;
  codeDbPath: string;
  refCount: number;
  lastUsed: number;
  pinned: boolean;
}

export interface ProjectStoreLease {
  stores: ProjectStores;
  release: () => void;
}

function normalizedPath(path: string, caseInsensitive: boolean): string {
  let canonical = resolve(path);
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    // A missing path still has a stable absolute identity for comparison.
  }
  return caseInsensitive ? canonical.toLocaleLowerCase('en-US') : canonical;
}

type BigIntFileIdentity = { dev: bigint; ino: bigint };

/** Compare exact filesystem identities without IEEE-754 rounding on Windows. */
export function fileIdentitiesMatch(
  left: BigIntFileIdentity,
  right: BigIntFileIdentity,
): boolean | undefined {
  const leftAvailable = left.dev !== 0n || left.ino !== 0n;
  const rightAvailable = right.dev !== 0n || right.ino !== 0n;
  if (!leftAvailable || !rightAvailable) return undefined;
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Compare two SQLite paths by file identity when possible, then by canonical
 * path. The explicit caseInsensitive argument makes the portability contract
 * directly testable without mutating process.platform.
 */
export function pathsReferToSameStore(
  left: string,
  right: string,
  caseInsensitive = process.platform === 'win32' || process.platform === 'darwin',
): boolean {
  const leftExists = existsSync(left);
  const rightExists = existsSync(right);
  // On a case-insensitive filesystem, a case-only alias of an existing path
  // also exists. A one-sided existence result is therefore conclusive
  // evidence that these are distinct paths on the current volume.
  if (leftExists !== rightExists) return false;
  if (leftExists && rightExists) {
    try {
      // NTFS file indexes can exceed Number.MAX_SAFE_INTEGER. Request bigint
      // stats so two adjacent file identities cannot collapse to one Number.
      const leftStat = statSync(left, { bigint: true });
      const rightStat = statSync(right, { bigint: true });
      // When both paths exist, the filesystem has already given us a
      // definitive identity answer. In particular, do not subsequently fold
      // case: a case-sensitive volume may legitimately contain two distinct
      // files whose names differ only by case.
      const identityMatch = fileIdentitiesMatch(leftStat, rightStat);
      if (identityMatch !== undefined) return identityMatch;
    } catch {
      // Fall through to canonical path comparison.
    }
  }
  return normalizedPath(left, caseInsensitive) === normalizedPath(right, caseInsensitive);
}

export function projectsReferToSameStores(left: string, right: string): boolean {
  const pathPairs = [
    [defaultCodeDbPath(left), defaultCodeDbPath(right)],
    [defaultHumanDbPath(left), defaultHumanDbPath(right)],
  ] as const;

  // Project aliases cover both physical stores. A shared code DB must never
  // cause a distinct (or merely not-yet-created) human DB to be routed through
  // the wrong registry entry, and vice versa.
  return pathPairs.every(([leftPath, rightPath]) =>
    pathsReferToSameStore(leftPath, rightPath)
  );
}

/**
 * Owns the per-project SQLite handles used by the UI. Requests take a short
 * lease so idle entries can be evicted without closing a store that is still
 * serving a request. The startup project remains pinned for the server's
 * lifetime and every handle is closed by closeAll().
 */
export class ProjectStoreRegistry {
  private readonly entries = new Map<string, StoreEntry>();
  private readonly canonicalProjects: string[] = [];
  private clock = 0;

  constructor(
    private readonly defaultProject: string,
    private readonly maxEntries = 4,
  ) {
    if (!isValidProjectName(defaultProject)) {
      throw new Error(`Invalid project name: ${defaultProject}`);
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Project store registry size must be a positive integer');
    }
    this.openEntry(defaultProject, true);
  }

  acquire(project: string): ProjectStoreLease {
    if (!isValidProjectName(project)) {
      throw new Error(`Invalid project name: ${project}`);
    }
    const canonicalProject = this.resolveProjectName(project);
    const entry = this.entries.get(canonicalProject)
      ?? this.openEntry(canonicalProject, canonicalProject === this.defaultProject);
    entry.refCount += 1;
    entry.lastUsed = ++this.clock;
    this.evictIdleEntries();

    const registry = this;
    let released = false;
    return {
      // Keep opening lazy all the way through RouteContext. Merely listing
      // projects, reading logs, checking index status, etc. must not create a
      // human SQLite database as a side effect.
      stores: {
        project: entry.project,
        get humanStore() { return registry.getHumanStore(entry); },
        get codeReader() { return registry.getCodeReader(entry); },
        humanDbPath: entry.humanDbPath,
        codeDbPath: entry.codeDbPath,
      },
      release: () => {
        if (released) return;
        released = true;
        entry.refCount = Math.max(0, entry.refCount - 1);
        entry.lastUsed = ++this.clock;
        this.evictIdleEntries();
      },
    };
  }

  /**
   * Open a replacement reader before closing the old one. If the replacement
   * cannot be opened, the existing reader remains usable and the error is
   * propagated to the index job.
   */
  refreshCodeReader(project: string): CodeGraphReader {
    if (!isValidProjectName(project)) {
      throw new Error(`Invalid project name: ${project}`);
    }
    const canonicalProject = this.resolveProjectName(project);
    const entry = this.entries.get(canonicalProject)
      ?? this.openEntry(canonicalProject, canonicalProject === this.defaultProject);
    const replacement = new CodeGraphReader(entry.codeDbPath);
    const previous = entry.codeReaderHandle;
    entry.codeReaderHandle = replacement;
    entry.codeReaderInitialized = true;
    entry.lastUsed = ++this.clock;
    try {
      previous?.close();
    } catch {
      // The new reader is already installed; a close failure must not roll it back.
    }
    this.evictIdleEntries();
    return replacement;
  }

  /** Return true when deleting the named DBs would remove an open store. */
  isProjectStoreOpen(project: string): boolean {
    const candidatePaths = [defaultCodeDbPath(project), defaultHumanDbPath(project)];
    for (const entry of this.entries.values()) {
      const openPaths: string[] = [];
      // The startup project is intentionally owned for the full server
      // lifetime even before a lazy handle is needed. Preserve the deletion
      // guard for that pinned identity while allowing incidental read-only
      // route entries with no handles to remain side-effect free.
      const leased = entry.refCount > 0;
      if (entry.pinned || leased || entry.codeReaderHandle) openPaths.push(entry.codeDbPath);
      if (entry.pinned || leased || entry.humanStoreHandle) openPaths.push(entry.humanDbPath);
      for (const candidate of candidatePaths) {
        for (const openPath of openPaths) {
          if (pathsReferToSameStore(candidate, openPath)) return true;
        }
      }
    }
    return false;
  }

  /** Resolve filesystem aliases/case variants to the registry's logical name. */
  resolveProjectName(project: string): string {
    if (!isValidProjectName(project)) throw new Error(`Invalid project name: ${project}`);
    // Files can be atomically replaced while the UI is running, which can
    // split a hardlink identity that used to be an alias. Recompute against
    // the live filesystem on every resolution instead of trusting a stale
    // logical-name cache. Earlier canonical projects remain stable.
    for (const canonical of this.canonicalProjects) {
      if (canonical === project) {
        return project;
      }
      if (!projectsReferToSameStores(project, canonical)) continue;
      const projectIndex = this.canonicalProjects.indexOf(project);
      if (projectIndex >= 0) this.canonicalProjects.splice(projectIndex, 1);
      return canonical;
    }
    // Resolution is also used by long-lived indexing jobs that do not keep a
    // route lease open. Remember their physical identity so a second spelling
    // cannot bypass the per-project concurrency limit.
    if (!this.canonicalProjects.includes(project)) this.canonicalProjects.push(project);
    this.trimUnopenedCanonicalHistory();
    return project;
  }

  get size(): number {
    return this.entries.size;
  }

  closeAll(): void {
    for (const entry of this.entries.values()) this.closeEntry(entry);
    this.entries.clear();
    this.canonicalProjects.length = 0;
  }

  private openEntry(project: string, pinned: boolean): StoreEntry {
    const humanDbPath = defaultHumanDbPath(project);
    const codeDbPath = defaultCodeDbPath(project);
    const entry: StoreEntry = {
      project,
      humanStoreHandle: undefined,
      codeReaderHandle: undefined,
      codeReaderInitialized: false,
      humanDbPath,
      codeDbPath,
      refCount: 0,
      lastUsed: ++this.clock,
      pinned,
    };
    this.entries.set(project, entry);
    if (!this.canonicalProjects.includes(project)) this.canonicalProjects.push(project);
    this.trimUnopenedCanonicalHistory();
    return entry;
  }

  private trimUnopenedCanonicalHistory(): void {
    while (this.canonicalProjects.length > this.maxEntries) {
      const index = this.canonicalProjects.findIndex((project) =>
        project !== this.defaultProject && !this.entries.has(project)
      );
      // Entry-backed identities are bounded by evictIdleEntries(). Avoid
      // forgetting one in the small interval between resolution and opening.
      if (index < 0) return;
      this.canonicalProjects.splice(index, 1);
    }
  }

  private getHumanStore(entry: StoreEntry): HumanMemoryStore {
    if (entry.humanStoreHandle) return entry.humanStoreHandle;
    const humanStore = new HumanMemoryStore(entry.humanDbPath);
    humanStore.attachNotifyHub(getNotifyHub(), entry.project);
    entry.humanStoreHandle = humanStore;
    return humanStore;
  }

  private getCodeReader(entry: StoreEntry): CodeGraphReader | undefined {
    if (entry.codeReaderInitialized) return entry.codeReaderHandle;
    entry.codeReaderInitialized = true;
    try {
      entry.codeReaderHandle = new CodeGraphReader(entry.codeDbPath);
    } catch {
      entry.codeReaderHandle = undefined;
    }
    return entry.codeReaderHandle;
  }

  private evictIdleEntries(): void {
    while (this.entries.size > this.maxEntries) {
      let candidate: StoreEntry | undefined;
      for (const entry of this.entries.values()) {
        if (entry.pinned || entry.refCount > 0) continue;
        if (!candidate || entry.lastUsed < candidate.lastUsed) candidate = entry;
      }
      if (!candidate) return;
      this.entries.delete(candidate.project);
      const canonicalIndex = this.canonicalProjects.indexOf(candidate.project);
      if (canonicalIndex >= 0) this.canonicalProjects.splice(canonicalIndex, 1);
      this.closeEntry(candidate);
    }
  }

  private closeEntry(entry: StoreEntry): void {
    try { entry.codeReaderHandle?.close(); } catch { /* best-effort shutdown */ }
    try { entry.humanStoreHandle?.close(); } catch { /* best-effort shutdown */ }
    entry.codeReaderHandle = undefined;
    entry.humanStoreHandle = undefined;
  }
}
