# Запуск «Полки»: сборка и preview-сервер.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host 'Node.js не найден. Установите Node.js 20+ и запустите снова: https://nodejs.org' -ForegroundColor Red
  exit 1
}

if (-not (Test-Path 'node_modules')) {
  Write-Host 'Устанавливаем зависимости…'
  $npm = Join-Path (Split-Path $node) 'npm.cmd'
  if (Test-Path $npm) {
    & $npm install
  } else {
    Write-Host 'Не найден npm. Выполните вручную: npm install' -ForegroundColor Red
    exit 1
  }
}

Write-Host 'Проверяем типы…'
& $node node_modules/typescript/bin/tsc --noEmit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Собираем приложение…'
& $node node_modules/vite/bin/vite.js build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host 'Полка запущена: http://127.0.0.1:4173' -ForegroundColor Green
Write-Host 'Остановить сервер — Ctrl+C. Телефон в той же сети: см. README (нужен HTTPS для офлайн-режима).'
Start-Process 'http://127.0.0.1:4173'
& $node server/serve.mjs
