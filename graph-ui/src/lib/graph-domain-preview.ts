export interface DomainPreviewSource {
  key: string;
  nodeCount: number;
  representativeNodeId?: number;
}

export interface DomainPreviewCandidate {
  id: number;
  domainKey: string;
  name: string;
  label: string;
  rank: number;
  size: number;
}

export interface DomainPreviewPlan {
  domainKey: string;
  nodeIds: number[];
  hiddenCount: number;
}

export interface DomainPreviewLimits {
  maxDomains: number;
  maxNodesPerDomain: number;
}

const DEFAULT_LIMITS: DomainPreviewLimits = {
  maxDomains: 24,
  maxNodesPerDomain: 2,
};

const SECONDARY_LABEL_PRIORITY = new Map([
  ["Class", 0],
  ["Interface", 0],
  ["Type", 0],
  ["Method", 0],
  ["Function", 0],
  ["Field", 1],
  ["Route", 1],
  ["File", 2],
  ["Module", 2],
  ["Section", 2],
]);

function byPreviewImportance(
  left: DomainPreviewCandidate,
  right: DomainPreviewCandidate,
): number {
  return (SECONDARY_LABEL_PRIORITY.get(left.label) ?? 99)
    - (SECONDARY_LABEL_PRIORITY.get(right.label) ?? 99)
    || right.rank - left.rank
    || right.size - left.size
    || left.id - right.id;
}

/**
 * Select a bounded, deterministic signature for large macro domains.
 *
 * The server-chosen representative remains first. A second semantic symbol is
 * chosen by type and exact topology rank, while structural shells and
 * parser-generated anonymous names are excluded from the secondary slot.
 */
export function buildDomainPreviewPlan(
  domains: readonly DomainPreviewSource[],
  candidates: readonly DomainPreviewCandidate[],
  limits: DomainPreviewLimits = DEFAULT_LIMITS,
): DomainPreviewPlan[] {
  if (limits.maxDomains <= 0 || limits.maxNodesPerDomain <= 0) return [];

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const candidatesByDomain = new Map<string, DomainPreviewCandidate[]>();
  for (const candidate of candidates) {
    if (/^anonymous#/u.test(candidate.name)) continue;
    const domainCandidates = candidatesByDomain.get(candidate.domainKey);
    if (domainCandidates) domainCandidates.push(candidate);
    else candidatesByDomain.set(candidate.domainKey, [candidate]);
  }
  for (const domainCandidates of candidatesByDomain.values()) {
    domainCandidates.sort(byPreviewImportance);
  }

  return [...domains]
    .sort((left, right) => right.nodeCount - left.nodeCount || left.key.localeCompare(right.key))
    .slice(0, limits.maxDomains)
    .flatMap((domain) => {
      const selected: DomainPreviewCandidate[] = [];
      const representative = domain.representativeNodeId == null
        ? undefined
        : candidateById.get(domain.representativeNodeId);
      if (representative?.domainKey === domain.key && !/^anonymous#/u.test(representative.name)) {
        selected.push(representative);
      }

      for (const candidate of candidatesByDomain.get(domain.key) ?? []) {
        if (selected.length >= limits.maxNodesPerDomain) break;
        if (!SECONDARY_LABEL_PRIORITY.has(candidate.label)) continue;
        if (selected.some((current) => current.id === candidate.id || current.name === candidate.name)) {
          continue;
        }
        selected.push(candidate);
      }
      if (selected.length === 0) return [];
      return [{
        domainKey: domain.key,
        nodeIds: selected.map((candidate) => candidate.id),
        hiddenCount: Math.max(0, domain.nodeCount - selected.length),
      }];
    });
}
