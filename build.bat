@echo off
title Build Paradox Backup
cd /d "%~dp0"
set CSC_IDENTITY_AUTO_DISCOVERY=false
echo ==============================================
echo  Paradox Backup - build Setup.exe
echo  (no Administrator rights needed)
echo ==============================================
where node >nul 2>nul
if errorlevel 1 goto nonode
call npm install
if errorlevel 1 goto fail
call npm run dist
if errorlevel 1 goto fail
echo.
echo DONE. Setup file is in the dist folder.
start "" "%~dp0dist"
pause
exit /b 0

:nonode
echo Node.js was not found. Install it from https://nodejs.org then run this file again.
pause
exit /b 1

:fail
echo.
echo Build failed. See the messages above.
echo If the error mentions "symbolic link", turn on Windows Developer Mode:
echo   Settings - Privacy and security - For developers - Developer Mode = On
echo then delete %%LOCALAPPDATA%%\electron-builder\Cache and run this file again.
pause
exit /b 1
