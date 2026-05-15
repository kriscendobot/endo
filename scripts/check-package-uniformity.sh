#!/bin/bash
#
# check-package-uniformity.sh enforces a single source-of-truth across
# every workspace package using packages/skel/ as the template.
#
# The checks (all fail closed; exit 1 on any drift):
#
#   1. SECURITY.md is byte-identical to packages/skel/SECURITY.md.
#   2. LICENSE matches packages/skel/LICENSE modulo the copyright line.
#      The copyright line must match either the skel placeholder
#      "Copyright [yyyy] [name of copyright owner]" or the filled form
#      "Copyright <YYYY> Endo Contributors". This preserves the existing
#      scripts/set-license-text.sh convention of stamping the package's
#      creation year into its LICENSE.
#   3. package.json fields:
#      - author              matches skel
#      - license             matches skel
#      - type                matches skel
#      - repository.type     matches skel
#      - repository.url      matches skel
#      - repository.directory == "packages/<dir>"
#      - name                ends with "/<dir>" (after the @endo scope)
#                            or equals "<dir>" for unscoped historical names
#      - bugs.url            matches skel
#      - publishConfig.access == "public" (only for packages whose
#                                          private flag is not true)
#      - description         is non-empty AND not equal to skel's
#                            description (skel itself is exempt; skel's
#                            null value is the placeholder this check
#                            forbids elsewhere)
#
# The skel package is the source of truth and is exempt from the
# description differs-from-skel check (since skel defines the default
# the check forbids).
#
# Style follows the sibling scripts/check-packages.sh.

set -ueo pipefail
IFS=$'\n\t'

DIR=$(dirname -- "${BASH_SOURCE[0]}")
cd "$DIR/.."

SKEL=packages/skel
EXIT=0

# Source-of-truth values harvested from skel once.
SKEL_SECURITY_SHA=$(sha256sum "$SKEL/SECURITY.md" | awk '{print $1}')
SKEL_LICENSE_NOCOPY=$(grep -v '^   Copyright ' "$SKEL/LICENSE" | sha256sum | awk '{print $1}')
SKEL_AUTHOR=$(jq -r '.author' "$SKEL/package.json")
SKEL_LICENSE_FIELD=$(jq -r '.license' "$SKEL/package.json")
SKEL_TYPE=$(jq -r '.type' "$SKEL/package.json")
SKEL_REPO_TYPE=$(jq -r '.repository.type' "$SKEL/package.json")
SKEL_REPO_URL=$(jq -r '.repository.url' "$SKEL/package.json")
SKEL_BUGS_URL=$(jq -r '.bugs.url' "$SKEL/package.json")
SKEL_DESCRIPTION=$(jq -r '.description // ""' "$SKEL/package.json")

# Collect every workspace package (every packages/<dir>/package.json).
PKGS=()
for JSON in $(find packages -mindepth 2 -maxdepth 2 -name 'package.json' | sort); do
  PKGS+=("$(dirname "$JSON")")
done

# --- SECURITY.md byte-identical to skel ----------------------------------
for PKG in "${PKGS[@]}"; do
  if [ ! -f "$PKG/SECURITY.md" ]; then
    echo "$PKG: missing SECURITY.md"
    EXIT=1
    continue
  fi
  HASH=$(sha256sum "$PKG/SECURITY.md" | awk '{print $1}')
  if [ "$HASH" != "$SKEL_SECURITY_SHA" ]; then
    echo "$PKG: SECURITY.md differs from $SKEL/SECURITY.md (sha256 $HASH vs $SKEL_SECURITY_SHA)"
    EXIT=1
  fi
done

