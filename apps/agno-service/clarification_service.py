"""Authoritative question transitions, applied inside the workspace transaction."""
from __future__ import annotations

import copy
import json
import re
import time
import uuid


class QuestionError(ValueError):
    def __init__(self, message, *, status=409):
        super().__init__(message)
        self.status = status


def pending_question(task):
    return next((message['question'] for message in reversed(task.get('messages', []))
                 if message.get('question', {}).get('status') == 'pending'), None)


def draft_is_current(state, question):
    drafts = state.get('data', {}).get('submissions', {}).get('drafts', {})
    if question.get('sourceDraftId'):
        source = drafts.get(question['sourceDraftId'])
        if not source or source.get('status') == 'draft' or source.get('version') != question.get('sourceDraftVersion'):
            return False
    if not question.get('draftId'):
        return True
    draft = drafts.get(question['draftId'])
    return bool(draft and draft.get('version') == question.get('draftVersion') and draft.get('status') == 'draft')


def expire_questions(state):
    """Saved draft changes invalidate the decision bound to its previous version."""
    changed = False
    for task in state.get('tasks', []):
        for message in task.get('messages', []):
            question = message.get('question')
            if question and question.get('status') == 'pending' and not draft_is_current(state, question):
                question['status'] = 'expired'
                changed = True
        if task.get('status') == '待你回答' and not pending_question(task):
            task['status'] = '待我核对'
            changed = True
    return changed


def reopen_question(state, task_id, question_id):
    """Restore the original decision without starting a run or adopting another draft."""
    task = next((item for item in state['tasks'] if item['id'] == task_id), None)
    last = next((entry['question'] for entry in reversed((task or {}).get('messages', []))
                 if entry.get('question')), None)
    if not last or last['id'] != question_id or task.get('activeRunId'):
        raise QuestionError('该追问已变化，请查看当前会话。')
    if last['status'] == 'pending' and draft_is_current(state, last):
        return True
    last_user = next((m for m in reversed(task['messages']) if m.get('role') == 'user'), {})
    deferred = last_user.get('questionAnswer') or {}
    if (task.get('status') != '已暂停' or last['status'] != 'deferred'
        or not deferred.get('deferred') or deferred.get('questionId') != question_id):
        raise QuestionError('该追问当前不能恢复，请查看当前会话。')
    if not draft_is_current(state, last):
        last['status'] = 'expired'
        task['status'] = '待我核对'
        return False
    last['status'] = 'pending'
    task['status'] = '待你回答'
    return True


def is_policy_aside(text):
    """Only an explicit intervening policy lookup bypasses the open question."""
    return bool(re.search(r'(?:先|顺便)(?:帮我|给我)?(?:查|问|看|了解|确认|核对)', text)
                and re.search(r'制度|政策|标准|规定|能否报销|能不能报销', text))


