"""Apply browser mic gain/threshold settings to recorded PCM/WAV on the server."""

from __future__ import annotations

import struct
import wave
from io import BytesIO


def clamp_mic_gain(gain: float) -> float:
    try:
        g = float(gain)
    except (TypeError, ValueError):
        return 1.0
    return max(0.4, min(g, 4.0))


def clamp_voice_threshold(threshold: int) -> int:
    try:
        t = int(threshold)
    except (TypeError, ValueError):
        return 20
    return max(1, min(t, 80))


def voice_threshold_to_silence_rms(threshold: int, *, default: float = 0.0035) -> float:
    """Map UI threshold (1–80, ~peak/255) to RMS used by record_until_silence."""
    t = clamp_voice_threshold(threshold)
    if t <= 0:
        return default
    return max(0.0008, min(0.02, (t / 80.0) * 0.014))


def apply_pcm16le_gain(pcm: bytes, gain: float) -> bytes:
    gain = clamp_mic_gain(gain)
    if gain == 1.0 or not pcm:
        return pcm
    usable = len(pcm) - (len(pcm) % 2)
    if usable <= 0:
        return pcm
    out = bytearray(usable)
    for i in range(0, usable, 2):
        sample = struct.unpack_from("<h", pcm, i)[0]
        out[i : i + 2] = struct.pack("<h", max(-32768, min(32767, round(sample * gain))))
    return bytes(out)


def apply_wav_gain(wav_bytes: bytes, gain: float) -> bytes:
    gain = clamp_mic_gain(gain)
    if gain == 1.0 or not wav_bytes:
        return wav_bytes
    with wave.open(BytesIO(wav_bytes), "rb") as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if sampwidth != 2:
        return wav_bytes
    pcm = apply_pcm16le_gain(frames, gain)
    buf = BytesIO()
    with wave.open(buf, "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(sampwidth)
        out.setframerate(framerate)
        out.writeframes(pcm)
    return buf.getvalue()
