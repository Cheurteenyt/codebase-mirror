# Atomic Generation Publication — R169A Target Architecture

> **Status: FOUNDATION / INACTIVE — implemented candidate, pending review**
>
> This document describes the **target architecture** for atomic generation
> publication in Codebase Memory V2. As of R169A the foundational pieces are
> an implemented candidate — inactive, pending review
> (`v2/src/storage/generation-store.ts`,
> `v2/src/storage/generation-types.ts`,
> `v2/tests/storage/r169a-generation-store.test.ts`), but **no production
> code path calls them yet**. The indexer still writes to the legacy
> `<project>.db` path; readers still open the legacy DB directly.
>
> Nothing in this document describes active behavior. Every "does" statement
> is a target contract. The "current behavior" is unchanged from R168.1:
> publication is **not** atomic, and `DATA-CARRY-01` (P1) remains open.
>
> **Version:** 0.75.0
> **Semantics:** `CURRENT_EXTRACTOR_SEMANTICS_VERSION = 8`,
> `CURRENT_DISCOVERY_POLICY_VERSION = 2`
> **Manifest format:** `CURRENT_GENERATION_MANIFEST_VERSION = 1`
> **Tracking round:** R169A (foundation). Activation rounds: R169B–R169E.

---

## 0. TL;DR

R169A lands the **plumbing** for atomic generation publication:
path helpers, manifest V1 types, a fail-closed read-only resolver, and an
atomic JSON writer. The pieces are independently tested, inert by default,
and impose **zero overhead** when unused.

Activation is staged across R169B–R169E (validated roadmap):

| Round | Scope | Status |
|-------|-------|--------|
| R169A | Generation Store Contract + Resolver Foundation | **implemented candidate — INACTIVE, pending review** |
| R169B | Durable Staging Publisher + Validator + fsync + CAS + GC primitives | planned |
| R169C | Indexer Integration + Outcome Contract | planned |
| R169D | Reader Cutover + Legacy Migration + Project Lifecycle | planned |
| R169E | Crash Matrix + Performance + Activation + Version | planned |

`DATA-CARRY-01` (P1) is **not** closed by R169A. It remains **OPEN until
R169E** — after the crash matrix (C01–C20 validation), concurrency
analysis, performance contract verification, and activation gating have
all been completed. R169B and R169C are necessary preconditions, but
closing the carryover requires the full R169E crash + performance +
activation evidence.

---

## 1. Goal

A reader of the code graph must see **either the old complete snapshot or
the new complete snapshot — never a partial publication**.

```
   reader sees:
     old complete snapshot
     OR
     new complete snapshot
     NEVER a partial publication
```

This is the contract that will close `DATA-CARRY-01` (P1) — but only once
the full R169A→R169E sequence has landed AND the R169E crash matrix,
concurrency analysis, performance verification, and activation gating
have all passed. R169A delivers the non-active foundation; R169B delivers
the durable publisher + fsync + CAS + GC primitives; R169C integrates the
indexer; R169D cuts over readers and migrates the legacy DB; R169E
performs the crash matrix, performance, and activation gating that
finally allow `DATA-CARRY-01` to be marked closed.

## 2. Invariants (specification section 4)

1. A published generation is **immutable**. Once a DB file is referenced by
   `active-generation.json`, no writer modifies or deletes it.
2. No writer modifies a DB that is currently referenced by
   `active-generation.json`.
3. A reader always sees a complete snapshot:
   - either the previously published generation (manifest still points to
     the old generation DB),
   - or the newly published generation (manifest now points to the new
     generation DB),
   - **never** a half-written DB or a manifest whose target does not
     exist.
4. The manifest swap is the only visible mutation. It happens via atomic
   rename of a pre-validated file.
5. The legacy DB is **only** used when no manifest exists. Once a manifest
   has been written, the legacy DB is no longer in the reader path; an
   invalid manifest never silently falls back to legacy.

## 3. Storage layout

All generation-store data lives under the platform cache directory:

```
<XDG_CACHE_HOME or ~/.cache>/
└── codebase-memory-mcp/                       # cbmCacheDir()
    ├── <project>.db                            # legacy DB (current behavior)
    └── projects/                               # generationStoreRoot()
        └── <sha256(project)>/                  # projectStoreDir()
            ├── active-generation.json          # manifest (the single pointer)
            ├── index-state.json                # diagnostics sidecar (no graph data)
            ├── generations/
            │   └── generation-<uuid>.db        # immutable published DB
            └── tmp/                            # staging area for new DBs
```

### 3.1 Project key = SHA-256 of project name

`projectStorageKey(project)` returns
`createHash("sha256").update(project, "utf8").digest("hex")`.

Why a hash and not the project name?

- **Path traversal:** project names like `../escape` cannot escape the
  store, because the key is a 64-char hex digest.
- **Separator injection:** `/`, `\`, `:` (Windows drive), NUL, etc. cannot
  corrupt the path.
- **Length / Unicode:** any project name collapses to a fixed-width
  directory name.
- **Collisions:** SHA-256 collision resistance is the only assumption; no
  human-readable name is trusted on the filesystem.

The original project name is **not** recoverable from the directory name.
It is stored inside the manifest (`project` field) and validated against
the requested project on every read.

### 3.2 Why `active-generation.json` is a single pointer

The manifest is the **only** file that decides which generation is
"active". Generation DBs in `generations/` are content — they never move,
never get overwritten, and never get renamed once published. Switching the
active generation is exactly one atomic rename of the manifest file.

This is what gives us the atomic-swap property: the manifest rename is
atomic on POSIX, and the new manifest points to a DB that has already been
fully written and fsynced.

### 3.3 `index-state.json` is diagnostics, not graph data

`index-state.json` records the operational state of the indexing process
(last attempt UUID, outcome, stale reason, recovery action). It is **not**
copied or moved during publication. A crash that leaves `index-state.json`
in an inconsistent state does not affect readers — they only look at
`active-generation.json`.

### 3.4 `tmp/` is scratch space

`tmp/` holds DB files while they are being built. Files in `tmp/` are
never read by readers. They are renamed into `generations/` only after
full validation. A crash leaves orphan files in `tmp/`; the GC reclaims
them.

## 4. Manifest schema V1

Stored as `active-generation.json`. The exact key set is enforced — **no
extra keys are allowed** for V1. A future incompatible change requires
bumping `formatVersion` and a migration plan.

### 4.1 Keys

| Key | Type | Constraint |
|---|---|---|
| `formatVersion` | integer | Must be `1`. Any other value → `MANIFEST_UNSUPPORTED_VERSION`. |
| `project` | string | Non-empty after trim; max 1024 chars; no C0 control chars; must match the requested project exactly. |
| `generationId` | string | Canonical UUID v4 (lowercase, with hyphens). |
| `dbFile` | string | **Canonical form**: must equal exactly `generations/generation-<generationId>.db` (where `<generationId>` is the manifest's own `generationId`). Any other form — `.`, `active-generation.json`, `tmp/foo.db`, a different UUID, an absolute path, a backslash separator, or any `..` segment — is rejected with `MANIFEST_DBFILE_NOT_CANONICAL`. |
| `createdAt` | string | ISO-8601 **with timezone**. `Z` or `±HH:MM`. |
| `rootFingerprint` | string | Non-empty after trim; max 1024 chars; no C0 control chars (charCode 0–31, including NUL and tab). Stable fingerprint of the project root (e.g. `dev:ino`). |
| `extractorSemanticsVersion` | integer | `>= 0`. |
| `discoveryPolicyVersion` | integer | `>= 0`. |
| `nodeCount` | integer | `>= 0`. |
| `edgeCount` | integer | `>= 0`. |
| `fileCount` | integer | `>= 0`. |
| `sizeBytes` | integer | `>= 0`. |
| `sha256` | string | 64 lowercase hex chars. |

The exact set of keys is exported as `MANIFEST_V1_KEYS` in
`v2/src/storage/generation-types.ts` — a **readonly tuple** (`as const`), NOT
a mutable `Set`. R169A-FIX-R2 (VALID-R169A-R2-01): consumers cannot `.add()`
or `.delete()` from the authority. The validator uses a private
`MANIFEST_V1_KEY_SET` (module-scoped, not exported) so that even if a
consumer were to mutate the exported tuple at runtime, validation would be
unaffected. The public helper `isManifestV1Key(key)` is the only supported
way to query the set from outside the module.

### 4.2 Validation rules

`validateGenerationManifest(value, expectedProject)` enforces:

1. `value` must be a JSON object (not array, not null).
2. **Exact key set.** Missing any of the 13 keys → `MANIFEST_SCHEMA_ERROR`.
   Adding any extra key → `MANIFEST_SCHEMA_ERROR`. This is intentional: V1
   is closed so that future versions can add keys without ambiguity.
3. `formatVersion === 1`. Any other value, including `2`, `null`, `""`,
   `1.0` → `MANIFEST_UNSUPPORTED_VERSION`.
4. `project === expectedProject`. → `MANIFEST_PROJECT_MISMATCH` on
   mismatch. This catches a manifest that was somehow copied between
   projects.
5. `generationId` matches the canonical UUID v4 regex
   `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
