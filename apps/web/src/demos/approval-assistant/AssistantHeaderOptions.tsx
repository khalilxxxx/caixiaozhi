import { useId } from 'react';
import { ScoreRing } from './RiskCardParts';
import type { RiskAssessment } from './risk-assessment';
import './assistant-header-options.css';

interface SummaryProps {
  assessment: RiskAssessment;
  summary: string;
  advice?: string;
}

export function AssessmentSummary({
  assessment,
  summary,
  advice,
}: SummaryProps) {
  const titleId = useId();
  return (
    <section
      className={`ah-assessment tone-${assessment.tone}`}
      aria-labelledby={titleId}
    >
      <div className="ah-assessment-result">
        <div>
          <h4 id={titleId}>整单风险评估</h4>
          <strong className="ah-level">{assessment.level}</strong>
        </div>
        <ScoreRing assessment={assessment} />
      </div>
      <p className="ah-summary">{summary}</p>
      {advice && (
        <div className="ah-advice">
          <h5>整改建议</h5>
          <p>{advice}</p>
        </div>
      )}
    </section>
  );
}
