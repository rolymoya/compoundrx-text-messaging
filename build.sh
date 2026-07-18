#!/usr/bin/env bash
# Builds the AWS Lambda deployment package (lambda.zip) from source.
# Run before deploying: `npm run build` (or `bash build.sh`).
set -euo pipefail

cd "$(dirname "$0")"

rm -f lambda.zip
zip -r -q lambda.zip \
  index.js \
  parser.js \
  dbUtils.js \
  s3FileReader.js \
  templates.js \
  package.json \
  package-lock.json \
  node_modules

echo "Built lambda.zip"
