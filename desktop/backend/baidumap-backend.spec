from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules


desktop_root = Path(SPECPATH).resolve().parent
repository_root = desktop_root.parent
backend_root = repository_root / "backend"
entrypoint = desktop_root / "backend" / "desktop_backend_entry.py"

hidden_imports = collect_submodules("uvicorn")

a = Analysis(
    [str(entrypoint)],
    pathex=[str(backend_root)],
    binaries=[],
    datas=[],
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "unittest.mock", "watchfiles", "websockets", "uvloop"],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="baidumap-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="baidumap-backend",
)

