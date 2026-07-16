const DIRECTORY_LABELS = new Set(['Directory', 'Folder']);

/** Normalize persisted Windows/POSIX paths without making them machine-specific. */
export function normalizeGraphPath(filePath: string | null | undefined): string {
  return (filePath ?? '')
    .replace(/\\/gu, '/')
    .replace(/^[A-Za-z]:\//u, '')
    .replace(/^\/+|\/+$/gu, '');
}

/** The exact directory community key used by the architecture overview. */
export function graphCommunityKey(
  filePath: string | null | undefined,
  label: string,
): string {
  const normalized = normalizeGraphPath(filePath);
  const parts = normalized.split('/').filter(Boolean);
  // Folder nodes already point at a directory. File and symbol nodes point at
  // a file and therefore drop the final segment.
  const directories = DIRECTORY_LABELS.has(label) ? parts : parts.slice(0, -1);
  if (directories.length === 0) {
    return normalized.length > 0 ? '(root)' : `(virtual)/${label}`;
  }
  return directories.slice(0, 3).join('/');
}

export function architectureDomainKey(communityKey: string): string {
  const parts = communityKey.split('/').filter(Boolean);
  return parts.length === 0 ? '(virtual)' : parts[0];
}

export function graphDomainKey(
  filePath: string | null | undefined,
  label: string,
): string {
  return architectureDomainKey(graphCommunityKey(filePath, label));
}
