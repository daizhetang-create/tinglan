@echo off
chcp 65001 >nul
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先从 https://nodejs.org/ 安装 Node.js LTS。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 首次启动，正在安装依赖……
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

start "" "http://127.0.0.1:4317/"
call npm run dev

