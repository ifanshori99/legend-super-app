#!/bin/sh
set -eu

check=deploy/edge/check-image-version.mjs
default_version=$(awk -F= '/^ARG EDGE_NODE_VERSION=/ { print $2 }' apps/api/Dockerfile)
EDGE_NODE_VERSION="$default_version" node "$check"
EDGE_NODE_VERSION=0.2.0 node "$check"
EDGE_NODE_VERSION=1.0.0 node "$check"
for version in '' dev 0.1.9 01.2.3; do
  if EDGE_NODE_VERSION="$version" node "$check" >/dev/null 2>&1; then
    echo "Expected EDGE_NODE_VERSION='$version' to be rejected" >&2
    exit 1
  fi
done
echo 'Edge image version checks passed.'
