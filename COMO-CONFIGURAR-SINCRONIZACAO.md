# Guia: login, recuperação de senha, painel administrativo e sincronização site ⇄ app

Tudo isso **já está programado** no projeto (site e aplicativo usam o mesmo código).
Falta só você criar o servidor gratuito (Supabase) e ligar. São ~20 minutos.

> Enquanto o arquivo `config.js` estiver vazio, o sistema funciona como antes: só neste
> aparelho e sem login. Nada quebra se você ainda não configurou.

## O que você vai ter no final

| Recurso | Como funciona |
|---|---|
| Login | E-mail + senha, no site e no aplicativo |
| Esqueci a senha | Código de 6 dígitos por **e-mail** |
| Recuperação | Depois de confirmar o código, o sistema pede a nova senha |
| Minha conta | Trocar senha e sair |
| Site ⇄ app | O que um fizer aparece no outro em instantes |
| Auditoria | Ações importantes ficam no Supabase e podem ser consultadas no painel administrativo |

---

## Passo 1 — Criar o servidor (Supabase)

1. Acesse **https://supabase.com** → **Start your project** → crie a conta.
2. Clique em **New project** e preencha:
   - **Name:** `intacto-car`
   - **Database Password:** crie uma senha forte e guarde
   - **Region:** `South America (São Paulo)`
3. Espere o projeto ficar pronto (1 a 2 minutos).
4. Vá em **Project Settings (engrenagem) → API** e copie para um bloco de notas:
   - **Project URL** (algo como `https://abcdefgh.supabase.co`)
   - **anon public** (chave comprida)

   ⚠️ **Nunca** use nem envie a chave `service_role`.

## Passo 2 — Criar as tabelas e a segurança

1. No menu da esquerda: **SQL Editor → New query**.
2. Abra o arquivo `supabase/setup.sql` deste projeto, copie **tudo** e cole no editor.
3. Clique em **Run**. Deve aparecer *Success*. (Pode rodar de novo sem problema.)

## Passo 3 — Ativar cadastro público (importante!)

O painel oferece cadastro por e-mail e senha. Para permitir novos cadastros:

1. **Authentication → Sign In / Providers** (em algumas versões: *Settings*).
2. Ative **Allow new users to sign up**. Salve.

> **Atenção:** o banco deste projeto compartilha o mesmo estoque entre todas as
> contas autenticadas. Qualquer pessoa que se cadastrar poderá consultar e alterar
> os mesmos produtos, movimentações e configurações sincronizadas da equipe. Só
> mantenha o cadastro público ativado se esse acesso compartilhado for intencional.

## Passo 4 — Criar as contas da equipe

Cada pessoa pode criar sua conta no painel com e-mail e senha. Se preferir,
também é possível criar contas manualmente em **Authentication → Users → Add user
→ Create new user** e marcar **Auto Confirm User**.

## Passo 5 — E-mail de recuperação por código

1. Abra **Authentication → Emails → Templates → Reset Password**.
2. No conteúdo do e-mail, inclua o código usando `{{ .Token }}`. Por exemplo:

   ```html
   <p>Seu código para redefinir a senha é: {{ .Token }}</p>
   ```

3. Salve o template. Para uso frequente, configure um servidor de envio em
   **Authentication → Emails → SMTP Settings**; o serviço padrão tem limite baixo.
4. Em **Authentication → URL Configuration**, mantenha o endereço do site no
   **Site URL** e adicione-o também a **Redirect URLs**.

> O template **Reset Password** precisa exibir `{{ .Token }}`; sem o código no e-mail,
> não será possível concluir a recuperação pelo sistema.

## Passo 6 — Painel administrativo e auditoria

1. Se ainda existir uma integração antiga, revogue o webhook em **Discord → canal →
   Editar canal → Integrações → Webhooks**. As mensagens antigas já publicadas no
   Discord não podem ser apagadas pelo Supabase; exclua-as no próprio Discord se desejar.
   Se a função antiga `discord-audit` tiver sido publicada no Supabase, remova-a e
   apague o segredo `DISCORD_WEBHOOK_URL` nas configurações de Edge Functions.
2. No Supabase, abra **SQL Editor → New query**, copie todo o arquivo
   `supabase/setup.sql` e clique em **Run**. O script remove a configuração antiga
   e cria a tabela de auditoria, o controle de acesso e a limpeza automática após 12 meses.
   Se o painel já estiver configurado, execute novamente a versão atualizada do
   `setup.sql` para instalar as operações protegidas de apagar e limpar registros.
3. Crie primeiro a conta de usuário que será administradora em
   **Authentication → Users** ou pela tela de cadastro do app. Depois autorize
   essa conta no SQL Editor, substituindo o e-mail pelo da conta:

   ```sql
   insert into public.admin_allowlist (user_id)
   select id from auth.users
   where lower(email) = lower('admin@exemplo.com')
   on conflict (user_id) do nothing;
   ```

   Se nenhuma linha for inserida, confira se a conta já existe e se o e-mail está correto.
   Para autorizar outros administradores, repita o comando com o e-mail de cada conta.
   Não é necessário compartilhar senhas ou chaves.
   Para retirar o acesso de uma conta, execute:

   ```sql
   delete from public.admin_allowlist
   where user_id in (select id from auth.users where lower(email) = lower('admin@exemplo.com'));
   ```

