"""Camera integrata G1 (V4L2 / RealSense) con overlay YOLO per stream MJPEG."""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Optional

import numpy as np

from talk_module.camera_config import load_camera_settings
from talk_module.v4l_probe import probe_v4l_devices, try_open_v4l, v4l_capture_indices

_lock = threading.Lock()
_service: Optional["CameraYoloService"] = None


def _probe_v4l_device(preferred: str, *, width: int = 640, height: int = 480, fps: int = 15) -> str:
    preferred = (preferred or "auto").strip()
    found, report = probe_v4l_devices(width=width, height=height, fps=fps, preferred=preferred)
    if found:
        print(f"[camera] V4L2 auto-rilevata: /dev/video{found}", flush=True)
        return found
    tried = ", ".join(f"/dev/video{r['device']}" for r in report[:6]) or "(nessuno)"
    print(f"[camera] probe V4L2 fallito, provati: {tried}", flush=True)
    return "auto"


class CameraYoloService:
    def __init__(self) -> None:
        settings = load_camera_settings()
        self.source = settings["source"]
        self.device = settings["device"]
        self.model_name = settings["yolo_model"]
        self.yolo_backend = settings["yolo_backend"]
        self.width = settings["width"]
        self.height = settings["height"]
        self.fps = settings["fps"]
        self.conf = settings["yolo_conf"]
        self.yolo_enabled = settings["yolo"]
        self.depth_enabled = settings["depth"]
        self.config_source = settings.get("config_source") or "env"
        self.config_path = settings.get("config_path")
        self.teleimager_host = settings.get("teleimager_host") or "127.0.0.1"
        self.teleimager_port = int(settings.get("teleimager_port") or 60000)
        self.teleimager_camera = settings.get("teleimager_camera") or "head"
        raw_classes = settings.get("yolo_classes") or ""
        self.yolo_classes: Optional[set[str]] = (
            {c.strip().lower() for c in str(raw_classes).split(",") if c.strip()} if raw_classes else None
        )
        print(
            f"[camera] config source={self.config_source} camera={self.source} device={self.device!r}",
            flush=True,
        )

        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._backend: Any = None
        self._backend_kind = ""
        self._align: Any = None
        self._yolo: Any = None
        self._yolo_backend_loaded = ""
        self._yolo_error: Optional[str] = None
        self._open_error: Optional[str] = None
        self._probe_report: list[dict[str, Any]] = []
        self._teleimager_getter: Any = None
        self._latest_jpeg: Optional[bytes] = None
        self._latest_ts = 0.0
        self._frame_count = 0
        self._detections: list[dict[str, Any]] = []
        self._fps_measured = 0.0

    def status(self) -> dict[str, Any]:
        with _lock:
            return {
                "running": self._running,
                "source": self.source,
                "device": self.device,
                "backend": self._backend_kind or None,
                "yolo_enabled": self.yolo_enabled,
                "yolo_model": self.model_name if self.yolo_enabled else None,
                "yolo_backend": self.yolo_backend if self.yolo_enabled else None,
                "yolo_loaded": self._yolo is not None,
                "yolo_backend_loaded": self._yolo_backend_loaded or None,
                "yolo_error": self._yolo_error,
                "depth_enabled": self.depth_enabled and self.source == "realsense",
                "yolo_classes": sorted(self.yolo_classes) if self.yolo_classes else None,
                "open_error": self._open_error,
                "frame_count": self._frame_count,
                "fps": round(self._fps_measured, 1),
                "resolution": f"{self.width}x{self.height}",
                "detections": list(self._detections),
                "has_frame": self._latest_jpeg is not None,
                "config_source": self.config_source,
                "config_path": self.config_path,
                "probe_report": list(self._probe_report[:8]),
            }

    def start(self) -> None:
        with _lock:
            if self._running:
                return
            self._running = True
        self._thread = threading.Thread(target=self._loop, name="camera-yolo", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with _lock:
            self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None
        self._close_backend()

    def get_jpeg(self) -> Optional[bytes]:
        with _lock:
            return self._latest_jpeg

    def _close_backend(self) -> None:
        backend = self._backend
        kind = self._backend_kind
        self._backend = None
        self._backend_kind = ""
        self._align = None
        if not backend:
            return
        try:
            if kind == "v4l" or (kind and str(kind).startswith("v4l")):
                backend.release()
            elif kind == "realsense":
                backend.stop()
            elif kind == "teleimager":
                if hasattr(backend, "close"):
                    backend.close()
        except Exception:
            pass

    def _try_open_teleimager(self) -> bool:
        host = self.teleimager_host
        port = self.teleimager_port
        cam = self.teleimager_camera
        client: Any = None
        try:
            from talk_module.teleimager_zmq import TeleimagerZmqClient

            client = TeleimagerZmqClient(host=host, request_port=port, camera=cam)
            client.connect(wait_frame_s=8.0)
            self._backend = client
            self._teleimager_getter = client.get_bgr
            self._backend_kind = "teleimager"
            self._open_error = None
            self.device = f"teleimager@{host}:{cam}"
            print(f"[camera] teleimager ZMQ {cam} da {host}:{port}", flush=True)
            return True
        except Exception as err:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass
            # Fallback pacchetto teleimager (Python <3.11)
            try:
                from teleimager.image_client import ImageClient  # type: ignore

                client = ImageClient(host=host, request_port=port, request_bgr=True)
                getter = {
                    "head": client.get_head_frame,
                    "left_wrist": client.get_left_wrist_frame,
                    "right_wrist": client.get_right_wrist_frame,
                }.get(cam, client.get_head_frame)
                frame = None
                for _ in range(40):
                    frame = getter()
                    if frame is not None and getattr(frame, "bgr", None) is not None:
                        break
                    time.sleep(0.15)
                if frame is None or frame.bgr is None:
                    client.close()
                    raise RuntimeError("nessun frame dal pacchetto teleimager")
                self._backend = client
                self._teleimager_getter = lambda: getter().bgr if getter() else None
                self._backend_kind = "teleimager"
                self._open_error = None
                self.device = f"teleimager@{host}:{cam}"
                return True
            except ImportError:
                pass
            except Exception as pkg_err:
                err = pkg_err
            self._open_error = f"teleimager {host}:{port} ({cam}): {err}"
            print(f"[camera] {self._open_error}", flush=True)
            return False

    def _open_v4l(self) -> bool:
        preferred = str(self.device).strip() or "auto"
        found, report = probe_v4l_devices(
            width=self.width,
            height=self.height,
            fps=self.fps,
            preferred=preferred,
        )
        if not found:
            self._probe_report = report
            if self._try_open_teleimager():
                return True
            tried = ", ".join(f"/dev/video{r['device']}" for r in report[:8]) or "nessuno"
            self._open_error = f"V4L2: nessuna camera ({tried}). Configura source=teleimager in camera.json"
            return False

        self._probe_report = report
        cap, err, mode = try_open_v4l(found, width=self.width, height=self.height, fps=self.fps)
        if cap is None:
            self._open_error = f"V4L2: {err}"
            print(f"[camera] {self._open_error}", flush=True)
            if not self._try_open_teleimager():
                return False
            return True

        self.device = found
        self._backend = cap
        self._backend_kind = "v4l" + (f"-{mode}" if mode else "")
        self._open_error = None
        print(f"[camera] V4L2 device=/dev/video{self.device}", flush=True)
        return True

    def _open_realsense(self) -> bool:
        try:
            import pyrealsense2 as rs  # type: ignore

            pipeline = rs.pipeline()
            config = rs.config()
            config.enable_stream(
                rs.stream.color, self.width, self.height, rs.format.bgr8, self.fps
            )
            use_depth = self.depth_enabled
            if use_depth:
                config.enable_stream(
                    rs.stream.depth, self.width, self.height, rs.format.z16, self.fps
                )
            pipeline.start(config)
            self._backend = pipeline
            self._backend_kind = "realsense"
            self._align = rs.align(rs.stream.color) if use_depth else None
            print(
                f"[camera] RealSense avviata (depth={'on' if use_depth else 'off'})",
                flush=True,
            )
            return True
        except Exception as e:
            self._open_error = f"RealSense: {e}"
            print(f"[camera] RealSense non disponibile: {e}", flush=True)
            return False

    def _open_backend(self) -> bool:
        self._close_backend()
        self._open_error = None
        if self.source == "teleimager":
            return self._try_open_teleimager()
        if self.source == "realsense":
            if self._open_realsense():
                return True
            print("[camera] RealSense fallita → fallback V4L2", flush=True)
            if str(self.device).strip().lower() == "auto":
                self.device = _probe_v4l_device("auto", width=self.width, height=self.height, fps=self.fps)
        return self._open_v4l()

    def _read_frame_bgr(self) -> tuple[Optional[np.ndarray], Optional[np.ndarray]]:
        if self._backend_kind == "realsense":
            try:
                frames = self._backend.wait_for_frames(timeout_ms=500)
                if self._align is not None:
                    frames = self._align.process(frames)
                color = frames.get_color_frame()
                if not color:
                    return None, None
                bgr = np.asanyarray(color.get_data())
                depth_mm: Optional[np.ndarray] = None
                if self._align is not None:
                    depth = frames.get_depth_frame()
                    if depth:
                        depth_mm = np.asanyarray(depth.get_data())
                return bgr, depth_mm
            except Exception:
                return None, None
        if self._backend_kind == "teleimager":
            try:
                if hasattr(self._backend, "get_bgr"):
                    bgr = self._backend.get_bgr()
                else:
                    getter = self._teleimager_getter or self._backend.get_head_frame
                    frame = getter()
                    bgr = frame.bgr if frame is not None else None
                if bgr is None:
                    return None, None
                return bgr.copy() if hasattr(bgr, "copy") else bgr, None
            except Exception:
                return None, None
        try:
            import cv2  # type: ignore

            ok, frame = self._backend.read()
            if not ok or frame is None:
                return None, None
            return frame, None
        except Exception:
            return None, None

    @staticmethod
    def _bbox_depth_m(depth_mm: np.ndarray, bbox: list[int]) -> Optional[float]:
        x, y, w, h = bbox
        h_img, w_img = depth_mm.shape[:2]
        x1 = max(0, min(w_img - 1, x))
        y1 = max(0, min(h_img - 1, y))
        x2 = max(x1 + 1, min(w_img, x + w))
        y2 = max(y1 + 1, min(h_img, y + h))
        roi = depth_mm[y1:y2, x1:x2]
        valid = roi[(roi > 0) & (roi < 12000)]
        if valid.size < 10:
            return None
        return round(float(np.median(valid)) / 1000.0, 2)

    @staticmethod
    def _overlay_depth(frame: np.ndarray, dets: list[dict[str, Any]]) -> np.ndarray:
        import cv2  # type: ignore

        for d in dets:
            dm = d.get("depth_m")
            bbox = d.get("bbox")
            if dm is None or not bbox:
                continue
            x, y, w, h = bbox
            y_txt = min(frame.shape[0] - 4, y + h + 18)
            cv2.putText(
                frame,
                f"{dm:.2f}m",
                (x, y_txt),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (80, 200, 255),
                2,
                cv2.LINE_AA,
            )
        return frame

    def _resolve_model_path(self) -> Path:
        from pathlib import Path

        name = self.model_name
        if name.endswith(".pt"):
            name = name[:-3] + ".onnx"
        p = Path(name)
        if p.is_file():
            return p
        return Path(__file__).resolve().parent.parent / "config" / "models" / Path(name).name

    def _ensure_yolo(self) -> None:
        if not self.yolo_enabled or self._yolo is not None or self._yolo_error:
            return
        if self.yolo_backend == "ultralytics":
            try:
                from ultralytics import YOLO  # type: ignore

                self._yolo = YOLO(self.model_name)
                self._yolo_backend_loaded = "ultralytics"
                print(f"[camera] YOLO ultralytics: {self.model_name}", flush=True)
            except Exception as e:
                self._yolo_error = str(e)
                print(f"[camera] ultralytics non disponibile: {e}", flush=True)
            return
        try:
            from talk_module.yolo_onnx import YoloOnnxDetector, ensure_onnx_model

            path = ensure_onnx_model(self._resolve_model_path())
            self._yolo = YoloOnnxDetector(path, conf=self.conf, class_filter=self.yolo_classes)
            self._yolo_backend_loaded = "onnx"
            print(f"[camera] YOLO ONNX: {path}", flush=True)
        except Exception as e:
            self._yolo_error = str(e)
            print(f"[camera] YOLO ONNX non disponibile: {e}", flush=True)

    def _annotate(self, frame: np.ndarray) -> tuple[np.ndarray, list[dict[str, Any]]]:
        import cv2  # type: ignore

        self._ensure_yolo()
        if not self._yolo:
            return frame, []
        try:
            if self._yolo_backend_loaded == "onnx":
                return self._yolo.annotate(frame)
            results = self._yolo(frame, conf=self.conf, verbose=False)
            if not results:
                return frame, []
            r0 = results[0]
            annotated = r0.plot()
            dets: list[dict[str, Any]] = []
            names = r0.names or {}
            if r0.boxes is not None:
                for box in r0.boxes:
                    cls_id = int(box.cls[0]) if box.cls is not None else -1
                    conf = float(box.conf[0]) if box.conf is not None else 0.0
                    label = names.get(cls_id, str(cls_id))
                    dets.append({"class": label, "confidence": round(conf, 2)})
            return annotated, dets
        except Exception as e:
            self._yolo_error = str(e)
            cv2.putText(
                frame,
                f"YOLO err: {e}"[:60],
                (8, 24),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (0, 80, 255),
                2,
                cv2.LINE_AA,
            )
            return frame, []

    def _loop(self) -> None:
        interval = 1.0 / max(self.fps, 1)
        fails = 0
        while True:
            with _lock:
                if not self._running:
                    break
            if self._backend is None:
                if not self._open_backend():
                    time.sleep(1.0)
                    continue
                fails = 0

            t0 = time.perf_counter()
            frame, depth_mm = self._read_frame_bgr()
            if frame is None:
                fails += 1
                if fails > 30:
                    self._close_backend()
                    fails = 0
                time.sleep(0.05)
                continue
            fails = 0

            annotated, dets = self._annotate(frame)
            if depth_mm is not None:
                for d in dets:
                    bbox = d.get("bbox")
                    if bbox:
                        dm = self._bbox_depth_m(depth_mm, bbox)
                        if dm is not None:
                            d["depth_m"] = dm
                if dets:
                    annotated = self._overlay_depth(annotated, dets)
            try:
                import cv2  # type: ignore

                ok, buf = cv2.imencode(".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                if not ok:
                    time.sleep(interval)
                    continue
                jpeg = buf.tobytes()
            except Exception as e:
                self._open_error = f"encode: {e}"
                time.sleep(interval)
                continue

            elapsed = max(time.perf_counter() - t0, 0.001)
            with _lock:
                self._latest_jpeg = jpeg
                self._latest_ts = time.time()
                self._frame_count += 1
                self._detections = dets[:12]
                self._fps_measured = 0.85 * self._fps_measured + 0.15 * (1.0 / elapsed)

            try:
                from talk_module.pick_on_detect import get_pick_service

                get_pick_service().on_detections(dets[:12])
            except Exception as _pick_err:
                print(f"[camera] pick_on_detect: {_pick_err}", flush=True)

            sleep_s = max(0.0, interval - (time.perf_counter() - t0))
            time.sleep(sleep_s)

        self._close_backend()


def reset_camera_service() -> None:
    global _service
    with _lock:
        if _service is not None:
            _service.stop()
        _service = None


def get_camera_service() -> CameraYoloService:
    global _service
    if _service is None:
        _service = CameraYoloService()
    return _service
