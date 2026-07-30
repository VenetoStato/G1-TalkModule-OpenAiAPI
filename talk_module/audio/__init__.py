"""Modulo audio: registrazione, riproduzione, selezione dispositivi."""

from __future__ import annotations

import sys

from talk_module.audio.player import AudioPlayer

AudioRecorder = None
_RECORDER_BACKEND = "none"
_AUDIO_AVAILABLE = False

try:
    from talk_module.audio.recorder import AudioRecorder as _PortAudioRecorder

    AudioRecorder = _PortAudioRecorder
    _RECORDER_BACKEND = "portaudio"
    _AUDIO_AVAILABLE = True
except OSError:
    pass

if AudioRecorder is None and sys.platform == "linux":
    try:
        from talk_module.audio.recorder_pulse import PulseAudioRecorder

        AudioRecorder = PulseAudioRecorder
        _RECORDER_BACKEND = "pulse"
        _AUDIO_AVAILABLE = True
    except ImportError:
        pass

try:
    from talk_module.audio.device_utils import list_audio_devices
except (ImportError, OSError):

    def list_audio_devices():  # type: ignore[misc]
        return []


__all__ = [
    "AudioRecorder",
    "AudioPlayer",
    "list_audio_devices",
    "_AUDIO_AVAILABLE",
    "_RECORDER_BACKEND",
]