4. Abra **Painel administrativo** no menu lateral do app/site ou use o aplicativo
   Windows separado do painel. Entre com o e-mail e a senha da conta autorizada.
   O Supabase verifica a autorização no servidor; uma tela ou URL separada, sozinha,
   não protege os dados. Não remova essa verificação nem publique credenciais
   administrativas.
5. No painel, **Apagar** remove um registro individual depois da confirmação. Para
   apagar vários, marque os registros e use **Limpar selecionados**. Essa ação pede
   uma senha própria, configurada no painel em **Configurar senha para limpar**.
   A senha é protegida no Supabase e vinculada à conta administradora; ela é
   independente da senha local de exclusão do estoque. O painel permite selecionar
   até 500 registros por operação e registra na auditoria cada operação de exclusão.

O painel apresenta registros de login/saída, cadastros, alterações e exclusões de
produtos, movimentações, categorias, restauração/exportação de backup e configurações
de aparência. Quando disponíveis, as alterações mostram valores anteriores e novos.
É possível filtrar por período, usuário, origem e nível, além de exportar os resultados
visíveis em CSV. Os registros são compartilhados entre site e aplicativo e permanecem
no Supabase por até 12 meses.

Senhas, tokens, imagens e anexos não são incluídos nos detalhes de auditoria. Para
registrar outra ação concluída no app, use `logar(título, descrição, nível, {before, after})`;
os níveis aceitos são `info`, `ok`, `aviso` e `perigo`. A fila local envia os eventos
quando a sessão volta a ficar online.

## Passo 7 — Ligar o sistema ao servidor

Abra o arquivo **`config.js`** e preencha com o que você anotou:

```js
window.INTACTO_CONFIG = {
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabaseAnonKey: 'COLE_AQUI_A_CHAVE_ANON_PUBLIC',
  siteUrl: 'https://seuusuario.github.io/intacto-car/'
};
```

- **Site:** envie todos os arquivos do projeto para o GitHub (o publicador já existe).
- **Aplicativo (.exe):** rode `gerar-instalador.bat` e instale o novo
  `Estoque-Intacto-Car.exe`.
- **App independente do painel (Windows):** rode `gerar-instalador-admin.bat`
  (ou `npm run build:admin`) e instale
  `instalador-admin/Intacto-Car-Painel-Admin.exe`.
- **Celular:** abra o site e instale de novo / atualize o app instalado.

## Passo 8 — Primeiro acesso

1. Abra o sistema e entre com o e-mail e a senha criados no passo 4.
2. No **primeiro login de cada aparelho**, os dados que já estão nele sobem ao servidor
   e os que já estão no servidor descem. Nada é apagado.
   👉 Entre primeiro no aparelho que tem os dados **mais completos**.
3. A lateral mostra o estado: **Conectado — em tempo real**, **Sincronizando…** ou
   **Offline**.

## Checklist de testes

- [ ] Entrar com e-mail e senha no site.
- [ ] Entrar no aplicativo (.exe) com a mesma conta.
- [ ] Criar um produto no site → aparece no app sem recarregar.
- [ ] Fazer uma saída no app → o estoque muda no site.
- [ ] Ações do app aparecendo no painel administrativo.
- [ ] Conta não autorizada sendo recusada pelo painel.
- [ ] "Esqueci minha senha" por e-mail → código → nova senha.
- [ ] Desligar a internet, lançar uma entrada, religar → sincroniza sozinho.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| "E-mail ou senha incorretos" | Confira se o usuário foi criado no passo 4 com **Auto Confirm User** |
| Não chega e-mail de recuperação | Veja o spam; confira o template Reset Password e configure SMTP próprio (passo 5) |
| Painel mostra acesso negado | Autorize a conta pelo SQL do passo 6 e entre novamente no app |
| Auditoria não atualiza | Confira se aparece **Conectado — em tempo real**, rode `supabase/setup.sql` e reabra o app |
| Fica em "Falha ao sincronizar" | Confira URL e chave no `config.js` e se o `setup.sql` rodou sem erro |
| Projeto "pausado" no Supabase | Projetos grátis pausam após ~7 dias sem uso: reative no painel |

## Limites e cuidados

- **Sem internet** o sistema continua funcionando; envia as alterações ao reconectar.
- Se duas pessoas alterarem **o mesmo produto ao mesmo tempo**, vale a última alteração e
  o saldo pode divergir da soma das movimentações. Evite lançar entrada/saída do mesmo
  produto simultaneamente em dois aparelhos.
- Anexos grandes pesam; prefira arquivos pequenos.
- A senha de exclusão passa a ser a mesma em todos os aparelhos (guardada em hash). A
  imagem de fundo continua individual.
- A biblioteca do Supabase é carregada da internet (versão fixa 2.45.4). Para o app abrir
  sem internet na primeira vez, baixe `supabase.js` dessa versão e coloque em
  `vendor/supabase.js`.
- Em computador compartilhado, use **Minha conta e sair → Sair da conta**.
