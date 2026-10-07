@echo off
title Execution OS - build everything
cd /d "%~dp0"
rem Machine-specific settings (SDK paths, build drive) go in local-env.bat, which is not committed.
if exist "%~dp0local-env.bat" call "%~dp0local-env.bat"
call npm run build || goto :fail
call npx vitest run || goto :fail
call npx electron-builder --config electron-builder.config.cjs --win portable nsis --x64 || goto :fail
call npx cap sync android || goto :fail
call node scripts\build-apk.mjs || goto :fail
echo.
if defined EOS_BUILD_DIR (echo All builds are in %EOS_BUILD_DIR%\release) else (echo All builds are in %~dp0release)
pause
exit /b 0
:fail
echo BUILD FAILED - see the messages above.
pause
exit /b 1
