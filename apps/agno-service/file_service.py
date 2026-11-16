from pathlib import Path
import hashlib
import io
import uuid
from datetime import datetime, timezone

ALLOWED = {'.txt', '.md', '.csv', '.json', '.pdf', '.docx', '.png', '.jpg', '.jpeg', '.webp', '.xlsx', '.xls', '.zip', '.yaml', '.yml'}


def extract_text(name, content):
    suffix = Path(name).suffix.lower()
    try:
        if suffix in {'.txt', '.md', '.csv', '.json', '.yaml', '.yml'}:
            for encoding in ('utf-8-sig', 'gb18030'):
                try:
                    return content.decode(encoding)[:60000], 'parsed'
                except UnicodeDecodeError:
                    pass
            return '', '待人工核对'
        if suffix == '.pdf':
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(content))
            text = '\n'.join((page.extract_text() or '') for page in reader.pages[:60])[:60000]
            return text, 'parsed' if text.strip() else '待人工识别'
        if suffix == '.docx':
            from docx import Document
            document = Document(io.BytesIO(content))
            text = '\n'.join(p.text for p in document.paragraphs)
            text += '\n' + '\n'.join(' | '.join(c.text for c in row.cells) for table in document.tables for row in table.rows)
            return text[:60000], 'parsed'
    except Exception:
        return '', '解析失败'
    return '', '待人工识别' if suffix in {'.png', '.jpg', '.jpeg', '.webp'} else '已存储'


def save_file(store, directory, name, content_type, content):
    name = Path(name.replace('\\', '/')).name[:180] or '未命名文件'
    suffix = Path(name).suffix.lower()
    if suffix not in ALLOWED:
        raise ValueError('暂不支持该文件类型。支持文本、PDF、Word、表格、图片和技能 ZIP。')
    file_id = 'file-' + uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=True)
    storage_name = file_id + suffix
    target = directory / storage_name
    target.write_bytes(content)
    target.chmod(0o600)
    text, status = extract_text(name, content)
    metadata = {'id': file_id, 'name': name, 'size': len(content), 'type': content_type or 'application/octet-stream', 'sha256': hashlib.sha256(content).hexdigest(), 'text': text, 'status': status, 'createdAt': datetime.now(timezone.utc).isoformat()}
    store.add_file(metadata, storage_name)
    def add_material(state):
        materials = state['data'].setdefault('materials', {'files': [], 'expenses': []})
        materials.setdefault('files', []).append({**metadata, 'status': 'pending', 'extractionStatus': status, 'addedAt': metadata['createdAt'], 'batchId': 'batch-20261111', 'label': '已存储，待核对', 'kind': 'other', 'amount': None})
        materials['revision'] = materials.get('revision', 0) + 1
        materials['acknowledged'] = False
    store.mutate(add_material)
    return metadata
