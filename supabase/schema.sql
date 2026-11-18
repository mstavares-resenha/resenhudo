-- =====================================================================
-- RESENHUDO V1 — banco de dados (Supabase / Postgres)
-- Rode este arquivo inteiro uma vez no SQL Editor do Supabase.
-- Segurança: nenhuma tabela é acessível direto pela chave pública.
-- Tudo passa por funções que exigem o código da pelada e, nas ações
-- de organizador, o PIN.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- Tabelas ----------
create table if not exists public.groups (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null check (char_length(name) between 1 and 40),
  admin_pin_hash   text not null,
  failed_attempts  int  not null default 0,
  locked_until     timestamptz,
  created_at       timestamptz not null default now()
);

create table if not exists public.players (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 30),
  nick        text not null default '' check (char_length(nick) <= 30),
  photo       text check (photo is null or (char_length(photo) < 150000 and photo ~ '^data:image/(jpeg|png|webp);base64,')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists players_group_idx on public.players(group_id);

create table if not exists public.rounds (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups(id) on delete cascade,
  date         date not null default current_date,
  score_a      int check (score_a between 0 and 99),
  score_b      int check (score_b between 0 and 99),
  status       text not null default 'open' check (status in ('open','closed')),
  craque_id    uuid references public.players(id) on delete set null,
  bagre_id     uuid references public.players(id) on delete set null,
  excuse_id    uuid,
  mae_dina_id  uuid references public.players(id) on delete set null,
  created_at   timestamptz not null default now(),
  closed_at    timestamptz
);
create index if not exists rounds_group_idx on public.rounds(group_id);
create unique index if not exists rounds_one_open_per_group on public.rounds(group_id) where status = 'open';

create table if not exists public.attendance (
  round_id   uuid not null references public.rounds(id) on delete cascade,
  player_id  uuid not null references public.players(id) on delete cascade,
  primary key (round_id, player_id)
);

create table if not exists public.excuses (
  id          uuid primary key default gen_random_uuid(),
  round_id    uuid not null references public.rounds(id) on delete cascade,
  player_id   uuid not null references public.players(id) on delete cascade,
  text        text not null check (char_length(text) between 1 and 120),
  created_at  timestamptz not null default now()
);
create index if not exists excuses_round_idx on public.excuses(round_id);

do $$ begin
  alter table public.rounds add constraint rounds_excuse_fk foreign key (excuse_id) references public.excuses(id) on delete set null;
exception when duplicate_object then null; end $$;

create table if not exists public.votes (
  round_id   uuid not null references public.rounds(id) on delete cascade,
  voter_id   uuid not null references public.players(id) on delete cascade,
  kind       text not null check (kind in ('craque','bagre','desculpa')),
  target_id  uuid not null,
  created_at timestamptz not null default now(),
  primary key (round_id, voter_id, kind)
);

create table if not exists public.guesses (
  round_id   uuid not null references public.rounds(id) on delete cascade,
  player_id  uuid not null references public.players(id) on delete cascade,
  a          int not null check (a between 0 and 99),
  b          int not null check (b between 0 and 99),
  created_at timestamptz not null default now(),
  primary key (round_id, player_id)
);

-- Ninguém acessa as tabelas direto: só pelas funções abaixo.
alter table public.groups     enable row level security;
alter table public.players    enable row level security;
alter table public.rounds     enable row level security;
alter table public.attendance enable row level security;
alter table public.excuses    enable row level security;
alter table public.votes      enable row level security;
alter table public.guesses    enable row level security;
revoke all on public.groups, public.players, public.rounds, public.attendance, public.excuses, public.votes, public.guesses from anon, authenticated;

-- ---------- Funções internas ----------
create or replace function public._gid(p_code text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from groups where code = upper(trim(coalesce(p_code,'')));
  if v is null then raise exception 'pelada_nao_encontrada'; end if;
  return v;
end $$;

-- Confere o PIN. Não lança erro em PIN errado: devolve null, para o
-- contador de tentativas ficar gravado (bloqueia 15 min após 5 erros).
create or replace function public._admin(p_code text, p_pin text) returns uuid
language plpgsql volatile security definer set search_path = public, extensions as $$
declare g groups;
begin
  select * into g from groups where code = upper(trim(coalesce(p_code,''))) for update;
  if g.id is null then raise exception 'pelada_nao_encontrada'; end if;
  if g.locked_until is not null and g.locked_until > now() then return null; end if;
  if g.admin_pin_hash = extensions.crypt(coalesce(p_pin,''), g.admin_pin_hash) then
    update groups set failed_attempts = 0, locked_until = null where id = g.id;
    return g.id;
  end if;
  update groups
     set failed_attempts = case when g.failed_attempts + 1 >= 5 then 0 else g.failed_attempts + 1 end,
         locked_until    = case when g.failed_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
   where id = g.id;
  return null;
end $$;

create or replace function public._admin_error(p_code text) returns json
language sql stable security definer set search_path = public as $$
  select case when locked_until is not null and locked_until > now()
              then json_build_object('error','bloqueado')
              else json_build_object('error','pin_invalido') end
    from groups where code = upper(trim(coalesce(p_code,'')));
$$;

create or replace function public._member(p_gid uuid, p_player uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from players where id = p_player and group_id = p_gid) then
    raise exception 'jogador_invalido';
  end if;
end $$;

create or replace function public._open_round(p_gid uuid, p_round uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from rounds where id = p_round and group_id = p_gid and status = 'open') then
    raise exception 'rodada_fechada';
  end if;
end $$;

-- ---------- Funções públicas: pelada e jogadores ----------
create or replace function public.create_group(p_name text, p_pin text) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_code text; v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int;
begin
  if char_length(trim(coalesce(p_name,''))) not between 1 and 40 then raise exception 'nome_invalido'; end if;
  if coalesce(p_pin,'') !~ '^[0-9]{4,8}$' then raise exception 'pin_invalido_formato'; end if;
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alpha, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32), 1);
    end loop;
    exit when not exists (select 1 from groups where code = v_code);
  end loop;
  insert into groups(code, name, admin_pin_hash)
  values (v_code, trim(p_name), extensions.crypt(p_pin, extensions.gen_salt('bf')));
  return json_build_object('code', v_code);
