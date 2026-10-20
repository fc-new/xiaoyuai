#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

supports_node() {
  "$1" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>24||(major===24&&minor>=13)?0:1)' >/dev/null 2>&1
}

preview_node=''
if command -v node >/dev/null 2>&1 && supports_node "$(command -v node)"; then
  preview_node="$(command -v node)"
else
  runtime_base="$PWD/.local/runtime"
  mkdir -p "$runtime_base"
  if [ -f "$runtime_base/current-node.txt" ]; then
    cached_folder="$(cat "$runtime_base/current-node.txt")"
    if [[ "$cached_folder" =~ ^node-v24\.[0-9]+\.[0-9]+-darwin-(arm64|x64)$ ]] && supports_node "$runtime_base/$cached_folder/bin/node"; then
      preview_node="$runtime_base/$cached_folder/bin/node"
    fi
  fi
  if [ -z "$preview_node" ]; then
    case "$(uname -m)" in
      arm64) runtime_arch='arm64' ;;
      x86_64) runtime_arch='x64' ;;
      *) echo 'This launcher supports Apple Silicon and Intel Macs.'; exit 1 ;;
    esac
    echo 'Preparing Node.js 24 LTS from the official Node.js website...'
    download_dir="$(mktemp -d "$runtime_base/.download.XXXXXX")"
    trap 'rm -rf "$download_dir"' EXIT
    official_base='https://nodejs.org/dist/latest-v24.x'
    curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 180 --retry 2 "$official_base/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"
    checksum_row="$(awk -v arch="$runtime_arch" '$2 ~ ("^node-v24[.][0-9]+[.][0-9]+-darwin-" arch "[.]tar[.]gz$") { print $1 " " $2; exit }' "$download_dir/SHASUMS256.txt")"
    expected_sha="${checksum_row%% *}"
    archive_name="${checksum_row#* }"
    if ! [[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || ! [[ "$archive_name" =~ ^node-v24\.[0-9]+\.[0-9]+-darwin-(arm64|x64)\.tar\.gz$ ]]; then
      echo 'Official Node.js checksum metadata is invalid. Startup stopped.'; exit 1
    fi
    curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 600 --retry 2 "$official_base/$archive_name" -o "$download_dir/$archive_name"
    (cd "$download_dir" && printf '%s  %s\n' "$expected_sha" "$archive_name" | shasum -a 256 -c -)
    # Extract only after checksum verification; preserve existing cached runtimes.
    tar -xzf "$download_dir/$archive_name" -C "$download_dir"
    runtime_folder="${archive_name%.tar.gz}"
    if [ -e "$runtime_base/$runtime_folder" ]; then
      echo 'An incomplete runtime already exists. Rename .local/runtime and retry.'; exit 1
    fi
    mv "$download_dir/$runtime_folder" "$runtime_base/$runtime_folder"
    preview_node="$runtime_base/$runtime_folder/bin/node"
    supports_node "$preview_node"
    printf '%s\n' "$runtime_folder" > "$runtime_base/current-node.txt"
    rm -rf "$download_dir"
    trap - EXIT
  fi
fi

if "$preview_node" scripts/local.mjs; then
  exit 0
else
  result=$?
  if [ -t 0 ]; then read -r -p 'Startup failed. Press Enter to close...'; fi
  exit "$result"
fi