6. `dbFile` is the **canonical path**
   `generations/generation-<generationId>.db`, where `<generationId>` is
   the manifest's own `generationId`. Any deviation — `.`, the manifest
   filename, a `tmp/` path, a different UUID, an absolute path, a
   backslash separator, or any `..` segment — raises
   `MANIFEST_DBFILE_NOT_CANONICAL`. (The previous relative-path check
   `MANIFEST_TARGET_OUTSIDE_STORE` is subsumed by the canonical check,
   which is strictly stronger.)
7. `createdAt` matches
   `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`.
   Date-only or no-timezone timestamps are rejected. Beyond the regex,
   the components are calendar-validated: month 1–12, day 1–N where N is
   the number of days in `(year, month)` (leap years handled correctly),
   hour 0–23, minute 0–59, second 0–59 (POSIX — no leap seconds).
8. `rootFingerprint` is a **safe string**: non-empty after `.trim()`
   (whitespace-only rejected), at most 1024 chars, and contains no C0
   control characters (charCode 0–31, including NUL and tab). The
   "no multiline" rule (11) is a separate defense-in-depth that catches
   `\n` and `\r`.
9. `extractorSemanticsVersion`, `discoveryPolicyVersion`, `nodeCount`,
   `edgeCount`, `fileCount`, `sizeBytes` are **safe integers** `>= 0`
   (`Number.isSafeInteger`). Floats, negatives, `Infinity`, `NaN`, and
   values greater than `Number.MAX_SAFE_INTEGER` are rejected.
10. `sha256` matches `^[0-9a-f]{64}$`. Uppercase hex is rejected.
11. No string field contains `\n` or `\r`. This keeps the manifest a
    single-line-friendly record and prevents newline-injection tricks.
12. **Size bound (R169A-FIX-R2 VALID-R169A-R2-01).** The manifest file on
    disk MUST be at most `MAX_GENERATION_MANIFEST_BYTES` (64 KiB). Before
    reading, `parseGenerationManifest` stats the file; if `size > max`,
    it raises `MANIFEST_TOO_LARGE` and does NOT read the file into memory.
    Reads are done via `openSync` + `readSync` + `closeSync` so the exact
    byte count is controlled. The 64 KiB bound is generous for the V1
    schema (which serializes to <1 KiB) but bounded enough to prevent a
    malicious / corrupted manifest from exhausting memory.
13. **Project field hardening (R169A-FIX-R2 VALID-R169A-R2-01).** The
    `project` field is validated as a safe string (rule 8) BEFORE the
    equality check against `expectedProject`. This is defense-in-depth:
    even if a corrupted manifest happened to match `expectedProject`, a
    NUL byte or other control character would still be rejected.

A manifest that fails any of these is **invalid** and triggers fail-closed
behavior in the resolver (section 8).

### 4.3 Example manifest

```json
{
  "formatVersion": 1,
  "project": "my-project",
  "generationId": "550e8400-e29b-41d4-a716-446655440000",
  "dbFile": "generations/generation-550e8400-e29b-41d4-a716-446655440000.db",
  "createdAt": "2026-07-13T00:00:00.000Z",
  "rootFingerprint": "/home/me/code/my-project:2049:1234567",
  "extractorSemanticsVersion": 8,
  "discoveryPolicyVersion": 2,
  "nodeCount": 12345,
  "edgeCount": 67890,
  "fileCount": 432,
  "sizeBytes": 9876543,
  "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
}
```

### 4.4 Index-state schema V1 (`index-state.json`)

Stored as `<projectStore>/index-state.json`. The exact key set is
enforced — **no extra keys are allowed** for V1. 11 keys:

| Key | Type | Constraint |
|---|---|---|
| `formatVersion` | integer | Must be `1`. Any other value → `INDEX_STATE_UNSUPPORTED_VERSION`. |
| `project` | string | Safe string (max 1024 chars, no C0 control chars); must match the expected project exactly. |
| `activeGenerationId` | string \| null | Canonical UUID v4 of the currently active generation, or null if none. |
| `candidateGenerationId` | string \| null | R169A-FIX-R4: UUID v4 of the generation being staged, or null. On SUCCESS+PUBLISHED, equals `activeGenerationId`. |
| `lastAttemptId` | string | Canonical UUID v4 of the last indexing attempt. |
| `lastAttemptAt` | string | ISO-8601 with timezone; calendar-validated. |
| `lastAttemptOutcome` | enum | One of `SUCCESS`, `SUCCESS_WITH_WARNINGS`, `PARTIAL`, `FAILED`, `STALE`. |
| `publicationState` | enum | R169A-FIX-R5 (STATE-R169A-R5-01): One of `PUBLISHED`, `NOT_NEEDED`, `NOT_PUBLISHED`, `DURABILITY_UNKNOWN`. Replaces the R4 `published: boolean` field. |
| `failure` | object \| null | R169A-FIX-R4: Structured `{ code, phase, message }` or null. Replaces the R3 `lastAttemptError: string \| null`. |
| `staleReason` | object \| null | R169A-FIX-R3: Structured `{ code, message, paths, totalPaths?, pathsTruncated? }` or null. |
| `recovery` | enum | One of `none`, `retry_incremental`, `fix_filesystem`, `full_reindex`, `manifest_repair`, `legacy_migration`. |

**Coherence rules (R169A-FIX-R5 STATE-R169A-R5-01/02):**

- `SUCCESS` / `SUCCESS_WITH_WARNINGS`:
  - `publicationState` MUST be `PUBLISHED` or `NOT_NEEDED`.
  - `PUBLISHED`: `activeGenerationId` non-null, `candidateGenerationId == activeGenerationId`, `failure=null`, `staleReason=null`, `recovery="none"`.
  - `NOT_NEEDED`: `candidateGenerationId=null`, `failure=null`, `staleReason=null`, `recovery="none"`.
- `PARTIAL`: `publicationState="NOT_PUBLISHED"`, `failure` non-null.
- `FAILED`: `publicationState="NOT_PUBLISHED"` or `"DURABILITY_UNKNOWN"`, `failure` non-null.
- `STALE`: `publicationState="NOT_PUBLISHED"`, `staleReason` non-null, `recovery != "none"`.