end $$;

create or replace function public.get_state(p_code text, p_me uuid default null) returns json
language plpgsql stable security definer set search_path = public as $$
declare v_gid uuid := _gid(p_code);
begin
  return json_build_object(
    'group', (select json_build_object('name', name, 'code', code) from groups where id = v_gid),
    'players', coalesce((select json_agg(json_build_object(
        'id', p.id, 'name', p.name, 'nick', p.nick, 'has_photo', p.photo is not null,
        'updated_at', p.updated_at, 'created_at', p.created_at) order by p.created_at)
      from players p where p.group_id = v_gid), '[]'::json),
    'rounds', coalesce((select json_agg(json_build_object(
        'id', r.id, 'date', r.date, 'score_a', r.score_a, 'score_b', r.score_b, 'status', r.status,
        'craque_id', r.craque_id, 'bagre_id', r.bagre_id, 'excuse_id', r.excuse_id, 'mae_dina_id', r.mae_dina_id,
        'created_at', r.created_at, 'closed_at', r.closed_at,
        'present', coalesce((select json_agg(a.player_id) from attendance a where a.round_id = r.id), '[]'::json),
        'excuses', coalesce((select json_agg(json_build_object('id', e.id, 'player_id', e.player_id, 'text', e.text,
              'votes', case when r.status = 'closed' then (select count(*) from votes v where v.round_id = r.id and v.kind = 'desculpa' and v.target_id = e.id) end)
              order by e.created_at) from excuses e where e.round_id = r.id), '[]'::json),
        'guesses', coalesce((select json_agg(json_build_object('player_id', g.player_id, 'a', g.a, 'b', g.b) order by g.created_at)
              from guesses g where g.round_id = r.id), '[]'::json),
        'voters', json_build_object(
              'craque',   coalesce((select json_agg(v.voter_id) from votes v where v.round_id = r.id and v.kind = 'craque'), '[]'::json),
              'bagre',    coalesce((select json_agg(v.voter_id) from votes v where v.round_id = r.id and v.kind = 'bagre'), '[]'::json),
              'desculpa', coalesce((select json_agg(v.voter_id) from votes v where v.round_id = r.id and v.kind = 'desculpa'), '[]'::json)),
        'tally', case when r.status = 'closed' then json_build_object(
              'craque', coalesce((select json_object_agg(t.target_id, t.n) from (select target_id, count(*) n from votes v where v.round_id = r.id and v.kind = 'craque' group by target_id) t), '{}'::json),
              'bagre',  coalesce((select json_object_agg(t.target_id, t.n) from (select target_id, count(*) n from votes v where v.round_id = r.id and v.kind = 'bagre'  group by target_id) t), '{}'::json)) end,
        'my_votes', case when p_me is null then null else coalesce((select json_object_agg(v.kind, v.target_id) from votes v where v.round_id = r.id and v.voter_id = p_me), '{}'::json) end
      ) order by r.date, r.created_at) from rounds r where r.group_id = v_gid), '[]'::json)
  );
