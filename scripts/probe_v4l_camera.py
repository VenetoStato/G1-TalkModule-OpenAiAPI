#!/usr/bin/env python3
"""Probe V4L2 sul Jetson: quale /dev/video* apre e manda frame."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from talk_module.v4l_probe import probe_v4l_devices, v4l_capture_indices  # noqa: E402


def main() -> int:
    print("Indici cattura (sysfs):", v4l_capture_indices())
    found, report = probe_v4l_devices()
    print(json.dumps({"selected": found, "devices": report}, indent=2))
    return 0 if found else 1


if __name__ == "__main__":
    raise SystemExit(main())
