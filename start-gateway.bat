@echo off
setlocal enabledelayedexpansion
title Fate RPG VTT - Network Gateway

REM ============================================================
REM   Fate RPG VTT - Gateway launcher
REM
REM   Starts Caddy gateway so other devices on your Wi-Fi
REM   (phone, second laptop) can connect to the app.
REM
REM   Run this AFTER start.bat - the app must already be running.
REM ============================================================

cd /d "%~dp0"

echo.
echo ============================================================
echo    Fate RPG VTT - Network Gateway
echo ============================================================
echo.
echo This opens your app to other devices on the same Wi-Fi.
echo Make sure start.bat is already running in another window.
echo.
echo ------------------------------------------------------------
echo.

if not exist "caddy.exe" (
    echo [1/2] Caddy not found. Downloading...
    echo       (one-time download, ~40 MB)
    echo.

    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ProgressPreference='SilentlyContinue';" ^
        "Invoke-WebRequest -Uri 'https://github.com/caddyserver/caddy/releases/latest/download/caddy_2.8.4_windows_amd64.zip' -OutFile 'caddy.zip';" ^
        "Expand-Archive -Path 'caddy.zip' -DestinationPath '.' -Force;" ^
        "Remove-Item 'caddy.zip'"

    if not exist "caddy.exe" (
        echo.
        echo ============================================================
        echo   ERROR: Could not download Caddy automatically.
        echo.
        echo   Please download it manually:
        echo     1. Open https://caddyserver.com/download
        echo     2. Download the Windows amd64 version
        echo     3. Put caddy.exe in this folder
        echo     4. Run this script again
        echo ============================================================
        echo.
        pause
        exit /b 1
    )
    echo       Caddy downloaded.
) else (
    echo [1/2] Caddy already present.
)
echo.

echo [2/2] Your computer IP address on the local network:
echo.
ipconfig | findstr /C:"IPv4"
echo.
echo ------------------------------------------------------------
echo.
echo    On your phone or other device, open:
echo.
echo        http://YOUR_IP:81
echo.
echo    (use the IPv4 address shown above, e.g. http://192.168.1.50:81)
echo.
echo    The first time, the browser may warn about an
echo    insecure connection - that is normal for local network.
echo    Click Advanced then Proceed anyway.
echo.
echo ============================================================
echo.

if not exist "Caddyfile" (
    echo :81 { > Caddyfile
    echo     @transform_port_query { query XTransformPort=* } >> Caddyfile
    echo     handle @transform_port_query { reverse_proxy localhost:{query.XTransformPort} } >> Caddyfile
    echo     handle { reverse_proxy localhost:3000 } >> Caddyfile
    echo } >> Caddyfile
)

caddy run --config Caddyfile

pause