end $$;

create or replace function public.get_photos(p_code text, p_ids uuid[]) returns json
language plpgsql stable security definer set search_path = public as $$
declare v_gid uuid := _gid(p_code);
begin
  return coalesce((select json_object_agg(id, photo) from players
                    where group_id = v_gid and id = any(p_ids[1:60]) and photo is not null), '{}'::json);
end $$;

create or replace function public.join_group(p_code text, p_name text, p_nick text, p_photo text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _gid(p_code); v_id uuid;
begin
  if (select count(*) from players where group_id = v_gid) >= 60 then raise exception 'elenco_cheio'; end if;
  insert into players(group_id, name, nick, photo)
  values (v_gid, trim(p_name), trim(coalesce(p_nick,'')), nullif(p_photo,''))
  returning id into v_id;
  return json_build_object('id', v_id);
end $$;

create or replace function public.update_player(p_code text, p_player uuid, p_name text, p_nick text, p_photo text, p_set_photo boolean default false) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _gid(p_code);
begin
  perform _member(v_gid, p_player);
  update players set
    name = trim(p_name),
    nick = trim(coalesce(p_nick,'')),
    photo = case when p_set_photo then nullif(p_photo,'') else photo end,
    updated_at = now()
  where id = p_player;
  return json_build_object('ok', true);
end $$;

-- ---------- Funções públicas: rodada ----------
create or replace function public.set_attendance(p_code text, p_round uuid, p_player uuid, p_present boolean) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _gid(p_code);
begin
  perform _member(v_gid, p_player);
  perform _open_round(v_gid, p_round);
  if p_present then
    insert into attendance(round_id, player_id) values (p_round, p_player) on conflict do nothing;
  else
    delete from attendance where round_id = p_round and player_id = p_player;
  end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.set_guess(p_code text, p_round uuid, p_player uuid, p_a int, p_b int) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _gid(p_code);
begin
  perform _member(v_gid, p_player);
  perform _open_round(v_gid, p_round);
  if exists (select 1 from rounds where id = p_round and score_a is not null) then raise exception 'palpites_encerrados'; end if;
  insert into guesses(round_id, player_id, a, b) values (p_round, p_player, p_a, p_b)
  on conflict (round_id, player_id) do update set a = excluded.a, b = excluded.b, created_at = now();
  return json_build_object('ok', true);
end $$;

create or replace function public.add_excuse(p_code text, p_round uuid, p_author uuid, p_text text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _gid(p_code); v_id uuid;
begin
  perform _member(v_gid, p_author);
  perform _open_round(v_gid, p_round);
  if (select count(*) from excuses where round_id = p_round) >= 20 then raise exception 'desculpas_demais'; end if;
  insert into excuses(round_id, player_id, text) values (p_round, p_author, regexp_replace(trim(p_text), '\s+', ' ', 'g'))
  returning id into v_id;
  return json_build_object('id', v_id);
end $$;

create or replace function public.cast_vote(p_code text, p_round uuid, p_voter uuid, p_kind text, p_target uuid) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _gid(p_code);
begin
  perform _member(v_gid, p_voter);
  perform _open_round(v_gid, p_round);
  if p_kind in ('craque','bagre') then
    if not exists (select 1 from attendance where round_id = p_round and player_id = p_target) then raise exception 'alvo_invalido'; end if;
  elsif p_kind = 'desculpa' then
    if not exists (select 1 from excuses where round_id = p_round and id = p_target) then raise exception 'alvo_invalido'; end if;
  else
    raise exception 'tipo_invalido';
  end if;
  insert into votes(round_id, voter_id, kind, target_id) values (p_round, p_voter, p_kind, p_target)
  on conflict (round_id, voter_id, kind) do update set target_id = excluded.target_id, created_at = now();
  return json_build_object('ok', true);
end $$;

-- ---------- Funções do organizador (exigem PIN) ----------
create or replace function public.admin_check(p_code text, p_pin text) returns json
language plpgsql volatile security definer set search_path = public as $$
begin
  if _admin(p_code, p_pin) is null then return _admin_error(p_code); end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_rename(p_code text, p_pin text, p_name text) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _admin(p_code, p_pin);
begin
  if v_gid is null then return _admin_error(p_code); end if;
  update groups set name = trim(p_name) where id = v_gid;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_open_round(p_code text, p_pin text, p_date date) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _admin(p_code, p_pin); v_id uuid;
begin
  if v_gid is null then return _admin_error(p_code); end if;
  if exists (select 1 from rounds where group_id = v_gid and status = 'open') then return json_build_object('error','rodada_aberta'); end if;
  insert into rounds(group_id, date) values (v_gid, coalesce(p_date, current_date)) returning id into v_id;
  return json_build_object('id', v_id);
end $$;

create or replace function public.admin_update_round(p_code text, p_pin text, p_round uuid, p_date date, p_score_a int, p_score_b int) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _admin(p_code, p_pin);
begin
  if v_gid is null then return _admin_error(p_code); end if;
  if (p_score_a is null) <> (p_score_b is null) then return json_build_object('error','placar_incompleto'); end if;
  update rounds set date = coalesce(p_date, date), score_a = p_score_a, score_b = p_score_b
   where id = p_round and group_id = v_gid and status = 'open';
  if not found then return json_build_object('error','rodada_fechada'); end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_close_round(p_code text, p_pin text, p_round uuid,
  p_craque uuid default null, p_bagre uuid default null, p_excuse uuid default null) returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  v_gid uuid := _admin(p_code, p_pin);
  r rounds; v_c uuid[]; v_b uuid[]; v_e uuid[]; v_cmax int; v_bmax int; v_emax int;
  v_craque uuid; v_bagre uuid; v_excuse uuid; v_dina uuid;
begin
  if v_gid is null then return _admin_error(p_code); end if;
  select * into r from rounds where id = p_round and group_id = v_gid and status = 'open' for update;
  if r.id is null then return json_build_object('error','rodada_fechada'); end if;
  if (select count(*) from attendance where round_id = r.id) < 2 then return json_build_object('error','poucos_jogadores'); end if;

  select max(n) into v_cmax from (select count(*) n from votes v join attendance a on a.round_id = v.round_id and a.player_id = v.target_id where v.round_id = r.id and v.kind = 'craque' group by v.target_id) t;
  select max(n) into v_bmax from (select count(*) n from votes v join attendance a on a.round_id = v.round_id and a.player_id = v.target_id where v.round_id = r.id and v.kind = 'bagre'  group by v.target_id) t;
  if coalesce(v_cmax,0) = 0 or coalesce(v_bmax,0) = 0 then return json_build_object('error','sem_votos'); end if;

  select array_agg(target_id) into v_c from (select v.target_id from votes v join attendance a on a.round_id = v.round_id and a.player_id = v.target_id where v.round_id = r.id and v.kind = 'craque' group by v.target_id having count(*) = v_cmax) t;
  select array_agg(target_id) into v_b from (select v.target_id from votes v join attendance a on a.round_id = v.round_id and a.player_id = v.target_id where v.round_id = r.id and v.kind = 'bagre'  group by v.target_id having count(*) = v_bmax) t;

  if array_length(v_c,1) > 1 then
    if p_craque is null or not (p_craque = any(v_c)) then return json_build_object('error','empate','kind','craque','ids', to_json(v_c)); end if;
    v_craque := p_craque;
  else v_craque := v_c[1]; end if;
  if array_length(v_b,1) > 1 then
    if p_bagre is null or not (p_bagre = any(v_b)) then return json_build_object('error','empate','kind','bagre','ids', to_json(v_b)); end if;
    v_bagre := p_bagre;
  else v_bagre := v_b[1]; end if;

  select max(n) into v_emax from (select count(*) n from votes v join excuses e on e.id = v.target_id where v.round_id = r.id and v.kind = 'desculpa' group by v.target_id) t;
  if coalesce(v_emax,0) > 0 then
    select array_agg(target_id) into v_e from (select v.target_id from votes v join excuses e on e.id = v.target_id where v.round_id = r.id and v.kind = 'desculpa' group by v.target_id having count(*) = v_emax) t;
    if array_length(v_e,1) > 1 then
      if p_excuse is null or not (p_excuse = any(v_e)) then return json_build_object('error','empate','kind','desculpa','ids', to_json(v_e)); end if;
      v_excuse := p_excuse;
    else v_excuse := v_e[1]; end if;
  end if;

  if r.score_a is not null then
    select g.player_id into v_dina from guesses g where g.round_id = r.id
     order by abs(g.a - r.score_a) + abs(g.b - r.score_b), (sign(g.a - g.b) = sign(r.score_a - r.score_b)) desc, g.created_at
     limit 1;
  end if;

  update rounds set status = 'closed', craque_id = v_craque, bagre_id = v_bagre, excuse_id = v_excuse,
                    mae_dina_id = v_dina, closed_at = now()
   where id = r.id;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_reopen_round(p_code text, p_pin text, p_round uuid) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _admin(p_code, p_pin);
begin
  if v_gid is null then return _admin_error(p_code); end if;
  if exists (select 1 from rounds where group_id = v_gid and status = 'open') then return json_build_object('error','rodada_aberta'); end if;
  update rounds set status = 'open', craque_id = null, bagre_id = null, excuse_id = null, mae_dina_id = null, closed_at = null
   where id = p_round and group_id = v_gid;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_delete_round(p_code text, p_pin text, p_round uuid) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _admin(p_code, p_pin);
begin
  if v_gid is null then return _admin_error(p_code); end if;
  update rounds set excuse_id = null where id = p_round and group_id = v_gid;
  delete from rounds where id = p_round and group_id = v_gid;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_remove_player(p_code text, p_pin text, p_player uuid) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _admin(p_code, p_pin);
begin
  if v_gid is null then return _admin_error(p_code); end if;
  delete from players where id = p_player and group_id = v_gid;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_delete_excuse(p_code text, p_pin text, p_excuse uuid) returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_gid uuid := _admin(p_code, p_pin);
begin
  if v_gid is null then return _admin_error(p_code); end if;
  delete from votes v using excuses e, rounds r
   where v.target_id = e.id and v.kind = 'desculpa' and e.id = p_excuse and r.id = e.round_id and r.group_id = v_gid and r.status = 'open';
  delete from excuses e using rounds r
   where e.id = p_excuse and r.id = e.round_id and r.group_id = v_gid and r.status = 'open';
  return json_build_object('ok', true);
end $$;

-- ---------- Permissões ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.create_group(text, text),
  public.get_state(text, uuid),
  public.get_photos(text, uuid[]),
  public.join_group(text, text, text, text),
  public.update_player(text, uuid, text, text, text, boolean),
  public.set_attendance(text, uuid, uuid, boolean),
  public.set_guess(text, uuid, uuid, int, int),
  public.add_excuse(text, uuid, uuid, text),
  public.cast_vote(text, uuid, uuid, text, uuid),
  public.admin_check(text, text),
  public.admin_rename(text, text, text),
  public.admin_open_round(text, text, date),
  public.admin_update_round(text, text, uuid, date, int, int),
  public.admin_close_round(text, text, uuid, uuid, uuid, uuid),
  public.admin_reopen_round(text, text, uuid),
  public.admin_delete_round(text, text, uuid),
  public.admin_remove_player(text, text, uuid),
  public.admin_delete_excuse(text, text, uuid)
to anon, authenticated;