**`pathsTruncated` coherence (R169A-FIX-R5 STATE-R169A-R5-02):**

- `pathsTruncated=true` → `totalPaths` MUST be present AND `totalPaths > paths.length`.
- `pathsTruncated=false` → `totalPaths` absent OR `totalPaths == paths.length`.
- `pathsTruncated` absent → `totalPaths` absent OR `totalPaths == paths.length`.

## 5. State machine overview

Publication is a sequence of states. Each transition is durable before
the next begins. A crash at any state has a deterministic recovery.

```
START
  │
  ▼
BUILD_STAGING     write generations/generation-<uuid>.db into tmp/
  │                 (sqlite build, fully populated, not yet visible)
  ▼
VALIDATE          open staging DB, run consistency checks
  │                 (row counts, sha256, schema version, root fingerprint)
  ▼
FINALIZE          fsync the staging DB file
  │                 (durability: DB content on disk before swap)
  ▼
CAS               move staging DB from tmp/ to generations/
  │                 (rename is atomic on POSIX; generations/ entry now exists)
  ▼
MANIFEST          write active-generation.json atomically (section 7)
  │                 (temp + fsync + rename + fsync dir)
  ▼
FINAL_STATE       new generation is live; old generation is now stale
                    (GC will eventually remove it)
```

Key properties:

- The DB is **fully written and fsynced** before the manifest is touched.
- The manifest swap is the **only** visible mutation to readers.
- The old generation DB remains on disk (and is still referenced by the
  old manifest content) until the new manifest is in place. A crash
  before the manifest rename leaves the old generation live.
- A crash after the manifest rename leaves the new generation live. The
  old generation DB becomes garbage and is collected by GC (section 10).

## 6. Durability ordering

The atomic writer enforces the following ordering, in this exact sequence:

1. **Create temp file** in the same directory as the target, using
   `openSync(tmpPath, "wx", 0o600)`. The `wx` flag fails if the file
   already exists — this prevents two concurrent writers from clobbering
   each other's temp file. Mode `0o600` keeps the file readable only by
   the owner.
2. **Write the complete content** to the temp file. Partial content is
   never visible to readers because the temp file is not the target name.
3. **fsync the temp file.** `fsyncSync(fd)`. This is the critical step:
   it forces the file **content** to stable storage. Without this, a
   crash after `rename` could leave a zero-length or partially-flushed
   file at the target path. On failure → `ATOMIC_FSYNC_FAILED`.
4. **Close the temp file.** `closeSync(fd)`.
5. **rename temp → target.** `renameSync(tmpPath, targetPath)`. This is
   atomic on POSIX: the target path is either the old file or the new
   file, never both, never neither. On failure → `ATOMIC_RENAME_FAILED`.
6. **fsync the directory.** Open the directory read-only and `fsync` it.
   This forces the directory entry (the rename) to stable storage.
   Without this, a crash could roll back the rename and leave the old
   file in place — which is correct for a writer (the old file is still
   valid) but undesirable for an indexer that wants confirmation that
   the new file is committed. **Directory fsync failure is NOT silent.**
   If the directory cannot be opened, or if `fsync` on the directory
   fails, the writer raises `ATOMIC_DURABILITY_UNKNOWN`. By the time
   this step runs, `rename` has already happened, so the new target may
   or may not be durable on crash — the caller (indexer) MUST re-read
   the target and diagnose. The error is **not** swallowed and **not**
   downgraded to success: silent success on directory fsync failure
   would let the indexer believe the new generation is durable when in
   fact it may be rolled back by a power loss. (On platforms that
   genuinely cannot fsync a directory, the failure surfaces as
   `ATOMIC_DURABILITY_UNKNOWN` so the indexer can take an explicit
   recovery decision; it is never silently treated as committed.)

The ordering can be summarized as:

```
fsync file  →  rename  →  fsync dir
```

Any deviation breaks the durability contract. In particular:

- `rename` before `fsync file` → a crash can leave the target empty.
- `fsync dir` before `rename` → useless; the rename hasn't happened yet.
- Skipping `fsync file` → on crash, the rename succeeds but the file
  content is lost.
- **Skipping `fsync dir` (or silently swallowing its failure)** → the
  rename survives in the page cache but may not survive a power loss.
  This is why the writer raises `ATOMIC_DURABILITY_UNKNOWN` on
  directory-fsync failure rather than reporting success.

### 6.1 Serialization and short-write safety

Two further properties of the atomic writer are part of the contract:

- **Serialization happens BEFORE any filesystem mutation.** The payload
  is `JSON.stringify`-d (and the result type-checked) before the temp
  file is opened. If serialization throws (circular references, BigInt)
  or returns a non-string (`undefined`, functions, symbols), the writer
  raises `ATOMIC_SERIALIZATION_FAILED` and **no temp file is created**.
  This prevents partial writes caused by mid-payload serialization
  failures and prevents leftover temp files.
- **Short writes are accounted for.** The write loop tracks an offset
  and continues from the new offset until the full payload is written.
  If `writeSync` returns `<= 0`, the writer raises `ATOMIC_SHORT_WRITE`
  and cleans up the temp file. Partial writes never reach the rename
  step.

### 6.2 Symlink chain security

The resolver walks **every path component** from a higher-trust root
(e.g. `generationStoreRoot`) down to both the manifest path and the
generation DB path. For each component it performs an `lstat` and
rejects ANY symlink in the chain — not just the final hop. The final
candidate is then verified with `realpathSync.native` and containment-
checked against the trust root.

Error policy on the walk:

- `ENOENT` on a component → return silently (the path is absent; the
  resolver falls back to legacy or returns `missing`).
- `EACCES`, `EIO`, `ENOTDIR`, `ELOOP` → fail closed with
  `PATH_TRAVERSAL_REJECTED`. These are not swallowed: a permission or
  I/O error during the walk is treated as evidence of tampering or
  filesystem corruption, not as "absent".

This means that a manifest parent directory that is a symlink, a
`generations/` directory that is a symlink, or a generation DB that is
a symlink are ALL rejected — the trust root must reach the target
through regular directories and a regular file only. The legacy DB
path uses the same walk and the same `lstat` chain.

This is implemented in `assertPathInsideNoSymlinks` and
`assertNotSymlink` in `v2/src/storage/generation-store.ts`.

### 6.3 Trust root validation (R169A-FIX-R2 SEC-R169A-R2-01)

`assertPathInsideNoSymlinks(root, candidate)` only walks components UNDER
`root`. It never `lstat`'s `root` itself. If `projects/` (or any of its
parents) is a symlink to an attacker-controlled directory, both
`realpath(root)` and `realpath(candidate)` follow the same symlink, and
the containment check passes — bypassing the trust boundary.

R169A-FIX-R2 closes this bypass with `assertTrustedRootNoSymlinks`. The
resolver AND the writer call this BEFORE checking the manifest / legacy
path / target. The function:

1. `lstat`'s `cacheRoot` itself — reject if symlink.
2. Walks `codebase-memory-mcp`, `projects`, `<project-key>` — `lstat`
   each, reject ANY symlink.
3. Only `ENOENT` is OK (component doesn't exist yet — common during the
   first write for a project). `EACCES` / `EIO` / `ENOTDIR` / `ELOOP`
   fail closed with `PATH_TRAVERSAL_REJECTED`.
4. Then calls `assertPathInsideNoSymlinks(generationStoreRoot,
   projectStoreDir, ...)` for a final `realpath` containment check on
   the validated root.

