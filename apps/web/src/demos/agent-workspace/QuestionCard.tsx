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
        <span>{question.title}</span>
        <Icon name="down" size={14} />
      </button>
    );

  const status =
    state === 'answered'
      ? '已回答'
      : state === 'deferred'
        ? '稍后回答'
        : '已失效';
  return (
    <details className="question-history">
      <summary>
        <Icon name={state === 'answered' ? 'check' : 'clock'} size={15} />
        <span>
          <strong>{status}</strong>
          <span>
            {state === 'answered'
              ? answerSummary(question) || question.title
              : question.title}
          </span>
        </span>
        <Icon name="down" size={14} />
      </summary>
      <div className="question-history-body">
        <p>{question.title}</p>
        {question.description && <p>{question.description}</p>}
        {state === 'expired' && <p>请以最新草稿和会话内容为准。</p>}
        {state === 'deferred' && <p>已保留当前内容，可在对话中继续办理。</p>}
      </div>
    </details>
  );
}
