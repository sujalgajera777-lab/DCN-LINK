@echo off
cd /d "%~dp0"
node index.js
if errorlevel 1 echo Backend stopped with an error. Check your .env settings.
pause
