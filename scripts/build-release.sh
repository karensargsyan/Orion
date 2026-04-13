#!/bin/bash
# Build and package Orion for Chrome Web Store submission
set -e

echo "=== Orion Release Builder ==="

# Clean
echo "Cleaning dist/..."
rm -rf dist/

# Build
echo "Building..."
npx tsx build.ts

# Remove source maps (not needed in store submission)
echo "Removing source maps..."
find dist/ -name "*.map" -delete

# Remove SVG source icons (only PNGs needed)
find dist/icons -name "*.svg" -delete 2>/dev/null || true

# Create ZIP
VERSION=$(node -e "console.log(require('./src/manifest.json').version)")
ZIP_NAME="orion-v${VERSION}.zip"

echo "Creating ${ZIP_NAME}..."
cd dist
zip -r "../${ZIP_NAME}" . -x ".DS_Store" "*.map"
cd ..

# Show result
SIZE=$(ls -lh "${ZIP_NAME}" | awk '{print $5}')
echo ""
echo "=== Done ==="
echo "Package: ${ZIP_NAME} (${SIZE})"
echo "Max allowed: 16 MB"
echo ""
echo "Upload at: https://chrome.google.com/webstore/devconsole"