# --- LICENSE matches skel modulo the copyright line ----------------------
for PKG in "${PKGS[@]}"; do
  if [ ! -f "$PKG/LICENSE" ]; then
    echo "$PKG: missing LICENSE"
    EXIT=1
    continue
  fi
  NOCOPY_HASH=$(grep -v '^   Copyright ' "$PKG/LICENSE" | sha256sum | awk '{print $1}')
  if [ "$NOCOPY_HASH" != "$SKEL_LICENSE_NOCOPY" ]; then
    echo "$PKG: LICENSE body differs from $SKEL/LICENSE (ignoring copyright line)"
    EXIT=1
    continue
  fi
  COPY_LINE=$(grep '^   Copyright ' "$PKG/LICENSE" || true)
  if ! echo "$COPY_LINE" | grep -Eq '^   Copyright (\[yyyy\] \[name of copyright owner\]|[0-9]{4} Endo Contributors)$'; then
    echo "$PKG: LICENSE copyright line not canonical: $COPY_LINE"
    EXIT=1
  fi
done

# --- package.json field uniformity ---------------------------------------
# Known historical exceptions: <pkg>:<jq-path>:<allowed-value>.
# Each entry permits one specific package.json field to deviate from
# the skel value for a documented reason. Keep this list small and
# named; every entry needs a comment explaining why.
EXCEPTIONS=(
  # eslint-plugin is a CommonJS plugin for ESLint v8 (it consumes
  # requireindex and uses __dirname / module.exports). Migrating it
  # to ESM is a substantial refactor; until that lands, the package
  # legitimately ships without a 'type' field (effectively commonjs).
  'packages/eslint-plugin:.type:'
)

function is_exception() {
  local pkg=$1 path=$2 actual=$3
  local entry
  for entry in "${EXCEPTIONS[@]}"; do
    if [ "$entry" = "$pkg:$path:$actual" ]; then
      return 0
    fi
  done
  return 1
}

function assert_field() {
  local pkg=$1 json=$2 path=$3 expected=$4
  local actual
  actual=$(jq -r "$path // \"\"" "$json")
  if [ "$actual" != "$expected" ]; then
    if is_exception "$pkg" "$path" "$actual"; then
      return 0
    fi
    echo "$pkg: package.json $path expected '$expected' actual '$actual'"
    EXIT=1
  fi
}

for PKG in "${PKGS[@]}"; do
  JSON="$PKG/package.json"
  DIR_NAME=$(basename "$PKG")

  assert_field "$PKG" "$JSON" .author "$SKEL_AUTHOR"
  assert_field "$PKG" "$JSON" .license "$SKEL_LICENSE_FIELD"
  assert_field "$PKG" "$JSON" .type "$SKEL_TYPE"
  assert_field "$PKG" "$JSON" .repository.type "$SKEL_REPO_TYPE"
  assert_field "$PKG" "$JSON" .repository.url "$SKEL_REPO_URL"
  assert_field "$PKG" "$JSON" '.repository.directory' "packages/$DIR_NAME"
  assert_field "$PKG" "$JSON" .bugs.url "$SKEL_BUGS_URL"

  # name: either "@<scope>/<dir>" or unscoped "<dir>".
  ACTUAL_NAME=$(jq -r '.name // ""' "$JSON")
  case "$ACTUAL_NAME" in
    "$DIR_NAME"|*/"$DIR_NAME") ;;
    *)
      echo "$PKG: package.json .name '$ACTUAL_NAME' does not end with directory '$DIR_NAME'"
      EXIT=1
      ;;
  esac

  # publishConfig.access: required to be "public" for non-private packages.
  PRIVATE=$(jq -r '.private // false' "$JSON")
  if [ "$PRIVATE" != "true" ]; then
    assert_field "$PKG" "$JSON" .publishConfig.access "public"
  fi

  # description: non-empty and not equal to skel's default. Skel itself
  # is exempt because skel defines the default the check forbids.
  if [ "$PKG" != "$SKEL" ]; then
    ACTUAL_DESC=$(jq -r '.description // ""' "$JSON")
    if [ -z "$ACTUAL_DESC" ]; then
      echo "$PKG: package.json .description is empty"
      EXIT=1
    elif [ "$ACTUAL_DESC" = "$SKEL_DESCRIPTION" ]; then
      echo "$PKG: package.json .description matches skel's default ('$SKEL_DESCRIPTION')"
      EXIT=1
    fi
  fi
done

exit "$EXIT"
