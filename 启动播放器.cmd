@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "studyExit=%errorlevel%"
if not "%studyExit%"=="0" pause
exit /b %studyExit%
