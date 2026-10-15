#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN required}"
: "${GITHUB_REPO:?GITHUB_REPO required}"
: "${DEMO_BRANCH:=demo}"
: "${PLAN_S3_URI:?PLAN_S3_URI required for surgeon}"
: "${RESULT_S3_URI:?RESULT_S3_URI required for surgeon}"

export GH_TOKEN="$GITHUB_TOKEN"
export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
export AWS_REGION_NAME="${AWS_REGION_NAME:-$AWS_REGION}"
export AGENT_ORCHESTRATOR="${AGENT_ORCHESTRATOR:-stepfunctions}"
export BEDROCK_MODEL_ID="${BEDROCK_MODEL_ID:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
export BEDROCK_DISABLED="${BEDROCK_DISABLED:-0}"
export PLAN_S3_URI
export RESULT_S3_URI

gh auth setup-git
rm -rf /work/app
git clone --depth 50 --branch "$DEMO_BRANCH" \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git" /work/app
cd /work/app

echo "branch=$(git rev-parse --abbrev-ref HEAD) sha=$(git rev-parse --short HEAD)"
pnpm install --frozen-lockfile
pnpm --filter @stale-flags/defs-utils \
  --filter @stale-flags/verdicts \
  --filter @stale-flags/local-store \
  --filter @stale-flags/flag-client \
  run build

set +e
OUT=$(pnpm agent:surgeon -- --plan-s3="$PLAN_S3_URI" 2>&1)
STATUS=$?
set -e
printf '%s\n' "$OUT"
# Surgeon writes RESULT_S3_URI itself in plan mode; keep exit status.
exit "$STATUS"
