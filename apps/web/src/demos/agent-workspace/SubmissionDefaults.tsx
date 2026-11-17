import type { SubmissionDraft } from './submission-model';
import { activeSubmissionDefaults } from './submission-defaults';
import './submission-defaults.css';

export function SubmissionDefaults({ draft }: { draft: SubmissionDraft }) {
  const entries = activeSubmissionDefaults(draft);
  if (!entries.length) return null;
  return (
    <details className="sf-defaults">
      <summary>
        自动填写依据 <span>{entries.length} 项</span>
      </summary>
      <dl>
        {entries.map((entry) => (
          <div key={entry.path}>
            <dt>{entry.label}</dt>
            <dd>
              <strong>{entry.value}</strong>
              <p>{entry.basis}</p>
              <small>{entry.source}</small>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
