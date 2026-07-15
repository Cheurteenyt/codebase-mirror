export const MINIMUM_NODE_VERSION = '22.12.0';
export const MINIMUM_NODE_MAJOR = 22;
export const MINIMUM_NODE_MINOR = 12;
export const MINIMUM_NODE_PATCH = 0;

/** Match the runtime contract declared in package.json#engines. */
export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;

  if (major !== MINIMUM_NODE_MAJOR) return major > MINIMUM_NODE_MAJOR;
  if (minor !== MINIMUM_NODE_MINOR) return minor > MINIMUM_NODE_MINOR;
  return patch >= MINIMUM_NODE_PATCH;
}
