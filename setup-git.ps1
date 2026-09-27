# =====================================================================
#  MIC website - one-time Git setup for Netlify continuous deploy
#
#  DO NOT run this file directly. Double-click run-setup.bat instead.
#  Windows blocks unsigned .ps1 scripts, which makes the window close
#  instantly with no message. The .bat launcher works around that.
# =====================================================================

# Always operate in the folder this script lives in, regardless of how
# it was launched. This is the usual cause of "file not found" errors.
if ($PSScriptRoot) { Set-Location $PSScriptRoot }

function Pause-AndExit($code) {
    Write-Host ""
    Read-Host "Press Enter to close"
    exit $code
}

try {

    Write-Host ""
    Write-Host "=== MIC website: Git setup ===" -ForegroundColor Cyan
    Write-Host ("Working in: " + (Get-Location)) -ForegroundColor DarkGray
    Write-Host ""

    # --- Step 0: confirm we are in the site folder --------------------
    if (-not (Test-Path ".\index.html")) {
        Write-Host "index.html was not found in this folder." -ForegroundColor Red
        Write-Host ""
        Write-Host "This script and run-setup.bat must sit in your site folder,"
        Write-Host "the same folder that contains index.html, styles.css and scripts.js."
        Write-Host ""
        Write-Host "Files I can see here:" -ForegroundColor Yellow
        Get-ChildItem -File | Select-Object -First 15 |
            ForEach-Object { Write-Host ("   " + $_.Name) }
        Pause-AndExit 1
    }
    Write-Host "[ok] Found index.html." -ForegroundColor Green

    # --- Step 1: confirm git is installed -----------------------------
    $gitOk = $false
    try {
        $gitVersion = (git --version) 2>&1
        if ($LASTEXITCODE -eq 0) { $gitOk = $true }
    } catch { $gitOk = $false }

    if (-not $gitOk) {
        Write-Host "Git is not installed, or is not on your PATH." -ForegroundColor Red
        Write-Host ""
        Write-Host "1. Install from https://git-scm.com/download/win"
        Write-Host "2. Accept every default during install"
        Write-Host "3. Close this window, then double-click run-setup.bat again"
        Pause-AndExit 1
    }
    Write-Host ("[ok] " + $gitVersion) -ForegroundColor Green

    # --- Step 2: show what will be committed --------------------------
    Write-Host ""
    Write-Host "Files that will go into the repo:" -ForegroundColor Cyan
    $files = Get-ChildItem -File | Where-Object {
        $_.Extension -notin @(".ps1", ".bat")
    }
    $files | Select-Object -First 30 | ForEach-Object {
        Write-Host ("   " + $_.Name)
    }
    if ($files.Count -gt 30) {
        Write-Host ("   ... and " + ($files.Count - 30) + " more")
    }
    Write-Host ("   TOTAL: " + $files.Count + " files")
    Write-Host ""

    $confirm = Read-Host "Does that look right? (y/n)"
    if ($confirm -ne "y") {
        Write-Host "Stopped. Nothing was changed." -ForegroundColor Yellow
        Pause-AndExit 0
    }

    # --- Step 3: flag duplicate browser downloads ---------------------
    $dupes = Get-ChildItem -File | Where-Object { $_.Name -match '\(\d+\)\.(html|css|js)$' }
    if ($dupes) {
        Write-Host ""
        Write-Host "WARNING: duplicate downloads found:" -ForegroundColor Yellow
        $dupes | ForEach-Object { Write-Host ("   " + $_.Name) }
        Write-Host ""
        Write-Host "These usually mean a file did not overwrite properly, which would"
        Write-Host "explain deploys that seemed to not take effect. They are excluded"
        Write-Host "by .gitignore, but confirm your real files are the current ones."
        Read-Host "Press Enter to continue"
    }

    # --- Step 4: init repo --------------------------------------------
    if (Test-Path ".\.git") {
        Write-Host "[skip] Repo already initialized." -ForegroundColor Yellow
    } else {
        git init | Out-Null
        git branch -M main
        Write-Host "[ok] Repo initialized on branch 'main'." -ForegroundColor Green
    }

    # --- Step 5: commit identity --------------------------------------
    if (-not (git config user.name)) {
        $n = Read-Host "Your name for commit messages"
        git config user.name "$n"
    }
    if (-not (git config user.email)) {
        $e = Read-Host "Your email for commit messages"
        git config user.email "$e"
    }
    Write-Host "[ok] Commit identity set." -ForegroundColor Green

    # --- Step 6: commit -----------------------------------------------
    git add .
    $staged = git diff --cached --name-only
    if (-not $staged) {
        Write-Host "[skip] Nothing new to commit." -ForegroundColor Yellow
    } else {
        git commit -m "MIC website: initial commit" | Out-Null
        Write-Host ("[ok] Committed " + ($staged | Measure-Object).Count + " files.") -ForegroundColor Green
    }

    # --- Step 7: remote and push ---------------------------------------
    $existingRemote = (git remote get-url origin) 2>$null
    if ($existingRemote) {
        Write-Host ("[skip] Remote already set: " + $existingRemote) -ForegroundColor Yellow
    } else {
        Write-Host ""
        Write-Host "Paste your GitHub repo URL." -ForegroundColor Cyan
        Write-Host "Looks like: https://github.com/YOUR-USERNAME/mic-website.git"
        $repoUrl = Read-Host "Repo URL"
        if (-not $repoUrl) {
            Write-Host "No URL given. Stopping before push." -ForegroundColor Yellow
            Write-Host "Your files are committed locally. Re-run this to push later."
            Pause-AndExit 0
        }
        git remote add origin "$repoUrl"
        Write-Host "[ok] Remote added." -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "Pushing to GitHub." -ForegroundColor Cyan
    Write-Host "A sign-in window may appear. Use your GitHub account."
    Write-Host ""

    git push -u origin main

    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "Push failed. The message above says why." -ForegroundColor Red
        Write-Host "Most common cause: the repo on GitHub is not empty, or the URL is wrong."
        Pause-AndExit 1
    }

    Write-Host ""
    Write-Host "=== Pushed successfully ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "Now link Netlify to the repo:"
    Write-Host "  1. Netlify > your site > Site configuration"
    Write-Host "  2. Build and deploy > Continuous deployment > Link repository"
    Write-Host "  3. Choose GitHub, authorize, pick your repo"
    Write-Host "  4. Leave build command EMPTY. Publish directory is '.'"
    Write-Host ""
    Write-Host "After that, every update is:"
    Write-Host "     git add ."
    Write-Host "     git commit -m 'what changed'"
    Write-Host "     git push"
    Write-Host ""
    Pause-AndExit 0

} catch {
    Write-Host ""
    Write-Host "Something went wrong:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "Copy this message and send it over."
    Pause-AndExit 1
}
