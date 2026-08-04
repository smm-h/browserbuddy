#!/bin/sh
# rlsbl pre-release hook. Runs after the preflight checks and before rlsbl
# writes the new version into package.json; anything it dirties is folded into
# the release commit.
#
# Two jobs, in this order.
#
# 1. Run the preflight checks. rlsbl skips its own built-in preflight checks
#    (the test suite, the config schema) whenever a customized pre-release hook
#    exists -- the hook is assumed to have taken over testing. So this hook runs
#    them, and the release keeps its test gate instead of silently losing it to
#    the existence of this file. Config-declared external checks (the
#    manifest/package version lockstep) rlsbl runs either way; running them
#    again here is cheap and keeps this one command the whole gate.
#
# 2. Stamp extension/manifest.json with the version being released. The
#    extension has no build step, so its manifest version is the one literal
#    rlsbl's bump does not reach.
#
# The order is not incidental: the test suite asserts that the manifest and
# package.json agree, and between the stamp and rlsbl's own version write they
# do not. Checks first, stamp second, and every commit that exists has the two
# versions equal.

set -eu

if [ -z "${RLSBL_VERSION:-}" ]; then
  echo "pre-release: RLSBL_VERSION is not set -- refusing to guess the version to stamp." >&2
  exit 1
fi

echo "pre-release: running preflight checks (rlsbl skips its built-in ones while this hook exists)..." >&2
rlsbl check --tag preflight

echo "pre-release: stamping extension/manifest.json with $RLSBL_VERSION..." >&2
node scripts/stamp-manifest-version.mjs "$RLSBL_VERSION"
