#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN required}"
: "${GITHUB_REPO:?GITHUB_REPO required}"
: "${DEMO_BRANCH:=demo}"
: "${RESULT_S3_URI:?RESULT_S3_URI required for scout}"

export GH_TOKEN="$GITHUB_TOKEN"
export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
export AWS_REGION_NAME="${AWS_REGION_NAME:-$AWS_REGION}"
export SCOUT_SOURCE="${SCOUT_SOURCE:-tinybird}"
export AGENT_ORCHESTRATOR="${AGENT_ORCHESTRATOR:-stepfunctions}"
export RESULT_S3_URI

git config --global credential.helper \
  '!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f'

rm -rf /work/app
git clone --depth 50 --branch "$DEMO_BRANCH" \
  "https://github.com/${GITHUB_REPO}.git" /work/app
cd /work/app

echo "branch=$(git rev-parse --abbrev-ref HEAD) sha=$(git rev-parse --short HEAD)"
pnpm install --frozen-lockfile
pnpm --filter @stale-flags/defs-utils \
  --filter @stale-flags/verdicts \
  --filter @stale-flags/local-store \
  run build

pnpm agent:scout -- --full --emit-json --no-dispatch
