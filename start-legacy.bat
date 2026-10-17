@echo off
title Fate RPG VTT - Launcher

REM ============================================================
REM   Fate RPG VTT - One-click launcher for Windows
REM   Version 4: includes physics service for 3D dice
REM ============================================================

cd /d "%~dp0"

echo ============================================================ > start.log
echo   Fate RPG VTT - Launcher log >> start.log
echo   Started: %date% %time% >> start.log
echo ============================================================ >> start.log
echo. >> start.log

echo.
echo ============================================================
echo    FATE RPG VTT  -  Automatic Launcher
echo ============================================================
echo.
echo   First launch takes 3-7 minutes (downloads dependencies).
echo   If a Windows permission prompt appears - click Yes.
echo.
echo   LOG FILE: start.log (in this folder)
echo   If something fails, send me this file.
echo.
echo ------------------------------------------------------------
echo.

REM ---- Step 1: Check / install Bun -----------------------------------
echo [1/8] Checking Bun...
echo [1/8] Checking Bun... >> start.log

set "BUN_BIN=%USERPROFILE%\.bun\bin"
set "PATH=%BUN_BIN%;%PATH%"

where bun >nul 2>nul
if %errorlevel%==0 (
    echo       Bun is already installed:
    bun --version
    bun --version >> start.log
    goto :bun_ok
)

echo       Bun not found. Installing Bun (one-time setup)... >> start.log
echo       Bun not found. Installing Bun...
echo       A permission prompt may appear - please allow it.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" >> start.log 2>&1

set "PATH=%BUN_BIN%;%PATH%"

where bun >nul 2>nul
if %errorlevel%==0 (
    echo       Bun installed successfully:
    bun --version
    bun --version >> start.log
    goto :bun_ok
)

echo.
echo ============================================================
echo   ERROR: Could not install Bun automatically.
echo   See start.log for details.
echo.
echo   Please install it manually from https://bun.sh
echo   Then restart this script.
echo ============================================================
echo   ERROR: Could not install Bun automatically. >> start.log
pause
exit /b 1

:bun_ok
echo. >> start.log
echo.

REM ---- Step 2: Install main project dependencies --------------------
echo [2/8] Installing main project dependencies...
echo [2/8] Installing main project dependencies... >> start.log
echo       (using --ignore-scripts to avoid Prisma network issues)
echo       This may take 2-5 minutes on first run. Please wait...
echo.

echo       Attempt 1... >> start.log
bun install --ignore-scripts >> start.log 2>&1
if %errorlevel%==0 goto :install_ok

echo       Attempt 1 failed. Retrying in 5 seconds... >> start.log
echo       Attempt 1 failed. Retrying in 5 seconds...
timeout /t 5 /nobreak >nul

echo       Attempt 2... >> start.log
bun install --ignore-scripts >> start.log 2>&1
if %errorlevel%==0 goto :install_ok

echo       Attempt 2 failed. Retrying in 10 seconds... >> start.log
echo       Attempt 2 failed. Retrying in 10 seconds...
timeout /t 10 /nobreak >nul

echo       Attempt 3... >> start.log
bun install --ignore-scripts >> start.log 2>&1
if %errorlevel%==0 goto :install_ok

echo.
echo ============================================================
echo   ERROR: Could not install dependencies after 3 attempts.
echo   See start.log for details.
echo.
echo   Possible causes:
echo     - No internet connection
echo     - Antivirus blocking the download
echo     - Corporate firewall / VPN
echo ============================================================
echo   ERROR: Dependency installation failed after 3 attempts. >> start.log
pause
exit /b 1

:install_ok
echo       Dependencies installed successfully. >> start.log
echo       Dependencies installed.
echo.

REM ---- Step 3: Restore pre-generated Prisma client ------------------
echo [3/8] Setting up Prisma client (offline - no download needed)...
echo [3/8] Setting up Prisma client... >> start.log

if not exist "node_modules\.prisma\client" (
    mkdir "node_modules\.prisma\client"
)

echo       Copying pre-generated Prisma client... >> start.log
echo       Copying pre-generated Prisma client...
xcopy /y /e /q "prisma-client-backup\*" "node_modules\.prisma\client\" >> start.log 2>&1
if %errorlevel% neq 0 (
    echo       WARNING: xcopy returned error %errorlevel% >> start.log
    echo       WARNING: xcopy returned error %errorlevel%
)

if not exist "node_modules\.prisma\client\query_engine-windows.dll.node" (
    echo       Windows engine missing. Trying prisma generate... >> start.log
    echo       Windows engine missing. Trying prisma generate...
    bunx prisma generate >> start.log 2>&1
)

if not exist "node_modules\.prisma\client\index.js" (
    echo       Client JS missing. Trying prisma generate... >> start.log
    echo       Client JS missing. Trying prisma generate...
    bunx prisma generate >> start.log 2>&1
)

echo       Prisma client setup done. >> start.log
echo       Prisma client ready.
echo.

REM ---- Step 4: Verify Prisma client ---------------------------------
echo [4/8] Verifying Prisma client...
echo [4/8] Verifying Prisma client... >> start.log

if not exist "node_modules\.prisma\client\index.js" (
    echo.
    echo ============================================================
    echo   ERROR: Prisma client is missing.
    echo   See start.log for details.
    echo ============================================================
    echo   ERROR: Prisma client index.js not found. >> start.log
    pause
    exit /b 1
)

if not exist "node_modules\.prisma\client\query_engine-windows.dll.node" (
    echo.
    echo ============================================================
    echo   ERROR: Windows engine binary is missing.
    echo   See start.log for details.
    echo ============================================================
    echo   ERROR: query_engine-windows.dll.node not found. >> start.log
    pause
    exit /b 1
)

