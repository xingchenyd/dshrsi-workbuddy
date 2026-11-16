"""Package a previously built self-contained marketplace, including dotfiles."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
MARKETPLACE = DIST / "workbuddy-rsi-marketplace"
VERSION = json.loads((ROOT / "packages/workbuddy-rsi/package.json").read_text(encoding="utf-8"))["version"]
if not (MARKETPLACE / ".codebuddy-plugin/marketplace.json").is_file():
    raise SystemExit("Run npm run build:workbuddy first")

archive = DIST / f"workbuddy-rsi-{VERSION}.zip"
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    for source in sorted(MARKETPLACE.rglob("*")):
        if source.is_symlink():
            raise SystemExit(f"Refusing symlink: {source}")
        if source.is_file():
            output.write(source, source.relative_to(DIST).as_posix())
    output.write(ROOT / "scripts/install-workbuddy.mjs", "install-workbuddy.mjs")
    output.write(ROOT / "docs/workbuddy/INSTALL.md", "INSTALL.md")
    for name in ("LICENSE", "NOTICE"):
        output.write(ROOT / name, name)

digest = hashlib.sha256(archive.read_bytes()).hexdigest()
checksum = DIST / "SHA256SUMS.txt"
checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
with zipfile.ZipFile(archive) as check:
    if check.testzip() is not None:
        raise SystemExit("ZIP CRC check failed")
print(json.dumps({"archive": str(archive), "sha256": digest, "bytes": archive.stat().st_size}, indent=2))
