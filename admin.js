(() => {
  'use strict';

  const PAGE_SIZE = 50;
  const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  const CONTROL_IDS = ['refresh', 'searchTitle', 'searchUser', 'source', 'severity', 'fromDate', 'toDate', 'applyFilters', 'clearFilters', 'export', 'previous', 'next'];
  const $ = id => document.getElementById(id);
  const state = { client: null, page: 0, count: 0, allowed: false, channel: null };
  let auditRefreshTimer = null;

  function setControlsEnabled(enabled) {
    CONTROL_IDS.forEach(id => { $(id).disabled = !enabled; });
  }

  function showMessage(text) {
    const message = $('message');
    message.textContent = text || '';
    message.hidden = !text;
  }

  function setStatus(text) {
    $('connection').textContent = text;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => {
        script.remove();
        reject(new Error(`Não foi possível carregar ${src}.`));
      };
      document.head.appendChild(script);
    });
  }

  async function ensureSupabase() {
    if (window.supabase?.createClient) return;
    for (const src of ['./vendor/supabase.js', CDN]) {
      try {
        await loadScript(src);
        if (window.supabase?.createClient) return;
      } catch (_) {
        // Tenta a próxima origem HTTPS.
      }
    }
    throw new Error('Não foi possível carregar a biblioteca de conexão com o Supabase.');
  }

  function queryWithFilters() {
    let query = state.client
      .from('audit_logs')
      .select('id,created_at,actor_email,title,description,severity,source,details', { count: 'exact' });
    const title = $('searchTitle').value.trim().replace(/[\\%_]/g, '\\$&');
    const user = $('searchUser').value.trim().replace(/[\\%_]/g, '\\$&');
    const source = $('source').value;
    const severity = $('severity').value;
    const from = $('fromDate').value;
    const to = $('toDate').value;
    if (title) query = query.ilike('title', `%${title}%`);
    if (user) query = query.ilike('actor_email', `%${user}%`);
    if (source) query = query.eq('source', source);
    if (severity) query = query.eq('severity', severity);
    if (from) query = query.gte('created_at', new Date(`${from}T00:00:00`).toISOString());
    if (to) {
      const nextDay = new Date(`${to}T00:00:00`);
      nextDay.setDate(nextDay.getDate() + 1);
      query = query.lt('created_at', nextDay.toISOString());
    }
    return query;
  }

  function addTextCell(row, value) {
    const cell = document.createElement('td');
    cell.textContent = value == null ? '' : String(value);
    row.appendChild(cell);
    return cell;
  }

  function addDetailsCell(row, details) {
    const cell = document.createElement('td');
    const before = details && details.before;
    const after = details && details.after;
    if (before === undefined && after === undefined) {
      cell.textContent = '—';
      row.appendChild(cell);
      return;
    }
    const disclosure = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Ver antes/depois';
    disclosure.appendChild(summary);
    for (const [label, value] of [['Antes', before], ['Depois', after]]) {
      if (value === undefined) continue;
      const heading = document.createElement('strong');
      heading.textContent = label;
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(value, null, 2);
      disclosure.append(heading, pre);
    }
    cell.appendChild(disclosure);
    row.appendChild(cell);
  }

  function renderRows(items) {
    const body = $('rows');
    body.replaceChildren();
    if (!items.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.className = 'empty';
      cell.textContent = 'Nenhum registro encontrado.';
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }
    for (const item of items) {
      const row = document.createElement('tr');
      const time = new Date(item.created_at);
      addTextCell(row, Number.isNaN(time.getTime()) ? item.created_at : time.toLocaleString('pt-BR'));
      addTextCell(row, item.actor_email || 'usuário');
      const action = addTextCell(row, item.title);
      if (item.description) {
        const description = document.createElement('small');
        description.textContent = item.description;
        action.appendChild(description);
      }
      const severityCell = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge ${item.severity || 'info'}`;
      badge.textContent = ({ info: 'Informação', ok: 'Sucesso', aviso: 'Atenção', perigo: 'Crítico' })[item.severity] || 'Informação';
      severityCell.appendChild(badge);
      row.appendChild(severityCell);
      addTextCell(row, item.source === 'aplicativo' ? 'Aplicativo' : 'Site');
      addDetailsCell(row, item.details || {});
      body.appendChild(row);
    }
  }

  async function loadPage() {
    if (!state.allowed) return;
    $('refresh').disabled = true;
    $('applyFilters').disabled = true;
    showMessage('');
    setStatus('Carregando auditoria…');
    try {
      const from = state.page * PAGE_SIZE;
      const { data, error, count } = await queryWithFilters()
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      state.count = count || 0;
      renderRows(data || []);
      const pages = Math.max(1, Math.ceil(state.count / PAGE_SIZE));
      $('pageInfo').textContent = `Página ${state.page + 1} de ${pages}`;
      $('previous').disabled = state.page === 0;
      $('next').disabled = from + PAGE_SIZE >= state.count;
      $('summary').textContent = `${state.count} registro(s) com os filtros atuais · retenção de 12 meses`;
      setStatus('Permissão administrativa validada pelo Supabase.');
    } catch (error) {
      console.error('Falha ao consultar auditoria:', error);
      showMessage(`Não foi possível carregar os registros: ${error.message || error}`);
      setStatus('Falha ao consultar auditoria.');
    } finally {
      $('refresh').disabled = false;
      $('applyFilters').disabled = false;
    }
  }

  function csvValue(value) {
    let text = value == null ? '' : String(value);
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  async function exportCsv() {
    if (!state.allowed) return;
    $('export').disabled = true;
    showMessage('');
    try {
      const all = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await queryWithFilters()
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(offset, offset + 499);
        if (error) throw error;
        all.push(...(data || []));
        if (!data || data.length < 500) break;
      }
      const columns = ['Data e hora', 'Usuário', 'Ação', 'Descrição', 'Nível', 'Origem', 'Alterações'];
      const rows = all.map(item => [
        item.created_at,
        item.actor_email,
        item.title,
        item.description,
        item.severity,
        item.source,
        JSON.stringify(item.details || {})
      ]);
      const csv = '\ufeff' + [columns, ...rows].map(row => row.map(csvValue).join(';')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `auditoria-intacto-car-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(`${all.length} registro(s) exportado(s).`);
    } catch (error) {
      console.error('Falha ao exportar auditoria:', error);
      showMessage(`Não foi possível exportar: ${error.message || error}`);
    } finally {
      $('export').disabled = false;
    }
  }

  function clearFilters() {
    for (const id of ['searchTitle', 'searchUser', 'source', 'severity', 'fromDate', 'toDate']) $(id).value = '';
    state.page = 0;
    loadPage();
  }

  async function init() {
    try {
      if (!window.INTACTO_CONFIG?.supabaseUrl || !window.INTACTO_CONFIG?.supabaseAnonKey) {
        throw new Error('A conexão Supabase não está configurada neste app/site.');
      }
      await ensureSupabase();
      state.client = window.supabase.createClient(window.INTACTO_CONFIG.supabaseUrl, window.INTACTO_CONFIG.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const { data, error } = await state.client.auth.getSession();
      if (error) throw error;
      if (!data.session) {
        setStatus('Entre no app/site com sua conta e abra o painel novamente.');
        $('rows').innerHTML = '<tr><td class="empty" colspan="6">É necessário ter uma sessão autenticada no app/site.</td></tr>';
        return;
      }
      const { data: authorized, error: authorizationError } = await state.client.rpc('admin_is_authorized');
      if (authorizationError) {
        throw new Error(`Não foi possível validar a permissão. Execute supabase/setup.sql no Supabase. ${authorizationError.message}`);
      }
      if (!authorized) {
        setStatus(`Conta conectada: ${data.session.user.email || 'usuário'}`);
        showMessage('Acesso negado. Autorize esta conta na tabela de administradores pelo SQL Editor do Supabase.');
        $('rows').innerHTML = '<tr><td class="empty" colspan="6">Esta conta não está autorizada como administradora.</td></tr>';
        return;
      }
      state.allowed = true;
      setControlsEnabled(true);
      setStatus(`Administradora: ${data.session.user.email || 'conta autorizada'}`);
      state.channel = state.client
        .channel('audit-logs-admin')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_logs' }, () => {
          if (state.page !== 0) return;
          clearTimeout(auditRefreshTimer);
          auditRefreshTimer = setTimeout(loadPage, 300);
        })
        .subscribe(status => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.error('Não foi possível acompanhar a auditoria em tempo real:', status);
          }
        });
      await loadPage();
    } catch (error) {
      console.error('Falha ao iniciar painel administrativo:', error);
      setStatus('Painel indisponível.');
      showMessage(error.message || String(error));
    }
  }

  $('refresh').addEventListener('click', loadPage);
  $('applyFilters').addEventListener('click', () => { state.page = 0; loadPage(); });
  $('clearFilters').addEventListener('click', clearFilters);
  $('previous').addEventListener('click', () => { if (state.page > 0) { state.page--; loadPage(); } });
  $('next').addEventListener('click', () => {
    if ((state.page + 1) * PAGE_SIZE < state.count) { state.page++; loadPage(); }
  });
  $('export').addEventListener('click', exportCsv);
  setControlsEnabled(false);
  window.addEventListener('pagehide', () => {
    clearTimeout(auditRefreshTimer);
    if (state.channel) state.client.removeChannel(state.channel);
  });
  for (const id of ['searchTitle', 'searchUser']) {
    $(id).addEventListener('keydown', event => {
      if (event.key === 'Enter') { state.page = 0; loadPage(); }
    });
  }
  init();
})();
