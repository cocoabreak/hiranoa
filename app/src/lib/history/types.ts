export interface HistoryCommit {
  id: string;
  summary: string;
  author: string;
  timestamp: number;
}
export interface HistoryInfo {
  sessionId: string;
  path: string;
  commits: HistoryCommit[];
  truncated: boolean;
}
export interface HistorySnapshot {
  raw: string;
  present: boolean;
}
