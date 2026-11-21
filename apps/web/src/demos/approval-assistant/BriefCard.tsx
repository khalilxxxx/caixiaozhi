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
import './brief-card.css';

export function BriefCard({ sample, onRules }: CardProps) {
  const risk = assessRisk(sample);
  return (
    <section
      className={`ra-card ra-brief tone-${risk.tone}`}
      aria-label="小智审批助手"
    >
      <header className="ra-brief-top">
        <div className="ra-brief-copy">
          <AssistantMark />
          <AssessmentHeading assessment={risk} />
        </div>
        <ScoreRing assessment={risk} />
      </header>
      <p className="ra-summary">{risk.summary}</p>
      <RiskPoints assessment={risk} />
      <ExecutionBreakdown assessment={risk} />
      <footer className="ra-card-foot">
        <RuleLink onRules={onRules} />
      </footer>
    </section>
  );
}
