/* Intacto Car — login, sincronização em tempo real entre site e aplicativo (Supabase)
   e envio de logs para um canal do Discord.
   Sem URL/chave em config.js nada disso é ativado e o sistema funciona só neste aparelho. */
(function () {
  'use strict';

  const CFG = window.INTACTO_CONFIG || {};
  if (!(CFG.supabaseUrl && CFG.supabaseAnonKey)) return;

  /* ------------------------------------------------------------------ constantes */
  const LIB_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  const ORIGEM = /electron/i.test(navigator.userAgent) ? 'aplicativo' : 'site';
  const META_SYNC = ['cats', 'deletePassword'];          // chaves da store "meta" que são sincronizadas
  const LS = { fila: 'ic_fila', cursor: 'ic_cursor', init: 'ic_init', logs: 'ic_logs', logado: 'ic_logado' };
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* sem espaço */ } };
  const lsDel = k => { try { localStorage.removeItem(k); } catch (_) { /* ok */ } };

  document.documentElement.classList.add('ic-bloqueado');  // esconde o app até o login

  /* ------------------------------------------------------------------ estado */
  let sb = null, sessao = null, canal = null;
  let entrou = false, offline = false, recuperando = false, loginManual = false, tipoEntrada = 'Login';
  let conectado = false, enviando = false, puxando = false, pendentePuxar = false;
  let erroSync = false, aplicando = false, painelAtual = '', emailRecuperacao = '';
  let timerEnvio = null, timerPuxar = null, timerRetry = null, timers = [];

  /* ------------------------------------------------------------------ fila de alterações locais */
  let seq = 0;
  const fila = new Map();                                   // "kind|id" -> nº da alteração
  try { JSON.parse(lsGet(LS.fila) || '[]').forEach(k => fila.set(k, ++seq)); } catch (_) { /* fila vazia */ }
  let salvaT = null;
  function salvarFilaJa() { clearTimeout(salvaT); lsSet(LS.fila, JSON.stringify([...fila.keys()])); }
  function salvarFila() { clearTimeout(salvaT); salvaT = setTimeout(salvarFilaJa, 100); }
  function enfileirar(k) { fila.set(k, ++seq); salvarFila(); agendarEnvio(); status(); }
  window.addEventListener('pagehide', salvarFilaJa);

  const storeDe = kind => kind === 'prod' ? 'prods' : kind === 'mov' ? 'movs' : kind === 'meta' ? 'meta' : null;
  function chaveDe(store, key) {
    if (typeof key !== 'string' && typeof key !== 'number') return null;
    if (store === 'prods') return 'prod|' + key;
    if (store === 'movs') return 'mov|' + key;
    if (store === 'meta' && META_SYNC.includes(key)) return 'meta|' + key;
    return null;
  }
  function marcar(store, key) {
    if (aplicando) return;
    const k = chaveDe(store, key);
    if (k) enfileirar(k);
  }

  /* Intercepta as gravações do IndexedDB para saber o que mudou neste aparelho,
     sem precisar alterar cada ponto do sistema que grava dados. */
  (function patchIDB() {
    const P = IDBObjectStore.prototype;
    const put = P.put, add = P.add, del = P.delete, clr = P.clear;
    P.put = function (v, k) {
      const r = put.apply(this, arguments);
      try { marcar(this.name, k !== undefined ? k : (this.keyPath ? v[this.keyPath] : undefined)); } catch (_) { /* ignora */ }
      return r;
    };
    P.add = function (v, k) {
      const r = add.apply(this, arguments);
      try { marcar(this.name, k !== undefined ? k : (this.keyPath ? v[this.keyPath] : undefined)); } catch (_) { /* ignora */ }
      return r;
    };
    P.delete = function (k) {
      const r = del.apply(this, arguments);
      try { marcar(this.name, k); } catch (_) { /* ignora */ }
      return r;
    };
    P.clear = function () {
      const nome = this.name;
      if (!aplicando && (nome === 'prods' || nome === 'movs')) {
        try {                                               // pede as chaves ANTES de limpar
          const g = this.getAllKeys();
          g.onsuccess = () => g.result.forEach(k => marcar(nome, k));
        } catch (_) { /* ignora */ }
      }
      return clr.apply(this, arguments);
    };
  })();

  /* ------------------------------------------------------------------ utilidades */
  function estavel(v) {
    if (Array.isArray(v)) return '[' + v.map(estavel).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + estavel(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  const igual = (local, remoto) => estavel(JSON.parse(JSON.stringify(local))) === estavel(remoto);

  function traduzir(err) {
    const m = String((err && (err.message || err.error_description)) || err || '');
    if (/invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/email not confirmed/i.test(m)) return 'Este e-mail ainda não foi confirmado.';
    if (/rate limit|too many|over_.*rate|security purposes/i.test(m) || (err && err.status === 429)) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    if (/token has expired|otp.*(expired|invalid)|invalid.*otp/i.test(m)) return 'Código inválido ou expirado.';
    if (/auth session missing|session missing/i.test(m)) return 'Sua sessão expirou. Entre novamente e tente alterar a senha.';
    if (/user already registered|already been registered|email.*already/i.test(m)) return 'Já existe uma conta com este e-mail. Entre ou recupere sua senha.';
    if (/signups? not allowed/i.test(m)) return 'O cadastro está desativado no Supabase. Habilite “Allow new users to sign up”.';
    if (/user not found|not found/i.test(m)) return 'Não encontramos uma conta com esses dados.';
    if (/same password|different from the old/i.test(m)) return 'A nova senha precisa ser diferente da atual.';
    if (/password.*(weak|short|at least|characters)/i.test(m)) return 'Senha muito fraca. Use pelo menos 8 caracteres.';
    if (/failed to fetch|network|load failed/i.test(m)) return 'Sem conexão com a internet.';
    return 'Não foi possível concluir: ' + m;
  }

  /* ------------------------------------------------------------------ biblioteca do Supabase */
  function carregarScript(src) {
    return new Promise((ok, er) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok;
      s.onerror = () => { s.remove(); er(new Error('falha ao carregar ' + src)); };
      document.head.appendChild(s);
    });
  }
  async function garantirLib() {
    if (window.supabase && window.supabase.createClient) return true;
    for (const src of ['./vendor/supabase.js', LIB_CDN]) {   // cópia local (opcional) e depois a internet
      try { await carregarScript(src); if (window.supabase && window.supabase.createClient) return true; } catch (_) { /* tenta a próxima */ }
    }
    return false;
  }
  const esperarApp = async () => { for (let i = 0; i < 300 && !window.__appPronto; i++) await sleep(50); };

  /* ------------------------------------------------------------------ leitura/gravação local */
  const lerLocal = (kind, id) => req(tx(storeDe(kind)).get(id));

  async function aplicar(linhas) {
    const ops = [];
    for (const l of linhas) {
      const k = l.kind + '|' + l.id;
      if (fila.has(k)) continue;                             // alteração local ainda não enviada vence
      if (l.kind === 'meta' && !META_SYNC.includes(l.id)) continue;
      const store = storeDe(l.kind);
      if (!store) continue;
      const local = await lerLocal(l.kind, l.id);
      if (l.deleted) { if (local !== undefined) ops.push({ store, k, key: l.id, del: true }); }
      else if (l.data != null && (local === undefined || !igual(local, l.data))) ops.push({ store, k, key: l.id, val: l.data });
    }
    if (!ops.length) return false;
    await new Promise((ok, er) => {
      const t = db.transaction(['prods', 'movs', 'meta'], 'readwrite');
      aplicando = true;                                      // estas gravações vieram do servidor: não reenviar
      try {
        for (const o of ops) {
          if (fila.has(o.k)) continue;
          const s = t.objectStore(o.store);
          if (o.del) s.delete(o.key); else if (o.store === 'meta') s.put(o.val, o.key); else s.put(o.val);
        }
      } finally { aplicando = false; }
      t.oncomplete = () => ok();
      t.onerror = t.onabort = () => er(t.error || new Error('Falha ao gravar no aparelho'));
    });
    await recarregar();
    return true;
  }

  /* ------------------------------------------------------------------ servidor: puxar e enviar */
  async function puxarLinhas(desde) {
    const out = [], T = 100;
    for (let de = 0; ; de += T) {
      let q = sb.from('registros').select('kind,id,data,deleted,updated_at')
        .order('updated_at', { ascending: true }).order('kind', { ascending: true }).order('id', { ascending: true })
        .range(de, de + T - 1);
      if (desde) q = q.gt('updated_at', desde);
      const { data, error } = await q;
      if (error) throw error;
      out.push(...data);
      if (data.length < T) break;
    }
    return out;
  }
  function desdeCursor() {
    const c = lsGet(LS.cursor);
    if (!c) return null;
    const d = new Date(c);
    return isNaN(d) ? null : new Date(d.getTime() - 5000).toISOString();   // 5 s de folga: o que repetir é ignorado
  }
  function guardarCursor(linhas) {
    let mx = lsGet(LS.cursor) || '';
    for (const l of linhas) if (l.updated_at > mx) mx = l.updated_at;
    if (mx) lsSet(LS.cursor, mx);
  }

  async function puxar() {
    if (!sb || !sessao || offline) return;
    if (puxando) { pendentePuxar = true; return; }
    puxando = true; status();
    try {
      do {
        pendentePuxar = false;
        const linhas = await puxarLinhas(desdeCursor());
        if (linhas.length) { await aplicar(linhas); guardarCursor(linhas); }
      } while (pendentePuxar);
      puxando = false; status('ok');
    } catch (e) { console.warn('Falha ao receber alterações:', e); puxando = false; status('erro'); }
  }
  function agendarPuxar() { clearTimeout(timerPuxar); timerPuxar = setTimeout(puxar, 120); }

  async function enviar() {
    if (!sb || !sessao || enviando || offline || !navigator.onLine) return;
    enviando = true; status();
    try {
      while (fila.size) {
        const lote = [];
        let bytes = 0;
        for (const [k, s] of fila) {
          const i = k.indexOf('|'), kind = k.slice(0, i), id = k.slice(i + 1);
          const reg = await lerLocal(kind, id);
          const linha = reg === undefined ? { kind, id, data: null, deleted: true } : { kind, id, data: reg, deleted: false };
          const tam = JSON.stringify(linha).length;
          if (lote.length && (bytes + tam > 700000 || lote.length >= 40)) break;
          lote.push({ k, s, linha }); bytes += tam;
        }
        const { error } = await sb.from('registros').upsert(lote.map(x => x.linha), { onConflict: 'kind,id' });
        if (error) throw error;
        for (const x of lote) if (fila.get(x.k) === x.s) fila.delete(x.k);
        salvarFilaJa();
      }
    } catch (e) {
      console.warn('Falha ao enviar alterações:', e);
      clearTimeout(timerRetry); timerRetry = setTimeout(enviar, 15000);
      enviando = false; status('erro'); return;
    }
    enviando = false; status('ok');
  }
  function agendarEnvio() { clearTimeout(timerEnvio); timerEnvio = setTimeout(enviar, 400); }

  async function sincronizacaoInicial() {
    const idUsuario = sessao.user.id;
    const primeira = lsGet(LS.init) !== idUsuario;
    const catsLocais = primeira ? await lerLocal('meta', 'cats') : undefined;
    const linhas = await puxarLinhas(primeira ? null : desdeCursor());
    await aplicar(linhas);
    if (primeira) {
      const noServidor = new Set(linhas.map(l => l.kind + '|' + l.id));
      for (const [store, kind] of [['prods', 'prod'], ['movs', 'mov']]) {
        const chaves = await req(tx(store).getAllKeys());
        chaves.forEach(k => { if (!noServidor.has(kind + '|' + k)) enfileirar(kind + '|' + k); });
      }
      for (const k of META_SYNC) {
        if (!noServidor.has('meta|' + k) && (await lerLocal('meta', k)) !== undefined) enfileirar('meta|' + k);
      }
      if (Array.isArray(catsLocais)) {                        // junta as categorias deste aparelho com as do servidor
        const atuais = (await lerLocal('meta', 'cats')) || [];
        const uniao = [...atuais];
        catsLocais.forEach(c => { if (!uniao.includes(c)) uniao.push(c); });
        if (uniao.length !== atuais.length) { await req(tx('meta', 'readwrite').put(uniao, 'cats')); await recarregar(); }
      }
      lsSet(LS.init, idUsuario);
    }
    guardarCursor(linhas);
    await enviar();
  }

  function assinar() {
    if (canal || !sb) return;
    canal = sb.channel('registros-ao-vivo')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'registros' }, agendarPuxar)
      .subscribe(st => { conectado = st === 'SUBSCRIBED'; if (conectado) puxar(); status(); });
  }
  function pararSync() {
    conectado = false;
    if (canal && sb) { try { sb.removeChannel(canal); } catch (_) { /* ok */ } }
    canal = null;
    timers.forEach(clearInterval); timers = [];
  }

  /* ------------------------------------------------------------------ logs no Discord */
  const lerLogs = () => { try { return JSON.parse(lsGet(LS.logs) || '[]'); } catch (_) { return []; } };
  const gravarLogs = l => lsSet(LS.logs, JSON.stringify(l.slice(-200)));
  let enviandoLogs = false;
  function registrarLog(titulo, texto, nivel) {
    const l = lerLogs();
    l.push({ t: String(titulo || ''), x: String(texto || ''), n: nivel || 'info', q: new Date().toISOString() });
    gravarLogs(l);
    enviarLogs();
  }
  async function enviarLogs() {
    if (!sb || !sessao || enviandoLogs || !navigator.onLine) return;
    enviandoLogs = true;
    try {
      let l = lerLogs();
      while (l.length) {
        const it = l[0];
        const { error } = await sb.rpc('registrar_log', { p_titulo: it.t, p_texto: it.x, p_nivel: it.n, p_origem: ORIGEM, p_quando: it.q });
        if (error) { console.warn('Falha ao enviar log:', error.message); break; }
        l.shift(); gravarLogs(l);
        await sleep(400);                                    // respeita o limite de mensagens do Discord
      }
    } catch (e) { console.warn('Falha ao enviar log:', e); }
    finally { enviandoLogs = false; }
  }
  window.registrarLog = registrarLog;

  /* ------------------------------------------------------------------ interface */
  function status(estado) {
    const el = $('syncStatus'), txt = $('syncTxt');
    if (!el || !txt) return;
    el.hidden = false;
    if (estado === 'erro') erroSync = true; else if (estado === 'ok') erroSync = false;
    const pend = fila.size;
    let cls, t;
    if (offline || !navigator.onLine) { cls = 'off'; t = 'Offline' + (pend ? ` — ${pend} alteração(ões) a enviar` : ' — salvando neste aparelho'); }
    else if (erroSync) { cls = 'erro'; t = 'Falha ao sincronizar — tentando de novo'; }
    else if (enviando || puxando || pend > 0) { cls = 'sync'; t = 'Sincronizando…'; }
    else if (conectado) { cls = 'ok'; t = 'Conectado — em tempo real'; }
    else { cls = 'sync'; t = 'Conectando…'; }
    el.className = 'sync ' + cls; txt.textContent = t;
  }
  const bloquear = on => document.documentElement.classList.toggle('ic-bloqueado', on);
  function msg(id, texto, ok) { const e = $(id); if (e) { e.textContent = texto || ''; e.classList.toggle('ok', !!ok); } }
  const trava = (btn, on) => { if (btn) btn.disabled = on; };

  function mostrar(id) {
    painelAtual = id;
    document.querySelectorAll('#auth .auth-p').forEach(p => p.classList.toggle('on', p.id === id));
    document.querySelectorAll('#auth .auth-msg').forEach(m => { m.textContent = ''; m.classList.remove('ok'); });
    const campo = $(id) && $(id).querySelector('input');
    if (campo) setTimeout(() => campo.focus(), 30);
  }
  const urlSite = () => CFG.siteUrl || (/^https?:$/.test(location.protocol) ? location.origin + location.pathname : '');

  function preencherConta() {
    const u = sessao && sessao.user;
    $('cEmail').textContent = (u && u.email) || '—';
    ['cSenha1', 'cSenha2'].forEach(i => { $(i).value = ''; });
    msg('mConta', '');
  }

  function montarUI() {
    const sync = $('syncStatus'), btnConta = $('btnConta');
    if (sync) sync.hidden = false;
    if (btnConta) { btnConta.hidden = false; btnConta.onclick = () => { preencherConta(); $('dconta').showModal(); }; }
    document.querySelectorAll('#auth [data-ir]').forEach(b => b.onclick = () => {
      if (b.dataset.ir === 'pLogin') recuperando = false;
      mostrar(b.dataset.ir);
    });

    $('pLogin').onsubmit = async e => {
      e.preventDefault();
      const email = $('aEmail').value.trim(), senha = $('aSenha').value;
      if (!email || !senha) { msg('mLogin', 'Informe e-mail e senha.'); return; }
      trava($('bEntrar'), true); msg('mLogin', ''); loginManual = true; tipoEntrada = 'Login';
      const { error } = await sb.auth.signInWithPassword({ email, password: senha });
      trava($('bEntrar'), false);
      if (error) { loginManual = false; msg('mLogin', traduzir(error)); } else $('aSenha').value = '';
    };

    $('pCadastro').onsubmit = async e => {
      e.preventDefault();
      const email = $('cadEmail').value.trim(), senha = $('cadSenha').value, confirmar = $('cadSenha2').value;
      if (!email || $('cadEmail').validity.typeMismatch) { msg('mCadastro', 'Informe um endereço de e-mail válido.'); return; }
      if (senha.length < 8) { msg('mCadastro', 'A senha precisa ter pelo menos 8 caracteres.'); return; }
      if (senha !== confirmar) { msg('mCadastro', 'As senhas não conferem.'); return; }

      trava($('bCadastro'), true); msg('mCadastro', ''); loginManual = true; tipoEntrada = 'Cadastro';
      try {
        const redirectTo = urlSite();
        const options = redirectTo ? { emailRedirectTo: redirectTo } : undefined;
        const { data, error } = await sb.auth.signUp({ email, password: senha, options });
        if (error) { loginManual = false; tipoEntrada = 'Login'; msg('mCadastro', traduzir(error)); return; }
        $('cadSenha').value = ''; $('cadSenha2').value = '';
        if (data.session) {
          $('cadEmail').value = '';
        } else {
          loginManual = false; tipoEntrada = 'Login';
          msg('mCadastro', 'Conta criada! Confira seu e-mail para confirmar o cadastro e depois entre.', true);
        }
      } catch (error) {
        loginManual = false; tipoEntrada = 'Login';
        msg('mCadastro', traduzir(error));
      } finally {
        trava($('bCadastro'), false);
      }
    };

    $('bRecEmail').onclick = async () => {
      const email = $('rEmail').value.trim();
      if (!email || $('rEmail').validity.typeMismatch) { msg('mEsqueci', 'Informe um endereço de e-mail válido.'); return; }
      trava($('bRecEmail'), true);
      const { error } = await sb.auth.resetPasswordForEmail(email);
      trava($('bRecEmail'), false);
      if (error) { msg('mEsqueci', traduzir(error)); return; }
      emailRecuperacao = email;
      $('aCod').value = '';
      mostrar('pCodigo');
      msg('mCodigo', 'Se este e-mail estiver cadastrado, enviamos o código. Confira também o spam.', true);
    };

    $('bReenviar').onclick = async () => {
      if (!emailRecuperacao) { mostrar('pEsqueci'); return; }
      trava($('bReenviar'), true);
      const { error } = await sb.auth.resetPasswordForEmail(emailRecuperacao);
      if (error) msg('mCodigo', traduzir(error));
      else msg('mCodigo', 'Se este e-mail estiver cadastrado, enviamos um novo código. Confira também o spam.', true);
      trava($('bReenviar'), false);
    };
    $('pCodigo').onsubmit = async e => {
      e.preventDefault();
      const token = $('aCod').value.replace(/\D/g, '');
      if (token.length < 6) { msg('mCodigo', 'Digite o código de 6 dígitos.'); return; }
      trava($('bCodigo'), true); loginManual = true; tipoEntrada = 'Login';
      const { data, error } = await sb.auth.verifyOtp({ email: emailRecuperacao, token, type: 'recovery' });
      trava($('bCodigo'), false);
      if (error) { loginManual = false; msg('mCodigo', traduzir(error)); return; }
      if (!data.session) {
        loginManual = false;
        msg('mCodigo', 'O código foi aceito, mas a sessão não foi iniciada. Solicite um novo código e tente novamente.');
        return;
      }
      sessao = data.session;
      const { data: sessionData, error: sessionError } = await sb.auth.getSession();
      if (sessionError) {
        loginManual = false; msg('mCodigo', traduzir(sessionError)); return;
      }
      if (!sessionData.session) {
        const { error: setSessionError } = await sb.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token
        });
        if (setSessionError) {
          loginManual = false; msg('mCodigo', traduzir(setSessionError)); return;
        }
      }
      recuperando = true; mostrar('pNova');
    };

    $('pNova').onsubmit = async e => {
      e.preventDefault();
      const s1 = $('nSenha1').value, s2 = $('nSenha2').value;
      if (s1.length < 8) { msg('mNova', 'A senha precisa ter pelo menos 8 caracteres.'); return; }
      if (s1 !== s2) { msg('mNova', 'As senhas não conferem.'); return; }
      trava($('bNova'), true);
      const { data: sessionData, error: sessionError } = await sb.auth.getSession();
      if (sessionError || !sessionData.session) {
        trava($('bNova'), false);
        msg('mNova', sessionError ? traduzir(sessionError) : traduzir(new Error('Auth session missing')));
        return;
      }
      const { error } = await sb.auth.updateUser({ password: s1 });
      trava($('bNova'), false);
      if (error) { msg('mNova', traduzir(error)); return; }
      $('nSenha1').value = ''; $('nSenha2').value = '';
      recuperando = false; loginManual = true;
      registrarLog('🔑 Senha redefinida', 'A senha de acesso foi redefinida pela recuperação de senha.', 'aviso');
      if (!entrou) entrar();
    };
    $('bNovaCancelar').onclick = async () => { await sairDaConta(); };

    /* minha conta */
    $('cFechar').onclick = () => $('dconta').close();
    $('cSair').onclick = async () => { $('dconta').close(); await sairDaConta(); };
    $('cSenhaOk').onclick = async () => {
      const s1 = $('cSenha1').value, s2 = $('cSenha2').value;
      if (s1.length < 8) { msg('mConta', 'A senha precisa ter pelo menos 8 caracteres.'); return; }
      if (s1 !== s2) { msg('mConta', 'As senhas não conferem.'); return; }
      const { data: sessionData, error: sessionError } = await sb.auth.getSession();
      if (sessionError || !sessionData.session) {
        msg('mConta', sessionError ? traduzir(sessionError) : traduzir(new Error('Auth session missing')));
        return;
      }
      const { error } = await sb.auth.updateUser({ password: s1 });
      if (error) { msg('mConta', traduzir(error)); return; }
      $('cSenha1').value = ''; $('cSenha2').value = '';
      msg('mConta', 'Senha alterada.', true);
      registrarLog('🔑 Senha alterada', 'A senha de acesso foi alterada em Minha conta.', 'aviso');
    };
  }

  /* ------------------------------------------------------------------ fluxo de entrada/saída */
  async function entrar() {
    if (entrou) return;
    entrou = true; offline = false;
    lsSet(LS.logado, (sessao && sessao.user && sessao.user.email) || '1');
    const foiLogin = loginManual, cadastro = tipoEntrada === 'Cadastro'; loginManual = false; tipoEntrada = 'Login';
    bloquear(false); status('sync');
    await esperarApp();
    try {
      await sincronizacaoInicial();
      assinar();
      timers.push(setInterval(puxar, 60000), setInterval(() => { enviar(); enviarLogs(); }, 30000));
      status('ok');
      if (foiLogin) registrarLog(cadastro ? '📝 Novo cadastro' : '🔐 Login', `${cadastro ? 'Criou uma conta' : 'Entrou no sistema'} pelo ${ORIGEM}.`, 'ok');
    } catch (e) {
      console.error('Falha na sincronização inicial:', e);
      status('erro'); clearTimeout(timerRetry); timerRetry = setTimeout(enviar, 15000);
    }
    enviarLogs();
  }
  function entrarOffline() {
    if (entrou) return;
    entrou = true; offline = true;
    bloquear(false); status();
  }
  function sairDaApp(avisoLogin) {
    entrou = false; offline = false; recuperando = false; loginManual = false;
    pararSync();
    bloquear(true); mostrar('pLogin');
    if (avisoLogin) msg('mLogin', avisoLogin);
  }
  async function sairDaConta() {
    try { await enviarLogsAntesDeSair(); } catch (_) { /* segue */ }
    lsDel(LS.logado);
    let erro = null;
    try { ({ error: erro } = await sb.auth.signOut()); } catch (e) { erro = e; }
    if (erro) {                                              // sem internet: limpa a sessão guardada neste aparelho
      Object.keys(localStorage).filter(k => k.startsWith('sb-')).forEach(lsDel);
      sessao = null; sairDaApp();
    }
  }
  async function enviarLogsAntesDeSair() {
    if (entrou && sessao && !offline) { registrarLog('🚪 Saída', `Saiu do sistema (${ORIGEM}).`, 'info'); await Promise.race([enviarLogs(), sleep(2500)]); }
  }

  function tratarAuth(ev, ses) {
    sessao = ses || null;
    if (ev === 'PASSWORD_RECOVERY') { recuperando = true; mostrar('pNova'); return; }
    if (ev === 'SIGNED_OUT') { sairDaApp(); return; }
    if (ev === 'USER_UPDATED') return;
    if (ses && (ev === 'SIGNED_IN' || ev === 'INITIAL_SESSION' || ev === 'TOKEN_REFRESHED')) {
      if (recuperando) { if (painelAtual !== 'pNova') mostrar('pNova'); return; }
      if (!entrou) entrar();
      return;
    }
    if (ev === 'INITIAL_SESSION' && !ses && !entrou) {
      if (!navigator.onLine && lsGet(LS.logado)) entrarOffline(); else mostrar('pLogin');
    }
  }

  async function aoVoltarOnline() {
    status();
    if (!sb) return;
    if (offline) {                                           // estava usando sem internet: valida a sessão
      const { data } = await sb.auth.getSession();
      if (data && data.session) { sessao = data.session; entrou = false; offline = false; entrar(); }
      else sairDaApp('Sua sessão expirou. Entre novamente.');
      return;
    }
    puxar(); enviar(); enviarLogs();
  }

  async function iniciar() {
    montarUI();
    mostrar('pCarregando');
    const ok = await garantirLib();
    if (!ok) {
      if (lsGet(LS.logado)) entrarOffline();
      else { mostrar('pLogin'); msg('mLogin', 'Não foi possível conectar ao servidor. Verifique a internet e recarregue a página.'); }
      return;
    }
    recuperando = /type=recovery/.test(location.hash);
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 10 } }
    });
    sb.auth.onAuthStateChange((ev, ses) => { setTimeout(() => tratarAuth(ev, ses), 0); });
    window.addEventListener('online', aoVoltarOnline);
    window.addEventListener('offline', () => status());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && entrou && !offline) { puxar(); enviar(); } });
    const { data, error } = await sb.auth.getSession();
    if (!entrou && !(data && data.session) && !recuperando) {
      if (error && lsGet(LS.logado) && !navigator.onLine) entrarOffline(); else if (painelAtual === 'pCarregando') mostrar('pLogin');
    }
  }

  window.addEventListener('load', () => { iniciar().catch(e => console.error('Falha ao iniciar o login:', e)); });
})();
