#!/bin/zsh
set -e
cd "$(dirname "$0")/../.."
python3 scripts/demos/agno-local.py start
open 'http://127.0.0.1:5190/agent.html#home'
