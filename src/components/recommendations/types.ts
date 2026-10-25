import type { Recommendation } from '../../recommendations';
import type { TriageStatus } from './triage';

// A recommendation as shown in the grid: the provider's output plus its triage state.
export interface RecommendationRow extends Recommendation {
  status: TriageStatus;
  firstSeen: string;
  lastSeen: string;
  snoozeUntil?: string;
  reason?: string;
}
