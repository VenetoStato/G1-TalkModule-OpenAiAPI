"""Factory: sceglie il recorder microfono migliore (Pulse/arecord su Jetson, poi PortAudio)."""

from __future__ import annotations

import os
import sys
from typing import Optional


def mic_backend_preference() -> str:
    return (os.getenv("G1_MIC_BACKEND") or "auto").strip().lower()


def create_microphone_recorder(device_id: Optional[int] = None):
    """
    Su Linux prova prima arecord/PulseAudio (come Grok Voice), poi PortAudio.
    Ritorna None solo se entrambi falliscono.
    """
    pref = mic_backend_preference()
    errors: list[str] = []

    try_pulse = sys.platform == "linux" and pref in ("auto", "pulse", "arecord", "")
    try_portaudio = pref in ("auto", "portaudio", "sd", "sounddevice")

    if try_pulse:
        try:
            from talk_module.audio.device_utils import ensure_pulse_usb_microphone_source
            from talk_module.audio.recorder_pulse import PulseAudioRecorder

            ensure_pulse_usb_microphone_source()
            rec = PulseAudioRecorder(device_id=device_id)
            print("[Audio] Recorder: PulseAudio/arecord", flush=True)
            return rec
        except Exception as exc:
            msg = f"pulse: {exc}"
            errors.append(msg)
            print(f"[Audio] Pulse recorder failed: {msg}", flush=True)

    if try_portaudio:
        try:
            from talk_module.audio.device_utils import portaudio_available
            from talk_module.audio.recorder import AudioRecorder

            if sys.platform != "linux" or portaudio_available() or pref != "auto":
                rec = AudioRecorder(device_id=device_id)
                print("[Audio] Recorder: PortAudio", flush=True)
                return rec
            errors.append("portaudio: libreria presente ma non utilizzabile")
        except Exception as exc:
            msg = f"portaudio: {exc}"
            errors.append(msg)
            print(f"[Audio] PortAudio recorder failed: {msg}", flush=True)

    if errors:
        print(f"[Audio] No microphone recorder: {' | '.join(errors)}", flush=True)
    return None