This closes the bypass where `cacheRoot`, `cbmCacheDir`, or `projects`
is itself a symlink. Implemented in `assertTrustedRootNoSymlinks` in
`v2/src/storage/generation-store.ts`.

R169A-FIX-R5 (SEC-R169A-R5-02): The trust root validation now ALSO
checks permissions on EXISTING directories. This means the resolver
and `listProjectStoreKeys` automatically get permission checks via
the trust root validation — not just the writer (which already had
them via `ensureGenerationStoreLayoutDurable`).

The permission policy is two-tier (R169A-FIX-R4 COMPAT-R169A-R4-01):

- **Compatibility roots** (`cacheRoot`, `codebase-memory-mcp`):
  require `mode & 0o022 === 0` (no group/other WRITE bits). 0755,
  0750, 0700 all accepted. This preserves existing legacy caches
  that have 0755 on the cbm directory.
- **Private R169 dirs** (`projects`, `<project-key>`, `generations`,
  `tmp`): require `mode === 0o700` exactly. These are created fresh
  by R169A and contain potentially sensitive information; they
  should not be readable by other users on the host.

On POSIX (where `process.getuid` is available), the directory's `uid`
is best-effort checked against `process.getuid()`. On Windows this
check is skipped.

Violations raise `STORE_LAYOUT_PERMISSIONS_INSECURE`.

### 6.4 Layout durability (R169A-FIX-R2 DUR-R169A-R2-01)

`mkdirSync(dir, { recursive: true })` + `fsync(dir)` does NOT guarantee
the directory ENTRY in the parent survives a crash if the directory was
just created. The mkdir creates the entry in the parent, but the parent's
directory metadata may not be flushed to disk. A crash after mkdir but
before the parent's metadata is flushed may leave the new directory
orphaned — even though `mkdir -p` returned successfully.

R169A-FIX-R2 closes this with `ensureGenerationStoreLayoutDurable`. The
writer calls this BEFORE writing the manifest / index-state file. The
function walks the FULL layout chain:

```
<cacheRoot>/codebase-memory-mcp/         (parent: cacheRoot)
<cacheRoot>/codebase-memory-mcp/projects/ (parent: cbmCacheDir)
<cacheRoot>/codebase-memory-mcp/projects/<sha256>/   (parent: projects)
<cacheRoot>/codebase-memory-mcp/projects/<sha256>/generations/  (parent: projectStore)
<cacheRoot>/codebase-memory-mcp/projects/<sha256>/tmp/          (parent: projectStore)
```

For each directory:

1. `lstat` — if it doesn't exist, `mkdir` with mode `0700` (NOT default
   `0777 & ~umask`). Failure (other than `EEXIST`) →
   `STORE_LAYOUT_CREATE_FAILED`.
2. `fsync` the directory itself. Failure →
   `STORE_LAYOUT_DURABILITY_UNKNOWN`.
3. If the directory was newly created, `fsync` the PARENT directory so
   the directory ENTRY in the parent is durable. Failure →
   `STORE_LAYOUT_DURABILITY_UNKNOWN`.

The chain does NOT include `cacheRoot` itself — that is the user's HOME
cache dir, created by the OS / XDG machinery, and we do not `fsync`
`cacheRoot`'s parent (which may be `/tmp` or `/home`, owned by root).

The `mkdir` mode is `0700` (NOT the default `0777 & ~umask`): the
project store, generations, and tmp directories contain potentially
sensitive information (DB file paths, manifest contents) and should not
be readable by other users on the host.

### 6.5 Project-aware atomic writer (R169A-FIX-R2 SEC-R169A-R2-02)

`writeJsonAtomically(targetPath, value)` accepts an arbitrary
`targetPath` with no containment check, no symlink rejection, and does
`mkdir -p` which can create directories via parent symlinks. R169A-FIX-R2
introduces a project-aware wrapper, `writeProjectJsonAtomically`, which
is now the ONLY public writer API. The internal `writeJsonAtomically` is
not exported.

The wrapper:

1. **Derives the target path** from `project` + `target` type (`"manifest"`
   → `activeManifestPath(project)`; `"index-state"` →
   `indexStatePath(project)`). The caller CANNOT specify an arbitrary
   path.
2. **Validates the trust root** via `assertTrustedRootNoSymlinks` (§6.3).
3. **Validates the target path** via `assertPathInsideNoSymlinks` from
   `generationStoreRoot` down to the target file. Symlink code is
   `MANIFEST_SYMLINK_REJECTED` for manifest targets,
   `GENERATION_TARGET_SYMLINK_REJECTED` for index-state targets.
4. **Rejects symlinked targets** via `assertNotSymlink` (defense-in-depth
   on the final file, in case the chain walk missed it).
5. **Ensures layout durability** via `ensureGenerationStoreLayoutDurable`
   (§6.4) — `mkdir 0700` + `fsync` chain + `fsync` parent of newly
   created dirs.
6. **Delegates to the internal `writeJsonAtomically`** for the
   temp-rename-fsync pattern. Temp file mode `0600`, temp directory mode
   `0700`.

All errors are wrapped in `GenerationStoreError` with the project name
and phase. The wrapper NEVER accepts an arbitrary target path — the path
is always derived from `project` + `target`. This eliminates the entire
class of "writer with arbitrary path" attacks.

### 6.6 Public API surface (R169A-FIX-R5 API-R169A-R5-01/02)

R169A-FIX-R5 tightened the public API surface of the generation store:

- The `__test__` export is **REMOVED**. The manifest writer
  `writeGenerationManifestAtomically` and the `prepare*ForWrite`
  helpers are NOT accessible to production code. Tests that need a
  manifest on disk use the test-only fixture
  `v2/tests/helpers/r169-generation-fixtures.ts` (writeFileSync-based,
  NOT the atomic writer). Atomic writer mechanic tests use
  `writeIndexStateAtomically` (the only public writer) which exercises
  the same internal writer code path.
- The manifest writer is **internal** — R169A does NOT export a
  publication API. R169B will own `publishPreparedGeneration`
  (DB validation, hash, size, CAS before manifest write).
- `writeIndexStateAtomically(project, state, options?)` is the ONLY
  public writer. The `ops` and `hook` parameters exist on the
  function signature for test fault/race injection ONLY; they are
  marked `@internal` and are NOT part of the public API contract.
  Production callers MUST omit them. A source-inspection test
  verifies `__test__` and `writeGenerationManifestAtomically` are
  NOT exported.

### 6.7 Cleanup after directory swap (R169A-FIX-R5 SEC-R169A-R5-01)

R169A-FIX-R4 (SEC-R169A-R4-01) introduced a pre-rename identity check:
the writer `lstat`s the target directory and verifies `dev+ino` match
the held `dirFd`. R169A-FIX-R5 closes the residual cleanup hazard:

- When the pre-rename identity check detects a swap (dev/ino mismatch
  OR the directory became a symlink), the writer sets
  `directoryIdentityStillValid = false`.
- In the catch block, the writer **does NOT** `unlinkSync(tmpPath)` if
  the identity is invalid — `tmpPath` may now point to a different
  directory (the replacement), and unlinking by path would operate on
  the wrong directory.
- The temp file is **orphaned** in the ORIGINAL directory. The error
  message includes a `WARNING: ATOMIC_TEMP_ORPHANED` note so an
  operator knows to manually remove the `.tmp-*.json` file from the
  original directory.
- The primary error code remains `PATH_TRAVERSAL_REJECTED` (the swap
  was detected); the warning explains that the temp file is
  intentionally NOT cleaned up.

### 6.8 fd leak in openDirectoryNoFollow (R169A-FIX-R5 QUAL-R169A-R5-01)

