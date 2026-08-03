"""Utility V4L2: trova dispositivi di cattura (G1: MJPEG su /dev/video0,2,4)."""

from __future__ import annotations

import glob
import os
from typing import Any, Optional

# Risoluzioni tipiche camera G1 USB (MJPEG)
_V4L_RESOLUTIONS = (
    (640, 480),
    (480, 640),
    (320, 240),
    (240, 320),
    (1280, 720),
    (640, 360),
)


def v4l_capture_indices() -> list[int]:
    """Indici cattura: su G1 le RGB sono sui pari (0,2,4); dispari = metadata."""
    indices: list[int] = []
    sysfs_indices: list[int] = []
    for entry in sorted(glob.glob("/sys/class/video4linux/video*")):
        name = os.path.basename(entry)
        if not name.startswith("video"):
            continue
        try:
            idx = int(name[5:])
        except ValueError:
            continue
        index_path = os.path.join(entry, "index")
        if os.path.isfile(index_path):
            try:
                with open(index_path, encoding="utf-8") as fh:
                    if int(fh.read().strip()) != 0:
                        continue
            except (OSError, ValueError):
                pass
        sysfs_indices.append(idx)
    indices.extend(sysfs_indices)
    for path in sorted(glob.glob("/dev/video*")):
        name = os.path.basename(path)
        if not name.startswith("video"):
            continue
        try:
            indices.append(int(name[5:]))
        except ValueError:
            continue
    indices = sorted(set(indices))
    evens = [i for i in indices if i % 2 == 0]
    odds = [i for i in indices if i % 2 == 1]
    ordered = evens + odds if evens else indices
    if ordered:
        return ordered
    # G1 tipico se sysfs/dev non visibili al processo
    return [0, 2, 4, 6, 1, 3, 5, 7]


def _normalize_device(device: str | int) -> tuple[str, Any]:
    text = str(device).strip()
    if text.startswith("/dev/video"):
        try:
            return text, int(text.rsplit("video", 1)[-1])
        except ValueError:
            return text, text
    if text.isdigit():
        return text, int(text)
    return text, text


def _try_gstreamer_mjpeg(dev_idx: int, width: int, height: int, fps: int) -> tuple[Any, Optional[str]]:
    try:
        import cv2  # type: ignore
    except ImportError as err:
        return None, str(err)

    if not hasattr(cv2, "CAP_GSTREAMER"):
        return None, "GStreamer non disponibile in OpenCV"

    for w, h in ((width, height), (height, width), (640, 480), (480, 640)):
        pipe = (
            f"v4l2src device=/dev/video{dev_idx} ! "
            f"image/jpeg,width={w},height={h},framerate={max(fps, 5)}/1 ! "
            f"jpegdec ! videoconvert ! video/x-raw,format=BGR ! appsink drop=1 max-buffers=1"
        )
        try:
            cap = cv2.VideoCapture(pipe, cv2.CAP_GSTREAMER)
        except Exception as err:
            continue
        if not cap.isOpened():
            cap.release()
            continue
        ok = False
        for _ in range(6):
            ret, frame = cap.read()
            if ret and frame is not None and getattr(frame, "size", 0) > 0:
                ok = True
                break
        if ok:
            return cap, None
        cap.release()
    return None, "GStreamer MJPEG fallito"


def try_open_v4l(
    device: str | int,
    *,
    width: int = 640,
    height: int = 480,
    fps: int = 15,
    read_frames: int = 8,
) -> tuple[Any, Optional[str], Optional[str]]:
    """Apre camera V4L2. Ritorna (cap, None, mode) o (None, errore, None)."""
    try:
        import cv2  # type: ignore
    except ImportError as err:
        return None, f"OpenCV mancante: {err}", None

    label, dev = _normalize_device(device)
    dev_idx = dev if isinstance(dev, int) else None
    targets: list[Any] = []
    if isinstance(dev, int):
        targets.extend([dev, f"/dev/video{dev}"])
    else:
        targets.append(dev)

    mjpg = cv2.VideoWriter_fourcc("M", "J", "P", "G")
    yuyv = cv2.VideoWriter_fourcc("Y", "U", "Y", "2")
    res_list = [(width, height), (height, width)]
    for rw, rh in _V4L_RESOLUTIONS:
        if (rw, rh) not in res_list:
            res_list.append((rw, rh))

    last_err = ""
    for target in targets:
        try:
            cap = cv2.VideoCapture(target, cv2.CAP_V4L2)
        except Exception as err:
            last_err = str(err)
            continue
        if not cap.isOpened():
            cap.release()
            last_err = f"non apribile {target}"
            continue

        for fourcc, mode in ((mjpg, "mjpeg"), (yuyv, "yuyv"), (0, "default")):
            if fourcc:
                try:
                    cap.set(cv2.CAP_PROP_FOURCC, fourcc)
                except Exception:
                    pass
            for w, h in res_list:
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
                cap.set(cv2.CAP_PROP_FPS, fps)
                ok = False
                for _ in range(max(read_frames, 1)):
                    ret, frame = cap.read()
                    if ret and frame is not None and getattr(frame, "size", 0) > 0:
                        ok = True
                        break
                if ok:
                    return cap, None, mode
        cap.release()
        last_err = f"aperta ma nessun frame ({label})"

    if dev_idx is not None:
        cap, err = _try_gstreamer_mjpeg(dev_idx, width, height, fps)
        if cap is not None:
            return cap, None, "gstreamer-mjpeg"
        if err:
            last_err = f"{last_err}; {err}".strip("; ")

    return None, last_err or f"impossibile aprire {label!r}", None


def probe_v4l_devices(
    *,
    width: int = 640,
    height: int = 480,
    fps: int = 15,
    preferred: str = "auto",
) -> tuple[Optional[str], list[dict[str, Any]]]:
    """Trova il primo device funzionante. Ritorna (device_id, report)."""
    preferred = (preferred or "auto").strip()
    report: list[dict[str, Any]] = []
    candidates: list[str] = []
    if preferred.lower() not in ("", "auto"):
        candidates.append(preferred)
    for idx in v4l_capture_indices():
        s = str(idx)
        if s not in candidates:
            candidates.append(s)
    if not candidates:
        candidates = ["0", "2", "4", "6", "1", "3", "5", "7"]
        cap, err, mode = try_open_v4l(cand, width=width, height=height, fps=fps, read_frames=6)
        entry: dict[str, Any] = {"device": cand, "ok": cap is not None, "error": err}
        if mode:
            entry["mode"] = mode
        if cap is not None:
            try:
                import cv2  # type: ignore

                w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
                h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
                entry["resolution"] = f"{w}x{h}"
            except Exception:
                pass
            cap.release()
            report.append(entry)
            return cand, report
        report.append(entry)
    return None, report
