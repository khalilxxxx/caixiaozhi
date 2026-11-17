"""Fail-closed local skill runner using the macOS kernel sandbox.

Only task inputs/skills and interpreter dependencies are readable. All writes
are confined to work, output and tmp; no credentials or network are inherited.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time


SERVICE = Path(__file__).resolve().parent
MAX_LOG_BYTES = 128 * 1024
MAX_MEMORY_KIB = 1024 * 1024
MAX_CHILDREN = 32
MAX_WORKSPACE_BYTES = 100 * 1024 * 1024


def _quoted(path: Path | str) -> str:
    return json.dumps(str(path), ensure_ascii=False)


class LocalSkillExecutor:
    def __init__(self, env: dict[str, str] | None = None):
        # Only PATH is used to locate approved tools. No source environment
        # variable, including provider tokens, is copied into the child.
        source = os.environ if env is None else env
        search_path = source.get("PATH", os.defpath)
        self.python = SERVICE / ".venv/bin/python"
        if not self.python.is_file():
            self.python = Path(sys.executable)
        self.node = shutil.which("node", path=search_path)
        self.soffice = shutil.which("soffice", path=search_path)
        self.pdftoppm = shutil.which("pdftoppm", path=search_path)
        self.sandbox = shutil.which("sandbox-exec", path="/usr/bin:/bin")
        self._available: bool | None = None

    def environment(self) -> dict:
        supported = sys.platform == "darwin" and bool(self.sandbox)
        if self._available is None:
            self._available = False
            if supported:
                try:
                    probe = subprocess.run(
                        [self.sandbox, "-p", '(version 1)(deny default)(allow process-exec)(allow sysctl-read)(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System") (literal "/usr/bin/true"))', "/usr/bin/true"],
                        env={"PATH": "/usr/bin:/bin"}, capture_output=True, timeout=3,
                    )
                    self._available = probe.returncode == 0
                except (OSError, subprocess.TimeoutExpired):
                    pass
        result = {
            "available": self._available, "supported": supported,
            "platform": sys.platform, "isolation": "macos-sandbox-exec" if supported else None,
            "network": "disabled", "interpreters": {"python": self.python.is_file(), "node": bool(self.node), "shell": Path("/bin/sh").is_file()},
            "tools": {"soffice": bool(self.soffice), "pdftoppm": bool(self.pdftoppm)},
            "limits": {"timeoutSeconds": 120, "logBytesPerStream": MAX_LOG_BYTES, "fileBytes": 64 * 1024 * 1024, "memoryBytes": MAX_MEMORY_KIB * 1024, "processes": MAX_CHILDREN, "workspaceBytes": MAX_WORKSPACE_BYTES},
        }
        if not self._available:
            result["reason"] = "当前环境缺少可用的系统隔离，已禁用技能脚本执行。"
        return result

    def _dependency_paths(self) -> set[Path]:
        paths = {self.python.parent.parent, self.python.resolve().parent.parent, SERVICE / "skill_process.py"}
        if self.python.is_symlink():
            paths.add((self.python.parent / self.python.readlink()).parent.parent)
        node_modules = SERVICE / "skill-node/node_modules"
        if node_modules.is_dir():
            paths.add(node_modules)
        for binary in (self.node, self.soffice, self.pdftoppm):
            if not binary:
                continue
            resolved = Path(binary).resolve()
            paths.add(resolved)
            # Discover the bundled runtime root from each selected tool path;
            # never grant read access to the whole home or cache directory.
            for parent in resolved.parents:
                if parent.name == "dependencies" and (parent / "native").is_dir():
                    paths.add(parent / "native")
                    paths.add(parent / "bin/override")
                    break
        return paths

    def _profile(self, root: Path) -> str:
        readable = self._dependency_paths() | {root / "input", root / "skills", root / "work", root / "output", root / "tmp"}
        readable |= {Path(p) for p in ("/System", "/usr/lib", "/usr/share", "/usr/bin", "/bin", "/Library/Fonts", "/Library/Apple", "/private/var/db/dyld") if Path(p).exists()}
        literals = {Path(p) for p in ("/", "/dev/null", "/dev/zero", "/dev/urandom", "/dev/random", "/private/etc/localtime", "/private/etc/passwd", "/private/etc/group")}
        literals.add(root)
        literals.add(root / "node_modules")
        metadata = {root, Path("/var"), Path("/tmp"), Path("/etc")}
        for path in readable | literals:
            metadata.update(path.parents)
        read_rules = " ".join(f'({"subpath" if p not in literals and p.is_dir() else "literal"} {_quoted(p)})' for p in sorted(readable | literals))
        metadata_rules = " ".join(f'(literal {_quoted(p)})' for p in sorted(metadata))
        write_rules = " ".join(f'(subpath {_quoted(root / name)})' for name in ("work", "output", "tmp"))
        return f'''(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid) (syscall-number SYS_posix_spawn))
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow file-read* {read_rules})
(allow file-read-metadata {metadata_rules})
(allow file-write* {write_rules} (literal "/dev/null"))
'''

    def _environment(self, root: Path) -> dict[str, str]:
        path = [str(self.python.parent), "/usr/bin", "/bin"]
        for binary in (self.node, self.soffice, self.pdftoppm):
            if binary:
                path.append(str(Path(binary).parent))
        result = {"PATH": ":".join(dict.fromkeys(path)), "HOME": str(root / "tmp"), "TMPDIR": str(root / "tmp") + "/", "TMP": str(root / "tmp"), "TEMP": str(root / "tmp"), "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1", "MPLCONFIGDIR": str(root / "tmp/matplotlib"), "XDG_CACHE_HOME": str(root / "tmp/cache"), "NODE_PATH": str(SERVICE / "skill-node/node_modules")}
        if self.soffice:
            result["SOFFICE_BIN"] = self.soffice
            for dependency in self._dependency_paths():
                if dependency.name == "native":
                    candidates = list(dependency.glob("libreoffice*/libreoffice/*.app/Contents/Resources/fontconfig/fonts.conf"))
                    if candidates:
                        result["FONTCONFIG_FILE"] = str(candidates[0])
                        break
        if self.pdftoppm:
            result["PDFTOPPM_BIN"] = self.pdftoppm
        return result

    def _command(self, root: Path, script: str, args: list[str]) -> list[str]:
        path = Path(script)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise ValueError("脚本路径必须位于当前工作区。")
        if not (path.parts[0] == "work" or (len(path.parts) >= 4 and path.parts[0] == "skills" and path.parts[2] == "scripts")):
            raise ValueError("仅允许执行 skills/*/scripts/ 或 work/ 中的脚本。")
        target = root / path
        if not target.resolve().is_relative_to(root) or any(parent.is_symlink() for parent in [target, *target.parents] if parent != root.parent):
            raise ValueError("脚本路径不能包含符号链接或越出当前工作区。")
        if not target.is_file() or not stat.S_ISREG(target.stat().st_mode):
            raise ValueError("脚本文件不存在或不是普通文件。")
        if not isinstance(args, list) or len(args) > 64 or any(not isinstance(arg, str) or "\0" in arg or len(arg) > 16384 for arg in args):
            raise ValueError("脚本参数格式无效或超出限制。")
        if target.suffix == ".py":
            command = [str(self.python), "-B", "-s", str(target)]
        elif target.suffix in {".js", ".mjs", ".cjs"} and self.node:
            command = [self.node, str(target)]
        elif target.suffix == ".sh":
            command = ["/bin/sh", str(target)]
        else:
            raise ValueError("脚本类型不受支持，或所需解释器未安装。")
        return command + args

    @staticmethod
    def _kill_group(pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    @staticmethod
    async def _read(stream: asyncio.StreamReader) -> str:
        chunks, count, truncated = [], 0, False
        while chunk := await stream.read(8192):
            keep = chunk[:max(0, MAX_LOG_BYTES - count)]
            if keep:
                chunks.append(keep)
            count += len(keep)
            truncated |= len(keep) != len(chunk)
        output = b"".join(chunks).decode("utf-8", errors="replace")
        return output + ("\n[输出已截断]" if truncated else "")

    @staticmethod
    async def _process_table() -> list[tuple[int, int, int, int, int]]:
        probe = await asyncio.create_subprocess_exec(
            "/bin/ps", "-axo", "pid=,ppid=,pgid=,rss=,uid=",
            env={"PATH": "/usr/bin:/bin"}, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        output, _ = await probe.communicate()
        if probe.returncode:
            raise RuntimeError("无法读取隔离进程资源使用情况。")
        return [tuple(map(int, line.split())) for line in output.splitlines() if len(line.split()) == 5]

    @staticmethod
    def _kill_descendants(pid: int, _observed: set[int]) -> None:
        # Snapshot PIDs can exit and be reused between observations. All ways
        # of leaving this group are denied by the sandbox, so signal its PGID
        # atomically instead of ever signalling observed PIDs individually.
        LocalSkillExecutor._kill_group(pid)

    @staticmethod
    def _workspace_exceeded(root: Path) -> bool:
        """Bound a live tree without ever following script-created symlinks."""
        size = count = 0
        def visit(directory: int, depth: int) -> bool:
            nonlocal size, count
            if depth > 64:
                return True
            with os.scandir(directory) as entries:
                for entry in entries:
                    try:
                        info = entry.stat(follow_symlinks=False)
                        if stat.S_ISLNK(info.st_mode):
                            continue
                        count += 1
                        size += info.st_size if stat.S_ISREG(info.st_mode) else 0
                        if size > MAX_WORKSPACE_BYTES or count > 1000:
                            return True
                        if stat.S_ISDIR(info.st_mode):
                            child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                            try:
                                if visit(child, depth + 1):
                                    return True
                            finally:
                                os.close(child)
                    except FileNotFoundError:
                        continue
            return False
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            return visit(descriptor, 0)
        finally:
            os.close(descriptor)

    async def execute(self, workspace: Path, script: str, args: list[str], timeout: int = 60) -> dict:
        started = time.monotonic()
        def result(status: str, code=None, stdout="", stderr=""):
            return {"status": status, "exitCode": code, "stdout": stdout, "stderr": stderr, "durationMs": round((time.monotonic() - started) * 1000)}

        if not self.environment()["available"]:
            return result("unavailable", stderr="当前环境无法提供受控隔离，脚本未执行。")
        try:
            if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 120:
                raise ValueError("执行时限必须为 1 至 120 秒。")
            root = Path(workspace).resolve(strict=True)
            for directory in ("skills", "input", "work", "output", "tmp"):
                path = root / directory
                if path.is_symlink() or not path.is_dir():
                    raise ValueError("工作区目录不存在或包含符号链接。")
            command = self._command(root, script, args)
            node_modules = SERVICE / "skill-node/node_modules"
            if node_modules.is_dir():
                link = root / "node_modules"
                if link.is_symlink() and link.resolve() != node_modules.resolve():
                    raise ValueError("工作区 Node 模块路径不受信任。")
                if not link.exists():
                    link.symlink_to(node_modules, target_is_directory=True)
                elif not link.is_symlink():
                    raise ValueError("工作区 Node 模块路径必须使用受控依赖。")
        except (OSError, ValueError, TypeError) as exc:
            return result("rejected", stderr=str(exc))
        try:
            table = await self._process_table()
            process_limit = sum(row[4] == os.getuid() for row in table) + MAX_CHILDREN
            process = await asyncio.create_subprocess_exec(
                self.sandbox, "-p", self._profile(root), str(self.python), "-I", "-B", str(SERVICE / "skill_process.py"), str(timeout), str(process_limit), *command,
                cwd=root, env=self._environment(root), start_new_session=True,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
        except (OSError, RuntimeError) as exc:
            return result("unavailable", stderr=f"隔离进程无法启动：{exc}")
        stdout_task = asyncio.create_task(self._read(process.stdout))
        stderr_task = asyncio.create_task(self._read(process.stderr))
        status = "error"
        descendants: set[int] = {process.pid}
        try:
            deadline = time.monotonic() + timeout
            while process.returncode is None:
                table = await self._process_table()
                descendants = {row[0] for row in table if row[2] == process.pid}
                resident = sum(row[3] for row in table if row[0] in descendants)
                count = sum(row[0] in descendants for row in table)
                if resident > MAX_MEMORY_KIB or count > MAX_CHILDREN or self._workspace_exceeded(root):
                    status = "resource_limit"
                    break
                if time.monotonic() >= deadline:
                    status = "timeout"
                    break
                await asyncio.sleep(.05)
            else:
                status = "success" if process.returncode == 0 else "error"
        except asyncio.CancelledError:
            self._kill_descendants(process.pid, descendants)
            await process.wait()
            await asyncio.gather(stdout_task, stderr_task)
            raise
        except (OSError, RuntimeError):
            status = "error"
        finally:
            # Also reap background children after a normally exiting script.
            self._kill_descendants(process.pid, descendants)
            await process.wait()
            # SIGKILL delivery and launchd's adoption/reaping are asynchronous.
            # Wait for the group to disappear before publishing its files.
            for _ in range(30):
                try:
                    remaining = {row[0] for row in await self._process_table() if row[2] == process.pid}
                except (OSError, RuntimeError):
                    remaining = set()
                if not remaining:
                    break
                self._kill_descendants(process.pid, remaining)
                await asyncio.sleep(.01)
        stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
        return result(status, process.returncode, stdout, stderr)
