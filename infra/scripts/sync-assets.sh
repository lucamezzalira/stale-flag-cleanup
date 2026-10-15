#!/usr/bin/env bash
# Upload datafile + web build to the deployed stack (us-east-1).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK_NAME:-StaleFlagsStack}"

echo "Reading outputs from $STACK ($REGION)…"
OUT=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query 'Stacks[0].Outputs' --output json)

web_bucket=$(node -e "const o=JSON.parse(process.argv[1]); console.log(o.find(x=>x.OutputKey==='WebBucketName').OutputValue)" "$OUT")
data_bucket=$(node -e "const o=JSON.parse(process.argv[1]); console.log(o.find(x=>x.OutputKey==='DatafileBucketName').OutputValue)" "$OUT")
data_cf=$(node -e "const o=JSON.parse(process.argv[1]); console.log(o.find(x=>x.OutputKey==='DatafileCloudFrontDomain').OutputValue)" "$OUT")
web_url=$(node -e "const o=JSON.parse(process.argv[1]); console.log(o.find(x=>x.OutputKey==='WebUrl').OutputValue)" "$OUT")
data_dist=$(node -e "const o=JSON.parse(process.argv[1]); console.log((o.find(x=>x.OutputKey==='DatafileDistributionId')||{}).OutputValue||'')" "$OUT")
web_dist=$(node -e "const o=JSON.parse(process.argv[1]); console.log((o.find(x=>x.OutputKey==='WebDistributionId')||{}).OutputValue||'')" "$OUT")

DATAFILE_URL="https://${data_cf}/featurevisor/production/featurevisor-all.json"

echo "Building Featurevisor datafile…"
pnpm datafile:build

echo "Uploading datafile → s3://$data_bucket/featurevisor/…"
aws s3 sync featurevisor/datafiles/ "s3://${data_bucket}/featurevisor/" \
  --region "$REGION" \
  --cache-control "max-age=60" \
  --exclude "*" --include "*.json"

if [[ -n "$data_dist" ]]; then
  aws cloudfront create-invalidation --distribution-id "$data_dist" --paths "/featurevisor/*" \
    --region "$REGION" --query 'Invalidation.Id' --output text
fi

# Load Tinybird browser ingest from .env first, then force CloudFront datafile URL
# (sourcing .env must not overwrite VITE_DATAFILE_URL with a local stand-in)
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  export VITE_TINYBIRD_API_HOST="${VITE_TINYBIRD_API_HOST:-$TINYBIRD_API_HOST}"
  export VITE_TINYBIRD_BROWSER_EVENTS_TOKEN="${VITE_TINYBIRD_BROWSER_EVENTS_TOKEN:-$TINYBIRD_BROWSER_EVENTS_TOKEN}"
fi
export VITE_DATAFILE_URL="$DATAFILE_URL"
echo "Building web with VITE_DATAFILE_URL=$VITE_DATAFILE_URL …"
pnpm --filter @stale-flags/web build

echo "Uploading web → s3://$web_bucket/ …"
aws s3 sync apps/web/dist/ "s3://${web_bucket}/" \
  --region "$REGION" \
  --delete \
  --cache-control "max-age=60"

if [[ -n "$web_dist" ]]; then
  aws cloudfront create-invalidation --distribution-id "$web_dist" --paths "/*" \
    --region "$REGION" --query 'Invalidation.Id' --output text
fi

echo ""
echo "Web:      $web_url"
echo "Datafile: $DATAFILE_URL"
echo "Set in .env:"
echo "  AWS_REGION=$REGION"
echo "  DATAFILE_S3_BUCKET=$data_bucket"
echo "  DATAFILE_S3_PREFIX=featurevisor"
echo "  DATAFILE_CLOUDFRONT_URL=https://$data_cf/featurevisor"
echo "  VITE_DATAFILE_URL=$DATAFILE_URL"
