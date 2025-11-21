#!/bin/bash

# Script to remove Chrome browser policies
# WARNING: Only run this if you have administrative rights and understand the implications
# Removing enterprise policies may violate your organization's IT policies

set -e

echo "Chrome Policy Removal Script"
echo "============================="
echo ""
echo "WARNING: This script will remove Chrome policies from your system."
echo "This should only be done if you have administrative rights and understand"
echo "the security implications of removing browser policies."
echo ""
echo "Common policy locations:"
echo "- /Library/Managed Preferences/com.google.Chrome.plist (macOS)"
echo "- /etc/opt/chrome/policies/managed/ (Linux)"
echo "- Registry keys (Windows)"
echo ""

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Detected macOS"

    # macOS policy locations
    POLICY_FILES=(
        "/Library/Managed Preferences/com.google.Chrome.plist"
        "/Library/Managed Preferences/com.google.Chrome.plist.backup"
        "/Library/Preferences/com.google.Chrome.plist"
        "$HOME/Library/Preferences/com.google.Chrome.plist"
    )

    echo "Removing Chrome policy files on macOS..."
    for file in "${POLICY_FILES[@]}"; do
        if [[ -f "$file" ]]; then
            echo "Removing: $file"
            sudo rm -f "$file"
        else
            echo "Not found: $file"
        fi
    done

    # Also check for Chrome app policies
    CHROME_APP_DIR="/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/Current/Resources"
    if [[ -d "$CHROME_APP_DIR" ]]; then
        echo "Checking Chrome app directory for policies..."
        # This is where some policies might be embedded
    fi

    echo "Clearing Chrome user data policies..."
    # Clear any cached policy data
    CHROME_USER_DATA="$HOME/Library/Application Support/Google/Chrome"
    if [[ -d "$CHROME_USER_DATA" ]]; then
        echo "Removing policy-related files from Chrome user data..."
        rm -rf "$CHROME_USER_DATA/Local State" 2>/dev/null || true
        rm -rf "$CHROME_USER_DATA/Preferences" 2>/dev/null || true
    fi

elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "Detected Linux"

    # Linux policy locations
    POLICY_DIRS=(
        "/etc/opt/chrome/policies/managed"
        "/etc/opt/chrome/policies/recommended"
        "/etc/chromium/policies/managed"
        "/etc/chromium/policies/recommended"
        "$HOME/.config/google-chrome"
    )

    echo "Removing Chrome policy directories on Linux..."
    for dir in "${POLICY_DIRS[@]}"; do
        if [[ -d "$dir" ]]; then
            echo "Removing directory: $dir"
            sudo rm -rf "$dir"
        else
            echo "Not found: $dir"
        fi
    done

    echo "Clearing Chrome user data policies..."
    CHROME_USER_DATA="$HOME/.config/google-chrome"
    if [[ -d "$CHROME_USER_DATA" ]]; then
        echo "Removing policy-related files from Chrome user data..."
        rm -f "$CHROME_USER_DATA/Local State" 2>/dev/null || true
        rm -f "$CHROME_USER_DATA/Preferences" 2>/dev/null || true
    fi

elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
    echo "Detected Windows"

    echo "For Windows, Chrome policies are typically stored in the registry."
    echo "This script cannot modify the Windows registry directly."
    echo ""
    echo "To remove Chrome policies on Windows:"
    echo "1. Press Win + R, type 'regedit', and press Enter"
    echo "2. Navigate to: HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome"
    echo "3. Delete the entire 'Chrome' key"
    echo "4. Also check: HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Google\\Chrome"
    echo ""
    echo "Alternatively, you can use Group Policy Editor:"
    echo "1. Press Win + R, type 'gpedit.msc', and press Enter"
    echo "2. Navigate to: Computer Configuration > Administrative Templates > Google > Google Chrome"
    echo "3. Remove or disable unwanted policies"
    echo ""
    echo "Note: Administrative privileges may be required."

else
    echo "Unsupported operating system: $OSTYPE"
    echo "This script supports macOS, Linux, and Windows."
    exit 1
fi

echo ""
echo "Policy removal complete."
echo ""
echo "Next steps:"
echo "1. Restart Chrome browser"
echo "2. Check chrome://policy in Chrome to verify policies are removed"
echo "3. If policies persist, they may be enforced by your organization's domain administrator"
echo ""
echo "Note: If you work in an enterprise environment, removing policies may violate"
echo "your organization's IT security policies. Consult with your IT department first."
