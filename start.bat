@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
cd /d "%~dp0"

node -v >nul 2>nul
if errorlevel 1 goto NONODE

echo [Model Doctor] starting...
node "%~dp0bin\model-doctor.mjs" %*
if errorlevel 1 pause
exit /b 0

:NONODE
echo.
echo [ERROR] Node.js not found.
echo Please install Node.js 18+ from https://nodejs.org/
echo.
pause
exit /b 1
