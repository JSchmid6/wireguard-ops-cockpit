#!/usr/bin/env bash
# Gate the captured `npm ci` log for warnings.
#
# A dependency install that prints `npm warn` lines is not done: a quiet build
# log is a feature, and an unread warning that scrolls by is exactly how the two
# deprecations this file exists for stayed unnoticed. This gate fails the job on
# every `npm warn` line that is not explicitly labeled in
# .github/npm-warn-allowlist.txt, so any accepted warning is a visible, reviewed
# decision — never silent noise.
#
# Usage: bash .github/scripts/check-npm-warnings.sh <path to npm ci log>
#
# Exit codes: 0 = quiet or fully labeled; 1 = unexpected warning(s); 2 = the log
# or the allowlist itself is broken (missing log, entry without a reason).
set -euo pipefail

log_path="${1:?usage: check-npm-warnings.sh <npm-ci-log>}"
allowlist_path="${NPM_WARN_ALLOWLIST:-.github/npm-warn-allowlist.txt}"

if [ ! -f "$log_path" ]; then
  echo "::error::npm ci log not found: ${log_path} (did the install step run and capture its output?)"
  exit 2
fi

patterns=()
reasons=()
used=()

if [ -f "$allowlist_path" ]; then
  lineno=0
  while IFS= read -r raw || [ -n "$raw" ]; do
    lineno=$((lineno + 1))
    line="$raw"
    line="${line#"${line%%[![:space:]]*}"}" # ltrim
    line="${line%"${line##*[![:space:]]}"}" # rtrim
    case "$line" in
      '' | '#'*) continue ;;
    esac
    if [[ "$line" != *'#'* ]]; then
      echo "::error file=${allowlist_path},line=${lineno}::allowlist entry without a '#' label: ${line}"
      echo "Every entry must read '<substring-of-warning> # <reason>'; unlabeled exceptions are not allowed."
      exit 2
    fi
    pattern="${line%%#*}"
    reason="${line#*#}"
    pattern="${pattern%"${pattern##*[![:space:]]}"}" # rtrim
    reason="${reason#"${reason%%[![:space:]]*}"}"   # ltrim
    if [ -z "$pattern" ] || [ -z "$reason" ]; then
      echo "::error file=${allowlist_path},line=${lineno}::empty pattern or empty reason: ${line}"
      exit 2
    fi
    patterns+=("$pattern")
    reasons+=("$reason")
    used+=(0)
  done < "$allowlist_path"
fi

mapfile -t warn_lines < <(grep -F 'npm warn' "$log_path" || true)

unexpected=0
if [ "${#warn_lines[@]}" -gt 0 ]; then
  for warn_line in "${warn_lines[@]}"; do
    hit=-1
    i=0
    while [ "$i" -lt "${#patterns[@]}" ]; do
      if printf '%s\n' "$warn_line" | grep -Fq -- "${patterns[$i]}"; then
        hit="$i"
        break
      fi
      i=$((i + 1))
    done
    if [ "$hit" -ge 0 ]; then
      used[$hit]=1
      echo "allowed (labeled exception): ${warn_line}"
      echo "    reason: ${reasons[$hit]}"
    else
      unexpected=$((unexpected + 1))
      echo "::error::unexpected 'npm warn' line in npm ci output: ${warn_line}"
    fi
  done
fi

i=0
while [ "$i" -lt "${#patterns[@]}" ]; do
  if [ "${used[$i]}" -eq 0 ]; then
    echo "::notice title=npm-warn-allowlist::entry matched no warning in this log (remove it if its warning is gone): ${patterns[$i]}"
  fi
  i=$((i + 1))
done

if [ "$unexpected" -gt 0 ]; then
  echo "::error::npm ci printed ${unexpected} warning line(s) that are not allowlisted."
  echo "Fix the dependency. If there is no fix in scope, add a labeled exception to ${allowlist_path}:"
  echo "    <substring of the warning line> # <why it is acceptable and when to remove it>"
  exit 1
fi

if [ "${#warn_lines[@]}" -eq 0 ]; then
  echo "OK: no 'npm warn' lines in ${log_path}."
  exit 0
fi

echo "OK: all ${#warn_lines[@]} 'npm warn' line(s) carry a labeled exception in ${allowlist_path}."
