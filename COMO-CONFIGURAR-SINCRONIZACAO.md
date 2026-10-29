# Guia: login, recuperação de senha por SMS, logs no Discord e sincronização site ⇄ app

Tudo isso **já está programado** no projeto (site e aplicativo usam o mesmo código).
Falta só você criar o servidor gratuito (Supabase) e ligar. São ~20 minutos.

> Enquanto o arquivo `config.js` estiver vazio, o sistema funciona como antes: só neste
> aparelho e sem login. Nada quebra se você ainda não configurou.

## O que você vai ter no final

| Recurso | Como funciona |
|---|---|
| Login | E-mail + senha, no site e no aplicativo |
| Esqueci a senha | Link por **e-mail** ou código de 6 dígitos por **SMS** |
| Recuperação | Depois do link/código, o sistema pede a nova senha |
| Minha conta | Cadastrar telefone (SMS), trocar senha, sair |
| Site ⇄ app | O que um fizer aparece no outro em instantes |
| Discord | Cada ação importante vira uma mensagem no canal que você escolher |

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

## Passo 5 — Endereço do site (para o link de recuperação por e-mail)

1. **Authentication → URL Configuration**.
2. **Site URL:** o endereço do seu site no GitHub Pages
   (ex.: `https://seuusuario.github.io/intacto-car/`).
3. **Redirect URLs → Add URL:** o mesmo endereço.

> O e-mail que o Supabase envia de graça tem limite baixo de mensagens. Para uso diário,
> configure um e-mail próprio em **Authentication → Emails → SMTP Settings**
> (pode ser uma conta do Gmail com "senha de app", Brevo, Resend etc.).

## Passo 6 — Código por SMS (opcional, mas é o que você pediu)

O SMS **é cobrado por mensagem pelo provedor** (o Supabase só repassa). Sem esse passo,
tudo funciona, só o botão de SMS avisa que não está configurado.

1. **Authentication → Sign In / Providers → Phone** → ative **Enable Phone provider**.
2. Escolha o provedor de SMS (**Twilio**, **MessageBird** ou **Vonage**) e preencha as
   credenciais que a conta dele fornece. (Twilio: Account SID, Auth Token e o número ou
   *Messaging Service SID*.)
3. **Para testar de graça:** ainda nessa tela use **Test Phone Numbers and OTPs**:
   cadastre um número de teste e um código fixo (ex.: `123456`).
4. Depois de entrar no sistema, cada pessoa cadastra o próprio celular em
   **Minha conta e sair → Cadastrar ou alterar telefone** (digite `(11) 99999-9999` e
   confirme o código recebido). O telefone precisa estar cadastrado para a recuperação
   por SMS funcionar.

## Passo 7 — Logs no Discord

1. No Discord, abra o canal que vai receber os logs → **Editar canal (engrenagem) →
   Integrações → Webhooks → Novo webhook**.
2. Dê um nome (ex.: `Estoque Intacto Car`) e clique em **Copiar URL do webhook**.
3. Se a URL do webhook já foi compartilhada em mensagens, arquivos ou outros locais,
   revogue-a no Discord e gere uma nova antes de continuar. Trate essa URL como uma
   senha: não a grave em `config.js`, JavaScript do navegador ou no repositório.
4. No Supabase: **SQL Editor → New query**, cole o comando abaixo substituindo o
   texto de exemplo pela URL atual e clique em **Run**:

```sql
insert into public.config_segredos (chave, valor)
values ('discord_webhook', 'COLE_AQUI_A_URL_DO_WEBHOOK')
on conflict (chave) do update set valor = excluded.valor;
```

A URL fica guardada só no servidor — não vai para o site nem para o aplicativo.

**O que aparece no canal:** novo cadastro, login e saída, produto criado/editado, entradas e saídas,
exclusões (com a lista do que foi apagado), categorias, senha de exclusão, backup
restaurado, senha redefinida. Cada mensagem mostra o e-mail de quem fez e se foi pelo
**site** ou pelo **aplicativo**.

## Passo 8 — Ligar o sistema ao servidor

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
- **Celular:** abra o site e instale de novo / atualize o app instalado.

## Passo 9 — Primeiro acesso

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
- [ ] Mensagens chegando no canal do Discord.
- [ ] "Esqueci minha senha" por e-mail → link → nova senha.
- [ ] "Esqueci minha senha" por SMS → código → nova senha.
- [ ] Desligar a internet, lançar uma entrada, religar → sincroniza sozinho.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| "E-mail ou senha incorretos" | Confira se o usuário foi criado no passo 4 com **Auto Confirm User** |
| Não chega e-mail de recuperação | Veja o spam; configure SMTP próprio (passo 5); confira Site URL/Redirect URLs |
| "O envio de SMS ainda não está configurado" | Faça o passo 6 (provedor de SMS) |
| "Não encontramos uma conta com esses dados" no SMS | O telefone ainda não foi cadastrado em **Minha conta** |
| Nada chega no Discord | Rode o comando do passo 7; confira se a URL do webhook está certa |
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
