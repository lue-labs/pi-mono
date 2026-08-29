#!/usr/bin/env bash
#
# Take a fresh pi-mono-fork worktree to a working build in one command.
#
#   ./scripts/bootstrap-worktree.sh
#
# A `git worktree add` gives you source only: no node_modules, and no
# packages/ai/src/providers/data/ (it is generated and gitignored). Both are
# required before anything in this repo runs, including pi itself. Doing the
# three steps by hand has repeatedly cost time, so they live here.
#
# Steps:
#   1. npm install
#   2. populate packages/ai/src/providers/data/ (copy from a sibling checkout,
#      else hydrate over the network)
#   3. npm run build:offline
#
# Every step is idempotent and re-running the script is safe: steps 2 and 3 are
# skipped when their output is already valid.
#
# See docs/worktree-bootstrap.md for why this exists.

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SCRIPT_NAME REPO_ROOT

# Path fragments used in more than one place, so a rename breaks in one spot.
readonly MODEL_DATA_REL="packages/ai/src/providers/data"
readonly MODEL_DATA_DIR="${REPO_ROOT}/${MODEL_DATA_REL}"
readonly MODEL_DATA_MANIFEST="${MODEL_DATA_DIR}/.manifest.json"
readonly BUILD_ARTIFACT="${REPO_ROOT}/packages/coding-agent/dist/cli.js"

DEFAULT_SIBLING="${HOME}/Projects/personal/pi-mono-fork"
sibling="${DEFAULT_SIBLING}"
force_hydrate=0
install_scripts=0
skip_install=0

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }

# Fail with the specific missing artifact, not a generic "bootstrap failed".
# The whole point of this script is that the four failure layers behind
# "timed out waiting for agent startup" were each invisible until named.
die() {
	printf '\033[31merror:\033[0m %s\n' "$1" >&2
	shift
	for line in "$@"; do
		printf '       %s\n' "${line}" >&2
	done
	exit 1
}

usage() {
	cat <<EOF
${SCRIPT_NAME} — bootstrap a fresh pi-mono-fork worktree.

Usage: ${SCRIPT_NAME} [options]

Options:
  --from <path>     Sibling checkout to copy generated model data from.
                    Default: ${DEFAULT_SIBLING}
  --hydrate         Skip the sibling copy and regenerate model data over the
                    network (npm run hydrate:model-data).
  --skip-install    Skip step 1. Only for re-runs where node_modules is known good.
  --with-scripts    Run npm install with lifecycle scripts enabled.
                    Default is --ignore-scripts, per docs/agents/testing-and-dependencies.md.
  -h, --help        Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--from)
			[[ $# -ge 2 ]] || die "--from needs a path argument"
			sibling="$2"
			shift 2
			;;
		--from=*)
			sibling="${1#*=}"
			shift
			;;
		--hydrate)       force_hydrate=1; shift ;;
		--skip-install)  skip_install=1; shift ;;
		--with-scripts)  install_scripts=1; shift ;;
		-h|--help)       usage; exit 0 ;;
		*)               usage >&2; die "unknown option: $1" ;;
	esac
done

cd "${REPO_ROOT}"

command -v npm >/dev/null 2>&1 || die "npm is not on PATH"
command -v node >/dev/null 2>&1 || die "node is not on PATH"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 24 )); then
	die "Node ${node_major} is too old (this repo requires >=24.14.0)" \
		"Current: $(node --version)" \
		"Fix: fnm use 24 (or your version manager's equivalent), then re-run."
fi

# ---------------------------------------------------------------------------
# Step 1 — dependencies
# ---------------------------------------------------------------------------
if (( skip_install )); then
	log "Step 1/3: skipping npm install (--skip-install)"
	[[ -d "${REPO_ROOT}/node_modules" ]] || \
		die "--skip-install was passed but ${REPO_ROOT}/node_modules does not exist" \
			"Re-run without --skip-install."
else
	install_flags=(--ignore-scripts)
	(( install_scripts )) && install_flags=()
	log "Step 1/3: npm install ${install_flags[*]:-}"
	npm install "${install_flags[@]}" || \
		die "npm install failed" \
			"If it failed authenticating @lue-labs/* or @valkyriweb/*, check .npmrc and your" \
			"GitHub Packages token (npm config get //npm.pkg.github.com/:_authToken)."
fi

