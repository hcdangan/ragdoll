"""Vercel Python entrypoint.

`api/index.py` is Vercel's conventional location for a Python function inside a
project that also contains a Next.js app: the platform auto-detects a module-level
ASGI object here, so no service declaration is needed. `vercel.json` exposes it at
`/engine/*` with a rewrite, so the public path does not leak the internal location.

`api/` is deliberately *not* a Python package — there is no `__init__.py` — because
Vercel loads this file as a top-level module with the project root on `sys.path`.
The engine's modules therefore sit flat in `api/`, and this file puts that directory
on the path so `main` resolves as a plain sibling module.
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from main import app  # noqa: E402  (the path insert above must run first)

__all__ = ["app"]
