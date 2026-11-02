-- =====================================================================
-- Estoque Intacto Car — configuração do servidor (Supabase)
-- Como usar: Supabase > SQL Editor > New query > cole TUDO > Run.
-- Pode ser executado mais de uma vez sem problema.
-- =====================================================================

-- 1) Tabela única que guarda produtos, movimentações e configurações compartilhadas
create table if not exists public.registros (
  kind        text        not null check (kind in ('prod', 'mov', 'meta')),
  id          text        not null,
  data        jsonb,
  deleted     boolean     not null default false,
  updated_at  timestamptz not null default clock_timestamp(),
  updated_by  uuid,
  primary key (kind, id)
);
create index if not exists registros_updated_at_idx on public.registros (updated_at);

-- carimbo automático de data e autor a cada gravação
create or replace function public.registros_carimbo()
returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists registros_carimbo on public.registros;
create trigger registros_carimbo
  before insert or update on public.registros
  for each row execute function public.registros_carimbo();

-- 2) Segurança: só usuários logados leem e gravam (nada para visitantes sem login)
alter table public.registros enable row level security;

drop policy if exists "equipe le"     on public.registros;
drop policy if exists "equipe insere" on public.registros;
drop policy if exists "equipe altera" on public.registros;
create policy "equipe le"     on public.registros for select to authenticated using (true);
create policy "equipe insere" on public.registros for insert to authenticated with check (true);
create policy "equipe altera" on public.registros for update to authenticated using (true) with check (true);
-- (não existe política de DELETE: a exclusão é feita marcando deleted = true)

revoke all on public.registros from anon;

-- 3) Tempo real: avisa os aparelhos conectados quando algo muda
do $$
begin
  alter publication supabase_realtime add table public.registros;
exception when duplicate_object then null;
end $$;

-- 4) Auditoria privada do app/site e acesso administrativo
-- Remove a integração antiga e sua configuração armazenada.
drop function if exists public.registrar_log(text, text, text, text, timestamptz);
drop table if exists public.config_segredos;

create table if not exists public.admin_allowlist (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admin_allowlist enable row level security;
revoke all on public.admin_allowlist from anon, authenticated;

create or replace function public.admin_is_authorized()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (select 1 from public.admin_allowlist where user_id = auth.uid())
$$;
revoke all on function public.admin_is_authorized() from public, anon;
grant execute on function public.admin_is_authorized() to authenticated;

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text not null default 'usuário',
  title text not null,
  description text not null default '',
  severity text not null default 'info' check (severity in ('info', 'ok', 'aviso', 'perigo')),
  source text not null check (source in ('site', 'aplicativo')),
  details jsonb not null default '{}'::jsonb
);
create index if not exists audit_logs_created_at_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_actor_id_idx on public.audit_logs (actor_id);
alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;

drop policy if exists "administradores leem auditoria" on public.audit_logs;
create policy "administradores leem auditoria"
  on public.audit_logs for select to authenticated
  using (public.admin_is_authorized());

do $$
begin
  alter publication supabase_realtime add table public.audit_logs;
exception when duplicate_object then null;
end $$;