echo       OK - client and Windows engine present. >> start.log
echo       OK - client and Windows engine present.
echo.

REM ---- Step 5: Install signaling server dependencies ----------------
echo [5/8] Installing signaling server dependencies...
echo [5/8] Installing signaling server dependencies... >> start.log

if not exist "mini-services\signaling\package.json" (
    echo       mini-services\signaling not found, skipping. >> start.log
    echo       mini-services\signaling not found, skipping.
    goto :sig_done
)

pushd mini-services\signaling

echo       Attempt 1... >> start.log
bun install --ignore-scripts >> start.log 2>&1
if %errorlevel%==0 (
    popd
    echo       Signaling deps installed. >> start.log
    echo       Done.
    goto :sig_done
)

echo       Attempt 1 failed. Retrying... >> start.log
echo       Attempt 1 failed. Retrying...
timeout /t 5 /nobreak >nul

bun install --ignore-scripts >> start.log 2>&1
if %errorlevel%==0 (
    popd
    echo       Signaling deps installed on retry. >> start.log
    echo       Done.
    goto :sig_done
)

popd
echo.
echo ============================================================
echo   ERROR: Signaling dependency installation failed.
echo   See start.log for details.
echo ============================================================
echo   ERROR: Signaling install failed. >> start.log
pause
exit /b 1

:sig_done
echo.

REM ---- Step 6: Install physics server dependencies ------------------
echo [6/8] Installing physics server dependencies (for 3D dice)...
echo [6/8] Installing physics server dependencies... >> start.log

if not exist "mini-services\physics-service\package.json" (
    echo       mini-services\physics-service not found, skipping. >> start.log
    echo       mini-services\physics-service not found, skipping.
    echo       3D dice physics will not be available.
    goto :phys_done
)

pushd mini-services\physics-service

echo       Attempt 1... >> start.log
bun install >> start.log 2>&1
if %errorlevel%==0 (
    popd
    echo       Physics deps installed. >> start.log
    echo       Done.
    goto :phys_done
)

echo       Attempt 1 failed. Retrying... >> start.log
echo       Attempt 1 failed. Retrying...
timeout /t 5 /nobreak >nul

bun install >> start.log 2>&1
if %errorlevel%==0 (
    popd
    echo       Physics deps installed on retry. >> start.log
    echo       Done.
    goto :phys_done
)

popd
echo.
echo       WARNING: Physics service deps could not be installed. >> start.log
echo       WARNING: Physics service deps could not be installed.
echo       3D dice physics will not be available.
echo       You can still use the app with 2D dice mode.
echo.

:phys_done
echo.

REM ---- Step 7: Database check ---------------------------------------
echo [7/8] Checking database...
echo [7/8] Checking database... >> start.log

if exist "db\custom.db" (
    echo       Database already exists. >> start.log
    echo       Database already exists.
    goto :db_done
)

if not exist "prisma\schema.prisma" (
    echo       WARNING: prisma\schema.prisma not found. >> start.log
    echo       WARNING: prisma\schema.prisma not found.
    goto :db_done
)

echo       Creating fresh database... >> start.log
echo       Creating fresh database...
bunx prisma db push >> start.log 2>&1

:db_done
echo.

REM ---- Step 8: Start services ---------------------------------------
echo [8/8] Starting services...
echo [8/8] Starting services... >> start.log

if exist "mini-services\signaling\index.ts" (
    echo       Starting signaling server on port 3004... >> start.log
    echo       Starting signaling server on port 3004...
    start "Fate RPG - Signaling (do not close)" /min cmd /c "cd /d "%~dp0mini-services\signaling" && bun --hot run index.ts"
    timeout /t 3 /nobreak >nul
)

if exist "mini-services\physics-service\index.ts" (
    if exist "mini-services\physics-service\node_modules" (
        echo       Starting physics server on port 3006... >> start.log
        echo       Starting physics server on port 3006...
        start "Fate RPG - Physics (do not close)" /min cmd /c "cd /d "%~dp0mini-services\physics-service" && bun --hot run index.ts"
        timeout /t 3 /nobreak >nul
    ) else (
        echo       Physics service deps not installed, skipping physics. >> start.log
        echo       Physics service deps not installed, skipping.
    )
)

echo.
echo ============================================================
echo    Fate RPG VTT is starting!
echo.
echo    The app will open in your browser automatically in ~8 sec.
echo    If it does not, open: http://localhost:3000
echo.
echo    Services running:
echo      - Web app:        http://localhost:3000
echo      - Signaling:      port 3004 (for P2P networking)
echo      - Dice physics:   port 3006 (for 3D dice)
echo.
echo    To stop: close this window (and the service windows).
echo ============================================================
echo. >> start.log
echo Starting Next.js on port 3000... >> start.log

REM Open browser after delay
start "" /b cmd /c "timeout /t 8 /nobreak >nul && start http://localhost:3000"

echo       Starting Next.js on http://localhost:3000 ...
echo       (this window must stay open while the app is running)
echo.

REM Run Next.js - this blocks until the user closes it
bunx next dev -p 3000

echo.
echo ============================================================
echo    Next.js has stopped.
echo    Closing all services...
echo ============================================================
echo Next.js stopped. >> start.log

taskkill /fi "WINDOWTITLE eq Fate RPG - Signaling*" /f >nul 2>nul
taskkill /fi "WINDOWTITLE eq Fate RPG - Physics*" /f >nul 2>nul

echo.
echo Done. Press any key to close this window.
pause >nul
