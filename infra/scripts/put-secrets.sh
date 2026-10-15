#!/usr/bin/env bash
# Push local .env tokens into Secrets Manager (stale-flags/agent).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
REGION="${AWS_REGION:-us-east-1}"

if [[ ! -f .env ]]; then
  echo "Missing .env" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${GITHUB_TOKEN:-}" || -z "${TINYBIRD_TOKEN:-}" || -z "${TINYBIRD_DECISION_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN, TINYBIRD_TOKEN, and TINYBIRD_DECISION_TOKEN must be set in .env" >&2
  exit 1
fi

if [[ -z "${TINYBIRD_MCP_TOKEN:-}" ]]; then
  echo "warning: TINYBIRD_MCP_TOKEN unset; surgeon evidence narrative will be unavailable" >&2
fi

SECRET_NAME="stale-flags/agent"
PAYLOAD=$(node -e '
const keys = [
  "GITHUB_TOKEN","GITHUB_REPO","DEMO_BRANCH",
  "TINYBIRD_API_HOST","TINYBIRD_TOKEN","TINYBIRD_DECISION_TOKEN",
  "TINYBIRD_MCP_TOKEN","OLLAMA_DISABLED"
];
const out = {};
for (const k of keys) {
  out[k] = process.env[k] || (k === "DEMO_BRANCH" ? "demo" : k === "OLLAMA_DISABLED" ? "1" : k === "GITHUB_REPO" ? "lucamezzalira/stale-flag-cleanup" : "");
}
if (!out.TINYBIRD_API_HOST) out.TINYBIRD_API_HOST = "https://api.us-east.aws.tinybird.co";
for (const req of ["GITHUB_TOKEN","TINYBIRD_TOKEN","TINYBIRD_DECISION_TOKEN"]) {
  if (!out[req]) { console.error("missing " + req); process.exit(1); }
}
process.stdout.write(JSON.stringify(out));
')

aws secretsmanager put-secret-value \
  --region "$REGION" \
  --secret-id "$SECRET_NAME" \
  --secret-string "$PAYLOAD" \
  --query 'VersionId' --output text

echo "Updated $SECRET_NAME in $REGION"
