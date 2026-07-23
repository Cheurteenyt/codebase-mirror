export function confidence(score: number): number {
  return Math.min(1, score / 100);
}

export function categoryForConfidence(value: number): string {
  if (value >= 0.8) return 'critical';
  if (value >= 0.5) return 'important';
  return 'routine';
}

export function classifyScore(score: number): string {
  return categoryForConfidence(confidence(score));
}

export function classificationLabel(category: string, score: number): string {
  return `${category}:${Math.round(score)}`;
}
