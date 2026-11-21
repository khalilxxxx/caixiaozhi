import { assessRisk } from './risk-assessment';
import type { CardProps } from './sample-types';
import {
  AssessmentHeading,
  AssistantMark,
  ExecutionBreakdown,
  RiskPoints,
  RuleLink,
  ScoreRing,
} from './RiskCardParts';
import './evidence-card.css';

export function EvidenceCard({ sample, onRules, onEvidence }: CardProps) {
  const risk = assessRisk(sample);
  return (
    <section
      className={`ra-card ra-ledger tone-${risk.tone}`}
      aria-label="小智审批助手"
    >
      <header className="ra-ledger-head">
        <AssistantMark />
        <span>{sample.doc.kind}</span>
      </header>
      <div className="ra-ledger-assess">
        <div>
          <AssessmentHeading assessment={risk} />
          <p className="ra-summary">{risk.summary}</p>
        </div>
        <ScoreRing assessment={risk} />
      </div>
      <RiskPoints assessment={risk} withEvidence onEvidence={onEvidence} />
      <ExecutionBreakdown assessment={risk} visual="ledger" />
      <footer className="ra-card-foot">
        <RuleLink onRules={onRules} />
      </footer>
    </section>
  );
}
