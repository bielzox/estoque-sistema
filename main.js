const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
Menu.setApplicationMenu(null);
// No Windows, depois de alert()/confirm() o Electron deixa a janela sem foco de teclado
// (campos de texto/senha param de aceitar digitação). Devolve o foco à janela.
ipcMain.on('intacto:refocar', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  win.blur();
  win.focus();
  win.webContents.focus();
});
function criar() {
  const w = new BrowserWindow({
    width: 1280, height: 800, title: 'Intacto Car',
    icon: path.join(__dirname, 'icone.png'),   // ícone da janela
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  w.on('focus', () => {
    w.webContents.executeJavaScript(
      "if (document.getElementById('dverify')?.open) document.getElementById('verifyPassword').focus();"
    ).catch(error => console.error('Não foi possível focar a senha de exclusão:', error));
  });
  w.loadFile(path.join(__dirname, 'index.html')); // tela do sistema
}
app.whenReady().then(criar);
app.on('window-all-closed', () => app.quit());
