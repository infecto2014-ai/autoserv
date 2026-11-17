@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите Node.js 22.12+ или 24 LTS и повторите запуск.
  pause
  exit /b 1
)
node "%~dp0scripts\local.mjs" setup %*
set "launcher_exit=%errorlevel%"
echo.
pause
exit /b %launcher_exit%
