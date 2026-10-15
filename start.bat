@echo off
REM Segmentation Tool launcher for Windows. Double-click to start.
REM First run installs the app's libraries (1-2 minutes); later runs start in seconds.
setlocal
cd /d "%~dp0"

where uv >nul 2>nul
if errorlevel 1 set "PATH=%USERPROFILE%\.local\bin;%USERPROFILE%\.cargo\bin;%PATH%"
where uv >nul 2>nul
if errorlevel 1 (
  echo Installing "uv" ^(the tool that sets up Python for this app^) ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.local\bin;%USERPROFILE%\.cargo\bin;%PATH%"
)
where uv >nul 2>nul
if errorlevel 1 (
  echo Could not install uv. Please install it from https://docs.astral.sh/uv/ and run this file again.
  pause
  exit /b 1
)

echo Preparing Segmentation Tool ^(this takes a minute the first time^) ...
REM --inexact keeps PyTorch/SAM 2 that the app installed for your GPU.
uv sync --no-dev --inexact --frozen
if errorlevel 1 ( pause & exit /b 1 )
uv run --no-dev --frozen python scripts\run_app.py %*
if errorlevel 1 pause
