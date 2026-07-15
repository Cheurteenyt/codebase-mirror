# Release Policy — Codebase Memory V2

> **Status:** current
> **Last verified:** 0.76.0 / 2026-07-15 audit

## Overview

This document defines the release governance for Codebase Memory V2. It
distinguishes between internal development rounds, package version bumps,
and public GitHub Releases.

## Internal Rounds (R\<n\>)

Internal rounds are the development unit. Each round:

- May or may not modify the distributable artifact.
- Does not automatically require a package version bump.
- Is tracked in `v2/CHANGELOG.md`.
- Is merged to `main` via Pull Request (preferred) or fast-forward
  (break-glass only, during incident recovery).

## Package Version

The `v2/package.json` version is bumped when:

- The user-facing artifact changes (new CLI command, new MCP tool,
  behavior change, bug fix).
- A breaking change is introduced.
- A new feature is added.

It is NOT bumped for:

- Pure documentation changes.
- CI/infrastructure-only changes.
- Test-only changes.
- Internal refactoring with no user-visible effect.

## GitHub Releases

A GitHub Release is a public distribution event. It requires:

1. **Immutable tag** (`v<version>`, e.g. `v0.77.0-alpha.1`).
2. **Full CI green** on the tagged commit.
3. **Package smoke test**: `npm pack` + install in temp dir + `cbm-v2 --version`
   + `cbm-v2 --help` + UI serves from arbitrary cwd.
4. **Docker smoke test**: `docker build --no-cache` + CLI help + UI HTTP.
5. **Release notes** derived from CHANGELOG.
6. **Checksums** for all assets.
7. **No force-push** to the tag after creation.

## First Release

The first public release (a **pre-release**) should happen only after:

- R168.3a: package + Docker smoke evidence
- R169E: atomic generation publication activated and validated end to end
- R170: project lease/fencing

Suggested first pre-release: `v0.77.0-alpha.1`.

Do NOT create retroactive tags for past versions (0.73.x, 0.74.x). These
were internal rounds, not public releases.

## Tag Mirroring

Tags are NOT currently mirrored to GitLab. When the first release is
published, a separate tag-mirroring policy will be defined. For now, the
mirror only copies `main`.

## Release Workflow (future)

No publish workflow or public npm package exists yet. Until the workflow below
is implemented and its package/Docker/UI/checksum gates pass, version bumps in
the repository are development artifacts rather than public releases.

```text
1. Ensure main is green (CI + mirror).
2. Create tag v<version> on the exact commit.
3. Push tag to GitHub.
4. GitHub Release workflow triggers (to be created).
5. Workflow builds package + Docker image.
6. Workflow publishes Release with notes + checksums.
7. Mirror tag to GitLab (future).
```
