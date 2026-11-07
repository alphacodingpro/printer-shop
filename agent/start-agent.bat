@echo off
REM Double-click to start the Print Agent (Windows). Keep this window open, or add a shortcut to the Startup folder.
cd /d "%~dp0"
:loop
node agent.js
timeout /t 5 >nul
goto loop
