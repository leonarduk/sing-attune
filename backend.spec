# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for sing-attune backend."""

from __future__ import annotations

from pathlib import Path
import site

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

BLOCK_CIPHER = None


def _tensorflow_cuda_dlls() -> list[tuple[str, str]]:
    """Collect TensorFlow CUDA DLLs when tensorflow is installed."""
    dll_patterns = (
        "*cublas*.dll",
        "*cudart*.dll",
        "*cudnn*.dll",
        "*cusolver*.dll",
        "*cusparse*.dll",
        "*curand*.dll",
    )
    bins: list[tuple[str, str]] = []
    for package_root in site.getsitepackages():
        tf_root = Path(package_root) / "tensorflow"
        if not tf_root.exists():
            continue
        for pattern in dll_patterns:
            for dll in tf_root.rglob(pattern):
                bins.append((str(dll), "."))
    return bins


datas = collect_data_files("music21", includes=["corpus/**"])
datas += collect_data_files("backend")

binaries = collect_dynamic_libs("torch")
binaries += collect_dynamic_libs("torchaudio")
binaries += _tensorflow_cuda_dlls()

hiddenimports = collect_submodules("torchcrepe")
hiddenimports += collect_submodules("librosa")
hiddenimports += [
    "backend.main",
    "backend.audio.capture",
    "backend.audio.pipeline",
    "backend.audio.pitch",
    "backend.score.parser",
    "backend.score.timeline",
    "backend.score.upload",
]


app = Analysis(
    ["backend/main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=BLOCK_CIPHER,
    noarchive=False,
)
pyz = PYZ(app.pure, app.zipped_data, cipher=BLOCK_CIPHER)

exe = EXE(
    pyz,
    app.scripts,
    [],
    exclude_binaries=True,
    name="sing-attune-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)

coll = COLLECT(
    exe,
    app.binaries,
    app.zipfiles,
    app.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="sing-attune-backend",
)