`openDirectoryNoFollow` opens a directory with
`O_RDONLY | O_DIRECTORY | O_NOFOLLOW` (when available) and then
`fstatSync`s the fd. If `fstatSync` fails after a successful
`openSync`, the fd MUST be closed before re-throwing — otherwise the
fd leaks.

R169A-FIX-R5 wraps the `fstatSync` call in a try/catch that closes
the fd on failure (best-effort) and re-throws the original error.
The fallback path (no `O_NOFOLLOW` — Windows) does the same for its
`fstatSync` call. A fault-injection test verifies `closeSync` is
called exactly once when `fstatSync` fails.

## 7. Reader contract

The reader contract is the **only** thing readers need to know:

> **Resolve once. Open the resolved DB. Keep the handle.**

Concretely:

1. **Resolve once.** Call `resolveActiveCodeDb(project)` **once**, at the
   start of the read session. This returns a `ResolvedCodeDb`:
   - `{ source: "generation", dbPath, generationId, manifest }` — a
     published generation was found via the manifest.
   - `{ source: "legacy", dbPath, generationId: null }` — no manifest,
     but a legacy `<project>.db` exists.
   - `{ source: "missing", dbPath: null, generationId: null }` — neither
     exists.
2. **Open the resolved DB.** Use `resolved.dbPath` to open the SQLite
   file. Do not re-resolve.
3. **Keep the handle.** Hold the SQLite connection open for the duration
   of the read session. Even if a concurrent publication swaps the
   manifest, your handle still points to the generation you opened,
   which is **immutable** (section 2 invariant 1).

What the reader must **not** do:

- Re-resolve mid-session. The manifest may swap; the second resolution
  could return a different generation. This is fine for a new session,
  but a single session must use one DB.
- Open the DB by constructing the path manually. Always go through
  `resolveActiveCodeDb`. Direct path construction bypasses the manifest
  and the fail-closed contract.
- Hold the manifest file open. The manifest is read once, validated,
  and discarded. Only the DB handle is kept.

This contract is enforced by the `ResolvedCodeDb` type in
`v2/src/storage/generation-types.ts`. The discriminated union makes it
impossible to forget the `missing` case at compile time.

## 8. Legacy migration

The legacy DB lives at `<cbmCacheDir>/<project>.db`. It is the path used
by all current production code (indexer, readers, UI, MCP, CLI). R169A
does **not** remove this path. It does **not** write to it either. The
legacy path is kept as a fallback for the resolver.

The resolver's decision table:

| Manifest state | Legacy DB state | Resolver result |
|---|---|---|
| valid | (ignored) | `generation` |
| absent | exists and is a regular file inside the trust root with no symlink chain | `legacy` |
| absent | exists but is a directory, symlink, special file, or outside the trust root | **FAIL CLOSED** — `LEGACY_SOURCE_INVALID` (R169A-FIX-R2: renamed from `LEGACY_SOURCE_OPEN_FAILED`) |
| absent | absent | `missing` |
| invalid (any reason) | (ignored) | **FAIL CLOSED** — `GenerationStoreError` |
| manifest target missing | (ignored) | **FAIL CLOSED** — `MANIFEST_TARGET_MISSING` |
| manifest target outside store | (ignored) | **FAIL CLOSED** — `MANIFEST_TARGET_OUTSIDE_STORE` |
| manifest `dbFile` not canonical | (ignored) | **FAIL CLOSED** — `MANIFEST_DBFILE_NOT_CANONICAL` |
| manifest target is not a regular file (directory / symlink / special) | (ignored) | **FAIL CLOSED** — `MANIFEST_TARGET_NOT_REGULAR` |
| manifest project mismatch | (ignored) | **FAIL CLOSED** — `MANIFEST_PROJECT_MISMATCH` |
| manifest is a symlink | (ignored) | **FAIL CLOSED** — `MANIFEST_SYMLINK_REJECTED` |
| manifest target is a symlink | (ignored) | **FAIL CLOSED** — `GENERATION_TARGET_SYMLINK_REJECTED` |
| any path component (manifest parent, `generations/`, target) is a symlink | (ignored) | **FAIL CLOSED** — `PATH_TRAVERSAL_REJECTED` |

### 8.1 Legacy DB validation contract

When the resolver falls back to the legacy DB (`<cbmCacheDir>/<project>.db`),
it does NOT silently open whatever is on disk. The legacy path is
validated with the same security invariants as the generation path:

1. **Project key containment.** The project name is checked lexically
   (no empty string, no absolute path, no `..`, no path separators, no
   `.`). The legacy path is then constructed as
   `<cacheRoot>/<project>.db` and containment-checked against
   `<cacheRoot>` using `isLexicallyInside`.
2. **No symlink chain.** Every path component from `<cacheRoot>` down
   to the legacy DB file is walked with `lstat`; ANY symlink in the
   chain raises `PATH_TRAVERSAL_REJECTED`.
3. **Regular file.** `lstatSync(legacyPath)` must report a regular
   file. A directory, symlink, FIFO, socket, or device node raises
   `LEGACY_SOURCE_INVALID` (R169A-FIX-R2 API-R169A-R2-01: renamed from
   `LEGACY_SOURCE_OPEN_FAILED`; R169A validates path + regular-file
   identity only — actual SQLite open validation occurs in R169D reader
   cutover). There is no "open it read-only anyway" fallback.

For ordinary project names with the real cache root, this produces the
same path as `defaultCodeDbPath` in `v2/src/bridge/sqlite-ro.ts`, so
back-compat is preserved on the happy path. Anything that would have
silently served unexpected content under the old behavior is now
rejected explicitly.

**The fail-closed rule is absolute.** An invalid manifest never silently
falls back to the legacy DB. The reasoning:

- A manifest that exists but is invalid is **evidence of corruption**.
  Falling back to legacy would hide that corruption and serve data that
  may be stale or wrong.
- The legacy DB may itself be corrupt or partial (it's the source of
  `DATA-CARRY-01`). Switching to it because the manifest is broken
  trades one bug for another.
- Operators should see the failure and repair the manifest. Silent
  fallback turns a hard failure into a soft data-correctness bug, which
  is exactly what R169 is supposed to eliminate.

Migration to generation-only operation happens across the validated
R169A→R169E roadmap. Each round activates one piece with its own tests
and audit. There is no "big bang" activation.

- **R169A (this round) — Generation Store Contract + Resolver
  Foundation.** Resolver, manifest V1 types, and atomic JSON writer
  exist as an implemented candidate. No production code calls them.
  Legacy path is the only path used. `DATA-CARRY-01` remains OPEN.
- **R169B — Durable Staging Publisher + Validator + fsync + CAS + GC
  primitives.** Implement independent publisher primitives and test
  harnesses — NO production indexer caller. The primitives include the
  staging-DB publisher (build in `tmp/`, validate, fsync, atomically
  rename into `generations/`), the CAS dedup table, the manifest
  writer (`writeProjectJsonAtomically`), and the GC primitives (keep
  active + 2 previous, `tmp/` sweep). All primitives are tested in
  isolation; no production code path calls them yet. Resolver still
  not called by production readers.
- **R169C — Indexer Integration + Outcome Contract.** Wire those
  primitives into `indexProjectWasm` and outcome paths. The
  publication pipeline is wired into the indexer end-to-end; the
  publication outcome (`SUCCESS | SUCCESS_WITH_WARNINGS | STALE |
  PARTIAL | FAILED`) is propagated through `IndexResult`. Legacy DB
  is still written as a fallback; readers still open the legacy path
  directly.
