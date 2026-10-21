"""Shared helpers for the amabie test suite."""

import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

AMABIE_CMD = [sys.executable, "-m", "amabie"]


def cli_env(extra=None):
    """Env for launching `python -m amabie` from a temp workspace."""
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT
    env.pop("PYTHONHOME", None)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    if extra:
        env.update(extra)
    return env


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path
