@echo off
setlocal
chcp 65001 >nul
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS from https://nodejs.org/en/download
  echo Then reopen this file. See README.txt.
  pause
  exit /b 1
)
set "BANANA_LAUNCHER=%~dp0scripts\windows-gallery.mjs"
if exist "%~dp0app\scripts\windows-gallery.mjs" set "BANANA_LAUNCHER=%~dp0app\scripts\windows-gallery.mjs"
if not "%~1"=="" (
  node "%BANANA_LAUNCHER%" %*
  exit /b
)
:menu
echo.
echo Banana Gallery - Windows local edition
echo 1. Install / repair dependencies (first use, internet required)
echo 2. Start and open gallery
echo 3. Stop
echo 4. Status
echo 5. Recent logs
echo 6. Backup (stop first)
echo 7. Verify data (stop first)
echo 8. Exit menu (gallery keeps running)
choice /c 12345678 /n /m "Select [1-8]: "
if errorlevel 8 exit /b 0
if errorlevel 7 goto verify
if errorlevel 6 goto backup
if errorlevel 5 goto logs
if errorlevel 4 goto status
if errorlevel 3 goto stop
if errorlevel 2 goto start
node "%BANANA_LAUNCHER%" install
goto done
:start
node "%BANANA_LAUNCHER%" start
if not errorlevel 1 start "" "http://localhost:3333"
goto done
:stop
node "%BANANA_LAUNCHER%" stop
goto done
:status
node "%BANANA_LAUNCHER%" status
goto done
:logs
node "%BANANA_LAUNCHER%" log
goto done
:backup
node "%BANANA_LAUNCHER%" backup
goto done
:verify
node "%BANANA_LAUNCHER%" verify
:done
pause
goto menu
