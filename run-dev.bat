@echo off
title Paradox Backup (dev)
cd /d "%~dp0"
call npm install
if errorlevel 1 goto fail
call npm start
exit /b 0

:fail
echo npm install failed. Is Node.js installed?
pause
exit /b 1
