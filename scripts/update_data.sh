#!/bin/bash
#
# Automated script to update course data and deploy
# 
# Usage:
#   ./scripts/update_data.sh
#
# This script will:
# 1. Export latest data from Neon database to static JSON
# 2. Commit the changes
# 3. Push to trigger automatic deployment
#

set -e  # Exit on error

echo "=========================================="
echo "🔄 UW Course Data Update Script"
echo "=========================================="
echo ""

# Check if we're in the project root
if [ ! -f "scripts/export_db_to_static.py" ]; then
    echo "❌ Error: Must run from project root directory"
    echo "   Usage: ./scripts/update_data.sh"
    exit 1
fi

# Check if venv exists
if [ ! -d "venv" ]; then
    echo "❌ Error: Virtual environment not found at ./venv"
    echo "   Create it with: python3 -m venv venv"
    exit 1
fi

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "⚠️  Warning: .env file not found"
    echo "   Make sure NEON_URL environment variable is set"
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source venv/bin/activate

# Run export script
echo ""
echo "📦 Exporting database to static JSON..."
python3 scripts/export_db_to_static.py

# Check if data file was created
if [ ! -f "data/courses_data.json" ]; then
    echo "❌ Error: Export failed - data/courses_data.json not found"
    exit 1
fi

# Get file size for info
FILE_SIZE=$(du -h data/courses_data.json | cut -f1)
echo ""
echo "✅ Export successful: data/courses_data.json ($FILE_SIZE)"
echo ""

# Git operations
echo "📝 Committing changes..."

# Check if there are changes to commit
if git diff --quiet data/courses_data.json 2>/dev/null; then
    echo "ℹ️  No changes detected in course data"
    echo "   Database content is identical to last export"
    echo ""
    echo "✨ Nothing to deploy - data is already up to date!"
    exit 0
fi

# Stage the data file
git add data/courses_data.json

# Create commit with timestamp
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
git commit -m "Update course data - $TIMESTAMP

- Exported from Neon database
- File size: $FILE_SIZE
- Automated update via scripts/update_data.sh"

echo ""
echo "✅ Changes committed"
echo ""

# Ask before pushing (safety check)
read -p "🚀 Push to deploy? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "📤 Pushing to remote..."
    git push
    echo ""
    echo "=========================================="
    echo "✅ Update Complete!"
    echo "=========================================="
    echo ""
    echo "Your changes are now deploying to production."
    echo "Check your Netlify dashboard for deployment status."
    echo ""
else
    echo ""
    echo "⏸️  Push cancelled"
    echo "   Changes are committed locally but not pushed"
    echo "   Run 'git push' when ready to deploy"
    echo ""
fi

