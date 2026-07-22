# Security policy

## Supported versions

Security fixes are applied to the current `main` branch. Until the project
publishes its first GitHub release, older commits and development snapshots are
not maintained as separate supported versions.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, exposed credential,
or bypass of a trust boundary. Use GitHub's private vulnerability reporting:

https://github.com/Cheurteenyt/Ariad/security/advisories/new

Include the affected commit or version, impact, reproduction steps, and the
smallest safe proof of concept. Remove tokens, private keys, personal data, and
unrelated logs before submitting the report.

The maintainer will acknowledge a usable report, assess its severity, and
coordinate remediation before public disclosure. Please do not disclose the
issue publicly until a fix or an agreed disclosure date exists.

## Credential incidents

If a GitHub, GitLab, z.ai, or mirror credential may have been exposed, revoke
or rotate it first. Repository history and issue comments are not appropriate
places to store secrets, even temporarily.
