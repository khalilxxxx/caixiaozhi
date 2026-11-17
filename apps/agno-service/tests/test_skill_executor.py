"""Real local sandbox regressions; never substitute a bare subprocess."""
import asyncio
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest


def executor():
    assert importlib.util.find_spec("skill_executor") is not None, "受限执行器尚未实现"
    from skill_executor import LocalSkillExecutor
    return LocalSkillExecutor()


@pytest.fixture
def workspace(tmp_path):
    root = tmp_path / "task"
    for directory in ("skills/demo/scripts", "input", "work", "output", "tmp"):
        (root / directory).mkdir(parents=True)
    return root


def run_script(workspace, source, *, suffix=".py", timeout=10):
    script = workspace / ("skills/demo/scripts/main" + suffix)
    script.write_text(source)
    return asyncio.run(executor().execute(workspace, str(script.relative_to(workspace)), [], timeout))


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_python_executes_and_writes_only_task_output(workspace):
    (workspace / "input/in.txt").write_text("hello")
    result = run_script(workspace, "from pathlib import Path\np=Path('input/in.txt').read_text()\nPath('output/out.txt').write_text(p)\nprint(p)\n")
    assert result["status"] == "success", result
    assert result["exitCode"] == 0
    assert result["stdout"].strip() == "hello"
    assert (workspace / "output/out.txt").read_text() == "hello"


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_secrets_network_and_readonly_task_files_are_denied(workspace, tmp_path, monkeypatch):
    secret = tmp_path / "outside-secret"
    secret.write_text("private-fixture")
    (workspace / "input/read-only").write_text("original")
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-must-not-be-inherited")
    source = f'''import os, socket
from pathlib import Path
assert "OPENAI_API_KEY" not in os.environ
for path in [{str(secret)!r}, str(Path.home().parent / ".env")]:
    try:
        Path(path).read_text()
    except (PermissionError, FileNotFoundError):
        pass
    else:
        raise AssertionError("outside read permitted")
try:
    Path("input/read-only").write_text("changed")
except PermissionError:
    pass
else:
    raise AssertionError("readonly write permitted")
try:
    socket.create_connection(("127.0.0.1", 9), timeout=1)
except PermissionError:
    pass
else:
    raise AssertionError("network permitted")
print("denied")
'''
    result = run_script(workspace, source)
    assert result["status"] == "success", result
    assert result["stdout"].strip() == "denied"
    assert (workspace / "input/read-only").read_text() == "original"


