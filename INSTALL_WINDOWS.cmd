@echo off
cd /d "%~dp0"
if not exist ".env" (
  echo No .env file! Please copy a suitable config example to .env first.
  echo On your database PC: copy config\YOUR_PC_HUB.env.example .env
  echo On other PC: copy config\OTHER_PC_PEER.env.example .env
  pause
  exit /b 1
)
call npm install
if errorlevel 1 (
  echo ERROR: npm install failed.
  pause
  exit /b 1
)
echo Done! Before starting, check .env and upload the same firmware to your ESP32.
pause
