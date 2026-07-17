export interface WorkItem {
  id: string;
  source: string;
  score: number;
  tags: string[];
}

export interface StageResult {
  stage: string;
  item: WorkItem;
  elapsedMs: number;
}

export type Stage = (item: WorkItem) => StageResult;
