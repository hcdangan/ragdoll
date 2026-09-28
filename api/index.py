"""Vercel Python entrypoint.

Vercel looks for a module-level ASGI object in `api/index.py` (or `app.py`,
`main.py`, `server.py`, `wsgi.py`, `asgi.py` at the root, `src/` or `app/`), and
this file is the one it will pick up for the `ragdoll-engine` service declared in
`vercel.json`. It simply re-exports the application built by `app.main`.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Vercel executes this file as a top-level module, so the package root has to be
# importable before `app` can be resolved.
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.main import app  # noqa: E402  (path setup must run first)

__all__ = ["app"]
