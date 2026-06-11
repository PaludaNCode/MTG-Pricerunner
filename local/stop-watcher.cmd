@echo off
REM Stops the Card Price Watcher: the hidden Node server + the debug Chrome.
REM Your normal Chrome is left alone (only the --remote-debugging-port=9222 one is closed).

taskkill /f /im node.exe >nul 2>&1

powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*remote-debugging-port=9222*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

echo Watcher stopped.
timeout /t 2 /nobreak >nul
