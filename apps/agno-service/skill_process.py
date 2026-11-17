"""Trusted exec bootstrap: set limits without preexec_fn in the ASGI process."""
from __future__ import annotations

import os
import resource
import sys


def main() -> None:
    timeout = int(sys.argv[1])
    process_limit = int(sys.argv[2])
    command = sys.argv[3:]
    if not command:
        raise SystemExit("缺少受限执行命令")
    for kind, value in (
        (resource.RLIMIT_CORE, 0),
        (resource.RLIMIT_CPU, timeout + 1),
        (resource.RLIMIT_FSIZE, 64 * 1024 * 1024),
        (resource.RLIMIT_NOFILE, 128),
        (resource.RLIMIT_NPROC, process_limit),
    ):
        _, hard = resource.getrlimit(kind)
        limit = value if hard == resource.RLIM_INFINITY else min(value, hard)
        resource.setrlimit(kind, (limit, limit))
    # Darwin does not enforce RLIMIT_AS/RSS reliably. The parent additionally
    # monitors aggregate resident memory and child count instead.
    os.execve(command[0], command, dict(os.environ))


if __name__ == "__main__":
    main()
