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
