"""Exercise uploaded skills through the real local Agent, never fake a model answer."""
import argparse
import io
import json
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:5190/api/local'
DEST = ROOT / 'artifacts/general-skills-20261117/verification'


def call(path, data=None, method=None):
    body = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
    req = urllib.request.Request(BASE + path, data=body, method=method,
                                 headers={'Content-Type': 'application/json'} if body else {})
    with urllib.request.urlopen(req, timeout=130) as response:
        return json.load(response)


def upload(name, content):
    boundary = 'skill-' + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()
            + content + f'\r\n--{boundary}--\r\n'.encode())
    req = urllib.request.Request(BASE + '/files', data=body, headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)['file']


def install(name):
    path = ROOT / 'artifacts/general-skills-20261117/examples' / (name + '.zip')
    file = upload(path.name, path.read_bytes())
    info = call('/skills/inspect', {'fileId': file['id']})['inspection']
    assert info['status'] == 'ready', info
    file.update(text=info['instructions'], inspection=info)
    skill_id = 'example-' + name
    skill = {'id': skill_id, 'title': '演示文稿制作' if name == 'office-presentation' else '表格报告制作',
             'category': '内容生成' if name == 'office-presentation' else '数据分析', 'icon': 'file',
             'description': info['description'], 'owner': '我', 'tags': ['文档生成'], 'favorite': False,
             'view': True, 'download': True, 'call': True, 'instructions': info['instructions'],
             'versions': [{'version': '1.0.0', 'status': 'published', 'mode': 'runnable', 'business': 'pass',
                           'technical': 'pass', 'security': 'pass', 'compatibility': 'pass', 'file': file,
                           'instructions': info['instructions'], 'note': '本机样例脚本与依赖验证通过。',
                           'updated': '2026-11-17', 'events': ['本机样例包校验通过']}]}
    for _ in range(5):
        snapshot = call('/workspace')
        hub = snapshot['state']['data']['skillsHub']
        hub['skills'] = [s for s in hub['skills'] if s['id'] != skill_id] + [skill]
        try:
            call('/workspace', {'baseRevision': snapshot['revision'], 'data': {'skillsHub': hub}}, 'PATCH')
            return {'kind': 'skill', 'id': skill_id, 'version': '1.0.0', 'title': skill['title']}
        except urllib.error.HTTPError as error:
            if error.code != 409:
                raise
    raise RuntimeError('工作空间持续冲突')


def run(task_id, message, refs):
    started = call('/runs', {'taskId': task_id, 'message': message, 'refs': refs})
    print(json.dumps({'runId': started['runId'], 'taskId': task_id}, ensure_ascii=False), flush=True)
    for _ in range(610):
        result = call('/runs/' + started['runId'])
        if result['status'] != 'running':
            assert result['status'] == 'completed', result
            return result
        time.sleep(1)
    raise RuntimeError('真实模型任务超时')


def main(case):
    DEST.mkdir(parents=True, exist_ok=True)
    if case == 'ppt-edit':
        previous = json.loads((DEST / 'ppt-live.json').read_text())
        task = previous['taskId']
        result = run(task, '请修改刚才生成的PPT：只把封面标题改为“财务数字化阶段汇报”，保持4页及其他文字内容不变，基于现有文件生成新的可下载PPT。直接完成，无需追问。', [])
        tools = [e['data'] for e in result['events'] if e['kind'] == 'tool']
        assert any(t['name'] == 'import_skill_artifact' and t['status'] == 'completed' for t in tools)
        items = call('/artifacts?taskId=' + task)['artifacts']
        item = next(x for x in items if x['runId'] == result['id'] and x['name'].endswith('.pptx'))
        from pptx import Presentation
        with urllib.request.urlopen(BASE + '/artifacts/' + item['id'] + '/download') as response:
            content = response.read()
        revised = Presentation(io.BytesIO(content))
        original = Presentation(DEST / 'ppt.pptx')
        assert len(revised.slides) == len(original.slides) == 4
        text = lambda slide: '\n'.join(s.text for s in slide.shapes if s.has_text_frame)
        assert '财务数字化阶段汇报' in text(revised.slides[0])
        assert [text(s) for s in list(revised.slides)[1:]] == [text(s) for s in list(original.slides)[1:]]
        assert call('/artifacts/' + previous['artifact']['id'])['artifact']['sha256'] == previous['artifact']['sha256']
        (DEST / 'ppt-edit.pptx').write_bytes(content)
        metadata = call('/artifacts/' + item['id'])['artifact']
        evidence = {'case': case, 'taskId': task, 'runId': result['id'], 'status': result['status'], 'artifact': metadata, 'tools': tools}
        (DEST / 'ppt-edit-live.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
        print(json.dumps(evidence, ensure_ascii=False, indent=2))
        return
    name = 'office-presentation' if case == 'ppt' else 'table-report'
    ref = install(name)
    task = 'skills-verification-' + case + '-' + uuid.uuid4().hex[:8]
    refs = [ref]
    if case == 'ppt':
        prompt = '请用已选技能制作4页中文PPT，主题为“财务数字化工作汇报”。内容包含目标、示例进展、后续安排；示例数据明确标注：处理时长从5天缩短到3天，材料补交率从20%降至12%。直接生成完整初稿并提供可下载的pptx文件，不要只给文案，不需要再问我。'
    else:
        file = upload('费用示例.csv', '类别,金额\n交通,125.50\n餐饮,80.00\n交通,24.50\n'.encode())
        refs.append({'kind': 'file', 'id': file['id'], 'title': file['name']})
        prompt = '请使用所选表格报告技能，将附加CSV制作成可下载的Excel费用汇总报告，包含明细和按类别汇总。不要使用内置费用统计，依据本次文件生成xlsx成果。直接完成。'
    result = run(task, prompt, refs)
    artifacts = call('/artifacts?taskId=' + task)['artifacts']
    suffix = '.pptx' if case == 'ppt' else '.xlsx'
    item = next(x for x in artifacts if x['name'].endswith(suffix))
    with urllib.request.urlopen(BASE + '/artifacts/' + item['id'] + '/download') as response:
        content = response.read()
    output = DEST / (case + suffix)
    output.write_bytes(content)
    if case == 'ppt':
        from pptx import Presentation
        doc = Presentation(io.BytesIO(content))
        assert len(doc.slides) == 4
        texts = '\n'.join(shape.text for slide in doc.slides for shape in slide.shapes if shape.has_text_frame)
        assert '财务' in texts and '示例' in texts
    else:
        from openpyxl import load_workbook
        doc = load_workbook(io.BytesIO(content), data_only=True)
        assert len(doc.sheetnames) >= 2
    metadata = call('/artifacts/' + item['id'])['artifact']
    evidence = {'case': case, 'taskId': task, 'runId': result['id'], 'status': result['status'], 'artifact': metadata,
                'tools': [e['data'] for e in result['events'] if e['kind'] == 'tool'], 'output': str(output)}
    (DEST / (case + '-live.json')).write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('case', choices=['ppt', 'xlsx', 'ppt-edit'])
    main(parser.parse_args().case)
