@echo off
cd /d "%~dp0"
call npm.cmd run build
if errorlevel 1 (
    echo Build failed. See the error above.
    pause
    exit /b 1
)
echo Build ready. Open Fate RPG.exe or start.bat.
pause
