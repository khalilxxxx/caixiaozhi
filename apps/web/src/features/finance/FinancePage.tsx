import type { Me } from '@caixiaozhi/contracts/identity';
import { KnowledgeWorkspace } from './KnowledgeWorkspace.js';
import { AnalyticsWorkspace } from './AnalyticsWorkspace.js';
import { SkillsWorkspace } from './SkillsWorkspace.js';
import './finance.css';
export function FinancePage({
  section,
  me,
}: {
  section: 'knowledge' | 'analytics' | 'skills';
  me: Me;
}) {
  return (
    <div className="finance-page">
      {section === 'knowledge' ? (
        <KnowledgeWorkspace me={me} />
      ) : section === 'analytics' ? (
        <AnalyticsWorkspace me={me} />
      ) : (
        <SkillsWorkspace me={me} />
      )}
    </div>
  );
}
