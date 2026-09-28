"""Dumps `openapi.json` for the type-sync job.

Run with the engine importable::

    python api/tools/export_openapi.py

CI then runs `openapi-typescript` over the result and diffs it against
`web/src/lib/pipeline/api-schema.d.ts`; a mismatch fails the build so a schema
change cannot ship without its generated types.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.main import app  # noqa: E402  (path setup must run first)


def main() -> int:
    """Writes the OpenAPI document next to the app package."""

    document = app.openapi()
    destination = ROOT / "openapi.json"
    destination.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {destination} ({len(document.get('paths', {}))} paths)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
