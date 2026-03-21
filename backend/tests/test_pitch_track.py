"""Tests for offline pitch extraction (issue #266)."""

import numpy as np

from backend.audio.pitch_track import PitchTrackConfig, _closest_octave, extract_pitch_frames


def _sine(freq_hz: float, seconds: float, sample_rate: int) -> np.ndarray:
    timeline = np.arange(int(sample_rate * seconds), dtype=np.float32) / sample_rate
    return np.sin(2.0 * np.pi * freq_hz * timeline).astype(np.float32)


class TestClosestOctave:
    def test_returns_input_for_unvoiced_values(self):
        assert _closest_octave(0.0, 69.0) == 0.0
        assert _closest_octave(69.0, 0.0) == 69.0

    def test_shifts_to_nearest_octave(self):
        corrected = _closest_octave(45.0, 69.0)
        assert abs(corrected - 69.0) < 1e-6


class TestExtractPitchFrames:
    def test_empty_audio_returns_no_frames(self):
        config = PitchTrackConfig(sample_rate=22050)
        assert extract_pitch_frames(np.array([], dtype=np.float32), config) == []

    def test_sub_frame_audio_returns_single_unvoiced_frame(self):
        config = PitchTrackConfig(sample_rate=22050, hop_length=256, frame_length=2048)
        audio = np.zeros(1024, dtype=np.float32)

        frames = extract_pitch_frames(audio, config)

        assert len(frames) == 1
        assert frames[0].time_ms == 0.0
        assert frames[0].midi == 0.0
        assert frames[0].confidence == 0.0

    def test_sustained_a4_is_stable(self):
        config = PitchTrackConfig(sample_rate=22050, hop_length=256, frame_length=2048)
        frames = extract_pitch_frames(_sine(440.0, 1.5, 22050), config)

        voiced_midis = [frame.midi for frame in frames if frame.midi > 0.0]
        assert voiced_midis
        assert abs(float(np.median(voiced_midis)) - 69.0) < 0.75

    def test_silence_detected_as_unvoiced(self):
        config = PitchTrackConfig(sample_rate=22050, hop_length=256, frame_length=2048)
        frames = extract_pitch_frames(np.zeros(22050, dtype=np.float32), config)

        assert frames
        assert all(frame.midi == 0.0 for frame in frames)

    def test_output_is_time_aligned(self):
        config = PitchTrackConfig(sample_rate=22050, hop_length=512, frame_length=2048)
        frames = extract_pitch_frames(_sine(220.0, 1.0, 22050), config)

        assert len(frames) > 2
        delta = frames[1].time_ms - frames[0].time_ms
        assert abs(delta - (512 * 1000.0 / 22050)) < 1e-6
        assert all(frames[i].time_ms <= frames[i + 1].time_ms for i in range(len(frames) - 1))

    def test_keeps_real_octave_jump(self):
        sample_rate = 22050
        config = PitchTrackConfig(sample_rate=sample_rate, hop_length=256, frame_length=2048)

        first = _sine(440.0, 0.8, sample_rate)
        second = _sine(880.0, 0.8, sample_rate)
        audio = np.concatenate([first, second]).astype(np.float32)
        frames = extract_pitch_frames(audio, config)

        midpoint = len(frames) // 2
        before = [frame.midi for frame in frames[:midpoint] if frame.midi > 0.0]
        after = [frame.midi for frame in frames[midpoint:] if frame.midi > 0.0]

        assert before and after
        assert abs(float(np.median(before)) - 69.0) < 1.0
        assert abs(float(np.median(after)) - 81.0) < 1.0
