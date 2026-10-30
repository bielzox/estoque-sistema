const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

Menu.setApplicationMenu(null);

function createAdminWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    title: 'Painel administrativo — Intacto Car',
    icon: path.join(__dirname, 'icone.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      shell.openExternal(url).catch(error => {
        console.error('Não foi possível abrir o link no navegador:', error);
      });
    }
    return { action: 'deny' };
  });

  window.loadFile(path.join(__dirname, 'admin.html'));
}

app.whenReady().then(createAdminWindow);
app.on('window-all-closed', () => app.quit());
