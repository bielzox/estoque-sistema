@echo off
cd /d "%~dp0"
echo 1/2 Instalando componentes (precisa de internet so desta vez)...
call npm install
echo 2/2 Gerando o instalador...
call "node_modules\.bin\electron-builder.cmd" --win --x64
if errorlevel 1 goto corrigir_icone
goto pronto

:corrigir_icone
echo Aplicando o icone do aplicativo e finalizando o instalador...
if not exist "instalador\win-unpacked\Estoque Intacto Car.exe" goto falha
if not exist "instalador\.icon-ico\icon.ico" goto falha
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$editor = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign') -Filter 'rcedit-x64.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName; if (-not $editor) { exit 2 }; & $editor '%CD%\instalador\win-unpacked\Estoque Intacto Car.exe' --set-icon '%CD%\instalador\.icon-ico\icon.ico' --set-version-string ProductName 'Estoque Intacto Car' --set-version-string FileDescription 'Controle de estoque de auto pecas' --set-file-version 1.0.9 --set-product-version 1.0.9.0; exit $LASTEXITCODE"
if errorlevel 1 goto falha
call "node_modules\.bin\electron-builder.cmd" --win --x64 --prepackaged "instalador\win-unpacked" --config.win.signAndEditExecutable=false
if errorlevel 1 goto falha

:pronto
echo.
echo Pronto! O instalador esta na pasta "instalador".
pause
exit /b 0

:falha
echo.
echo Falha ao gerar o instalador. Confira as mensagens acima.
pause
exit /b 1