# ---------------------------------------------------------------------------
# Step 2 — generated model data
# ---------------------------------------------------------------------------
# packages/ai/src/providers/data/ is gitignored generated output. Without it,
# every build fails at `check:model-data`.
model_data_valid() {
	npm run --silent check:model-data >/dev/null 2>&1
}

describe_model_data_state() {
	if [[ ! -d "${MODEL_DATA_DIR}" ]]; then
		echo "${MODEL_DATA_REL}/ does not exist"
	elif [[ ! -f "${MODEL_DATA_MANIFEST}" ]]; then
		echo "${MODEL_DATA_REL}/.manifest.json is missing"
	else
		echo "${MODEL_DATA_REL}/ is present but stale or incomplete"
	fi
}

copy_model_data_from_sibling() {
	local src="$1/${MODEL_DATA_REL}"

	[[ -d "${src}" ]] || return 1
	[[ -f "${src}/.manifest.json" ]] || {
		warn "sibling ${src} has no .manifest.json; it is not bootstrapped either"
		return 1
	}

	mkdir -p "${MODEL_DATA_DIR}"
	# `${src}/.` — NOT `${src}/*.json`.
	#
	# The manifest is `.manifest.json`, a dotfile. A `*.json` glob silently
	# misses it, so the directory looks fully populated while every build still
	# fails with "model data is missing or stale" — the exact trap that cost a
	# lane its whole dispatch window on 2026-08-18. The trailing `/.` makes cp
	# copy the directory's contents including dotfiles.
	cp -R "${src}/." "${MODEL_DATA_DIR}/"

	[[ -f "${MODEL_DATA_MANIFEST}" ]] || \
		die "copied model data from ${src} but ${MODEL_DATA_REL}/.manifest.json is still missing" \
			"The copy dropped the dotfile. Re-run with --hydrate."
	return 0
}

if (( force_hydrate )); then
	log "Step 2/3: hydrating model data (--hydrate)"
	npm run hydrate:model-data || \
		die "npm run hydrate:model-data failed" \
			"This step needs network access to the model catalogs." \
			"Offline? Re-run with --from <path-to-a-bootstrapped-checkout>."
elif model_data_valid; then
	log "Step 2/3: model data already valid, skipping"
else
	log "Step 2/3: model data needs populating ($(describe_model_data_state))"

	copied=0
	if [[ "${sibling}" != "${REPO_ROOT}" ]] && copy_model_data_from_sibling "${sibling}"; then
		log "        copied from ${sibling} (including .manifest.json)"
		copied=1
	else
		log "        no usable sibling at ${sibling}"
	fi

	# A sibling at a different commit produces a manifest whose structureHash
	# does not match this worktree's provider sources, so validate before
	# trusting the copy and fall back to a real regeneration.
	if (( copied )) && model_data_valid; then
		log "        model data validated"
	else
		if (( copied )); then
			warn "copied model data did not validate (sibling is probably at a different commit); hydrating instead"
		fi
		log "        hydrating model data over the network"
		npm run hydrate:model-data || \
			die "npm run hydrate:model-data failed" \
				"This step needs network access to the model catalogs." \
				"Offline? Point --from at a checkout on the same commit as this one."
	fi
fi

if ! model_data_valid; then
	# Re-run non-silently so the validator's own diagnosis is the last thing printed.
	npm run --silent check:model-data || true
	die "model data is still invalid after step 2" \
		"Checked: ${MODEL_DATA_REL}/ (see the validator output above)" \
		"Try: npm run hydrate:model-data"
fi

# ---------------------------------------------------------------------------
# Step 3 — build the workspace packages
# ---------------------------------------------------------------------------
# npm links workspace packages but does not build them. Extensions import
# @lue-labs/pi-tui/dist etc., so an unbuilt worktree fails at import time.
log "Step 3/3: npm run build:offline"
npm run build:offline || \
	die "npm run build:offline failed" \
		"The failing package is named in the output above."

[[ -f "${BUILD_ARTIFACT}" ]] || \
	die "build reported success but ${BUILD_ARTIFACT#"${REPO_ROOT}/"} was not produced"

version="$(node "${BUILD_ARTIFACT}" --version 2>/dev/null)" || \
	die "built CLI does not run: node ${BUILD_ARTIFACT#"${REPO_ROOT}/"} --version failed"

log "Bootstrap complete — pi ${version} built at ${BUILD_ARTIFACT#"${REPO_ROOT}/"}"
