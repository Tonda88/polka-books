@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запускаем «Полку»: http://127.0.0.1:4173
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите Node.js 20+ с https://nodejs.org
  pause
  exit /b 1
)
start "" http://127.0.0.1:4173
node server\serve.mjs
pause
