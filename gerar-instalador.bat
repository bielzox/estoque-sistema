@echo off
cd /d "%~dp0"
echo 1/2 Instalando componentes (precisa de internet so desta vez)...
call npm install
echo 2/2 Gerando o instalador...
call npm run build
echo.
echo Pronto! O instalador esta na pasta "instalador".
pause
Exit