- **R169D — Reader Cutover + Legacy Migration + Project Lifecycle.**
  Readers switch from `legacyCodeDbPath` to `resolveActiveCodeDb`. The
  legacy DB write path is removed for projects that have at least one
  published generation. Project lifecycle (create / re-index / archive)
  is wired through the generation store.
- **R169E — Crash Matrix + Performance + Activation + Version.** The
  crash matrix C01–C20 is replayed against the integrated pipeline;
  the performance contract (per-publication fsync cost, zero overhead
  on readers) is verified; concurrency analysis (single-host safety,
  multi-host boundary) is completed; the legacy read fallback is
  removed for projects that have been re-indexed. **Only after R169E
  passes all four (crash matrix + concurrency + performance +
  activation) is `DATA-CARRY-01` (P1) marked closed.**

R170 (out of scope for R169) adds multi-host lease / fencing on top of
the R169A–R169E single-host foundation.

## 9. Failure taxonomy

The generation store uses **structured error codes**, never a single
`DB_ERROR` bucket. Each code corresponds to a specific failure mode with
a specific recovery action.

```typescript
type GenerationStoreErrorCode =
  | "GENERATION_STORE_CONFIG_ERROR"          // misconfiguration (e.g. bad store root)
  | "MANIFEST_PARSE_ERROR"                   // file unreadable or invalid JSON
  | "MANIFEST_SCHEMA_ERROR"                  // JSON valid but schema wrong
  | "MANIFEST_TOO_LARGE"                     // manifest file > MAX_GENERATION_MANIFEST_BYTES (64 KiB); not read into memory
  | "MANIFEST_TARGET_MISSING"                // dbFile does not exist
  | "MANIFEST_TARGET_OUTSIDE_STORE"          // dbFile escapes the project store
  | "MANIFEST_TARGET_NOT_REGULAR"            // dbFile resolves to a directory / symlink / special file
  | "MANIFEST_DBFILE_NOT_CANONICAL"          // dbFile is not `generations/generation-<generationId>.db`
  | "MANIFEST_PROJECT_MISMATCH"              // project field != requested project
  | "MANIFEST_UNSUPPORTED_VERSION"           // formatVersion != 1
  | "MANIFEST_SYMLINK_REJECTED"              // manifest path is a symlink
  | "GENERATION_TARGET_SYMLINK_REJECTED"     // dbFile is a symlink
  | "LEGACY_SOURCE_INVALID"                  // legacy DB exists but is a directory/symlink/special/outside store (R169A-FIX-R2: renamed from LEGACY_SOURCE_OPEN_FAILED; R169A validates path + regular-file identity only — actual SQLite open validation occurs in R169D reader cutover)
  | "ATOMIC_WRITE_FAILED"                    // generic write failure (open / write / close)
  | "ATOMIC_RENAME_FAILED"                   // rename failed (e.g. cross-device)
  | "ATOMIC_FSYNC_FAILED"                    // fsync of the temp file failed
  | "ATOMIC_DURABILITY_UNKNOWN"              // directory open or fsync failed post-rename; target MAY be new, caller must re-read
  | "ATOMIC_SERIALIZATION_FAILED"            // JSON.stringify threw or returned non-string; no temp file created
  | "ATOMIC_SHORT_WRITE"                     // writeSync returned <= 0; partial write never reached rename
  | "STORE_LAYOUT_CREATE_FAILED"             // mkdir of a layout directory (cbm / projects / projectStore / generations / tmp) failed during ensureGenerationStoreLayoutDurable
  | "STORE_LAYOUT_DURABILITY_UNKNOWN"        // directory or PARENT fsync failed during layout setup; the directory entry MAY not be durable
  | "PATH_TRAVERSAL_REJECTED"                // path escapes store OR any component in the trust-root walk is a symlink / EACCES / EIO / ENOTDIR / ELOOP
  | "PROJECT_KEY_INVALID"                    // project name was empty/non-string
  | "PROJECT_STATE_SYMLINK_REJECTED"         // index-state.json is or contains a symlink (R169A-FIX-R3 QUAL-R169A-R3-01)
  | "INDEX_STATE_SCHEMA_ERROR"               // index-state.json failed structural / type / coherence validation (R169A-FIX-R3 API-R169A-R3-02)
  | "INDEX_STATE_PROJECT_MISMATCH"           // index-state.json `project` field != expected project (R169A-FIX-R3 API-R169A-R3-02)
  | "INDEX_STATE_UNSUPPORTED_VERSION"        // index-state.json `formatVersion` is not 1 (R169A-FIX-R3 API-R169A-R3-02)
  | "STORE_LAYOUT_PERMISSIONS_INSECURE"      // existing layout dir has insecure permissions (R169A-FIX-R3 SEC-R169A-R3-04, R169A-FIX-R4 COMPAT-R169A-R4-01 two-tier policy)
  | "ATOMIC_TEMP_ORPHANED";                  // WARNING appended to error message when the writer detects the target directory was swapped between temp-create and rename (R169A-FIX-R5 SEC-R169A-R5-01); the temp file may be orphaned in the ORIGINAL directory and is NOT unlinked by path
```

The five codes added in R169A pass 1 (after the first GPT 5.6 audit) are:

- `MANIFEST_TARGET_NOT_REGULAR` — the resolved `dbFile` exists but is a
  directory, symlink, or special file. The reader must never open a
  non-regular file as a SQLite database.