@pytest.mark.parametrize("path", ["../outside.py", "/tmp/outside.py", "input/main.py", "skills/demo/main.py", "work/program.exe"])
def test_rejects_script_paths_outside_allowed_roots(workspace, path):
    result = asyncio.run(executor().execute(workspace, path, []))
    assert result["status"] in {"rejected", "unavailable"}
    assert result["exitCode"] is None


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_timeout_kills_child_process_group(workspace):
    result = run_script(workspace, "import subprocess, sys, time\nfrom pathlib import Path\np=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])\nPath('output/child.pid').write_text(str(p.pid))\ntime.sleep(60)\n", timeout=1)
    assert result["status"] == "timeout", result
    pid = int((workspace / "output/child.pid").read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_cancellation_kills_child_process_group(workspace):
    path = workspace / "work/sleep.py"
    path.write_text("import subprocess, sys, time\nfrom pathlib import Path\np=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])\nPath('output/child.pid').write_text(str(p.pid))\ntime.sleep(60)\n")

    async def exercise():
        task = asyncio.create_task(executor().execute(workspace, "work/sleep.py", [], 30))
        for _ in range(100):
            if (workspace / "output/child.pid").exists():
                break
            await asyncio.sleep(.03)
        assert (workspace / "output/child.pid").exists()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(exercise())
    pid = int((workspace / "output/child.pid").read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_python_can_import_local_helper_and_office_packages(workspace):
    (workspace / "skills/demo/scripts/helper.py").write_text("message = '本地技能'\n")
    result = run_script(workspace, "from helper import message\nfrom pptx import Presentation\nfrom openpyxl import Workbook\nfrom PIL import Image\nprint(message)\n")
    assert result["status"] == "success", result
    assert result["stdout"].strip() == "本地技能"


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
@pytest.mark.parametrize("suffix,source", [
    (".js", "const fs=require('fs');const PptxGenJS=require('pptxgenjs');fs.writeFileSync('output/node.txt', 'node');console.log(typeof PptxGenJS);"),
    (".mjs", "import PptxGenJS from 'pptxgenjs';import fs from 'node:fs';fs.writeFileSync('output/node.txt', 'node');console.log(typeof PptxGenJS);"),
    (".sh", "printf shell > output/node.txt; printf function"),
])
def test_node_modules_esm_and_shell(workspace, suffix, source):
    result = run_script(workspace, source, suffix=suffix)
    assert result["status"] == "success", result
    assert result["stdout"].strip() == "function"
    assert (workspace / "output/node.txt").is_file()


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_success_cleans_background_children_and_prevents_detachment(workspace):
    result = run_script(workspace, "import subprocess, sys\nfrom pathlib import Path\np=subprocess.Popen([sys.executable, '-c', 'import os,time;os.setsid();time.sleep(60)'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nPath('output/child.pid').write_text(str(p.pid))\n")
    assert result["status"] == "success", result
    pid = int((workspace / "output/child.pid").read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_normal_exit_also_kills_background_children(workspace):
    result = run_script(workspace, "import subprocess, sys\nfrom pathlib import Path\np=subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nPath('output/child.pid').write_text(str(p.pid))\n")
    assert result["status"] == "success", result
    pid = int((workspace / "output/child.pid").read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_output_is_bounded_without_deadlocking(workspace):
    result = run_script(workspace, "import sys\nsys.stdout.write('a'*2000000)\nsys.stderr.write('b'*2000000)\n")
    assert result["status"] == "success", result
    assert len(result["stdout"]) < 140000
    assert len(result["stderr"]) < 140000
    assert "输出已截断" in result["stdout"]


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_office_conversion_uses_controlled_tools_and_fonts(workspace):
    if not executor().environment()["tools"]["soffice"]:
        pytest.skip("未安装本地文档转换工具")
    result = run_script(workspace, '''import os, subprocess
from pathlib import Path
from pptx import Presentation
deck=Presentation()
slide=deck.slides.add_slide(deck.slide_layouts[1])
slide.shapes.title.text="业务汇报"
deck.save("output/demo.pptx")
assert Path(os.environ["FONTCONFIG_FILE"]).is_file()
subprocess.run([os.environ["SOFFICE_BIN"], "-env:UserInstallation=" + (Path.cwd()/"tmp/lo").as_uri(), "--headless", "--convert-to", "pdf", "--outdir", "output", "output/demo.pptx"], check=True, timeout=20)
assert Path("output/demo.pdf").is_file()
subprocess.run([os.environ["PDFTOPPM_BIN"], "-scale-to", "480", "-png", "-singlefile", "output/demo.pdf", "output/preview"], check=True, timeout=10)
assert Path("output/preview.png").is_file()
''', timeout=40)
    assert result["status"] == "success", result
    assert (workspace / "output/preview.png").stat().st_size > 100


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_posix_spawn_cannot_escape_the_process_group(workspace):
    result = run_script(workspace, '''import os, sys
from pathlib import Path
try:
    pid=os.posix_spawn(sys.executable, [sys.executable, "-c", "import time;time.sleep(60)"], os.environ, setpgroup=0)
except PermissionError:
    print("denied")
else:
    Path("output/detached.pid").write_text(str(pid))
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    raise AssertionError("posix_spawn绕过了进程组限制")
''')
    assert result["status"] == "success", result
    assert result["stdout"].strip() == "denied"


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_memory_limit_stops_large_allocations(workspace, monkeypatch):
    import skill_executor
    monkeypatch.setattr(skill_executor, "MAX_MEMORY_KIB", 64 * 1024)
    result = run_script(workspace, "import time\ndata=bytearray(96*1024*1024)\ntime.sleep(10)\n")
    assert result["status"] == "resource_limit", result


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_single_file_size_is_limited(workspace):
    result = run_script(workspace, "with open('output/oversize.bin','wb') as f:\n for i in range(65): f.write(bytes(1024*1024))\n")
    assert result["status"] == "error", result
    assert (workspace / "output/oversize.bin").stat().st_size <= 64 * 1024 * 1024


def test_unsupported_platform_refuses_execution_without_fallback(workspace, monkeypatch):
    import skill_executor
    monkeypatch.setattr(skill_executor.sys, "platform", "linux")
    script = workspace / "work/never.py"
    script.write_text("from pathlib import Path\nPath('output/unsafe').write_text('unsafe')")
    local = executor()
    assert local.environment()["available"] is False
    result = asyncio.run(local.execute(workspace, "work/never.py", []))
    assert result["status"] == "unavailable"
    assert not (workspace / "output/unsafe").exists()


def test_symlink_script_is_rejected(workspace, tmp_path):
    source = tmp_path / "escape.py"
    source.write_text("print('escape')")
    (workspace / "work/link.py").symlink_to(source)
    result = asyncio.run(executor().execute(workspace, "work/link.py", []))
    assert result["status"] in {"rejected", "unavailable"}


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 隔离测试")
def test_workspace_quota_is_enforced_while_script_is_running(workspace):
    result = run_script(workspace, "import time\nfrom pathlib import Path\nfor n in range(6):\n Path(f'output/chunk{n}').write_bytes(bytes(20*1024*1024))\ntime.sleep(10)\n")
    assert result["status"] == "resource_limit", result


@pytest.mark.skipif(sys.platform != "darwin", reason="真实 macOS 进程组边界")
def test_cleanup_never_kills_a_pid_reused_in_another_group():
    from skill_executor import LocalSkillExecutor
    own = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    unrelated = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    try:
        LocalSkillExecutor._kill_descendants(own.pid, {own.pid, unrelated.pid})
        own.wait(timeout=2)
        time.sleep(.03)
        assert unrelated.poll() is None, "不能按可能已复用的历史 PID 杀掉其他进程组"
    finally:
        for process in (own, unrelated):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=2)
