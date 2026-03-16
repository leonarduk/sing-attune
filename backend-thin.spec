# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for sing-attune backend (thin CPU-only variant)."""

from __future__ import annotations

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

BLOCK_CIPHER = None


datas = collect_data_files("music21", includes=["corpus/**"])
# Bundle local backend package source explicitly (collect_data_files expects installed packages)
datas += [("backend", "backend")]

hiddenimports = collect_submodules("librosa")
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
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["torch", "torchaudio", "torchcrepe", "tensorflow"],
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
    name="sing-attune-backend-thin",
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
    name="sing-attune-backend-thin",
)
