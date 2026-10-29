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

-- 4) Logs no Discord
create extension if not exists pg_net;

-- guarda o endereço do webhook do Discord (ninguém de fora consegue ler)
create table if not exists public.config_segredos (
  chave text primary key,
  valor text not null
);
alter table public.config_segredos enable row level security;
revoke all on public.config_segredos from anon, authenticated;

create or replace function public.registrar_log(
  p_titulo text,
  p_texto  text        default '',
  p_nivel  text        default 'info',
  p_origem text        default 'site',
  p_quando timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url   text;
  v_quem  text;
  v_cor   int;
  v_corpo jsonb;
begin
  if auth.uid() is null then
    raise exception 'não autenticado';
  end if;

  select valor into v_url from public.config_segredos where chave = 'discord_webhook';
  if v_url is null or v_url = '' then
    return;                                   -- webhook ainda não configurado: ignora
  end if;

  select coalesce(email, phone, 'usuário') into v_quem from auth.users where id = auth.uid();

  v_cor := case p_nivel
             when 'ok'     then 3066993       -- verde
             when 'aviso'  then 15844367      -- amarelo
             when 'perigo' then 15158332      -- vermelho
             else 3447003                     -- azul
           end;

  v_corpo := jsonb_build_object(
    'username', 'Estoque Intacto Car',
    'embeds', jsonb_build_array(jsonb_build_object(
      'title',       left(coalesce(p_titulo, ''), 250),
      'description', left(coalesce(p_texto, ''), 3800),
      'color',       v_cor,
      'timestamp',   to_char(least(p_quando, now()) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'footer',      jsonb_build_object('text', coalesce(v_quem, 'usuário') || ' • ' || coalesce(p_origem, 'site'))
    ))
  );

  perform net.http_post(
    url     := v_url,
    body    := v_corpo,
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
end $$;

revoke all on function public.registrar_log(text, text, text, text, timestamptz) from public, anon;
grant execute on function public.registrar_log(text, text, text, text, timestamptz) to authenticated;

-- =====================================================================
-- DEPOIS de rodar o script acima, rode este comando SEPARADAMENTE,
-- trocando o endereço pelo webhook do seu canal do Discord:
--
-- insert into public.config_segredos (chave, valor)
-- values ('discord_webhook', 'https://discord.com/api/webhooks/SEU_ID/SEU_TOKEN')
-- on conflict (chave) do update set valor = excluded.valor;
-- =====================================================================