- `MANIFEST_DBFILE_NOT_CANONICAL` — `dbFile` is not exactly
  `generations/generation-<generationId>.db`. This is strictly stronger
  than the previous relative-path check; it rules out `.`, the manifest
  filename, `tmp/` paths, mismatched UUIDs, absolute paths, and `\`
  separators in one rule.
- `ATOMIC_DURABILITY_UNKNOWN` — raised when the directory cannot be
  opened or fsynced after `rename`. The rename has already happened, so
  the target MAY be the new file, but we cannot guarantee durability
  without the directory fsync. The caller (indexer) MUST re-read the
  target and diagnose. This is NOT the same as silent success.
- `ATOMIC_SERIALIZATION_FAILED` — raised when `JSON.stringify` throws
  (BigInt, circular references) or returns a non-string. Raised BEFORE
  the temp file is created, so no leftover temp file is possible from
  this failure mode.
- `ATOMIC_SHORT_WRITE` — raised when `writeSync` returns `<= 0` mid
  payload. The write loop tracks the offset and continues from the new
  offset on partial writes; this code is reserved for the "wrote zero
  or negative bytes" case that cannot make progress.

R169A-FIX-R2 (GPT 5.6 pass 2 audit) adds four more codes:

- `MANIFEST_TOO_LARGE` — the manifest file on disk exceeds
  `MAX_GENERATION_MANIFEST_BYTES` (64 KiB). Raised BEFORE the file is
  read into memory. Defense against a malicious / corrupted manifest
  that would otherwise exhaust memory.
- `STORE_LAYOUT_CREATE_FAILED` — `mkdir` of a layout directory (cbm /
  projects / projectStore / generations / tmp) failed during
  `ensureGenerationStoreLayoutDurable`. The directory entry could not
  be created; the write is aborted before any temp file is opened.
- `STORE_LAYOUT_DURABILITY_UNKNOWN` — fsync of a layout directory OR
  its PARENT failed during `ensureGenerationStoreLayoutDurable`. The
  directory MAY exist on disk (mkdir succeeded) but its entry in the
  parent directory may not be durable. The caller MUST re-stat and
  diagnose.
- `LEGACY_SOURCE_INVALID` — renamed from `LEGACY_SOURCE_OPEN_FAILED`.
  R169A validates path + regular-file identity only — the actual
  SQLite open validation occurs in R169D reader cutover. The old name
  implied an open was attempted, which was misleading.

`GenerationStoreError` carries:

- `code` — one of the above.
- `phase` — the function name where the error was raised, e.g.
  `"validateGenerationManifest"`, `"resolveActiveCodeDb"`,
  `"writeProjectJsonAtomically"`,
  `"ensureGenerationStoreLayoutDurable"`.
- `project` — the project name being operated on (may be `""` for
  writer-level errors).
- `message` — human-readable detail.

R169A-FIX-R3 (GPT 5.6 pass 3 audit) adds five more codes:

- `STORE_LAYOUT_PERMISSIONS_INSECURE` — an existing layout directory
  has group/other permissions that violate the two-tier policy.
  Compatibility roots (cacheRoot, cbm) require `mode & 0o022 === 0`
  (no group/other WRITE — 0755, 0750, 0700 all accepted). Private
  R169 dirs (projects, projectStore, generations, tmp) require
  `mode === 0o700` exactly. (R169A-FIX-R4 COMPAT-R169A-R4-01 split
  the policy into two tiers; the R3 version rejected 0755 which
  would have broken legacy caches.)
- `PROJECT_STATE_SYMLINK_REJECTED` — `index-state.json` is or contains
  a symlink. Distinct from `MANIFEST_SYMLINK_REJECTED` (for
  `active-generation.json`) and `GENERATION_TARGET_SYMLINK_REJECTED`
  (for the generation DB file).
- `INDEX_STATE_SCHEMA_ERROR` — `index-state.json` failed structural,
  type, or coherence validation.
- `INDEX_STATE_PROJECT_MISMATCH` — `index-state.json` `project` field
  does not match the expected project.
- `INDEX_STATE_UNSUPPORTED_VERSION` — `index-state.json` `formatVersion`
  is not 1.

R169A-FIX-R5 (GPT 5.6 pass 5 audit) adds one more code:

- `ATOMIC_TEMP_ORPHANED` — raised as a WARNING in the error message
  (not as a separate thrown error) when the writer detects the target
  directory was swapped between temp-create and rename. The temp file
  may be orphaned in the ORIGINAL directory and MUST NOT be unlinked
  by path (the path now points elsewhere). The primary error code
  remains `PATH_TRAVERSAL_REJECTED` (the swap was detected); the
  warning explains that the temp file is intentionally NOT cleaned
  up. An operator must manually remove the orphaned `.tmp-*.json`
  file from the original directory.

This taxonomy is exhaustive on the foundation path. New failure modes
that emerge during R169B–R169E will be added as new codes, never folded
into existing ones. The R169A foundation exports 30 codes (15 original
plus 5 from pass 1 plus 4 from pass 2 plus 5 from pass 3 plus 1 from
pass 5).

## 10. GC policy

**Keep the active generation plus the two most recent previous
generations. Older generations are deleted.**

- The active generation is identified by reading `active-generation.json`.
- The "two most recent previous" are identified by `createdAt` timestamp
  in their manifest entries (a future GC scan will read each generation's
  manifest from a sidecar or from a generations index).
- `tmp/` is swept on every GC pass: any file older than a threshold
  (default 1 hour) is deleted. This reclaims space from crashed
  publications.
- GC is **best-effort**. If a deletion fails (e.g. file is locked on
  Windows), GC logs the failure and continues. The next GC pass will
  retry.
- GC never deletes the active generation. GC retains generations by
  policy/pinning, not by OS handle — POSIX allows unlink of open files,
  so a reader that holds an fd on a deleted DB will see the old content
  until it closes the fd, but the directory entry is gone immediately.
  R169B+ must implement an explicit pin/refcount on top of the OS handle
  to prevent deletion of any generation currently referenced by an
  in-flight reader.
- GC is **not** enabled in R169A. The policy is documented here so that
  R169B+ can implement it without redesign.

## 11. Recovery

The recovery model is **fail closed and stay closed** until the operator
or the indexer repairs the state. There is no silent fallback, no
automatic downgrade, no manual bypass flag.

- A manifest that fails validation must be repaired or deleted. Until
  then, the resolver throws on every read for that project.
- A missing generation target (manifest says `dbFile` but the file is
  absent) must be repaired by re-indexing. Until then, the resolver
  throws.
- A legacy source identity invalid (path/symlink/regular-file check
  only; SQLite open validation deferred to R169D) must be repaired by
  re-indexing. The resolver does not try to "open it read-only" or
  "skip the broken table" — it throws. R169A validates path containment,
  rejects symlinks, and rejects non-regular-files; the actual SQLite
  header / schema validation is R169D's responsibility.
- There is **no `--skip-manifest` flag**, **no `--force-legacy` flag**,
  **no `CBM_IGNORE_GENERATION_STORE=1` environment variable**. The
  integrity guarantee depends on the resolver being the only path; an
  escape hatch defeats the purpose.

This is a deliberate departure from the R168 and earlier behavior, where
the indexer would sometimes "do its best" with corrupt state. R169's
contract is that the reader sees a complete snapshot or an error — never
a partial snapshot. The price of that contract is that some failures
require operator action.

## 12. Crash matrix (C01–C20)

This is the **target** crash matrix. Each row identifies a crash point,
the on-disk state after the crash, and what the resolver does on the
next read. The matrix is exhaustive for the foundation path; R169B–R169E
will extend it with indexer-specific crash points (extraction failure,
discovery failure, etc.).

| ID | Crash point | On-disk state | Resolver behavior |
|----|-------------|---------------|-------------------|
| C01 | Before opening the temp DB file | No temp file. Active manifest unchanged. | Read returns previous generation (or legacy, or missing). |
| C02 | While writing the temp DB file | Partial temp file in `tmp/`. Active manifest unchanged. | Read returns previous generation. GC later removes the temp file. |
| C03 | After writing, before fsync of temp DB | Temp file fully written but not durable. Active manifest unchanged. | Read returns previous generation. On reboot, temp file may be empty or partial. |
| C04 | During fsync of temp DB | Temp file may be partially durable. Active manifest unchanged. | Read returns previous generation. |
| C05 | After fsync of temp DB, before rename to `generations/` | Temp file durable in `tmp/`. Active manifest unchanged. | Read returns previous generation. GC later promotes or removes the temp file. |
| C06 | During rename `tmp/ → generations/` | Rename is atomic on POSIX: either the old state or the new state. Active manifest unchanged. | Read returns previous generation. The new generation DB is in `generations/` but unreferenced. |
| C07 | After rename, before writing the new manifest | New generation DB is in `generations/`. Active manifest still points to the old generation. | Read returns previous generation. The new DB is unreferenced; GC later removes it. |
| C08 | While writing the manifest temp file | Partial manifest temp file in the project store. Active manifest unchanged. | Read returns previous generation. |
| C09 | After writing manifest temp, before fsync | Manifest temp file written but not durable. Active manifest unchanged. | Read returns previous generation. |
| C10 | During fsync of manifest temp | Manifest temp may be partially durable. Active manifest unchanged. | Read returns previous generation. |
| C11 | After fsync of manifest temp, before rename | Manifest temp durable. Active manifest still points to old generation. | Read returns previous generation. |
| C12 | During rename `manifest.tmp → active-generation.json` | Atomic on POSIX: either old manifest or new manifest. | Read returns either the old or the new generation, never a partial manifest. |
| C13 | After manifest rename, before fsync of directory | New manifest is in place but the directory entry may not be durable. On crash, the rename could roll back. | Read returns either the old or the new generation, depending on whether the rename survived. Both are valid. |
| C14 | After directory fsync | New generation is fully live and durable. | Read returns the new generation. |
| C15 | Crash during GC, between unlink of two old generations | Some old generations deleted, some remain. | Read returns the active generation (GC never touches the active generation). |
| C16 | Crash during `tmp/` sweep | Some temp files deleted, some remain. | Read returns the active generation. |
| C17 | Disk full while writing temp DB | Temp file is partial or absent. Active manifest unchanged. | Read returns previous generation. Indexer must retry or fail visibly. |
| C18 | Disk full while writing manifest temp | Manifest temp file is partial or absent. Active manifest unchanged. | Read returns previous generation. Indexer must retry or fail visibly. |
| C19 | Permission denied on `generations/` directory | Temp DB cannot be created. Active manifest unchanged. | Read returns previous generation. Indexer must surface the permission error. |
| C20 | Permission denied on the project store directory (manifest write) | Manifest temp cannot be created. Active manifest unchanged. | Read returns previous generation. Indexer must surface the permission error. |

The common property: **a crash never leaves the reader seeing a partial
publication.** The reader either sees the previous complete snapshot or
the new complete snapshot, depending on whether the manifest rename
(C12) survived.

## 13. Performance contract

R169A is **zero overhead** when unused.

- No production code imports `generation-store.js` at startup. The
  module is only loaded by its own tests.
- No `fsync`, no `mkdir`, no `lstat` is performed on the hot path. The
  indexer, readers, UI, MCP, and CLI all continue to use
  `defaultCodeDbPath` (which equals `legacyCodeDbPath`).
- The test suite that verifies the no-overhead property lives at
  `v2/tests/storage/r169a-generation-store.test.ts`, in the
  `R169A — No production behavior change` block. It checks that:
  - `defaultCodeDbPath` still exists and is importable.
  - `legacyCodeDbPath(project)` produces the same path as
    `defaultCodeDbPath(project)`.
  - `CURRENT_GENERATION_MANIFEST_VERSION` is still `1`.

When R169C integrates the R169B publisher primitives, the cost model is:

- One extra `fsync` of the generation DB file per publication.
- One extra `fsync` of the manifest file per publication.
- One extra `fsync` of the project store directory per publication.
- One `rename` of the generation DB from `tmp/` to `generations/`.
- One `rename` of the manifest temp file to `active-generation.json`.

These costs are paid **once per indexing run**, not per query. Readers
pay no cost — they open the resolved DB once and keep the handle.

## 14. R170 boundary (lease / fencing)

R169A is the foundation for atomic publication **within a single host**.
It does **not** address multi-host coordination. That is R170.

R170 will add:

- **Project lease:** an indexer must acquire a lease before publishing.
  The lease is identified by a fencing token (monotonic integer).
- **Fencing on write:** the writer checks the lease token and refuses
  to publish if the token is stale (lower than the highest token seen
  for the project). Fencing token is required for publication
  authorization. The token may live in a sidecar CAS/lease state, not
  necessarily in the manifest V1 content. The exact location will be
  decided in R170 — candidates include `index-state.json`, a separate
  `lease.json` sidecar, or a CAS entry keyed by the project key.
- **Fencing on read:** not required for correctness (readers always see
  a complete snapshot), but useful for diagnostics: a reader can detect
  that the active generation was published by a stale indexer and warn.
- **Lease storage:** likely in `index-state.json` (a sidecar, not the
  manifest). The manifest stays clean of operational metadata.

The R169A schema deliberately leaves room for this:

- `MANIFEST_V1_KEYS` is closed, so adding a `leaseToken` field requires
  bumping `formatVersion` to `2` and a migration. This is intentional:
  lease tokens are an operational concern, not a content concern. R170
  may keep the token out of the manifest V1 content entirely and store
  it in a sidecar CAS/lease state — the closed manifest schema is
  compatible with either approach.
- `index-state.json` is already defined as the sidecar for operational
  state. R170 can extend it without breaking the manifest schema.

R169A does **not** implement lease or fencing. Multi-host deployments
that share a cache directory (rare, but possible over NFS) are not safe
under R169A alone. The single-host contract (section 2) is the only
contract R169A provides.

## 15. Status: FOUNDATION / INACTIVE

To repeat the headline, because it is the most important fact in this
document:

> **R169A is an implemented candidate — INACTIVE, pending review. No
> production code path uses the generation store. The indexer still
> writes to the legacy DB. Readers still open the legacy DB directly.
> `DATA-CARRY-01` (P1) remains OPEN until R169E (after crash matrix +
> concurrency + performance + activation).**

What R169A delivers:

- `v2/src/storage/generation-store.ts` — path helpers, manifest parser
  and validator, resolver, atomic JSON writer.
- `v2/src/storage/generation-types.ts` — manifest V1 types,
  `ResolvedCodeDb` discriminated union, error taxonomy.
- `v2/tests/storage/r169a-generation-store.test.ts` — full test matrix
  for the above.

What R169A does **not** deliver:

- R169B — Durable Staging Publisher + Validator + fsync + CAS + GC
  primitives. Implement independent publisher primitives and test
  harnesses — NO production indexer caller.
- R169C — Indexer Integration + Outcome Contract. Wire those primitives
  into `indexProjectWasm` and outcome paths.
- R169D — Reader Cutover + Legacy Migration + Project Lifecycle.
- R169E — Crash Matrix + Performance + Activation + Version (and the
  formal close-out of `DATA-CARRY-01`).
- R170 — Multi-host fencing / lease.

The foundation is an implemented candidate (pending review) so that
R169B–R169E can land incrementally, each round activating one piece
with its own tests and audit. There is no "big bang" activation.
`DATA-CARRY-01` (P1) remains OPEN until R169E has passed the crash
matrix, concurrency analysis, performance verification, and activation
gating.

### 15.1 Platform support (R169A-FIX-R5 PORT-R169A-R5-01)

The R169A foundation is **Linux certified** — every code path
(O_NOFOLLOW + O_DIRECTORY opens, fsync of directories and parents,
fchmod 0700, dev/ino identity checks, path-traversal rejection) is
exercised by the test matrix on Linux.

**macOS is planned — verification deferred to R169E.** The primitives
used (`O_NOFOLLOW`, `O_DIRECTORY`, `fsync(fd)`, `fchmod`, lstat +
dev/ino) are POSIX and available on macOS, but the R169A test matrix
was run on Linux only. R169E will repeat the full matrix on macOS as
part of the crash + performance + activation evidence. Until then,
macOS is NOT certified and the foundation MUST NOT be activated on
macOS production hosts.

**Windows is legacy / inactive.** `O_NOFOLLOW` and `O_DIRECTORY` are
not available on Windows; the code falls back to a lstat → open →
fstat → dev/ino-compare path. This fallback is exercised by unit
tests but is NOT certified for production use. Windows remains a
legacy / inactive platform for the generation store; R169E will
decide whether to certify Windows or to formally drop support.

## 16. References

- `v2/src/storage/generation-store.ts` — implementation.
- `v2/src/storage/generation-types.ts` — types and error codes.
- `v2/tests/storage/r169a-generation-store.test.ts` — test matrix.
- `docs/V2_ARCHITECTURE.md` — section 10 (publication, current state +
  R169 target) and section 15 (R169A generation store target).
- `docs/V2_CURRENT_STATE.md` — R169A section (foundation implemented as a candidate, inactive, pending review, publication NOT active).
- `v2/CHANGELOG.md` — R169A entry (foundation, feature inactive).
- `v2/src/indexer/schema.ts` — `CURRENT_GENERATION_MANIFEST_VERSION = 1`.
- `v2/src/bridge/sqlite-ro.ts` — `defaultCodeDbPath` (the legacy path,
  unchanged by R169A).
