@echo off
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.12 或以上版本：https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0scripts\setup-asr.mjs"
pause
