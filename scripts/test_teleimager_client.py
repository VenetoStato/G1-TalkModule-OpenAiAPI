#!/usr/bin/env python3
"""Test teleimager ZMQ (senza pacchetto teleimager, Python 3.11 ok)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

host = (os.getenv("G1_TELEIMAGER_HOST") or "127.0.0.1").strip()
port = int((os.getenv("G1_TELEIMAGER_PORT") or "60000").strip())
cam = (os.getenv("G1_TELEIMAGER_CAMERA") or "head").strip()

from talk_module.teleimager_zmq import TeleimagerZmqClient  # noqa: E402

print(f"Test teleimager ZMQ {host}:{port} camera={cam}")
client = TeleimagerZmqClient(host=host, request_port=port, camera=cam)
try:
    client.connect(wait_frame_s=8.0)
    bgr = client.get_bgr()
    print(f"OK frame shape={bgr.shape if bgr is not None else None}")
except Exception as err:
    print(f"FAIL: {err}")
    raise SystemExit(1) from err
finally:
    client.close()
