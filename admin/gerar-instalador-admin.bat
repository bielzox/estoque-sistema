@echo off
cd /d "%~dp0.."
echo Verificando dependencias do projeto...
if not exist "node_modules\electron-builder\out\cli\cli.js" (
  call npm install
  if errorlevel 1 (
    echo.
    echo Falha ao instalar as dependencias.
    pause
    exit /b 1
  )
)
echo Gerando o instalador do painel administrativo...
call "node_modules\.bin\electron-builder.cmd" --win --x64 --config admin\electron-builder.admin.json
if errorlevel 1 goto corrigir_icone
goto pronto

:corrigir_icone
echo Aplicando o icone do painel e finalizando o instalador...
if not exist "instalador-admin\win-unpacked\Intacto Car Painel Admin.exe" goto falha
if not exist "instalador-admin\.icon-ico\icon.ico" goto falha
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$editor = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign') -Filter 'rcedit-x64.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName; if (-not $editor) { exit 2 }; & $editor '%CD%\instalador-admin\win-unpacked\Intacto Car Painel Admin.exe' --set-icon '%CD%\instalador-admin\.icon-ico\icon.ico' --set-version-string ProductName 'Intacto Car Painel Admin' --set-version-string FileDescription 'Painel administrativo Intacto Car' --set-file-version 1.0.11 --set-product-version 1.0.11.0; exit $LASTEXITCODE"
if errorlevel 1 goto falha
call "node_modules\.bin\electron-builder.cmd" --win --x64 --prepackaged "instalador-admin\win-unpacked" --config admin\electron-builder.admin.json --config.win.signAndEditExecutable=false
if errorlevel 1 goto falha

:pronto
echo.
echo Pronto! O instalador esta em "instalador-admin\Intacto-Car-Painel-Admin.exe".
pause
exit /b 0

:falha
echo.
echo Falha ao gerar o instalador. Confira as mensagens acima.
pause
exit /b 1
