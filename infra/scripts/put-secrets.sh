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

SECRET_NAME="stale-flags/agent"
PAYLOAD=$(node -e '
const keys = [
  "GITHUB_TOKEN","GITHUB_REPO","DEMO_BRANCH",
  "TINYBIRD_API_HOST","TINYBIRD_APPEND_TOKEN","TINYBIRD_TOKEN","OLLAMA_DISABLED"
];
const out = {};
for (const k of keys) {
  out[k] = process.env[k] || (k === "DEMO_BRANCH" ? "demo" : k === "OLLAMA_DISABLED" ? "1" : k === "GITHUB_REPO" ? "lucamezzalira/stale-flag-cleanup" : "");
}
if (!out.TINYBIRD_API_HOST) out.TINYBIRD_API_HOST = "https://api.us-east.aws.tinybird.co";
process.stdout.write(JSON.stringify(out));
')

aws secretsmanager put-secret-value \
  --region "$REGION" \
  --secret-id "$SECRET_NAME" \
  --secret-string "$PAYLOAD" \
  --query 'VersionId' --output text

echo "Updated $SECRET_NAME in $REGION"
