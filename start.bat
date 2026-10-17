@echo off
cd /d "%~dp0"
if exist "Fate RPG.exe" (
    start "" "%~dp0Fate RPG.exe"
    exit /b 0
)
if not exist ".next\standalone\runtime\node.exe" (
    echo Production build not found. Run build.bat first.
    pause
    exit /b 1
)
".next\standalone\runtime\node.exe" "scripts\start-all.cjs"
if errorlevel 1 pause
