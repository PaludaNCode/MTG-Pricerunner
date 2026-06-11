@echo off
REM ============================================================
REM  Card Price Watcher - one-click launcher
REM  1) opens debug Chrome (separate profile) with the Cardmarket tabs
REM  2) starts the Node watcher server
REM  3) opens the dashboard in your browser
REM
REM  FIRST TIME EACH SESSION: in the Chrome window that opens,
REM  make sure you are LOGGED IN to Cardmarket and any
REM  "Verify you are human" check is cleared. Then leave it open.
REM ============================================================

cd /d "%~dp0"

REM 0) Block focus-stealing (belt-and-suspenders with the background-tab scraping).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-foreground-lock.ps1" >nul

REM 1) Debug Chrome (CDP on 9222, isolated profile) + the 3 Cardmarket cards
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%USERPROFILE%\chrome-debug" ^
  "https://www.cardmarket.com/en/Magic/Products/Singles/Secrets-of-Strixhaven/Flow-State?language=7" ^
  "https://www.cardmarket.com/en/Magic/Products/Singles/Secrets-of-Strixhaven-Mystical-Archive/Stock-Up-V1?language=7" ^
  "https://www.cardmarket.com/en/Magic/Products/Singles/Aetherdrift/Stock-Up?language=7"

REM 2) Give Chrome a moment to open the debug port
timeout /t 3 /nobreak >nul

REM 3) Start the watcher server HIDDEN and detached (no console window).
REM    There is nothing to keep open; to stop it later run stop-watcher.cmd.
powershell -NoProfile -WindowStyle Hidden -Command ^
  "Start-Process node -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"

REM 4) Wait for the server, then open the dashboard
timeout /t 3 /nobreak >nul
start "" http://localhost:8787
