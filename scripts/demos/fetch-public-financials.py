#!/usr/bin/env python3
"""显式刷新海康威视 2025、2024 年法定年报，校验后原子发布快照。"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps' / 'agno-service'))
from financial_analytics import DOCUMENTS, SNAPSHOT_PATH, normalize_reports


def _atomic_write(target, content):
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def refresh_snapshot(user_agent='Caixiaozhi-Public-Financials/1.0'):
    payloads = {}
    for document in DOCUMENTS.values():
        request = Request(document['url'], headers={'User-Agent': user_agent, 'Accept-Encoding': 'identity'})
        with urlopen(request, timeout=45) as response:
            raw = response.read(40 * 1024 * 1024 + 1)
        if len(raw) > 40 * 1024 * 1024:
            raise ValueError('官方年报超出 40 MiB 大小限制，校验失败。')
        payloads[document['id']] = raw
    # 两份原件均通过哈希、合并报表、分币勾稽及共同年度核对后才写入。
    manifest = normalize_reports(payloads, datetime.now(timezone.utc).isoformat())
    SNAPSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
    for document in manifest['dataset']['source']['documents']:
        _atomic_write(SNAPSHOT_PATH.parent / document['rawFile'], gzip.compress(payloads[document['id']], mtime=0))
    # 原件使用不可变哈希文件名，最后一次原子替换 manifest 发布完整版本。
    _atomic_write(SNAPSHOT_PATH, (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    return {'snapshot': str(SNAPSHOT_PATH), 'datasetVersion': manifest['dataset']['version'],
            'documents': [{'id': doc['id'], 'sha256': doc['sha256']} for doc in manifest['dataset']['source']['documents']],
            'retrievedAt': manifest['dataset']['source']['retrievedAt']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', required=True, help='从巨潮资讯固定官方地址重新获取两份年报')
    parser.add_argument('--user-agent', default='Caixiaozhi-Public-Financials/1.0', help='可选 HTTP 请求标识')
    args = parser.parse_args()
    print(json.dumps(refresh_snapshot(args.user_agent), ensure_ascii=False))


if __name__ == '__main__':
    main()
