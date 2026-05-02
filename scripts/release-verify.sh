#!/usr/bin/env bash
# Post-build release verification — fails CI if a signed/notarized
# artefact is missing or tampered with. Runs after `electron-builder`
# emits the .dmg / .exe and BEFORE the artefact is uploaded to the
# release channel.
#
# Usage: scripts/release-verify.sh <artifact-dir>
#
# Verifications:
#   1. Mac .dmg — `spctl --assess` (Gatekeeper accept), `codesign --verify
#      --deep --strict`, `stapler validate` (offline ticket present).
#   2. Win .exe — `signtool verify /pa /all` if available; otherwise
#      Authenticode signature parse via `osslsigncode verify`.
#   3. SHA-256 checksum file emitted alongside every artefact and recorded
#      in `release-manifest.json` so the desktop auto-update client can
#      verify the download before applying it.
#
# Exit code is non-zero on the first failure — never silently warn.
set -euo pipefail

ART_DIR="${1:-dist/release}"
if [[ ! -d "${ART_DIR}" ]]; then
  echo "release-verify: artifact dir not found: ${ART_DIR}" >&2
  exit 1
fi

manifest="${ART_DIR}/release-manifest.json"
echo "[]" > "${manifest}.tmp"

verify_mac_dmg() {
  local dmg="$1"
  echo "  → spctl assess (Gatekeeper)"
  spctl --assess --type install --verbose "${dmg}"
  echo "  → codesign deep verify"
  codesign --verify --deep --strict --verbose=2 "${dmg}"
  echo "  → stapler validate (offline ticket)"
  stapler validate "${dmg}"
}

verify_win_exe() {
  local exe="$1"
  if command -v signtool >/dev/null 2>&1; then
    echo "  → signtool verify /pa /all"
    signtool verify //pa //all "${exe}"
  elif command -v osslsigncode >/dev/null 2>&1; then
    echo "  → osslsigncode verify"
    osslsigncode verify "${exe}"
  else
    echo "release-verify: no signtool or osslsigncode available" >&2
    exit 1
  fi
}

shopt -s nullglob
for f in "${ART_DIR}"/*.dmg "${ART_DIR}"/*.exe; do
  echo "==> ${f}"
  case "${f}" in
    *.dmg) verify_mac_dmg "${f}" ;;
    *.exe) verify_win_exe "${f}" ;;
  esac
  sha=$(sha256sum "${f}" | awk '{print $1}')
  size=$(stat -c%s "${f}" 2>/dev/null || stat -f%z "${f}")
  base=$(basename "${f}")
  echo "${sha}  ${base}" > "${f}.sha256"
  python3 - "$manifest.tmp" "$base" "$sha" "$size" <<'PY'
import json, sys
path, name, sha, size = sys.argv[1:]
data = json.load(open(path))
data.append({"file": name, "sha256": sha, "size": int(size)})
json.dump(data, open(path, "w"), indent=2)
PY
done

mv "${manifest}.tmp" "${manifest}"
echo "release-verify: OK — manifest at ${manifest}"