def issue_question(state, task_id, title, options=None, *, description=None, multiple=False,
                   draft_id=None, message_id=None, run_id=None):
    if not isinstance(title, str) or not title.strip() or len(title) > 300:
        raise ValueError('问题标题须为1至300字。')
    if description is not None and (not isinstance(description, str) or len(description) > 1000):
        raise ValueError('问题说明不能超过1000字。')
    if not isinstance(multiple, bool):
        raise ValueError('问题选择方式无效。')
    options = [] if options is None else options
    if not isinstance(options, list) or len(options) > 6:
        raise ValueError('每个问题最多提供6个选项。')
    normalized, seen = [], set()
    for option in options:
        if not isinstance(option, dict):
            raise ValueError('问题选项格式无效。')
        option_id, label = option.get('id'), option.get('label')
        if not isinstance(option_id, str) or not option_id.strip() or len(option_id) > 100 or option_id in seen:
            raise ValueError('问题选项编号不能为空或重复。')
        if not isinstance(label, str) or not label.strip() or len(label) > 200:
            raise ValueError('问题选项名称须为1至200字。')
        value = {'id': option_id, 'label': label.strip()}
        if option.get('description'):
            if not isinstance(option['description'], str) or len(option['description']) > 500:
                raise ValueError('问题选项说明不能超过500字。')
            value['description'] = option['description'].strip()
        normalized.append(value)
        seen.add(option_id)
    task = next((task for task in state.get('tasks', []) if task['id'] == task_id), None)
    if task is None:
        raise QuestionError('会话不存在，请返回会话后重试。')
    question = {'id': 'question-' + uuid.uuid4().hex, 'title': title.strip(), 'options': normalized,
                'multiple': multiple, 'status': 'pending'}
    if description and description.strip():
        question['description'] = description.strip()
    if draft_id:
        draft = state.get('data', {}).get('submissions', {}).get('drafts', {}).get(draft_id)
        if not draft or draft.get('status') != 'draft':
            raise QuestionError('草稿已更新或不可编辑，请重新读取。')
        question.update(draftId=draft_id, draftVersion=draft['version'])
    for message in task.get('messages', []):
        if message.get('question', {}).get('status') == 'pending':
            message['question']['status'] = 'expired'
    message = {'id': message_id or 'assistant-' + question['id'], 'role': 'assistant',
               'text': question['title'], 'question': question, 'submissionPhase': 'collecting',
               'createdAt': int(time.time() * 1000)}
    if run_id:
        message['runId'] = run_id
    existing = next((entry for entry in task.get('messages', []) if entry.get('id') == message['id']), None)
    if existing is not None:
        existing.update(message)
    else:
        task.setdefault('messages', []).append(message)
    task['status'] = '待你回答'
    return question


def answer_question(state, task_id, answer, message):
    """Return a trusted question context and a human-readable user message.

    Free text remains free text: labels in an unrelated message never imply an
    option choice or consent to overwrite, submit, or execute a business action.
    """
    task = next((task for task in state.get('tasks', []) if task['id'] == task_id), None)
    if answer is not None:
        question_id = answer.get('questionId')
        question = next((entry['question'] for entry in (task or {}).get('messages', [])
                         if entry.get('question', {}).get('id') == question_id), None)
        if question is None:
            raise QuestionError('该问题不属于当前会话，或已不存在。')
        if question.get('status') != 'pending' or not draft_is_current(state, question):
            raise QuestionError('该问题已处理或已失效，请继续当前会话。')
    else:
        question = pending_question(task) if task else None
        if question is None or not draft_is_current(state, question):
            return None, message.strip()
    option_ids = (answer or {}).get('optionIds') or []
    text = ((answer or {}).get('text') or '').strip() if answer is not None else message.strip()
    deferred = bool((answer or {}).get('deferred'))
    if not isinstance(option_ids, list) or any(not isinstance(value, str) for value in option_ids):
        raise QuestionError('回答选项格式无效。', status=422)
    allowed = {option['id']: option['label'] for option in question['options']}
    if len(set(option_ids)) != len(option_ids) or any(value not in allowed for value in option_ids):
        raise QuestionError('回答包含无效或重复选项。', status=422)
    if not question.get('multiple') and len(option_ids) > 1:
        raise QuestionError('该问题只能选择一项。', status=422)
    if deferred:
        if option_ids or text:
            raise QuestionError('稍后回答时不能同时提交答案。', status=422)
        question['status'] = 'deferred'
        return {'question': copy.deepcopy(question), 'mode': 'deferred'}, '稍后回答'
    if not option_ids and not text:
        raise QuestionError('请选择一个选项或填写回答。', status=422)
    if not option_ids and is_policy_aside(text):
        return {'question': copy.deepcopy(question), 'mode': 'policy_lookup'}, text
    question.update(status='answered', answer={'optionIds': option_ids, 'text': text})
    summary = '；'.join([*(allowed[value] for value in option_ids), *([text] if text else [])])
    return {'question': copy.deepcopy(question), 'mode': 'selection' if option_ids else 'free_text'}, summary


def conversation_content(message):
    text = message.get('text', '')
    if message.get('question'):
        text += '\n结构化追问：' + json.dumps(message['question'], ensure_ascii=False)
    if message.get('questionAnswer'):
        text += '\n对应问题的回答：' + json.dumps(message['questionAnswer'], ensure_ascii=False)
    return text
