"""Camera settings: G1_CAMERA_* env, sovrascritti da config/camera.json se presente."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "camera.json"

_BOOL_FALSE = frozenset({"0", "false", "no", "off"})


def _as_bool(val: Any, default: bool) -> bool:
    if val is None:
        return default
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() not in _BOOL_FALSE


def _as_int(val: Any, default: int) -> int:
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _as_float(val: Any, default: float) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _load_json_config() -> dict[str, Any]:
    if not _CONFIG_PATH.is_file():
        return {}
    try:
        data = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError) as err:
        print(f"[camera] config/camera.json ignorato: {err}", flush=True)
        return {}


def load_camera_settings() -> dict[str, Any]:
    """Merge: defaults ← G1_CAMERA_* env ← config/camera.json (json vince se presente)."""
    cfg: dict[str, Any] = {
        "source": "v4l",
        "device": "auto",
        "width": 640,
        "height": 480,
        "fps": 15,
        "yolo": True,
        "depth": False,
        "yolo_model": "yolov8n.onnx",
        "yolo_backend": "onnx",
        "yolo_conf": 0.35,
        "yolo_classes": None,
        "teleimager_host": "127.0.0.1",
        "teleimager_port": 60000,
        "teleimager_camera": "head",
    }
    file_cfg = _load_json_config()

    env_map = {
        "source": "G1_CAMERA_SOURCE",
        "device": "G1_CAMERA_DEVICE",
        "width": "G1_CAMERA_WIDTH",
        "height": "G1_CAMERA_HEIGHT",
        "fps": "G1_CAMERA_FPS",
        "yolo_model": "G1_YOLO_MODEL",
        "yolo_backend": "G1_YOLO_BACKEND",
        "yolo_conf": "G1_YOLO_CONF",
        "teleimager_host": "G1_TELEIMAGER_HOST",
        "teleimager_port": "G1_TELEIMAGER_PORT",
        "teleimager_camera": "G1_TELEIMAGER_CAMERA",
    }
    int_keys = {"width", "height", "fps", "teleimager_port"}
    for key, env_name in env_map.items():
        raw = os.getenv(env_name)
        if raw is not None and str(raw).strip() != "":
            cfg[key] = _as_int(raw, cfg[key]) if key in int_keys else raw.strip()

    yolo_raw = os.getenv("G1_CAMERA_YOLO")
    if yolo_raw is not None and str(yolo_raw).strip() != "":
        cfg["yolo"] = _as_bool(yolo_raw, True)

    depth_raw = os.getenv("G1_CAMERA_DEPTH")
    if depth_raw is not None and str(depth_raw).strip() != "":
        cfg["depth"] = _as_bool(depth_raw, False)

    classes_raw = os.getenv("G1_YOLO_CLASSES")
    if classes_raw is not None and str(classes_raw).strip() != "":
        cfg["yolo_classes"] = classes_raw.strip()

    if file_cfg:
        for key in cfg:
            if key in file_cfg and file_cfg[key] is not None:
                cfg[key] = file_cfg[key]
        if file_cfg.get("comment"):
            cfg["comment"] = file_cfg["comment"]
        if "yolo" in file_cfg:
            cfg["yolo"] = _as_bool(file_cfg.get("yolo"), True)
        if "depth" in file_cfg:
            cfg["depth"] = _as_bool(file_cfg.get("depth"), False)
        yc = file_cfg.get("yolo_classes")
        if yc is not None:
            cfg["yolo_classes"] = ",".join(str(c) for c in yc) if isinstance(yc, list) else str(yc)

    cfg["source"] = str(cfg.get("source") or "v4l").strip().lower()
    cfg["device"] = str(cfg.get("device") if cfg.get("device") is not None else "auto").strip()
    cfg["width"] = _as_int(cfg.get("width"), 640)
    cfg["height"] = _as_int(cfg.get("height"), 480)
    cfg["fps"] = _as_int(cfg.get("fps"), 15)
    cfg["yolo"] = _as_bool(cfg.get("yolo"), True)
    cfg["depth"] = _as_bool(cfg.get("depth"), False) and cfg["source"] == "realsense"
    cfg["yolo_conf"] = _as_float(cfg.get("yolo_conf"), 0.35)
    cfg["teleimager_host"] = str(cfg.get("teleimager_host") or "127.0.0.1").strip()
    cfg["teleimager_port"] = _as_int(cfg.get("teleimager_port"), 60000)
    cfg["teleimager_camera"] = str(cfg.get("teleimager_camera") or "head").strip().lower()
    if cfg["source"] == "teleimager":
        dev = str(cfg.get("device") or "").strip()
        if dev and dev.lower() not in ("auto", "0") and ("." in dev or dev == "localhost"):
            cfg["teleimager_host"] = dev
    cfg["config_path"] = str(_CONFIG_PATH)
    cfg["config_exists"] = _CONFIG_PATH.is_file()
    cfg["config_source"] = "camera.json" if file_cfg else "env"
    return cfg
