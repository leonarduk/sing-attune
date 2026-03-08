#!/usr/bin/env python3
"""
Quick benchmark: torchcrepe 'full' vs 'tiny' on RTX 5070.
Run: uv run python backend/scripts/benchmark_crepe.py
"""
import math, time
import numpy as np
import torch
import torchcrepe
import torchaudio.functional as F

SAMPLE_RATE = 22050
CREPE_SR = 16000
N = 2048
N_RUNS = 50
device = torch.device("cuda")

t = np.arange(N, dtype=np.float32) / SAMPLE_RATE
window = (0.8 * np.sin(2 * math.pi * 440.0 * t)).astype(np.float32)
audio = torch.from_numpy(window).unsqueeze(0)
audio_16k = F.resample(audio, SAMPLE_RATE, CREPE_SR).to(device)

for model in ("full", "tiny"):
    # warmup
    for _ in range(3):
        with torch.no_grad():
            torchcrepe.predict(
                audio_16k, CREPE_SR,
                hop_length=audio_16k.shape[-1],
                fmin=65.0, fmax=2093.0,
                model=model,
                decoder=torchcrepe.decode.weighted_argmax,
                return_periodicity=True,
                device=device,
            )
    times = []
    for _ in range(N_RUNS):
        t0 = time.monotonic()
        with torch.no_grad():
            torchcrepe.predict(
                audio_16k, CREPE_SR,
                hop_length=audio_16k.shape[-1],
                fmin=65.0, fmax=2093.0,
                model=model,
                decoder=torchcrepe.decode.weighted_argmax,
                return_periodicity=True,
                device=device,
            )
        times.append((time.monotonic() - t0) * 1000.0)
    p50 = float(np.percentile(times, 50))
    p95 = float(np.percentile(times, 95))
    print(f"{model:6s}  p50={p50:.1f}ms  p95={p95:.1f}ms  max={max(times):.1f}ms")
