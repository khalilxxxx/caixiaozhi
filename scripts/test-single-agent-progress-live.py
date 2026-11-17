"""Verify real thinking/tool round trips in an isolated local workspace."""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/agno-service'))
import config
from store import Store
from business import Business
from agent_runtime import Runtime, model


async def main():
    output = ROOT / 'artifacts/single-agent-progress-20261117'
    output.mkdir(parents=True, exist_ok=True)
    result = {'model': config.MODEL, 'thinkingConfigured': config.THINKING, 'adapter': type(model()).__name__, 'isolated': True, 'runs': []}
    with tempfile.TemporaryDirectory(prefix='caixiaozhi-progress-') as temp:
        config.DATA_DIR = Path(temp)
        store = Store(Path(temp) / 'workspace.sqlite3')
        runtime = Runtime(store, Business(store))
        store.mutate(lambda state: state.update(tasks=[{'id': 'verification', 'title': '执行进度验证', 'messages': [], 'refs': [], 'input': '', 'type': 'assistant'}]))
        for index, prompt in enumerate(['请查询10月销售部费用合计，使用业务工具，不生成文件。', '与9月相比增加了多少？请读取业务数据，给出准确金额。']):
            run_id = f'verification-{index + 1}'
            def prepare(state):
                task = state['tasks'][0]
                task['activeRunId'] = run_id
                task['messages'].append({'id': f'user-{index}', 'role': 'user', 'text': prompt})
            store.mutate(prepare)
            store.create_run(run_id, 'verification', {'message': prompt, 'refs': []})
            await runtime.execute(run_id)
            message = store.get_state()['tasks'][0]['messages'][-1]
            events = store.events(run_id)
            steps = message.get('tools', [])
            record = {'status': store.run(run_id)['status'], 'runStatus': message.get('runStatus'), 'text': message.get('text'), 'steps': steps, 'eventTypes': [event['kind'] for event in events]}
            result['runs'].append(record)
            (output / 'live-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
            print(json.dumps({'turn': index + 1, 'status': record['status'], 'toolCount': len(steps)}, ensure_ascii=False), flush=True)
            assert record['status'] == 'completed', record['text']
            assert steps and all(step.get('id') for step in steps)
            assert all(step['status'] == 'completed' for step in steps)
            assert len({step['id'] for step in steps}) == len(steps)
            assert not any('input' in step or 'output' in step or 'reasoning_content' in step for step in steps)
    result['status'] = 'passed'
    (output / 'live-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print('真实模型两轮工具调用通过；思考内容未进入进度记录。')


if __name__ == '__main__':
    asyncio.run(main())
