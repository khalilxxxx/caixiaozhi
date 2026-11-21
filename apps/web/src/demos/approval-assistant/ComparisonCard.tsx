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
import './comparison-card.css';

export function ComparisonCard({ sample, onRules }: CardProps) {
  const risk = assessRisk(sample);
  return (
    <section
      className={`ra-card ra-dashboard tone-${risk.tone}`}
      aria-label="小智审批助手"
    >
      <header className="ra-dashboard-top">
        <div className="ra-dashboard-brand">
          <AssistantMark />
        </div>
        <div className="ra-dashboard-assess">
          <ScoreRing assessment={risk} />
          <div>
            <AssessmentHeading assessment={risk} />
            <p className="ra-summary">{risk.summary}</p>
          </div>
        </div>
      </header>
      <RiskPoints assessment={risk} />
      <ExecutionBreakdown assessment={risk} visual="metrics" />
      <footer className="ra-card-foot">
        <RuleLink onRules={onRules} />
      </footer>
    </section>
  );
}
