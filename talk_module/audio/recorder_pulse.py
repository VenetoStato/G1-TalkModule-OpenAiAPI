"""
Registrazione microfono Jetson via arecord + PulseAudio (senza libportaudio).
Stesso percorso usato da Grok Voice quando PortAudio non è disponibile.
"""

from __future__ import annotations

import io
import subprocess
import time
from typing import Optional

import numpy as np
import soundfile as sf

from talk_module.audio.device_utils import ensure_pulse_usb_microphone_source
from talk_module.config import settings

VOLUME_BOOST = 1.5


class PulseAudioRecorder:
    """API compatibile con AudioRecorder; cattura via `arecord -D pulse`."""

    def __init__(
        self,
        sample_rate: Optional[int] = None,
        device_id: Optional[int] = None,
        channels: int = 1,
    ):
        self.device_id = device_id
        self.sample_rate = int(sample_rate or settings.sample_rate or 16000)
        self.channels = 1

    def _start_arecord(self) -> subprocess.Popen:
        ensure_pulse_usb_microphone_source()
        return subprocess.Popen(
            [
                "arecord",
                "-q",
                "-D",
                "pulse",
                "-t",
                "raw",
                "-f",
                "S16_LE",
                "-r",
                str(self.sample_rate),
                "-c",
                "1",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    @staticmethod
    def _stop_process(process: subprocess.Popen | None) -> None:
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()

    def _read_pcm(self, process: subprocess.Popen, nbytes: int) -> np.ndarray:
        raw = process.stdout.read(nbytes)
        if not raw:
            err = process.stderr.read().decode("utf-8", errors="replace").strip()
            raise RuntimeError(err or "stream microfono terminato")
        usable = len(raw) - (len(raw) % 2)
        return np.frombuffer(raw[:usable], dtype=np.int16).astype(np.float32) / 32768.0

    def _to_wav_bytes(self, audio: np.ndarray, sample_rate: Optional[int] = None) -> bytes:
        buf = io.BytesIO()
        audio_flat = audio.squeeze().astype(np.float32)
        if VOLUME_BOOST != 1.0:
            audio_flat = np.clip(audio_flat * VOLUME_BOOST, -1.0, 1.0)
        rate = sample_rate or self.sample_rate
        sf.write(buf, audio_flat, rate, format="WAV")
        return buf.getvalue()

    def record_until_stop(
        self,
        stop_check,
        chunk_duration: float = 0.3,
        min_duration: float = 0.5,
    ) -> bytes:
        process = None
        try:
            process = self._start_arecord()
            chunk_bytes = int(chunk_duration * self.sample_rate) * 2
            buffer: list[np.ndarray] = []
            while not stop_check():
                buffer.append(self._read_pcm(process, chunk_bytes))
            if not buffer:
                return b""
            audio = np.concatenate(buffer)
            if len(audio) / self.sample_rate < min_duration:
                return b""
            return self._to_wav_bytes(audio)
        finally:
            self._stop_process(process)

    def record_fixed_duration(self, duration_seconds: float) -> bytes:
        process = None
        try:
            process = self._start_arecord()
            total_bytes = int(duration_seconds * self.sample_rate) * 2
            chunk_bytes = max(2, int(0.1 * self.sample_rate) * 2)
            parts: list[np.ndarray] = []
            collected = 0
            while collected < total_bytes:
                to_read = min(chunk_bytes, total_bytes - collected)
                parts.append(self._read_pcm(process, to_read))
                collected += to_read
            audio = np.concatenate(parts) if parts else np.array([], dtype=np.float32)
            return self._to_wav_bytes(audio)
        finally:
            self._stop_process(process)

    def record_until_silence(
        self,
        silence_seconds: float = 10.0,
        chunk_duration: float = 0.5,
        silence_threshold: float = 0.01,
        max_duration: float = 120.0,
        stop_check=None,
    ):
        process = None
        try:
            process = self._start_arecord()
            silence_chunks_needed = max(1, int(silence_seconds / chunk_duration))
            chunk_bytes = max(2, int(chunk_duration * self.sample_rate) * 2)
            buffer: list[np.ndarray] = []
            silence_count = 0
            in_speech = False
            total_dur = 0.0
            log_count = 0

            print(
                f"[PulseRecorder] Started rate={self.sample_rate} "
                f"threshold={silence_threshold} silence_needed={silence_chunks_needed}ch",
                flush=True,
            )

            while stop_check is None or not stop_check():
                chunk = self._read_pcm(process, chunk_bytes)
                rms = float(np.sqrt(np.mean(chunk**2)))
                total_dur += chunk_duration
                log_count += 1

                if log_count <= 5 or log_count % 40 == 0 or (rms > silence_threshold and not in_speech):
                    print(
                        f"[PulseRec] #{log_count} rms={rms:.4f} speech={in_speech} "
                        f"sil={silence_count} buf={len(buffer)}",
                        flush=True,
                    )

                if rms > silence_threshold:
                    in_speech = True
                    silence_count = 0
                    buffer.append(chunk)
                elif in_speech:
                    buffer.append(chunk)
                    silence_count += 1
                    if silence_count >= silence_chunks_needed:
                        if buffer and len(buffer) > 2:
                            audio = np.concatenate(buffer)
                            print(
                                f"[PulseRec] YIELD {len(buffer)} chunks {len(audio) / self.sample_rate:.1f}s",
                                flush=True,
                            )
                            yield self._to_wav_bytes(audio)
                        buffer = []
                        silence_count = 0
                        in_speech = False
                        total_dur = 0.0

                if total_dur >= max_duration and buffer:
                    audio = np.concatenate(buffer)
                    print(f"[PulseRec] YIELD max_dur {len(buffer)} chunks", flush=True)
                    yield self._to_wav_bytes(audio)
                    buffer = []
                    total_dur = 0.0
        finally:
            self._stop_process(process)
