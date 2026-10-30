@echo off
cd /d "%~dp0"
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
call npm run build:admin
if errorlevel 1 (
  echo.
  echo Falha ao gerar o instalador.
  pause
  exit /b 1
)
echo.
echo Pronto! O instalador esta em "instalador-admin\Intacto-Car-Painel-Admin.exe".
pause
