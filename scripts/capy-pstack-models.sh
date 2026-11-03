#!/usr/bin/env bash
# Owns turning .capy/pstack-models.md (the Capy pstack model map) into ~/.cursor/rules/pstack-models.mdc, which pstack skills read.
# Run by the Capy Setup startup entry "pstack-models" on every boot; exits 0 and changes nothing when the map is missing.
set -euo pipefail
src="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.capy/pstack-models.md}"
dest="${2:-$HOME/.cursor/rules/pstack-models.mdc}"
[ -f "$src" ] || exit 0
mkdir -p "$(dirname "$dest")"
tmp="$(mktemp "$dest.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
  printf '%s\n' '---' 'description: pstack per-role model choices (overrides skill defaults)' 'alwaysApply: true' '---'
  echo '# pstack model configuration. One line per role. Generated from .capy/pstack-models.md on each boot.'
  echo '# A Capy agent passes each value as model_id plus reasoning_mode (the word after the model id), plus modes fast when the value ends in fast, to subagent or thread creation.'
  grep -m1 '^# budget:' "$src"
  grep -E '^# (fallback|note) ' "$src" || true
  awk -F'|' 'NF>3 && $2 !~ /^ *(Role|-)/ { gsub(/^ +| +$/, "", $2); gsub(/^ +| +$/, "", $3); gsub(/ · /, " ", $3); print $2 ": " $3 }' "$src"
} > "$tmp"
mv "$tmp" "$dest"
