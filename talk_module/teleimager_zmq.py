"""Client ZMQ minimo per teleimager (Python 3.11+, senza pacchetto teleimager)."""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np

_CAMERA_KEYS = {
    "head": "head_camera",
    "left_wrist": "left_wrist_camera",
    "right_wrist": "right_wrist_camera",
}

_DEFAULT_CONFIG_PATHS = (
    "/home/unitree/unitree_eai_environment/service/teleimager/cam_config_server.yaml",
    "/home/unitree/unitree_eai_environment/service/teleimager/cam_config_client.yaml",
    str(Path.home() / "teleimager" / "cam_config_server.yaml"),
)


def _load_yaml_config() -> Optional[dict[str, Any]]:
    try:
        import yaml  # type: ignore
    except ImportError:
        yaml = None  # type: ignore
    paths = list(_DEFAULT_CONFIG_PATHS)
    extra = (os.getenv("G1_TELEIMAGER_CONFIG") or "").strip()
    if extra:
        paths.insert(0, extra)
    for path in paths:
        if not path or not os.path.isfile(path):
            continue
        try:
            if yaml is not None:
                data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
            else:
                import json

                # fallback molto grezzo: non ideale senza pyyaml
                data = None
            if isinstance(data, dict):
                print(f"[teleimager_zmq] config da {path}", flush=True)
                return data
        except Exception as err:
            print(f"[teleimager_zmq] yaml {path}: {err}", flush=True)
    return None


def fetch_teleimager_config(host: str, request_port: int = 60000) -> dict[str, Any]:
    """REQ ZMQ GET_DATA → JSON cam_config (come ImageClient teleimager)."""
    try:
        import zmq  # type: ignore
    except ImportError as err:
        raise RuntimeError(f"pyzmq mancante: {err}") from err

    ctx = zmq.Context.instance()
    sock = ctx.socket(zmq.REQ)
    sock.setsockopt(zmq.LINGER, 0)
    sock.connect(f"tcp://{host}:{request_port}")
    poller = zmq.Poller()
    poller.register(sock, zmq.POLLIN)
    try:
        sock.send(b"GET_DATA")
        events = dict(poller.poll(2500))
        if sock in events and events[sock] == zmq.POLLIN:
            data = sock.recv_json()
            if isinstance(data, dict):
                print(f"[teleimager_zmq] config da {host}:{request_port}", flush=True)
                return data
    except Exception as err:
        print(f"[teleimager_zmq] REQ {host}:{request_port} fallita: {err}", flush=True)
    finally:
        sock.close()

    local = _load_yaml_config()
    if local:
        return local
    raise RuntimeError(
        f"Config teleimager non raggiungibile su {host}:{request_port} e yaml locale assente"
    )


class TeleimagerZmqClient:
    """Sottoscrive JPEG da teleimager-server e decodifica in BGR."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        request_port: int = 60000,
        camera: str = "head",
    ) -> None:
        self.host = host.strip()
        self.request_port = int(request_port)
        self.camera = (camera or "head").strip().lower()
        self._cam_key = _CAMERA_KEYS.get(self.camera, "head_camera")
        self._zmq_port = 0
        self._context: Any = None
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._latest_bgr: Optional[np.ndarray] = None
        self._config: dict[str, Any] = {}

    def connect(self, wait_frame_s: float = 6.0) -> None:
        self._config = fetch_teleimager_config(self.host, self.request_port)
        cam = self._config.get(self._cam_key) or {}
        if not cam.get("enable_zmq", True):
            raise RuntimeError(f"{self._cam_key}: ZMQ disabilitato in teleimager config")
        self._zmq_port = int(cam.get("zmq_port") or 0)
        if self._zmq_port <= 0:
            raise RuntimeError(f"{self._cam_key}: zmq_port mancante in config teleimager")

        import zmq  # type: ignore

        self._context = zmq.Context.instance()
        self._running = True
        self._thread = threading.Thread(target=self._recv_loop, name="teleimager-zmq", daemon=True)
        self._thread.start()

        deadline = time.time() + max(wait_frame_s, 1.0)
        while time.time() < deadline:
            if self.get_bgr() is not None:
                print(
                    f"[teleimager_zmq] OK {self._cam_key} da {self.host}:{self._zmq_port}",
                    flush=True,
                )
                return
            time.sleep(0.15)
        raise RuntimeError(
            f"Nessun frame da {self.host}:{self._zmq_port} ({self._cam_key}) entro {wait_frame_s}s"
        )

    def _recv_loop(self) -> None:
        import cv2  # type: ignore
        import zmq  # type: ignore

        sock = self._context.socket(zmq.SUB)
        sock.setsockopt(zmq.CONFLATE, 1)
        sock.setsockopt(zmq.RCVHWM, 1)
        sock.setsockopt(zmq.LINGER, 0)
        sock.connect(f"tcp://{self.host}:{self._zmq_port}")
        sock.setsockopt_string(zmq.SUBSCRIBE, "")
        poller = zmq.Poller()
        poller.register(sock, zmq.POLLIN)
        try:
            while self._running:
                events = dict(poller.poll(300))
                if sock not in events:
                    continue
                try:
                    jpg = sock.recv(flags=zmq.NOBLOCK)
                except Exception:
                    jpg = sock.recv()
                if not jpg:
                    continue
                bgr = cv2.imdecode(np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_COLOR)
                if bgr is None or bgr.size == 0:
                    continue
                with self._lock:
                    self._latest_bgr = bgr
        finally:
            try:
                sock.close()
            except Exception:
                pass

    def get_bgr(self) -> Optional[np.ndarray]:
        with self._lock:
            if self._latest_bgr is None:
                return None
            return self._latest_bgr.copy()

    def close(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None
