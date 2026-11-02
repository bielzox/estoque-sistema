(() => {
  'use strict';

  const PAGE_SIZE = 50;
  const MAX_SELECTED = 500;
  const PASSWORD_ITERATIONS = 210000;
  const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  const CONTROL_IDS = ['refresh', 'searchTitle', 'searchUser', 'source', 'severity', 'fromDate', 'toDate', 'applyFilters', 'clearFilters', 'export', 'previous', 'next', 'selectPage', 'selectPageButton', 'deleteSelected', 'configureClearPassword', 'adminAreaButton', 'adminApproveUserButton'];
  const $ = id => document.getElementById(id);
  const state = { client: null, page: 0, count: 0, allowed: false, channel: null, selectedIds: new Set(), loading: false, mutating: false };
  let auditRefreshTimer = null;
  let filterTimer = null;
  let reloadAfterCurrent = false;
  let areaPasswordSalt = '';
  let areaPasswordHash = '';
  let adminAreaNextPanel = 'options';

  function setControlsEnabled(enabled) {
    CONTROL_IDS.forEach(id => { $(id).disabled = !enabled; });
  }

  function showMessage(text, type = 'error') {
    const authVisible = !$('loginPanel').hidden;
    const message = $('message');
    message.textContent = text || '';
    message.hidden = !text || authVisible;
    message.classList.toggle('success', !!text && type === 'success');
    const authMessage = $('authMessage');
    authMessage.textContent = text || '';
    authMessage.hidden = !text || !authVisible;
    authMessage.classList.toggle('success', !!text && type === 'success');
  }

  function setStatus(text) {
    $('connection').textContent = text;
  }

  function adminAreaErrorMessage(error) {
    const message = error?.message || String(error);
    if (error?.code === 'PGRST202' || (message.includes('admin_get_area_password_salt') && message.toLowerCase().includes('schema cache'))) {
      return 'O Supabase ainda não reconhece as funções da Área Admin. No SQL Editor do projeto, execute todo o arquivo supabase/setup.sql, aguarde a conclusão e tente novamente.';
    }
    return message;
  }

  function showLogin(visible) {
    $('loginPanel').hidden = !visible;
    $('logout').hidden = visible;
  }

  function setAuthMode(mode) {
    const registering = mode === 'register';
    $('loginForm').hidden = registering;
    $('registerForm').hidden = !registering;
    $('showLoginTab').setAttribute('aria-selected', String(!registering));
    $('showRegisterTab').setAttribute('aria-selected', String(registering));
    $('authTitle').textContent = registering ? 'Crie sua conta' : 'Bem-vindo de volta';
    $('authIntro').textContent = registering
      ? 'Cadastre sua conta para usar os serviços Intacto Car.'
      : 'Entre com sua conta do sistema. O acesso administrativo é validado separadamente.';
    showMessage('');
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function hexToBytes(hex) {
    return Uint8Array.from(hex.match(/.{2}/g) || [], byte => parseInt(byte, 16));
  }

  async function derivePassword(password, salt) {
    if (!crypto.subtle) throw new Error('A proteção por senha não está disponível neste ambiente seguro.');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({
      name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS
    }, key, 256));
  }

  const ADMIN_AREA_PANELS = ['adminAreaSetup', 'adminAreaVerify', 'adminAreaOptions', 'adminAreaDelete', 'adminAreaUser', 'adminAreaConfirmEmail', 'adminAreaChange'];

  function showAdminAreaPanel(panel, title, info) {
    ADMIN_AREA_PANELS.forEach(id => { $(id).hidden = id !== panel; });
    $('adminAreaTitle').textContent = title;
    $('adminAreaInfo').textContent = info || '';
    $('adminAreaMessage').textContent = '';
    $('adminAreaMessage').classList.remove('success');
  }

  function clearAdminAreaInputs() {
    ['adminAreaNew', 'adminAreaConfirm', 'adminAreaPassword', 'adminDeleteNew', 'adminDeleteConfirm', 'adminUserEmail', 'adminUserNew', 'adminUserConfirm', 'adminConfirmEmail', 'adminAreaChangeNew', 'adminAreaChangeConfirm']
      .forEach(id => { $(id).value = ''; });
  }

  function showAdminAreaNextPanel() {
    if (adminAreaNextPanel === 'confirmEmail') {
      showAdminAreaPanel('adminAreaConfirmEmail', 'Aprovar usuário', 'Verifique a identidade da pessoa antes de confirmar o e-mail.');
      return;
    }
    showAdminAreaPanel('adminAreaOptions', 'Área Admin', 'Selecione a senha que deseja redefinir.');
  }

  async function openAdminArea(nextPanel = 'options') {
    if (!state.allowed) return;
    adminAreaNextPanel = nextPanel;
    clearAdminAreaInputs();
    areaPasswordSalt = '';
    areaPasswordHash = '';
    try {
      const { data: salt, error } = await state.client.rpc('admin_get_area_password_salt');
      if (error) throw error;
      areaPasswordSalt = salt || '';
      if (areaPasswordSalt) {
        showAdminAreaPanel('adminAreaVerify', 'Área Admin', 'Informe sua senha administrativa para continuar.');
      } else {
        showAdminAreaPanel('adminAreaSetup', 'Cadastrar senha administrativa', 'Este é o primeiro acesso desta conta. Crie uma senha para proteger as redefinições.');
      }
      $('adminAreaDialog').showModal();
    } catch (error) {
      adminAreaNextPanel = 'options';
      console.error('Falha ao abrir a Área Admin:', error);
      showMessage(`Não foi possível abrir a Área Admin: ${adminAreaErrorMessage(error)}`);
    }
  }

  async function saveAreaPassword() {
    const newPassword = $('adminAreaNew').value;
    if (newPassword.length < 8 || newPassword.length > 128) {
      $('adminAreaMessage').textContent = 'Use uma senha entre 8 e 128 caracteres.';
      return;
    }
    if (newPassword !== $('adminAreaConfirm').value) {
      $('adminAreaMessage').textContent = 'As senhas não conferem.';
      return;
    }
    const button = $('adminAreaSaveSetup');
    button.disabled = true;
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = bytesToHex(await derivePassword(newPassword, salt));
      const { data, error } = await state.client.rpc('admin_set_area_password', {
        p_salt: bytesToHex(salt),
        p_hash: hash,
        p_current_hash: null
      });
      if (error) throw error;
      if (data !== true) throw new Error('O banco não confirmou o cadastro da senha administrativa.');
      areaPasswordSalt = bytesToHex(salt);
      areaPasswordHash = hash;
      clearAdminAreaInputs();
      showAdminAreaNextPanel();
      $('adminAreaMessage').textContent = 'Senha administrativa cadastrada com segurança.';
      $('adminAreaMessage').classList.add('success');
    } catch (error) {
      console.error('Falha ao cadastrar a senha administrativa:', error);
      $('adminAreaMessage').textContent = `Não foi possível cadastrar a senha: ${error.message || error}`;
    } finally {
      button.disabled = false;
    }
  }

  async function verifyAreaPassword() {
    const button = $('adminAreaVerifyButton');
    button.disabled = true;
    try {
      const passwordHash = bytesToHex(await derivePassword($('adminAreaPassword').value, hexToBytes(areaPasswordSalt)));
      const { data, error } = await state.client.rpc('admin_verify_area_password', { p_password_hash: passwordHash });
      if (error) throw error;
      if (!data) {
        $('adminAreaMessage').textContent = 'Senha administrativa incorreta.';
        $('adminAreaPassword').value = '';
        $('adminAreaPassword').focus();
        return;
      }
      areaPasswordHash = passwordHash;
      clearAdminAreaInputs();
      showAdminAreaNextPanel();
    } catch (error) {
      console.error('Falha ao validar a senha administrativa:', error);
      $('adminAreaMessage').textContent = `Não foi possível validar a senha: ${error.message || error}`;
    } finally {
      button.disabled = false;
    }
  }

  async function changeAreaPassword() {
    const newPassword = $('adminAreaChangeNew').value;
    if (newPassword.length < 8 || newPassword.length > 128) {
      $('adminAreaMessage').textContent = 'Use uma senha entre 8 e 128 caracteres.';
      return;
    }
    if (newPassword !== $('adminAreaChangeConfirm').value) {
      $('adminAreaMessage').textContent = 'As senhas não conferem.';
      return;
    }
    const button = $('adminAreaChangeSave');
    button.disabled = true;
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = bytesToHex(await derivePassword(newPassword, salt));
      const { data, error } = await state.client.rpc('admin_set_area_password', {
        p_salt: bytesToHex(salt),
        p_hash: hash,
        p_current_hash: areaPasswordHash
      });
      if (error) throw error;
      if (data !== true) throw new Error('A senha administrativa atual não foi confirmada.');
      areaPasswordSalt = bytesToHex(salt);
      areaPasswordHash = hash;
      clearAdminAreaInputs();
      showAdminAreaPanel('adminAreaOptions', 'Área Admin', 'Senha administrativa atualizada.');
      $('adminAreaMessage').classList.add('success');
    } catch (error) {
      console.error('Falha ao alterar a senha administrativa:', error);
      $('adminAreaMessage').textContent = `Não foi possível alterar a senha: ${error.message || error}`;
    } finally {
      button.disabled = false;
    }
  }

  async function resetDeletePassword() {
    const newPassword = $('adminDeleteNew').value;
    if (newPassword.length < 8 || newPassword.length > 128) {
      $('adminAreaMessage').textContent = 'Use uma senha entre 8 e 128 caracteres.';
      return;
    }
    if (newPassword !== $('adminDeleteConfirm').value) {
      $('adminAreaMessage').textContent = 'As senhas não conferem.';
      return;
    }
    if (!window.confirm('A senha de exclusão será substituída para todos os aparelhos sincronizados. Continuar?')) return;
    const button = $('adminDeleteSave');
    button.disabled = true;
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = bytesToHex(await derivePassword(newPassword, salt));
      const { data, error } = await state.client.rpc('admin_reset_delete_password', {
        p_salt: bytesToHex(salt),
        p_hash: bytesToHex(hash),
        p_admin_hash: areaPasswordHash
      });
      if (error) throw error;
      if (data !== true) throw new Error('A senha administrativa não foi confirmada.');
      $('adminAreaDialog').close();
      showMessage('Senha de exclusão redefinida e sincronizada com o estoque.', 'success');
    } catch (error) {
      console.error('Falha ao redefinir a senha de exclusão:', error);
      $('adminAreaMessage').textContent = `Não foi possível redefinir a senha: ${error.message || error}`;
    } finally {
      button.disabled = false;
    }
  }

  async function resetUserPassword() {
    const email = $('adminUserEmail').value.trim();
    const newPassword = $('adminUserNew').value;
    if (!email || $('adminUserEmail').validity.typeMismatch) {
      $('adminAreaMessage').textContent = 'Informe um e-mail válido.';
      $('adminUserEmail').focus();
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      $('adminAreaMessage').textContent = 'Use uma senha entre 8 e 128 caracteres.';
      return;
    }
    if (newPassword !== $('adminUserConfirm').value) {
      $('adminAreaMessage').textContent = 'As senhas não conferem.';
      return;
    }
    if (!window.confirm(`Redefinir a senha da conta ${email}? As sessões existentes serão encerradas.`)) return;
    const button = $('adminUserSave');
    button.disabled = true;
    try {
      const { data, error } = await state.client.rpc('admin_reset_user_password', {
        p_email: email,
        p_new_password: newPassword,
        p_admin_hash: areaPasswordHash
      });
      if (error) throw error;
      if (data !== true) throw new Error('A senha administrativa não foi confirmada.');
      $('adminAreaDialog').close();
      showMessage('Senha da conta redefinida. As sessões anteriores foram encerradas.', 'success');
    } catch (error) {
      console.error('Falha ao redefinir a senha da conta:', error);
      $('adminAreaMessage').textContent = `Não foi possível redefinir a senha: ${error.message || error}`;
    } finally {
      button.disabled = false;
    }
  }

  async function approveUserEmail() {
    const email = $('adminConfirmEmail').value.trim();
    if (!email || $('adminConfirmEmail').validity.typeMismatch) {
      $('adminAreaMessage').textContent = 'Informe um e-mail válido.';
      $('adminConfirmEmail').focus();
      return;
    }
    if (!window.confirm(`Aprovar o e-mail ${email} sem confirmação pelo link enviado? Confirme a identidade da pessoa por outro meio antes de continuar.`)) return;
    const button = $('adminConfirmEmailSave');
    button.disabled = true;
    try {
      const { data, error } = await state.client.rpc('admin_confirm_user_email', {
        p_email: email,
        p_admin_hash: areaPasswordHash
      });
      if (error) throw error;
      if (data === 'invalid_admin_password') throw new Error('A senha administrativa não foi confirmada.');
      if (data === 'already_confirmed') {
        $('adminAreaMessage').textContent = 'Este e-mail já estava aprovado.';
        $('adminAreaMessage').classList.add('success');
        return;
      }
      if (data !== 'approved') throw new Error('O banco não confirmou a aprovação do e-mail.');
      $('adminAreaDialog').close();
      showMessage(`E-mail ${email} aprovado. A pessoa já pode entrar com a senha cadastrada.`, 'success');
    } catch (error) {
      console.error('Falha ao aprovar o e-mail da conta:', error);
      $('adminAreaMessage').textContent = `Não foi possível aprovar o e-mail: ${error.message || error}`;
    } finally {
      button.disabled = false;
    }
  }

  async function getClearPasswordSalt() {
    const { data, error } = await state.client.rpc('admin_get_clear_password_salt');
    if (error) throw error;
    return data;
  }

  function updateSelectionControls() {
    const count = state.selectedIds.size;
    $('selectionInfo').textContent = `${count} selecionado(s)${count >= MAX_SELECTED ? ' · limite atingido' : ''}`;
    $('deleteSelected').textContent = count ? `Limpar selecionados (${count})` : 'Limpar selecionados';
    $('deleteSelected').disabled = !state.allowed || count === 0 || state.loading || state.mutating;
    const visible = [...$('rows').querySelectorAll('[data-audit-id]')];
    const checked = visible.filter(row => state.selectedIds.has(Number(row.dataset.auditId))).length;
    const allSelected = visible.length > 0 && checked === visible.length;
    visible.forEach(row => {
      const selected = state.selectedIds.has(Number(row.dataset.auditId));
      const checkbox = row.querySelector('input[type="checkbox"]');
      const deleteButton = row.querySelector('button');
      checkbox.disabled = !state.allowed || state.loading || state.mutating || (!selected && count >= MAX_SELECTED);
      deleteButton.disabled = !state.allowed || state.loading || state.mutating;
    });
    $('selectPage').checked = allSelected;
    $('selectPage').indeterminate = checked > 0 && checked < visible.length;
    $('selectPage').disabled = !state.allowed || state.loading || state.mutating || (!allSelected && count >= MAX_SELECTED);
    $('selectPageButton').textContent = allSelected
      ? 'Desmarcar esta página'
      : count >= MAX_SELECTED && checked > 0 ? 'Remover seleção desta página' : 'Selecionar esta página';
    $('selectPageButton').disabled = !state.allowed || state.loading || state.mutating || visible.length === 0 || (count >= MAX_SELECTED && checked === 0);
  }

  function setPageSelection(selected) {
    const rows = [...$('rows').querySelectorAll('[data-audit-id]')];
    if (selected) {
      const candidates = rows
        .map(row => Number(row.dataset.auditId))
        .filter(id => !state.selectedIds.has(id));
      const available = Math.max(0, MAX_SELECTED - state.selectedIds.size);
      candidates.slice(0, available).forEach(id => state.selectedIds.add(id));
      if (candidates.length > available) {
        showMessage(`Selecionamos até o limite de ${MAX_SELECTED} registros. Desmarque outros para selecionar mais.`);
      } else {
        showMessage('');
      }
    } else {
      rows.forEach(row => state.selectedIds.delete(Number(row.dataset.auditId)));
      showMessage('');
    }
    updateSelectionControls();
  }

  function setSelected(id, selected) {
    if (selected) {
      if (state.selectedIds.size >= MAX_SELECTED) {
        showMessage(`É possível selecionar até ${MAX_SELECTED} registros por vez.`);
        return false;
      }
      state.selectedIds.add(id);
    } else {
      state.selectedIds.delete(id);
    }
    updateSelectionControls();
    return true;
  }

  function scheduleFilter() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      state.page = 0;
      state.selectedIds.clear();
      updateSelectionControls();
      loadPage();
    }, 250);
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

  async function ensureConfig() {
    const isConfigured = () => window.INTACTO_CONFIG?.supabaseUrl && window.INTACTO_CONFIG?.supabaseAnonKey;
    if (!isConfigured()) {
      await loadScript('https://bielzox.github.io/estoque-sistema/config.js');
    }
    if (!isConfigured()) {
      throw new Error('A conexão Supabase não está configurada neste app/site.');
    }
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
    const title = $('searchTitle').value.trim();
    const user = $('searchUser').value.trim();
    const source = $('source').value;
    const severity = $('severity').value;
    const from = $('fromDate').value;
    const to = $('toDate').value;
    if (from && to && from > to) throw new Error('A data inicial não pode ser posterior à data final.');
    if (title) {
      const pattern = `%${title.replace(/[\\%_"]/g, '\\$&')}%`;
      query = query.or(`title.ilike."${pattern}",description.ilike."${pattern}"`);
    }
    if (user) query = query.ilike('actor_email', `%${user.replace(/[\\%_]/g, '\\$&')}%`);
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
    disclosure.className = 'audit-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Ver comparação';
    disclosure.appendChild(summary);
    const comparison = document.createElement('div');
    comparison.className = 'audit-compare';
    for (const [label, value, tone] of [['Antes', before, 'before'], ['Depois', after, 'after']]) {
      const snapshot = document.createElement('section');
      snapshot.className = `audit-snapshot ${tone}`;
      const heading = document.createElement('div');
      heading.className = 'audit-snapshot-heading';
      heading.textContent = label;
      snapshot.appendChild(heading);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const fields = Object.entries(value);
        if (fields.length) {
          const list = document.createElement('dl');
          fields.forEach(([key, fieldValue]) => {
            const entry = document.createElement('div');
            const term = document.createElement('dt');
            term.textContent = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
            const definition = document.createElement('dd');
            if (fieldValue !== null && typeof fieldValue === 'object') {
              const pre = document.createElement('pre');
              pre.textContent = JSON.stringify(fieldValue, null, 2);
              definition.appendChild(pre);
            } else {
              definition.textContent = fieldValue == null || fieldValue === '' ? '—' : String(fieldValue);
            }
            entry.append(term, definition);
            list.appendChild(entry);
          });
          snapshot.appendChild(list);
        } else {
          const empty = document.createElement('p');
          empty.className = 'audit-snapshot-empty';
          empty.textContent = 'Nenhum dado registrado.';
          snapshot.appendChild(empty);
        }
      } else if (value === undefined || value === null) {
        const empty = document.createElement('p');
        empty.className = 'audit-snapshot-empty';
        empty.textContent = 'Sem dados registrados.';
        snapshot.appendChild(empty);
      } else {
        const text = document.createElement('p');
        text.className = 'audit-snapshot-empty';
        text.textContent = String(value);
        snapshot.appendChild(text);
      }
      comparison.appendChild(snapshot);
    }
    disclosure.appendChild(comparison);
    cell.appendChild(disclosure);
    row.appendChild(cell);
  }

  function renderRows(items) {
    const body = $('rows');
    body.replaceChildren();
    if (!items.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 8;
      cell.className = 'empty';
      cell.textContent = 'Nenhum registro encontrado.';
      row.appendChild(cell);
      body.appendChild(row);
      updateSelectionControls();
      return;
    }
    for (const item of items) {
      const row = document.createElement('tr');
      row.dataset.auditId = String(item.id);
      const selectionCell = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selectedIds.has(Number(item.id));
      checkbox.disabled = !state.allowed || state.loading;
      checkbox.setAttribute('aria-label', `Selecionar ${item.title}`);
      checkbox.addEventListener('change', () => {
        if (!setSelected(Number(item.id), checkbox.checked)) checkbox.checked = false;
      });
      selectionCell.appendChild(checkbox);
      row.appendChild(selectionCell);
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
      const actions = document.createElement('td');
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'danger';
      deleteButton.textContent = 'Apagar';
      deleteButton.disabled = !state.allowed || state.loading;
      deleteButton.setAttribute('aria-label', `Apagar registro: ${item.title}`);
      deleteButton.addEventListener('click', () => deleteOne(item));
      actions.appendChild(deleteButton);
      row.appendChild(actions);
      body.appendChild(row);
    }
    updateSelectionControls();
  }

  async function loadPage() {
    if (!state.allowed) return;
    if (state.loading) {
      reloadAfterCurrent = true;
      return;
    }
    state.loading = true;
    $('refresh').disabled = true;
    $('applyFilters').disabled = true;
    updateSelectionControls();
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
      setStatus('Permissões administrativas.');
    } catch (error) {
      console.error('Falha ao consultar auditoria:', error);
      showMessage(`Não foi possível carregar os registros: ${error.message || error}`);
      setStatus('Falha ao consultar auditoria.');
    } finally {
      state.loading = false;
      $('refresh').disabled = state.mutating;
      $('applyFilters').disabled = state.mutating;
      updateSelectionControls();
      if (reloadAfterCurrent && !state.mutating) {
        reloadAfterCurrent = false;
        await loadPage();
      }
    }
  }

  function setBulkControlsEnabled(enabled) {
    state.mutating = !enabled;
    if (enabled) reloadAfterCurrent = false;
    updateSelectionControls();
    $('refresh').disabled = !enabled || state.loading;
    $('applyFilters').disabled = !enabled || state.loading;
    $('clearFilters').disabled = !enabled || state.loading;
    $('export').disabled = !enabled || state.loading;
    $('previous').disabled = !enabled || state.loading || state.page === 0;
    $('next').disabled = !enabled || state.loading || (state.page + 1) * PAGE_SIZE >= state.count;
  }

  async function deleteIds(ids, description, passwordHash = null) {
    if (!state.allowed || !ids.length) return;
    setBulkControlsEnabled(false);
    showMessage('');
    try {
      const request = passwordHash
        ? state.client.rpc('admin_clear_audit_logs', { p_ids: ids, p_password_hash: passwordHash })
        : state.client.rpc('admin_delete_audit_log', { p_id: ids[0] });
      const { data, error } = await request;
      if (error) throw error;
      const deleted = Number(data);
      if (!Number.isInteger(deleted) || deleted < 0) throw new Error('O servidor retornou uma quantidade inválida.');
      ids.forEach(id => state.selectedIds.delete(Number(id)));
      showMessage(`${deleted} registro(s) apagado(s): ${description}.`);
      await loadPage();
      return true;
    } catch (error) {
      console.error('Falha ao apagar registros de auditoria:', error);
      showMessage(`Não foi possível apagar os registros: ${error.message || error}`);
      return false;
    } finally {
      setBulkControlsEnabled(true);
      updateSelectionControls();
    }
  }

  async function deleteOne(item) {
    if (!window.confirm(`Apagar o registro “${item.title}”?`)) return;
    await deleteIds([Number(item.id)], item.title);
  }

  async function openPasswordSetup() {
    if (!state.allowed) return;
    showMessage('');
    try {
      const salt = await getClearPasswordSalt();
      $('clearPasswordSetupTitle').textContent = salt ? 'Alterar senha para limpar' : 'Configurar senha para limpar';
      $('clearPasswordSetupInfo').textContent = salt
        ? 'Informe a senha atual e escolha uma nova. A configuração vale para esta conta admin.'
        : 'Crie uma senha de no mínimo 8 caracteres. Ela será protegida no Supabase e vinculada a esta conta admin.';
      $('clearPasswordCurrentWrap').hidden = !salt;
      $('clearPasswordCurrent').required = !!salt;
      $('clearPasswordCurrent').value = '';
      $('clearPasswordNew').value = '';
      $('clearPasswordConfirm').value = '';
      $('clearPasswordSetupError').hidden = true;
      $('clearPasswordSetupError').textContent = '';
      $('clearPasswordSetup').dataset.savedSalt = salt || '';
      $('clearPasswordSetup').showModal();
    } catch (error) {
      console.error('Falha ao consultar a configuração da senha de limpeza:', error);
      showMessage(`Não foi possível consultar a senha de limpeza: ${error.message || error}`);
    }
  }

  async function saveClearPassword(event) {
    event.preventDefault();
    const form = $('clearPasswordSetupForm');
    const button = form.querySelector('[type="submit"]');
    const newPassword = $('clearPasswordNew').value;
    button.disabled = true;
    showMessage('');
    try {
      if (newPassword.length < 8 || newPassword.length > 128) throw new Error('A senha precisa ter entre 8 e 128 caracteres.');
      if (newPassword !== $('clearPasswordConfirm').value) throw new Error('As senhas não conferem.');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = await derivePassword(newPassword, salt);
      const savedSalt = $('clearPasswordSetup').dataset.savedSalt;
      const currentHash = savedSalt
        ? bytesToHex(await derivePassword($('clearPasswordCurrent').value, hexToBytes(savedSalt)))
        : null;
      const { error } = await state.client.rpc('admin_set_clear_password', {
        p_salt: bytesToHex(salt),
        p_hash: bytesToHex(hash),
        p_current_hash: currentHash
      });
      if (error) throw error;
      $('clearPasswordSetup').close();
      showMessage('Senha para limpar configurada para esta conta admin.');
    } catch (error) {
      console.error('Falha ao configurar senha para limpar:', error);
      $('clearPasswordSetupError').textContent = error.message || String(error);
      $('clearPasswordSetupError').hidden = false;
    } finally {
      button.disabled = false;
    }
  }

  async function clearSelected() {
    const ids = [...state.selectedIds];
    if (!ids.length || !state.allowed) return;
    try {
      const salt = await getClearPasswordSalt();
      if (!salt) {
        showMessage('Configure uma senha para limpar antes de continuar.');
        await openPasswordSetup();
        return;
      }
      $('clearPasswordVerify').dataset.savedSalt = salt;
      $('clearPasswordVerify').dataset.selectedIds = JSON.stringify(ids);
      $('clearPasswordVerifyInfo').textContent = `Digite sua senha para apagar ${ids.length} registro(s) selecionado(s).`;
      $('clearPasswordInput').value = '';
      $('clearPasswordVerifyError').hidden = true;
      $('clearPasswordVerifyError').textContent = '';
      $('clearPasswordVerify').showModal();
      $('clearPasswordInput').focus();
    } catch (error) {
      console.error('Falha ao preparar a limpeza da auditoria:', error);
      showMessage(`Não foi possível preparar a limpeza: ${error.message || error}`);
    }
  }

  async function verifyAndClearSelected(event) {
    event.preventDefault();
    const button = $('clearPasswordVerifyForm').querySelector('[type="submit"]');
    button.disabled = true;
    showMessage('');
    try {
      const salt = $('clearPasswordVerify').dataset.savedSalt;
      const ids = JSON.parse($('clearPasswordVerify').dataset.selectedIds || '[]');
      if (!salt) throw new Error('Configure uma senha para limpar e tente novamente.');
      const passwordHash = bytesToHex(await derivePassword($('clearPasswordInput').value, hexToBytes(salt)));
      if (await deleteIds(ids, 'registros selecionados', passwordHash)) {
        $('clearPasswordVerify').close();
      } else {
        $('clearPasswordVerifyInfo').textContent = $('message').textContent || 'Não foi possível limpar os registros.';
        $('clearPasswordInput').value = '';
        $('clearPasswordInput').focus();
      }
    } catch (error) {
      console.error('Falha ao confirmar a limpeza da auditoria:', error);
      $('clearPasswordVerifyError').textContent = `Não foi possível limpar: ${error.message || error}`;
      $('clearPasswordVerifyError').hidden = false;
      $('clearPasswordInput').value = '';
      $('clearPasswordInput').focus();
    } finally {
      button.disabled = false;
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
    state.selectedIds.clear();
    updateSelectionControls();
    loadPage();
  }

  async function init() {
    try {
      await ensureConfig();
      if (window.INTACTO_CONFIG.siteUrl) $('backToApp').href = window.INTACTO_CONFIG.siteUrl;
      await ensureSupabase();
      state.client = window.supabase.createClient(window.INTACTO_CONFIG.supabaseUrl, window.INTACTO_CONFIG.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const { data, error } = await state.client.auth.getSession();
      if (error) throw error;
      if (!data.session) {
        showLogin(true);
        setStatus('Entre com sua conta para continuar.');
        $('rows').innerHTML = '<tr><td class="empty" colspan="8">Faça login para consultar os registros.</td></tr>';
        return;
      }
      showLogin(false);
      const { data: authorized, error: authorizationError } = await state.client.rpc('admin_is_authorized');
      if (authorizationError) {
        throw new Error(`Não foi possível validar a permissão. Execute supabase/setup.sql no Supabase. ${authorizationError.message}`);
      }
      if (!authorized) {
        setStatus(`Conta conectada: ${data.session.user.email || 'usuário'}`);
        showMessage('Acesso negado. Autorize esta conta na tabela de administradores pelo SQL Editor do Supabase.');
        $('rows').innerHTML = '<tr><td class="empty" colspan="8">Esta conta não está autorizada como administradora.</td></tr>';
        return;
      }
      state.allowed = true;
      setControlsEnabled(true);
      $('logout').hidden = false;
      $('configureClearPassword').hidden = false;
      $('adminAreaButton').hidden = false;
      $('adminApproveUserButton').hidden = false;
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
      showLogin(true);
      showMessage(error.message || String(error));
    }
  }

  $('showLoginTab').addEventListener('click', () => setAuthMode('login'));
  $('showRegisterTab').addEventListener('click', () => setAuthMode('register'));
  $('loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('loginButton');
    button.disabled = true;
    showMessage('');
    try {
      if (!state.client) throw new Error('A conexão ainda está sendo preparada. Tente novamente.');
      const { error } = await state.client.auth.signInWithPassword({
        email: $('loginEmail').value.trim(),
        password: $('loginPassword').value
      });
      if (error) throw error;
      $('loginPassword').value = '';
      window.location.reload();
    } catch (error) {
      console.error('Falha ao entrar no painel administrativo:', error);
      showMessage(`Não foi possível entrar: ${error.message || error}`);
    } finally {
      button.disabled = false;
    }
  });
  $('registerForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('registerButton');
    const email = $('registerEmail').value.trim();
    const password = $('registerPassword').value;
    if (password.length < 8) {
      showMessage('A senha precisa ter pelo menos 8 caracteres.');
      $('registerPassword').focus();
      return;
    }
    if (password !== $('registerPasswordConfirm').value) {
      showMessage('As senhas não conferem.');
      $('registerPasswordConfirm').focus();
      return;
    }
    button.disabled = true;
    showMessage('');
    try {
      if (!state.client) throw new Error('A conexão ainda está sendo preparada. Tente novamente.');
      const { data, error } = await state.client.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) {
        const { error: signOutError } = await state.client.auth.signOut({ scope: 'local' });
        if (signOutError) throw new Error(`A conta foi criada, mas não foi possível encerrar a sessão: ${signOutError.message}`);
      }
      $('registerPassword').value = '';
      $('registerPasswordConfirm').value = '';
      $('loginEmail').value = email;
      setAuthMode('login');
      showMessage(data.session
        ? 'Conta criada. Entre com ela; o acesso administrativo ainda precisa ser autorizado por um administrador.'
        : 'Solicitação enviada. Confira seu e-mail para concluir o cadastro. O acesso administrativo também precisa ser autorizado por um administrador.',
      'success');
    } catch (error) {
      console.error('Falha ao criar conta no painel administrativo:', error);
      showMessage(`Não foi possível criar a conta: ${error.message || error}`);
    } finally {
      button.disabled = false;
    }
  });
  $('logout').addEventListener('click', async () => {
    $('logout').disabled = true;
    showMessage('');
    try {
      const { data, error: sessionError } = await state.client.auth.getSession();
      if (sessionError) throw sessionError;
      if (data.session) {
        const { error } = await state.client.auth.signOut({ scope: 'local' });
        if (error) throw error;
      }
      window.location.reload();
    } catch (error) {
      if (error?.name === 'AuthSessionMissingError' || error?.message === 'Auth session missing!') {
        window.location.reload();
        return;
      }
      console.error('Falha ao sair do painel administrativo:', error);
      showMessage(`Não foi possível sair: ${error.message || error}`);
      $('logout').disabled = false;
    }
  });
  $('configureClearPassword').addEventListener('click', openPasswordSetup);
  $('adminAreaButton').addEventListener('click', openAdminArea);
  $('adminApproveUserButton').addEventListener('click', () => openAdminArea('confirmEmail'));
  $('adminAreaCancelSetup').addEventListener('click', () => $('adminAreaDialog').close());
  $('adminAreaCancelVerify').addEventListener('click', () => $('adminAreaDialog').close());
  $('adminAreaCloseOptions').addEventListener('click', () => $('adminAreaDialog').close());
  $('adminAreaSaveSetup').addEventListener('click', saveAreaPassword);
  $('adminAreaVerifyButton').addEventListener('click', verifyAreaPassword);
  $('adminAreaDeleteOption').addEventListener('click', () => showAdminAreaPanel('adminAreaDelete', 'Redefinir senha de exclusão', 'A nova senha será sincronizada com os demais aparelhos.'));
  $('adminAreaUserOption').addEventListener('click', () => showAdminAreaPanel('adminAreaUser', 'Redefinir senha de usuário', 'Informe o e-mail cadastrado e defina uma nova senha.'));
  $('adminAreaConfirmEmailOption').addEventListener('click', () => showAdminAreaPanel('adminAreaConfirmEmail', 'Aprovar e-mail de usuário', 'Esta ação substitui a confirmação pelo link do e-mail. Verifique a identidade da pessoa antes de aprovar.'));
  $('adminAreaChangeOption').addEventListener('click', () => showAdminAreaPanel('adminAreaChange', 'Alterar senha administrativa', 'Confirme uma nova senha para proteger a Área Admin.'));
  document.querySelectorAll('.adminAreaBack').forEach(button => button.addEventListener('click', () => showAdminAreaPanel('adminAreaOptions', 'Área Admin', 'Selecione a senha que deseja redefinir.')));
  $('adminAreaChangeSave').addEventListener('click', changeAreaPassword);
  $('adminDeleteSave').addEventListener('click', resetDeletePassword);
  $('adminUserSave').addEventListener('click', resetUserPassword);
  $('adminConfirmEmailSave').addEventListener('click', approveUserEmail);
  $('adminAreaDialog').addEventListener('close', () => {
    areaPasswordSalt = '';
    areaPasswordHash = '';
    adminAreaNextPanel = 'options';
    clearAdminAreaInputs();
  });
  $('clearPasswordSetupForm').addEventListener('submit', saveClearPassword);
  $('cancelPasswordSetup').addEventListener('click', () => $('clearPasswordSetup').close());
  $('clearPasswordVerifyForm').addEventListener('submit', verifyAndClearSelected);
  $('cancelPasswordVerify').addEventListener('click', () => $('clearPasswordVerify').close());
  $('deleteSelected').addEventListener('click', clearSelected);
  $('selectPage').addEventListener('change', event => setPageSelection(event.currentTarget.checked));
  $('selectPageButton').addEventListener('click', () => {
    const rows = [...$('rows').querySelectorAll('[data-audit-id]')];
    const checked = rows.filter(row => state.selectedIds.has(Number(row.dataset.auditId))).length;
    const cappedPartialPage = state.selectedIds.size >= MAX_SELECTED && checked > 0 && checked < rows.length;
    setPageSelection(!$('selectPage').checked && !cappedPartialPage);
  });
  $('refresh').addEventListener('click', loadPage);
  $('applyFilters').addEventListener('click', () => {
    state.page = 0;
    state.selectedIds.clear();
    loadPage();
  });
  $('clearFilters').addEventListener('click', clearFilters);
  $('previous').addEventListener('click', () => {
    if (state.page > 0) {
      state.page--;
      updateSelectionControls();
      loadPage();
    }
  });
  $('next').addEventListener('click', () => {
    if ((state.page + 1) * PAGE_SIZE < state.count) {
      state.page++;
      updateSelectionControls();
      loadPage();
    }
  });
  $('export').addEventListener('click', exportCsv);
  setControlsEnabled(false);
  window.addEventListener('pagehide', () => {
    clearTimeout(auditRefreshTimer);
    if (state.channel) state.client.removeChannel(state.channel);
  });
  for (const id of ['searchTitle', 'searchUser']) $(id).addEventListener('input', scheduleFilter);
  for (const id of ['source', 'severity', 'fromDate', 'toDate']) $(id).addEventListener('change', scheduleFilter);
  init();
})();
