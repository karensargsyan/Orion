# GitHub Pages Setup Instructions

## Problem
The privacy policy link `https://karensargsyan.github.io/Orion/privacy-policy.html` returns 404 because GitHub Pages isn't enabled yet for the repository.

## Solution (One-Time Manual Setup Required)

GitHub Pages requires a **one-time manual configuration** in your repository settings. This takes 30 seconds.

### Step-by-Step Instructions

1. **Go to your GitHub repository:**
   ```
   https://github.com/karensargsyan/Orion
   ```

2. **Click "Settings"** (top navigation bar)

3. **Click "Pages"** (left sidebar, under "Code and automation")

4. **Configure the source:**
   - Under "Build and deployment"
   - **Source:** Select `Deploy from a branch`
   - **Branch:** Select `gh-pages` (dropdown)
   - **Folder:** Select `/ (root)` (dropdown)
   - Click **Save**

5. **Wait 2-3 minutes** for GitHub to deploy

6. **Test the link:**
   ```
   https://karensargsyan.github.io/Orion/privacy-policy.html
   ```

### Screenshot Reference

The settings page should look like this:

```
Pages
─────────────────────────────────────────
Build and deployment

Source: Deploy from a branch  [dropdown ▼]

Branch:
┌─────────────┬──────────┬──────┐
│ gh-pages ▼  │ /(root) ▼│ Save │
└─────────────┴──────────┴──────┘
```

---

## What's Already Done (No Action Needed)

✅ Privacy policy file created and enhanced for Chrome Web Store compliance
✅ `gh-pages` branch created with privacy policy at root
✅ `index.html` redirect page added
✅ All files pushed to GitHub
✅ Failed GitHub Actions workflow removed

**Only missing step:** Enable GitHub Pages in repository settings (see above).

---

## After Enabling Pages

Once you enable Pages in settings, GitHub will automatically:
1. Deploy the `gh-pages` branch
2. Make the site live at `https://karensargsyan.github.io/Orion/`
3. Update the deployment every time you push to `gh-pages` branch

**The link will work forever** after this one-time setup.

---

## Alternative: Use GitHub API to Enable Pages (Advanced)

If you have a GitHub Personal Access Token with `repo` scope, you can enable Pages programmatically:

```bash
# Set your GitHub token
export GITHUB_TOKEN="your_github_token_here"

# Enable Pages via API
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/karensargsyan/Orion/pages \
  -d '{
    "source": {
      "branch": "gh-pages",
      "path": "/"
    }
  }'
```

**But the UI method (above) is simpler and takes 30 seconds.**

---

## Verification

After enabling Pages, verify:

1. **Check deployment status:**
   ```
   https://github.com/karensargsyan/Orion/deployments
   ```

2. **Test the live link:**
   ```bash
   curl -I https://karensargsyan.github.io/Orion/privacy-policy.html
   # Should return: HTTP/2 200
   ```

3. **View in browser:**
   - Navigate to: https://karensargsyan.github.io/Orion/privacy-policy.html
   - Should show: Orion Privacy Policy page (styled, with 13 sections)

---

## Troubleshooting

**Still getting 404 after enabling Pages?**
- Wait 2-3 minutes for GitHub's CDN to update
- Check repository visibility (must be public for free GitHub Pages)
- Verify branch name is exactly `gh-pages` (lowercase, dash not underscore)
- Clear browser cache: `Cmd+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows)

**Need to update the privacy policy later?**

Option 1 (Recommended):
```bash
# Edit on master
git checkout master
# Edit: docs/privacy-policy.html
git add docs/privacy-policy.html
git commit -m "update: privacy policy"
git push github master

# Copy to gh-pages
git checkout gh-pages
git checkout master -- docs/privacy-policy.html
mv docs/privacy-policy.html .
rmdir docs
git add privacy-policy.html
git commit -m "sync: update privacy policy from master"
git push github gh-pages
git checkout master
```

Option 2 (Quick):
```bash
# Edit directly on gh-pages
git checkout gh-pages
# Edit: privacy-policy.html
git add privacy-policy.html
git commit -m "update: privacy policy"
git push github gh-pages
git checkout master
```

---

## Contact

If you encounter issues, the problem is almost certainly that Pages isn't enabled in GitHub settings. Double-check step 4 above.

Once enabled, the link will be stable and work permanently (unless the repo is deleted or made private).
