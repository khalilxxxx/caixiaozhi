#!/usr/bin/env python3
"""Start/stop only the processes owned by this local Demo launcher."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.runtime' / 'agno-local'
MANIFEST = RUNTIME / 'processes.json'
SERVICE = ROOT / 'apps' / 'agno-service'
PYTHON = SERVICE / '.venv' / 'bin' / 'python'


def read_json(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return json.load(response)
    except Exception:
        return None


def web_ready():
    try:
        with urllib.request.urlopen('http://127.0.0.1:5190/agent.html', timeout=2) as response:
            return b'agent-workspace' in response.read()
    except Exception:
        return False


def state():
    try:
        return json.loads(MANIFEST.read_text())
    except Exception:
        return {}


def start():
    RUNTIME.mkdir(parents=True, exist_ok=True)
    os.chmod(RUNTIME, 0o700)
    if not PYTHON.exists():
        subprocess.run(['uv', 'sync', '--project', str(SERVICE), '--python', '3.12', '--frozen'], cwd=ROOT, check=True)
    owned = state()
    services = []
    if not read_json('http://127.0.0.1:5191/api/local/health'):
        services.append(('api', [str(PYTHON), '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '5191'], SERVICE))
    if not web_ready():
        node = ROOT / 'node_modules' / '.bin' / 'node'
        services.append(('web', [str(node) if node.exists() else 'node', str(ROOT / 'apps/web/node_modules/vite/bin/vite.js'), '--config', str(ROOT/'apps/web/vite.agent.config.ts')], ROOT))
    for name, command, cwd in services:
        with (RUNTIME / (name + '.log')).open('ab') as log:
            process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        owned[name] = process.pid
    MANIFEST.write_text(json.dumps(owned))
    for _ in range(80):
        health = read_json('http://127.0.0.1:5190/api/local/health')
        if health and health.get('framework') == 'Agno' and web_ready():
            print('财小智已启动：http://127.0.0.1:5190/agent.html#home')
            print('Agno ' + health['version'] + ' · 模型 ' + health['model'] + (' · 配置就绪' if health['modelConfigured'] else ' · 尚未配置密钥'))
            return
        time.sleep(0.25)
    print('启动未完成，请检查 .runtime/agno-local/api.log 与 web.log。', file=sys.stderr)
    raise SystemExit(1)


def stop():
    owned = state()
    for name, pid in owned.items():
        try:
            command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True)
            if 'uvicorn server:app' in command or 'vite.agent.config.ts' in command:
                os.kill(pid, signal.SIGTERM)
                for _ in range(80):
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        break
                    time.sleep(0.1)
                print('已停止本次启动器管理的 ' + name)
        except (ProcessLookupError, subprocess.CalledProcessError):
            pass
    MANIFEST.write_text('{}')


def status():
    direct = read_json('http://127.0.0.1:5191/api/local/health')
    proxied = read_json('http://127.0.0.1:5190/api/local/health')
    print(json.dumps({'api': direct, 'webProxy': proxied, 'web': web_ready()}, ensure_ascii=False, indent=2))
    if not direct or not proxied:
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='财小智本地 Demo 服务管理')
    parser.add_argument('action', choices=['start', 'stop', 'status'], default='start', nargs='?')
    args = parser.parse_args()
    {'start': start, 'stop': stop, 'status': status}[args.action]()
