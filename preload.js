const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Pede ao processo principal para devolver o foco do teclado à janela.
contextBridge.exposeInMainWorld('__intactoRefocar', () => ipcRenderer.send('intacto:refocar'));

// Mantém alert()/confirm() nativos exatamente como estão; só devolve o foco depois que fecham.
webFrame.executeJavaScript(`(function () {
  ['alert', 'confirm'].forEach(function (nome) {
    var original = window[nome];
    window[nome] = function () {
      var resultado = original.apply(window, arguments);
      try { window.__intactoRefocar(); } catch (e) {}
      return resultado;
    };
  });
})();`);
