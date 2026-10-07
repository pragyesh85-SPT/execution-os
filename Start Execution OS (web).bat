@echo off
title Execution OS - local hub
cd /d "%~dp0"
if not exist "dist\index.html" call npm run build
if not exist "build\server.cjs" call npm run build:node
start "" http://localhost:4747
node build\server.cjs
pause
