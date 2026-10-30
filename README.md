# Estoque Intacto Car

Aplicativo de controle de estoque de autopeças, disponível como site instalável
e como aplicativo para Windows.

## Organização

- `index.html`, `manifest.webmanifest`, `sw.js` e `icone-*.png`: versão web.
- `main.js`, `package.json` e `package-lock.json`: aplicativo Windows e suas
  dependências.
- `config.js`, `sync.js` e `supabase/setup.sql`: login, recuperação de senha por
  código no e-mail, sincronização em tempo real e auditoria no painel administrativo.
- `admin.html` e `admin.js`: painel separado para consultar e exportar auditoria,
  protegido pela lista de administradores no Supabase.
- `admin-main.js` e `electron-builder.admin.json`: aplicativo Windows independente
  para abrir somente o painel administrativo.
- `COMO-CONFIGURAR-SINCRONIZACAO.md`: passo a passo de configuração, acesso admin
  e auditoria.
- `gerar-instalador.bat` e `testar-sem-instalar.bat`: atalhos para gerar e
  executar o aplicativo no Windows.
- `backups/`: cópias locais dos dados. Não compartilhe nem publique esta pasta.
- `instalador/`: saída gerada pelo Electron Builder; o instalador final fica
  aqui.
- `instalador-admin/`: saída do instalador separado do painel administrativo.

Os arquivos da versão web permanecem na raiz porque a publicação do GitHub Pages
e a configuração do instalador esperam esses caminhos.

## Executar e gerar o instalador no Windows

Instale o Node.js LTS e, na pasta do projeto, execute:

```text
npm install
npm start
```

Para gerar o instalador:

```text
npm run build
```

Também é possível usar `testar-sem-instalar.bat` e `gerar-instalador.bat`.
Dependências e arquivos intermediários de compilação podem ser recriados com
esses comandos; o instalador `.exe` em `instalador/` é mantido como artefato
pronto para distribuição.

Para abrir o painel como aplicativo separado durante o desenvolvimento:

```text
npm run start:admin
```

Para gerar o instalador do painel, sem substituir o instalador do estoque:

```text
npm run build:admin
```

O arquivo `Intacto-Car-Painel-Admin.exe` será criado em `instalador-admin/`.
No primeiro uso, entre no painel com o e-mail e a senha da conta autorizada no
Supabase. A sessão do painel é independente da sessão do aplicativo de estoque.

## Publicar e instalar no celular

O GitHub Pages publica automaticamente os arquivos da raiz a cada atualização
da branch `main`; não é necessário um workflow próprio de publicação. Depois que
o deploy padrão do Pages terminar, abra o endereço HTTPS no navegador:

- **iPhone/iPad:** no Safari, toque em **Compartilhar** e em **Adicionar à Tela
  de Início**.
- **Android/Chrome/Edge:** use a opção **Instalar aplicativo**.

Após a primeira abertura com internet, o aplicativo web pode funcionar offline.

## Dados e backups

Produtos, movimentações, anexos e senha de exclusão ficam armazenados localmente
em cada dispositivo; não há sincronização automática. Use **Salvar backup** no
aplicativo para transferir ou guardar os dados e mantenha cópias em local seguro.
Backups não devem ser publicados nem incluídos no repositório.

A senha de exclusão é armazenada como hash no dispositivo e não é incluída no
backup. A exclusão de registros exige essa senha. Excluir uma movimentação apaga
seu histórico e anexos, mas não recalcula o saldo do produto; excluir um produto
mantém seu histórico.

## Ícones

`icone.png` é usado pelo aplicativo Windows e como imagem de fundo original.
`icone-192.png` e `icone-512.png` são usados pela versão web. Ao trocar a marca,
atualize os arquivos correspondentes.
