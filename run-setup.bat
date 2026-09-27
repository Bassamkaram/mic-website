@echo off
REM =====================================================================
REM  MIC website - Git setup launcher
REM
REM  Double-click THIS file, not the .ps1
REM
REM  Windows blocks unsigned PowerShell scripts by default. This launcher
REM  bypasses that for this one run only, and keeps the window open so you
REM  can read the output even if something fails.
REM =====================================================================

cd /d "%~dp0"

echo.
echo Starting MIC Git setup...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0setup-git.ps1"
