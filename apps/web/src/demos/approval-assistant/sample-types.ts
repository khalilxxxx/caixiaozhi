import type { ApprovalCase } from './preview-data';
import type { WorkDocument } from '../agent-workspace/work-document-model';
import type { WorkReview } from '../agent-workspace/WorkRuleDetails';

export interface ReviewSubject {
  doc: WorkDocument;
  result: WorkReview;
}

export const mascot = '/agent-assets/mascot-exploration-20261117/c-review.png';

export interface CardProps {
  sample: ApprovalCase;
  onRules: () => void;
  onEvidence: (expenseId?: string) => void;
}

export function hotelComparison(sample: ReviewSubject) {
  const { doc, result } = sample;
  const rule = result.risks.find((f) => f.rule.metric === 'hotelNight')?.rule;
  const expense = doc.expenses?.find((e) => e.categoryId === 'hotel');
  if (!expense || !rule?.thresholdMinor || !expense.nights || !expense.rooms)
    return null;
  const roomNights = expense.rooms * expense.nights;
  const actual = expense.amountCents / roomNights;
  if (actual !== doc.hotelNightCents || actual <= rule.thresholdMinor)
    return null;
  return {
    actual: actual / 100,
    limit: rule.thresholdMinor / 100,
    over: (actual - rule.thresholdMinor) / 100,
    totalOver: (expense.amountCents - rule.thresholdMinor * roomNights) / 100,
    nights: roomNights,
    hotelName: expense.name,
    expenseId: expense.id,
    fileName: doc.files?.find((f) => f.id === expense.sourceFileId)?.name,
  };
}