create or replace function public.sanitize_audit_json(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select coalesce(jsonb_object_agg(
        key,
        case
          when lower(key) ~ '(password|senha|token|secret|webhook|foto|image|imagem|attachment|anexo|base64)'
            then '"[removido]"'::jsonb
          else public.sanitize_audit_json(value)
        end
      ), '{}'::jsonb)
      into v_result
      from jsonb_each(p_value);
      return v_result;
    when 'array' then
      select coalesce(jsonb_agg(public.sanitize_audit_json(value)), '[]'::jsonb)
      into v_result
      from jsonb_array_elements(p_value);
      return v_result;
    when 'string' then
      return to_jsonb(left(p_value #>> '{}', 1000));
    else
      return p_value;
  end case;
end $$;
revoke all on function public.sanitize_audit_json(jsonb) from public, anon, authenticated;

create or replace function public.registrar_log(
  p_titulo text,
  p_texto text default '',
  p_nivel text default 'info',
  p_origem text default 'site',
  p_detalhes jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
begin
  if v_user_id is null then
    raise exception 'É necessário estar autenticado para registrar uma ação.';
  end if;
  if pg_column_size(coalesce(p_detalhes, '{}'::jsonb)) > 32768 then
    raise exception 'Os detalhes do registro excedem o limite permitido.';
  end if;

  select coalesce(email, phone, 'usuário')
    into v_email
    from auth.users
    where id = v_user_id;

  insert into public.audit_logs (actor_id, actor_email, title, description, severity, source, details)
  values (
    v_user_id,
    coalesce(v_email, 'usuário'),
    left(coalesce(nullif(btrim(p_titulo), ''), 'Registro do sistema'), 200),
    left(coalesce(p_texto, ''), 2000),
    case when p_nivel in ('ok', 'aviso', 'perigo') then p_nivel else 'info' end,
    case when p_origem = 'aplicativo' then 'aplicativo' else 'site' end,
    public.sanitize_audit_json(coalesce(p_detalhes, '{}'::jsonb))
  );
end $$;

revoke all on function public.registrar_log(text, text, text, text, jsonb) from public, anon;
grant execute on function public.registrar_log(text, text, text, text, jsonb) to authenticated;

create table if not exists public.admin_clear_passwords (
  user_id uuid primary key references auth.users(id) on delete cascade,
  salt text not null check (salt ~ '^[0-9a-f]{32}$'),
  password_hash text not null check (password_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);
alter table public.admin_clear_passwords enable row level security;
revoke all on public.admin_clear_passwords from anon, authenticated;

create table if not exists public.admin_area_passwords (
  user_id uuid primary key references auth.users(id) on delete cascade,
  salt text not null check (salt ~ '^[0-9a-f]{32}$'),
  password_hash text not null check (password_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);
alter table public.admin_area_passwords enable row level security;
revoke all on public.admin_area_passwords from anon, authenticated;

create table if not exists public.admin_area_password_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.admin_area_password_attempts enable row level security;
revoke all on public.admin_area_password_attempts from anon, authenticated;

create or replace function public.admin_get_area_password_salt()
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.admin_is_authorized() then
    raise exception 'Acesso administrativo obrigatório.';
  end if;
  return (
    select salt
    from public.admin_area_passwords
    where user_id = auth.uid()
  );
end $$;
revoke all on function public.admin_get_area_password_salt() from public, anon;
grant execute on function public.admin_get_area_password_salt() to authenticated;

drop function if exists public.admin_set_area_password(text, text, text);
create function public.admin_set_area_password(
  p_salt text,
  p_hash text,
  p_current_hash text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_saved_hash text;
  v_has_password boolean;
begin
  if v_actor_id is null or not public.admin_is_authorized() then
    raise exception 'Acesso administrativo obrigatório.';
  end if;
  if p_salt is null or p_salt !~ '^[0-9a-f]{32}$'
     or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Formato inválido para a senha administrativa.';
  end if;

  perform 1 from auth.users where id = v_actor_id for update;
  select password_hash
    into v_saved_hash
    from public.admin_area_passwords
    where user_id = v_actor_id
    for update;
  v_has_password := found;

  if v_has_password and p_current_hash is null then
    raise exception 'Senha administrativa atual incorreta.';
  end if;
  if v_has_password and not public.admin_verify_area_password(p_current_hash) then
    return false;
  end if;
  if not v_has_password and p_current_hash is not null then
    raise exception 'Não há uma senha administrativa configurada para esta conta.';
  end if;

  insert into public.admin_area_passwords (user_id, salt, password_hash, updated_at)
  values (v_actor_id, p_salt, p_hash, now())
  on conflict (user_id) do update
    set salt = excluded.salt,
        password_hash = excluded.password_hash,
        updated_at = excluded.updated_at;
  delete from public.admin_area_password_attempts where user_id = v_actor_id;
  return true;
end $$;
revoke all on function public.admin_set_area_password(text, text, text) from public, anon;
grant execute on function public.admin_set_area_password(text, text, text) to authenticated;

create or replace function public.admin_verify_area_password(p_password_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_saved_hash text;
  v_failed_attempts integer;
  v_locked_until timestamptz;
begin
  if auth.uid() is null or not public.admin_is_authorized() then
    raise exception 'Acesso administrativo obrigatório.';
  end if;

  insert into public.admin_area_password_attempts (user_id)
  values (v_actor_id)
  on conflict (user_id) do nothing;
  select failed_attempts, locked_until
    into v_failed_attempts, v_locked_until
    from public.admin_area_password_attempts
    where user_id = v_actor_id
    for update;
  if v_locked_until is not null and v_locked_until > now() then
    raise exception 'Muitas tentativas incorretas. Aguarde 15 minutos e tente novamente.';
  end if;

  select password_hash
    into v_saved_hash
    from public.admin_area_passwords
    where user_id = auth.uid();
  if v_saved_hash is not null
     and p_password_hash is not null
     and p_password_hash ~ '^[0-9a-f]{64}$'
     and p_password_hash = v_saved_hash then
    update public.admin_area_password_attempts
      set failed_attempts = 0, locked_until = null, updated_at = now()
      where user_id = v_actor_id;
    return true;
  end if;

  v_failed_attempts := v_failed_attempts + 1;
  update public.admin_area_password_attempts
    set failed_attempts = v_failed_attempts,
        locked_until = case when v_failed_attempts >= 5 then now() + interval '15 minutes' else null end,
        updated_at = now()
    where user_id = v_actor_id;
  return false;
end $$;
revoke all on function public.admin_verify_area_password(text) from public, anon;
grant execute on function public.admin_verify_area_password(text) to authenticated;

create extension if not exists pgcrypto with schema extensions;

drop function if exists public.admin_reset_delete_password(text, text, text);
create function public.admin_reset_delete_password(
  p_salt text,
  p_hash text,
  p_admin_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_email text;
begin
  if v_actor_id is null or not public.admin_is_authorized() then
    raise exception 'Acesso administrativo obrigatório.';
  end if;
  if p_salt is null or p_salt !~ '^[0-9a-f]{32}$'
     or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Formato inválido para a senha de exclusão.';
  end if;
  if not public.admin_verify_area_password(p_admin_hash) then
    return false;
  end if;

  insert into public.registros (kind, id, data, deleted)
  values (
    'meta',
    'deletePassword',
    jsonb_build_object('version', 1, 'salt', p_salt, 'hash', p_hash),
    false
  )
  on conflict (kind, id) do update
    set data = excluded.data,
        deleted = false;

  select coalesce(email, 'usuário')
    into v_actor_email
    from auth.users
    where id = v_actor_id;
  insert into public.audit_logs (actor_id, actor_email, title, description, severity, source, details)
  values (
    v_actor_id,
    coalesce(v_actor_email, 'usuário'),
    'Senha de exclusão redefinida',
    'A senha compartilhada de exclusão foi redefinida pela Área Admin.',
    'aviso',
    'aplicativo',
    '{}'::jsonb
  );
  return true;
end $$;
revoke all on function public.admin_reset_delete_password(text, text, text) from public, anon;
grant execute on function public.admin_reset_delete_password(text, text, text) to authenticated;

drop function if exists public.admin_reset_user_password(text, text, text);
create function public.admin_reset_user_password(
  p_email text,
  p_new_password text,
  p_admin_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_email text;
  v_target_id uuid;
begin
  if v_actor_id is null or not public.admin_is_authorized() then
    raise exception 'Acesso administrativo obrigatório.';
  end if;
  if p_email is null or length(btrim(p_email)) > 320
     or btrim(p_email) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Informe um e-mail válido.';
  end if;
  if p_new_password is null or length(p_new_password) < 8 or length(p_new_password) > 128 then
    raise exception 'A nova senha precisa ter entre 8 e 128 caracteres.';
  end if;
  if not public.admin_verify_area_password(p_admin_hash) then
    return false;
  end if;

  select id
    into v_target_id
    from auth.users
    where lower(email) = lower(btrim(p_email))
    limit 1;
  if v_target_id is null then
    raise exception 'Não encontramos uma conta com esse e-mail.';
  end if;

  update auth.users
    set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
        updated_at = now()
    where id = v_target_id;
  delete from auth.sessions where user_id = v_target_id;

  select coalesce(email, 'usuário')
    into v_actor_email
    from auth.users
    where id = v_actor_id;
  insert into public.audit_logs (actor_id, actor_email, title, description, severity, source, details)
  values (
    v_actor_id,
    coalesce(v_actor_email, 'usuário'),
    'Senha de usuário redefinida',
    'A senha de uma conta foi redefinida pela Área Admin.',
    'aviso',
    'site',
    jsonb_build_object('email', lower(btrim(p_email)))
  );
  return true;
end $$;
revoke all on function public.admin_reset_user_password(text, text, text) from public, anon;
grant execute on function public.admin_reset_user_password(text, text, text) to authenticated;

drop function if exists public.admin_confirm_user_email(text, text);
create function public.admin_confirm_user_email(
  p_email text,
  p_admin_hash text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_email text;
  v_target_id uuid;
  v_email_confirmed_at timestamptz;
begin
  if v_actor_id is null or not public.admin_is_authorized() then
    raise exception 'Acesso administrativo obrigatório.';
  end if;
  if p_email is null or length(btrim(p_email)) > 320
     or btrim(p_email) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Informe um e-mail válido.';
  end if;
  if not public.admin_verify_area_password(p_admin_hash) then
    return 'invalid_admin_password';
  end if;

  select id, email_confirmed_at
    into v_target_id, v_email_confirmed_at
    from auth.users
    where lower(email) = lower(btrim(p_email))
    limit 1
    for update;
  if v_target_id is null then
    raise exception 'Não encontramos uma conta com esse e-mail.';
  end if;
  if v_email_confirmed_at is not null then
    return 'already_confirmed';
  end if;

  update auth.users
    set email_confirmed_at = now(),
        updated_at = now()
    where id = v_target_id;

  select coalesce(email, 'usuário')
    into v_actor_email
    from auth.users
    where id = v_actor_id;
  insert into public.audit_logs (actor_id, actor_email, title, description, severity, source, details)
  values (
    v_actor_id,
    coalesce(v_actor_email, 'usuário'),
    'E-mail de usuário aprovado',
    'Um administrador confirmou manualmente o e-mail de uma conta pela Área Admin.',
    'aviso',
    'site',
    jsonb_build_object('email', lower(btrim(p_email)))
  );
  return 'approved';
end $$;
revoke all on function public.admin_confirm_user_email(text, text) from public, anon;
grant execute on function public.admin_confirm_user_email(text, text) to authenticated;

create or replace function public.admin_get_clear_password_salt()
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.admin_is_authorized() then
    raise exception 'Acesso administrativo obrigatório.';
  end if;
  return (
    select salt
    from public.admin_clear_passwords
    where user_id = auth.uid()
  );
end $$;
revoke all on function public.admin_get_clear_password_salt() from public, anon;
grant execute on function public.admin_get_clear_password_salt() to authenticated;

create or replace function public.admin_set_clear_password(
  p_salt text,
  p_hash text,
  p_current_hash text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_saved_hash text;
begin
  if v_actor_id is null or not public.admin_is_authorized() then
    raise exception 'Acesso administrativo obrigatório.';
  end if;
  if p_salt is null or p_salt !~ '^[0-9a-f]{32}$'
     or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Formato inválido para a senha de limpeza.';
  end if;

  select password_hash
    into v_saved_hash
    from public.admin_clear_passwords
    where user_id = v_actor_id
    for update;

  if found and (p_current_hash is null or p_current_hash <> v_saved_hash) then
    raise exception 'Senha atual incorreta.';
  end if;
  if not found and p_current_hash is not null then
    raise exception 'Não há uma senha de limpeza configurada para esta conta.';
  end if;

  insert into public.admin_clear_passwords (user_id, salt, password_hash, updated_at)
  values (v_actor_id, p_salt, p_hash, now())
  on conflict (user_id) do update
    set salt = excluded.salt,
        password_hash = excluded.password_hash,
        updated_at = excluded.updated_at;
end $$;
revoke all on function public.admin_set_clear_password(text, text, text) from public, anon;
grant execute on function public.admin_set_clear_password(text, text, text) to authenticated;

create or replace function public.admin_delete_audit_log(p_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_email text;
  v_deleted integer;
begin
  if v_actor_id is null or not public.admin_is_authorized() then
    raise exception 'Acesso administrativo obrigatório para apagar registros.';
  end if;
  if p_id is null then
    raise exception 'Selecione um registro válido para apagar.';
  end if;

  delete from public.audit_logs
  where id = p_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'O registro não foi encontrado ou já foi apagado.';
  end if;

  select coalesce(email, 'usuário')
    into v_actor_email
    from auth.users
    where id = v_actor_id;

  insert into public.audit_logs (actor_id, actor_email, title, description, severity, source, details)
  values (
    v_actor_id,
    coalesce(v_actor_email, 'usuário'),
    'Registros de auditoria apagados',
    'Um registro foi apagado pelo painel administrativo.',
    'aviso',
    'site',
    jsonb_build_object('quantidade', v_deleted, 'modo', 'individual')
  );
  return v_deleted;
end $$;
revoke all on function public.admin_delete_audit_log(bigint) from public, anon;
grant execute on function public.admin_delete_audit_log(bigint) to authenticated;

create or replace function public.admin_clear_audit_logs(p_ids bigint[], p_password_hash text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_email text;
  v_saved_hash text;
  v_deleted integer;
begin
  if v_actor_id is null or not public.admin_is_authorized() then
    raise exception 'Acesso administrativo obrigatório para limpar registros.';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 500 then
    raise exception 'Selecione entre 1 e 500 registros para limpar.';
  end if;
  if p_password_hash is null or p_password_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Senha de limpeza incorreta.';
  end if;

  select password_hash
    into v_saved_hash
    from public.admin_clear_passwords
    where user_id = v_actor_id;
  if v_saved_hash is null or p_password_hash <> v_saved_hash then
    raise exception 'Senha de limpeza incorreta.';
  end if;

  delete from public.audit_logs
  where id = any(p_ids);
  get diagnostics v_deleted = row_count;

  select coalesce(email, 'usuário')
    into v_actor_email
    from auth.users
    where id = v_actor_id;

  insert into public.audit_logs (actor_id, actor_email, title, description, severity, source, details)
  values (
    v_actor_id,
    coalesce(v_actor_email, 'usuário'),
    'Registros de auditoria limpos',
    format('%s registro(s) selecionado(s) limpo(s) pelo painel administrativo.', v_deleted),
    'aviso',
    'site',
    jsonb_build_object('quantidade', v_deleted, 'modo', 'selecionados')
  );
  return v_deleted;
end $$;
revoke all on function public.admin_clear_audit_logs(bigint[], text) from public, anon;
grant execute on function public.admin_clear_audit_logs(bigint[], text) to authenticated;

create extension if not exists pg_cron with schema pg_catalog;
do $$
declare
  v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'estoque-intacto-purge-audit'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
  perform cron.schedule(
    'estoque-intacto-purge-audit',
    '0 3 * * *',
    $job$delete from public.audit_logs where created_at < now() - interval '12 months'$job$
  );
end $$;

notify pgrst, 'reload schema';
