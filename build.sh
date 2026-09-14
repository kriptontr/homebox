#!/bin/bash

# A script to replicate the local build steps from the Dockerfile.
# This script builds the frontend and then the backend.

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
FRONTEND_DIR="frontend"
BACKEND_DIR="backend"
BUILD_DIR="build"
OUTPUT_BINARY="$BUILD_DIR/homebox"

# --- Prerequisites Check ---
echo "Checking for prerequisites..."

if ! command -v go &> /dev/null; then
    echo "Go is not installed. Please install Go to build the backend."
    exit 1
fi

if ! command -v pnpm &> /dev/null; then
    echo "pnpm is not installed. Please install it first."
    echo "See: https://pnpm.io/installation"
    exit 1
fi

if ! command -v git &> /dev/null; then
    echo "git is not installed. It's needed to get version information."
    exit 1
fi

echo "All prerequisites are met."
echo

# --- Frontend Build ---
echo "--- Building Frontend ---"
cd "$FRONTEND_DIR"

echo "Installing frontend dependencies with pnpm..."
pnpm install --frozen-lockfile

echo "Building frontend application..."
pnpm build

cd ..
echo "Frontend build complete. Output is in $FRONTEND_DIR/.output/public"
echo

# --- Backend Build ---
echo "--- Building Backend ---"

# The backend needs the frontend assets.
# This mirrors the Dockerfile's logic of copying built assets.
echo "Preparing backend assets..."
rm -rf "$BACKEND_DIR/app/api/static/public"
mkdir -p "$BACKEND_DIR/app/api/static/public"
cp -r "$FRONTEND_DIR/.output/public" "$BACKEND_DIR/app/api/static"
echo "Frontend assets copied to backend."
echo

# Get build information for ldflags from git and current time
# Using `git describe` for version, falling back to "dev"
VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo "dev")
# Using short git commit hash
COMMIT=$(git rev-parse --short HEAD)
# Using current UTC time
BUILD_TIME=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

LDFLAGS="-s -w -X main.version=$VERSION -X main.commit=$COMMIT -X main.buildTime=$BUILD_TIME"

# Create build directory
mkdir -p "$BUILD_DIR"

# Change to backend directory to run the build
cd "$BACKEND_DIR"

# Determine local architecture for build tags, mirroring the Dockerfile
TARGETARCH=$(go env GOARCH)
BUILD_TAGS=""
if [ "$TARGETARCH" = "arm" ] || [ "$TARGETARCH" = "riscv64" ]; then
    echo "Detected ARM/RISCV64 architecture, adding 'nodynamic' build tag."
    BUILD_TAGS="-tags nodynamic"
fi

echo "Building backend Go application..."
# The Dockerfile uses CGO_ENABLED=0 for a static binary, which is good practice.
CGO_ENABLED=0 go build -ldflags "$LDFLAGS" $BUILD_TAGS -v -o "../$OUTPUT_BINARY" ./app/api

cd ..

echo
echo "--- Build Complete ---"
echo "Backend binary created at: $OUTPUT_BINARY"
echo "You can now run ./$OUTPUT_BINARY"