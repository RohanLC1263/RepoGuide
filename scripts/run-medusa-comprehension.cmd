@echo off
REM Run from the repo root (this script lives in scripts/, so %~dp0.. is the root).
REM Uses `node` from PATH rather than a hardcoded node.exe location.
cd /d "%~dp0.."
node scripts\run-medusa-comprehension.js > medusa_comprehension.log 2> medusa_comprehension.err.log
