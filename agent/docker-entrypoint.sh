#!/usr/bin/env bash
set -euo pipefail

: "${AGENT_ROLE:?AGENT_ROLE required (scout|surgeon)}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN required}"
: "${GITHUB_REPO:?GITHUB_REPO required}"
: "${DEMO_BRANCH:=demo}"

export GH_TOKEN="$GITHUB_TOKEN"
export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
export AWS_REGION_NAME="${AWS_REGION_NAME:-$AWS_REGION}"
export SCOUT_SOURCE="${SCOUT_SOURCE:-tinybird}"
export AGENT_ORCHESTRATOR="${AGENT_ORCHESTRATOR:-stepfunctions}"
export BEDROCK_MODEL_ID="${BEDROCK_MODEL_ID:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
export BEDROCK_DISABLED="${BEDROCK_DISABLED:-0}"

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

case "$AGENT_ROLE" in
  scout)
    : "${RESULT_S3_URI:?RESULT_S3_URI required for scout}"
    export RESULT_S3_URI
    pnpm agent:scout -- --full --emit-json --no-dispatch
    ;;
  surgeon)
    : "${SURGEON_PAYLOAD_B64:?SURGEON_PAYLOAD_B64 required for surgeon}"
    : "${FLAG_KEY:?FLAG_KEY required for surgeon}"
    : "${RESULT_S3_URI:?RESULT_S3_URI required for surgeon}"
    set +e
    OUT=$(pnpm agent:surgeon -- --payload="$SURGEON_PAYLOAD_B64" 2>&1)
    STATUS=$?
    set -e
    printf '%s\n' "$OUT"
    PR_URL=$(printf '%s\n' "$OUT" | grep -Eo 'https://github.com/[^[:space:]]+/pull/[0-9]+' | tail -n1 || true)
    if [[ "$STATUS" -eq 0 ]]; then
      OK=true
      ERR=""
    else
      OK=false
      ERR="surgeon_exit_$STATUS"
    fi
    printf '{"flag_key":"%s","ok":%s,"pr_url":"%s","error":%s}\n' \
      "$FLAG_KEY" "$OK" "$PR_URL" \
      "$(if [[ -n "$ERR" ]]; then printf '"%s"' "$ERR"; else printf 'null'; fi)" \
      | aws s3 cp - "$RESULT_S3_URI"
    exit "$STATUS"
    ;;
  *)
    echo "Unknown AGENT_ROLE=$AGENT_ROLE" >&2
    exit 2
    ;;
esac
