#!/bin/bash
set -e
pnpm install --frozen-lockfile
mkdir -p data
pnpm --filter db push
