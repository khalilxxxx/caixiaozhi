import {
  answerSummary,
  questionState,
  type ClarificationQuestion,
} from './question-model';
import { useWorkspace } from './workspace';
import { Icon } from './ui';
import './question-card.css';

export function QuestionCard({
  question,
  active,
  busy,
}: {
  question: ClarificationQuestion;
  active: boolean;
  busy: boolean;
}) {
  const w = useWorkspace();
  const state =
    question.status === 'pending' && !active
      ? 'expired'
      : questionState(question, w.state.data);

  if (state === 'pending')
    return (
      <button
        type="button"
        className="question-pending-link"
        aria-label={`转到输入区回答：${question.title}`}
        disabled={busy}
        onClick={() => {
          document.getElementById('question-answer-input')?.focus();
        }}
      >
        <Icon name="chat" size={15} />
        <span className="question-pending-copy">
          <span className="question-pending-tag">待确认</span>
          <span className="question-pending-title">{question.title}</span>
        </span>
        <span className="question-pending-cta">
          去下方回答
          <Icon name="down" size={13} />
        </span>
      </button>
    );

  const status =
    state === 'answered'
      ? '已回答'
      : state === 'deferred'
        ? '稍后回答'
        : '已失效';
  const summary = state === 'answered' ? answerSummary(question) : '';
  return (
    <details className="question-history" data-state={state}>
      <summary>
        <Icon name={state === 'answered' ? 'check' : 'clock'} size={14} />
        <span className="question-history-summary">
          <strong>{status}</strong>
          <span className="question-history-title">{question.title}</span>
          {summary && (
            <span className="question-history-answer">{summary}</span>
          )}
        </span>
        <Icon name="down" size={14} />
      </summary>
      <div className="question-history-body">
        <p>{question.title}</p>
        {question.description && <p>{question.description}</p>}
        {summary && <p className="question-history-reply">回答：{summary}</p>}
        {state === 'expired' && <p>请以最新草稿和会话内容为准。</p>}
        {state === 'deferred' && <p>已保留当前内容，可在对话中继续办理。</p>}
      </div>
    </details>
  );
}
