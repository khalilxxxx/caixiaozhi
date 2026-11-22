import { useEffect, useId, useRef, useState } from 'react';
import type { ClarificationQuestion } from './question-model';
import { Button, Icon } from './ui';
import { useWorkspace } from './workspace';
import './question-composer.css';

interface QuestionResponse {
  selected: string[];
  text: string;
}

export function questionResponseKey(
  taskId: string,
  questionId: string,
): string {
  return `cx.agent.question.${encodeURIComponent(taskId)}:${encodeURIComponent(questionId)}`;
}

export function readQuestionResponse(
  taskId: string,
  question: ClarificationQuestion,
): QuestionResponse {
  try {
    const raw =
      sessionStorage.getItem(questionResponseKey(taskId, question.id)) ??
      sessionStorage.getItem(`cx.agent.question.${question.id}`);
    const saved = JSON.parse(raw ?? '{}');
    const selected = Array.isArray(saved?.selected)
      ? question.options
          .filter((option) => saved.selected.includes(option.id))
          .map((option) => option.id)
      : [];
    return {
      selected: question.multiple ? selected : selected.slice(0, 1),
      text: typeof saved?.text === 'string' ? saved.text : '',
    };
  } catch {
    return { selected: [], text: '' };
  }
}

export function writeQuestionResponse(
  taskId: string,
  questionId: string,
  response: QuestionResponse,
): void {
  try {
    sessionStorage.setItem(
      questionResponseKey(taskId, questionId),
      JSON.stringify(response),
    );
  } catch {
    // The in-memory answer remains editable when browser storage is unavailable.
  }
}

// The workspace calls this only after confirming the question's resolved state.
export function clearQuestionResponse(
  taskId: string,
  questionId: string,
): void {
  try {
    sessionStorage.removeItem(questionResponseKey(taskId, questionId));
    sessionStorage.removeItem(`cx.agent.question.${questionId}`);
  } catch {
    // Storage availability must not block the conversation.
  }
}

export function QuestionComposer({
  question,
  taskId,
  busy,
  onStop,
}: {
  question: ClarificationQuestion;
  taskId: string;
  busy: boolean;
  onStop?: () => void;
}) {
  const w = useWorkspace();
  const titleId = useId();
  const contextId = useId();
  const errorId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const composing = useRef(false);
  const focusAttempted = useRef(false);
  const [response, setResponse] = useState(() =>
    readQuestionResponse(taskId, question),
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const disabled = busy || sending;
  const selectedOptionIds = question.options
    .filter((option) => response.selected.includes(option.id))
    .map((option) => option.id);
  const selected = question.multiple
    ? selectedOptionIds
    : selectedOptionIds.slice(0, 1);
  const hasAnswer = selected.length > 0 || response.text.trim().length > 0;
  const hasDetails = question.options.some((option) => option.description);

  useEffect(() => {
    writeQuestionResponse(taskId, question.id, response);
  }, [taskId, question.id, response]);

  useEffect(() => {
    if (disabled || focusAttempted.current) return;
    focusAttempted.current = true;
    if (
      document.activeElement === document.body ||
      document.activeElement?.id === 'message-input'
    )
      textarea.current?.focus({ preventScroll: true });
  }, [disabled]);

  async function answer(deferred = false) {
    if (disabled || inFlight.current || (!deferred && !hasAnswer)) return;
    inFlight.current = true;
    setSending(true);
    setError('');
    try {
      // A resolved request is not proof that the server accepted the answer.
      // Keep the draft until the workspace observes the resolved question.
      await w.answerQuestion({
        questionId: question.id,
        optionIds: deferred ? [] : selected,
        text: deferred ? '' : response.text,
        deferred,
      });
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : '回答未发送，请重试。',
      );
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <section
      className="composer question-composer"
      aria-labelledby={titleId}
      aria-busy={disabled}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void answer();
        }}
      >
        <div className="question-composer-prompt">
          <header className="question-composer-header">
            <h2 id={titleId}>{question.title}</h2>
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => void answer(true)}
            >
              稍后回答
            </Button>
          </header>
          {question.description && (
            <p id={contextId} className="question-composer-context">
              {question.description}
            </p>
          )}
          {question.options.length > 0 && (
            <fieldset disabled={disabled}>
              <legend className={question.multiple ? undefined : 'sr-only'}>
                {question.multiple ? '可多选' : '选择回答'}
              </legend>
              <div
                className={`question-composer-options${hasDetails ? ' has-details' : ''}`}
              >
                {question.options.map((option) => (
                  <label
                    className="question-composer-option"
                    data-selected={selected.includes(option.id)}
                    key={option.id}
                  >
                    <input
                      type={question.multiple ? 'checkbox' : 'radio'}
                      name={`question-answer-${question.id}`}
                      value={option.id}
                      checked={selected.includes(option.id)}
                      onChange={() => {
                        setError('');
                        setResponse((previous) => ({
                          ...previous,
                          selected: question.multiple
                            ? previous.selected.includes(option.id)
                              ? previous.selected.filter(
                                  (id) => id !== option.id,
                                )
                              : [...previous.selected, option.id]
                            : [option.id],
                        }));
                      }}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {option.description && (
                        <small>{option.description}</small>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {selected.length > 0 && (
            <button
              className="question-composer-clear"
              type="button"
              disabled={disabled}
              onClick={() => {
                setError('');
                setResponse((previous) => ({ ...previous, selected: [] }));
              }}
            >
              清除选择
            </button>
          )}
        </div>
        <textarea
          id="question-answer-input"
          ref={textarea}
          rows={2}
          maxLength={2000}
          aria-label="回答追问"
          aria-describedby={
            [question.description ? contextId : '', error ? errorId : '']
              .filter(Boolean)
              .join(' ') || undefined
          }
          aria-invalid={error ? true : undefined}
          placeholder={
            question.options.length ? '补充或直接回答…' : '输入回答…'
          }
          value={response.text}
          disabled={disabled}
          onChange={(event) => {
            setError('');
            setResponse((previous) => ({
              ...previous,
              text: event.target.value,
            }));
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !composing.current &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              void answer();
            }
          }}
        />
        {error && (
          <p id={errorId} className="question-composer-error" role="alert">
            {error}
          </p>
        )}
        <footer className="question-composer-toolbar">
          {busy && onStop && (
            <Button type="button" variant="ghost" icon="stop" onClick={onStop}>
              停止处理
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={disabled || !hasAnswer}
          >
            {sending ? '正在发送…' : '发送回答'}
            <Icon name="up" size={14} />
          </Button>
        </footer>
      </form>
    </section>
  );
}
