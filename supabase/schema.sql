-- =====================================================================
--  KIPPA RING DEPOT STORES  —  Supabase database
--  Run this whole file once in Supabase > SQL Editor > New query > Run.
--  It is safe to run again (it updates functions and keeps your data).
-- =====================================================================
--
--  Security model
--  --------------
--  * Every table has Row Level Security ON with NO policies, so the public
--    "anon" key cannot read or write any table directly.
--  * The app only talks to the database through the functions below
--    (SECURITY DEFINER). Each one checks a session token issued by
--    login() after a correct name + PIN, and admin-only functions also
--    check the role.
--  * PINs are stored as bcrypt hashes. 5 wrong PINs locks that person for
--    5 minutes.
--  * Internal helpers live in the "krd_private" schema, which the API
--    cannot see.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- Email (pg_net) and the daily schedule (pg_cron). On Supabase both are
-- available; if either fails to enable, the app still works without it.
do $$ begin
  begin create extension if not exists pg_net;  exception when others then raise notice 'pg_net not enabled: %', sqlerrm; end;
  begin create extension if not exists pg_cron; exception when others then raise notice 'pg_cron not enabled: %', sqlerrm; end;
end $$;

create schema if not exists krd_private;
revoke all on schema krd_private from public;
do $$ begin
  execute 'revoke all on schema krd_private from anon, authenticated';
exception when undefined_object then null; end $$;

-- ---------------------------------------------------------------------
--  TABLES
-- ---------------------------------------------------------------------
create table if not exists public.staff (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  pin_hash        text not null,
  role            text not null default 'staff' check (role in ('staff','admin')),
  active          boolean not null default true,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  last_login      timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists staff_name_uq on public.staff (lower(name));
alter table public.staff add column if not exists can_broadcast boolean not null default false;

create table if not exists public.sessions (
  token      uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references public.staff(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '120 days'
);
create index if not exists sessions_staff_idx on public.sessions(staff_id);

create table if not exists public.items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  category      text not null default 'General',
  unit          text not null default 'each',
  code          text,                       -- optional: your TRACKS / supplier code
  on_hand       int  not null default 0,
  par           int  not null default 0,    -- reorder when on hand is AT or BELOW this
  order_up_to   int,                        -- suggested order brings stock up to this
  max_per_take  int,                        -- optional limit per take (null = no limit)
  active        boolean not null default true,
  below_par_alerted boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists items_name_uq on public.items (lower(name)) where active;

create table if not exists public.stocktakes (
  id           uuid primary key default gen_random_uuid(),
  status       text not null default 'open' check (status in ('open','completed','cancelled')),
  note         text,
  started_by   uuid references public.staff(id),
  started_at   timestamptz not null default now(),
  completed_by uuid references public.staff(id),
  completed_at timestamptz
);
create unique index if not exists one_open_stocktake on public.stocktakes ((status)) where status = 'open';

create table if not exists public.stocktake_counts (
  stocktake_id      uuid not null references public.stocktakes(id) on delete cascade,
  item_id           uuid not null references public.items(id),
  counted           int  not null check (counted >= 0),
  expected_at_count int  not null,     -- system qty at the moment of counting (never shown while counting)
  counted_by        uuid references public.staff(id),
  counted_at        timestamptz not null default now(),
  primary key (stocktake_id, item_id)
);

create table if not exists public.transactions (
  id           bigserial primary key,
  item_id      uuid not null references public.items(id),
  staff_id     uuid references public.staff(id),
  kind         text not null check (kind in ('take','receive','adjust','stocktake','undo')),
  qty          int  not null,          -- signed change to on hand (take = negative)
  note         text,
  stocktake_id uuid references public.stocktakes(id),
  undone       boolean not null default false,
  exported_at  timestamptz,            -- set when you mark it as entered into TRACKS
  created_at   timestamptz not null default now()
);
create index if not exists tx_created_idx on public.transactions(created_at desc);
create index if not exists tx_item_idx on public.transactions(item_id);
create index if not exists tx_staff_idx on public.transactions(staff_id);

create table if not exists public.messages (
  id           bigserial primary key,
  sender_id    uuid not null references public.staff(id),
  recipient_id uuid references public.staff(id),   -- null = Team channel
  body         text not null check (length(body) between 1 and 2000),
  created_at   timestamptz not null default now()
);
create index if not exists msg_pair_idx on public.messages(sender_id, recipient_id, id);
create index if not exists msg_team_idx on public.messages(id) where recipient_id is null;

create table if not exists public.message_reads (
  staff_id     uuid not null references public.staff(id) on delete cascade,
  convo        text not null,            -- 'team' or the other person's id
  last_read_id bigint not null default 0,
  primary key (staff_id, convo)
);

create table if not exists public.settings (
  key   text primary key,
  value text
);
insert into public.settings(key, value) values
  ('alert_email', ''),
  ('resend_api_key', ''),
  ('email_from', 'Kippa Ring Depot Stores <onboarding@resend.dev>'),
  ('instant_alerts', 'true'),
  ('daily_summary', 'true'),
  ('app_url', '')
on conflict (key) do nothing;

create table if not exists public.email_log (
  id         bigserial primary key,
  request_id bigint,
  subject    text,
  created_at timestamptz not null default now()
);

-- Lock every table down: no direct access with the public key.
do $$
declare t text;
begin
  foreach t in array array['staff','sessions','items','stocktakes','stocktake_counts',
                           'transactions','messages','message_reads','settings','email_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    begin
      execute format('revoke all on public.%I from anon, authenticated', t);
    exception when undefined_object then null; end;
  end loop;
end $$;

-- ---------------------------------------------------------------------
--  PRIVATE HELPERS (not callable from the app)
-- ---------------------------------------------------------------------
create or replace function krd_private.err(msg text) returns void
language plpgsql as $$ begin raise exception using message = msg, errcode = 'P0001'; end $$;

-- Validates a session token; returns the staff row. Raises SESSION_EXPIRED / ADMIN_ONLY.
create or replace function krd_private.auth(p_token uuid, p_admin boolean default false)
returns public.staff
language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff;
begin
  select st.* into s
    from public.sessions se join public.staff st on st.id = se.staff_id
   where se.token = p_token and se.expires_at > now() and st.active;
  if not found then perform krd_private.err('SESSION_EXPIRED'); end if;
  if p_admin and s.role <> 'admin' then perform krd_private.err('ADMIN_ONLY'); end if;
  update public.sessions set last_seen = now(), expires_at = now() + interval '120 days'
   where token = p_token and last_seen < now() - interval '1 hour';
  return s;
end $$;

create or replace function krd_private.me_json(s public.staff) returns jsonb
language sql immutable as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'role', s.role,
                            'can_broadcast', (s.role = 'admin' or s.can_broadcast))
$$;

create or replace function krd_private.setting(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.settings where key = p_key), '')
$$;

create or replace function krd_private.html_escape(t text) returns text
language sql immutable as $$
  select replace(replace(replace(coalesce(t,''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

-- Sends an email through Resend (https://resend.com) using pg_net.
-- Never raises: a failed email must never block a stock transaction.
create or replace function krd_private.send_email(p_subject text, p_html text)
returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key text := krd_private.setting('resend_api_key');
  v_to  text := krd_private.setting('alert_email');
  v_from text := coalesce(nullif(krd_private.setting('email_from'), ''), 'Kippa Ring Depot Stores <onboarding@resend.dev>');
  v_req bigint;
begin
  if v_key = '' or v_to = '' then return null; end if;
  begin
    execute 'select net.http_post(url := $1, body := $2, headers := $3)'
      into v_req
      using 'https://api.resend.com/emails',
            jsonb_build_object('from', v_from,
                               'to', (select jsonb_agg(trim(x)) from unnest(string_to_array(v_to, ',')) x where trim(x) <> ''),
                               'subject', p_subject, 'html', p_html),
            jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key);
    insert into public.email_log(request_id, subject) values (v_req, p_subject);
  exception when others then
    insert into public.email_log(request_id, subject) values (null, 'FAILED: ' || p_subject || ' — ' || sqlerrm);
  end;
  return v_req;
end $$;

create or replace function krd_private.suggest_order(i public.items) returns int
language sql immutable as $$
  select greatest(coalesce(i.order_up_to, i.par * 2) - i.on_hand, 1)
$$;

-- Call after any stock change. Flags items that just dropped to/below par
-- and sends ONE email listing them; clears the flag once stock is back above par.
create or replace function krd_private.refresh_alerts()
returns void
language plpgsql security definer set search_path = public as $$
declare v_rows text; v_n int; v_url text := krd_private.setting('app_url');
begin
  update public.items set below_par_alerted = false
   where below_par_alerted and (on_hand > par or not active or par <= 0);

  with newly as (
    update public.items set below_par_alerted = true
     where active and par > 0 and on_hand <= par and not below_par_alerted
    returning *
  )
  select count(*),
         string_agg(format('<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">%s</td>'
                           '<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#b42318"><b>%s</b></td>'
                           '<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">%s</td>'
                           '<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right"><b>%s %s</b></td></tr>',
                           krd_private.html_escape(n.name), n.on_hand, n.par,
                           krd_private.suggest_order(n), krd_private.html_escape(n.unit)), '' order by n.name)
    into v_n, v_rows
    from newly n;

  if v_n > 0 and krd_private.setting('instant_alerts') = 'true' then
    perform krd_private.send_email(
      format('Reorder needed: %s item%s at or below par', v_n, case when v_n = 1 then '' else 's' end),
      '<div style="font-family:Arial,sans-serif;max-width:560px">'
      || '<h2 style="color:#0b3d2e;margin:0 0 4px">Kippa Ring Depot Stores</h2>'
      || '<p style="margin:0 0 14px;color:#555">These items just reached their par level:</p>'
      || '<table style="border-collapse:collapse;width:100%;font-size:14px">'
      || '<tr style="background:#f3f6f4"><th style="padding:6px 10px;text-align:left">Item</th><th style="padding:6px 10px;text-align:right">On hand</th><th style="padding:6px 10px;text-align:right">Par</th><th style="padding:6px 10px;text-align:right">Suggested order</th></tr>'
      || v_rows || '</table>'
      || case when v_url <> '' then format('<p style="margin-top:16px"><a href="%s" style="background:#0b3d2e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the app</a></p>', v_url) else '' end
      || '</div>');
  end if;
end $$;

create or replace function krd_private.item_json(i public.items, p_admin boolean)
returns jsonb language sql immutable as $$
  select case when p_admin then
    jsonb_build_object('id', i.id, 'name', i.name, 'category', i.category, 'unit', i.unit, 'code', i.code,
                       'on_hand', i.on_hand, 'par', i.par, 'order_up_to', i.order_up_to,
                       'max_per_take', i.max_per_take, 'active', i.active,
                       'low', (i.par > 0 and i.on_hand <= i.par), 'suggest', krd_private.suggest_order(i))
  else
    jsonb_build_object('id', i.id, 'name', i.name, 'category', i.category, 'unit', i.unit,
                       'max_per_take', i.max_per_take)
  end
$$;

-- ---------------------------------------------------------------------
--  PUBLIC API — SIGN IN
-- ---------------------------------------------------------------------

-- Is this a brand new install (no staff yet)?
create or replace function public.app_status()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('needs_setup', not exists(select 1 from public.staff), 'version', 1)
$$;

-- One-time: create the first admin. Only works while there are no staff at all.
create or replace function public.setup_first_admin(p_name text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_token uuid;
begin
  perform pg_advisory_xact_lock(42);
  if exists(select 1 from public.staff) then perform krd_private.err('Setup has already been done.'); end if;
  if coalesce(trim(p_name),'') = '' then perform krd_private.err('Please enter your name.'); end if;
  if p_pin !~ '^[0-9]{4,8}$' then perform krd_private.err('PIN must be 4 to 8 digits.'); end if;
  insert into public.staff(name, pin_hash, role) values (trim(p_name), crypt(p_pin, gen_salt('bf', 8)), 'admin')
  returning id into v_id;
  insert into public.sessions(staff_id) values (v_id) returning token into v_token;
  return jsonb_build_object('token', v_token, 'me', (select krd_private.me_json(st) from public.staff st where st.id = v_id));
end $$;

-- Names shown on the sign-in screen.
create or replace function public.list_people()
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by lower(name)), '[]'::jsonb)
    from public.staff where active
$$;

create or replace function public.login(p_staff_id uuid, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff; v_token uuid;
begin
  select * into s from public.staff where id = p_staff_id and active for update;
  if not found then perform krd_private.err('Unknown person.'); end if;
  if s.locked_until is not null and s.locked_until > now() then
    perform krd_private.err(format('Too many wrong PINs. Try again in %s min.',
                            ceil(extract(epoch from (s.locked_until - now())) / 60)));
  end if;
  if s.pin_hash <> crypt(coalesce(p_pin,''), s.pin_hash) then
    update public.staff set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5 then now() + interval '5 minutes' else null end
     where id = s.id;
    -- commit the failed attempt even though we report an error
    return jsonb_build_object('error', case when s.failed_attempts + 1 >= 5
                                       then 'Too many wrong PINs. Locked for 5 minutes.'
                                       else 'Wrong PIN. Please try again.' end);
  end if;
  update public.staff set failed_attempts = 0, locked_until = null, last_login = now() where id = s.id;
  delete from public.sessions where expires_at < now();
  insert into public.sessions(staff_id) values (s.id) returning token into v_token;
  return jsonb_build_object('token', v_token, 'me', krd_private.me_json(s));
end $$;

create or replace function public.logout(p_token uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.sessions where token = p_token
$$;

create or replace function public.me(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token);
begin
  return krd_private.me_json(s);
end $$;

-- Light poll the app makes every ~20s: unread messages + low stock count.
create or replace function public.heartbeat(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token);
begin
  return jsonb_build_object(
    'unread', public.unread_total_for(s.id, s.role),
    'low', case when s.role = 'admin' then (select count(*) from public.items where active and par > 0 and on_hand <= par) else 0 end,
    'broadcasts', krd_private.unseen_broadcasts(s.id),
    'urgent', krd_private.urgent_broadcasts(s.id));
end $$;

create or replace function public.change_my_pin(p_token uuid, p_old text, p_new text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token);
begin
  if s.pin_hash <> crypt(coalesce(p_old,''), s.pin_hash) then perform krd_private.err('Current PIN is wrong.'); end if;
  if p_new !~ '^[0-9]{4,8}$' then perform krd_private.err('PIN must be 4 to 8 digits.'); end if;
  update public.staff set pin_hash = crypt(p_new, gen_salt('bf', 8)) where id = s.id;
end $$;

-- ---------------------------------------------------------------------
--  ITEMS & TAKING STOCK (everyone)
-- ---------------------------------------------------------------------
create or replace function public.list_items(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token);
begin
  return coalesce((select jsonb_agg(krd_private.item_json(i, s.role = 'admin') order by lower(i.category), lower(i.name))
                     from public.items i where i.active), '[]'::jsonb);
end $$;

-- p_lines: [{"item_id": "...", "qty": 2}, ...]
create or replace function public.take_items(p_token uuid, p_lines jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token); l jsonb; v_qty int; i public.items; v_n int := 0;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then perform krd_private.err('Nothing selected.'); end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_qty := (l->>'qty')::int;
    if v_qty is null or v_qty < 1 or v_qty > 999 then perform krd_private.err('Quantity must be between 1 and 999.'); end if;
    select * into i from public.items where id = (l->>'item_id')::uuid and active for update;
    if not found then perform krd_private.err('An item is no longer available. Refresh and try again.'); end if;
    if i.max_per_take is not null and v_qty > i.max_per_take then
      perform krd_private.err(format('%s: max %s per take. Message the manager if you need more.', i.name, i.max_per_take));
    end if;
    update public.items set on_hand = on_hand - v_qty, updated_at = now() where id = i.id;
    insert into public.transactions(item_id, staff_id, kind, qty, note)
    values (i.id, s.id, 'take', -v_qty, nullif(trim(coalesce(p_note,'')), ''));
    v_n := v_n + v_qty;
  end loop;
  perform krd_private.refresh_alerts();
  return jsonb_build_object('ok', true, 'units', v_n);
end $$;

create or replace function public.my_history(p_token uuid, p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token);
begin
  return coalesce((select jsonb_agg(x order by x.id desc) from (
    select t.id, t.kind, -t.qty as qty, t.note, t.created_at, t.undone, it.name as item, it.unit,
           (t.kind = 'take' and not t.undone and t.exported_at is null and t.created_at > now() - interval '15 minutes') as can_undo
      from public.transactions t join public.items it on it.id = t.item_id
     where t.staff_id = s.id and t.kind = 'take'
     order by t.id desc limit least(greatest(p_limit, 1), 200)) x), '[]'::jsonb);
end $$;

-- Staff can undo their own take within 15 minutes (fixes mis-taps).
create or replace function public.undo_take(p_token uuid, p_tx_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token); t public.transactions;
begin
  select * into t from public.transactions where id = p_tx_id for update;
  if not found or t.kind <> 'take' or t.undone then perform krd_private.err('That entry cannot be undone.'); end if;
  if t.staff_id <> s.id and s.role <> 'admin' then perform krd_private.err('You can only undo your own entries.'); end if;
  if s.role <> 'admin' and t.created_at < now() - interval '15 minutes' then
    perform krd_private.err('Too late to undo (15 min). Message the manager.');
  end if;
  if t.exported_at is not null then perform krd_private.err('Already entered into TRACKS — ask the manager to adjust.'); end if;
  update public.transactions set undone = true where id = t.id;
  update public.items set on_hand = on_hand - t.qty, updated_at = now() where id = t.item_id;
  insert into public.transactions(item_id, staff_id, kind, qty, note)
  values (t.item_id, s.id, 'undo', -t.qty, 'Undo of entry #' || t.id);
  perform krd_private.refresh_alerts();
end $$;

-- ---------------------------------------------------------------------
--  ADMIN — ITEMS, RECEIVING, ADJUSTMENTS
-- ---------------------------------------------------------------------
create or replace function public.admin_dashboard(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true);
begin
  return jsonb_build_object(
    'low', coalesce((select jsonb_agg(krd_private.item_json(i, true) order by (i.on_hand::numeric / nullif(i.par,0)), lower(i.name))
                       from public.items i where i.active and i.par > 0 and i.on_hand <= i.par), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(x order by x.id desc) from (
        select t.id, t.kind, t.qty, t.note, t.created_at, t.undone, it.name as item, it.unit, st.name as who
          from public.transactions t join public.items it on it.id = t.item_id left join public.staff st on st.id = t.staff_id
         order by t.id desc limit 40) x), '[]'::jsonb),
    'today_takes', (select coalesce(sum(-qty),0) from public.transactions
                     where kind = 'take' and not undone
                       and created_at >= date_trunc('day', now() at time zone 'Australia/Brisbane') at time zone 'Australia/Brisbane'),
    'unexported', (select count(*) from public.transactions where kind = 'take' and not undone and exported_at is null),
    'item_count', (select count(*) from public.items where active),
    'staff_count', (select count(*) from public.staff where active),
    'open_stocktake', (select id from public.stocktakes where status = 'open'));
end $$;

-- Create or update one item. If on_hand is changed, an 'adjust' entry is recorded.
create or replace function public.save_item(p_token uuid, p_item jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); i public.items; v_id uuid; v_new_on_hand int;
begin
  if coalesce(trim(p_item->>'name'),'') = '' then perform krd_private.err('Item name is required.'); end if;
  v_id := nullif(p_item->>'id','')::uuid;
  if v_id is null then
    insert into public.items(name, category, unit, code, on_hand, par, order_up_to, max_per_take)
    values (trim(p_item->>'name'),
            coalesce(nullif(trim(p_item->>'category'),''), 'General'),
            coalesce(nullif(trim(p_item->>'unit'),''), 'each'),
            nullif(trim(p_item->>'code'),''),
            coalesce((p_item->>'on_hand')::int, 0),
            greatest(coalesce((p_item->>'par')::int, 0), 0),
            nullif(p_item->>'order_up_to','')::int,
            nullif(p_item->>'max_per_take','')::int)
    returning * into i;
    if i.on_hand <> 0 then
      insert into public.transactions(item_id, staff_id, kind, qty, note) values (i.id, s.id, 'adjust', i.on_hand, 'Opening stock');
    end if;
  else
    select * into i from public.items where id = v_id for update;
    if not found then perform krd_private.err('Item not found.'); end if;
    v_new_on_hand := coalesce((p_item->>'on_hand')::int, i.on_hand);
    if v_new_on_hand <> i.on_hand then
      insert into public.transactions(item_id, staff_id, kind, qty, note)
      values (i.id, s.id, 'adjust', v_new_on_hand - i.on_hand, coalesce(nullif(trim(p_item->>'adjust_note'),''), 'Manual adjustment'));
    end if;
    update public.items set
      name = trim(p_item->>'name'),
      category = coalesce(nullif(trim(p_item->>'category'),''), 'General'),
      unit = coalesce(nullif(trim(p_item->>'unit'),''), 'each'),
      code = nullif(trim(p_item->>'code'),''),
      on_hand = v_new_on_hand,
      par = greatest(coalesce((p_item->>'par')::int, par), 0),
      order_up_to = nullif(p_item->>'order_up_to','')::int,
      max_per_take = nullif(p_item->>'max_per_take','')::int,
      updated_at = now()
    where id = i.id returning * into i;
  end if;
  perform krd_private.refresh_alerts();
  return krd_private.item_json(i, true);
exception when unique_violation then
  perform krd_private.err('An item with that name already exists.');
end $$;

create or replace function public.archive_item(p_token uuid, p_item_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true);
begin
  update public.items set active = false, updated_at = now() where id = p_item_id;
  perform krd_private.refresh_alerts();
end $$;

-- Bulk import / update by name. p_rows: [{name, category, unit, code, on_hand, par, order_up_to, max_per_take}]
create or replace function public.import_items(p_token uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); r jsonb; v_existing uuid; v_added int := 0; v_updated int := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    continue when coalesce(trim(r->>'name'),'') = '';
    select id into v_existing from public.items where lower(name) = lower(trim(r->>'name')) and active;
    if v_existing is null then
      perform public.save_item(p_token, r - 'id');
      v_added := v_added + 1;
    else
      -- keep existing values for any column the import leaves blank
      perform public.save_item(p_token,
        (select to_jsonb(i) from public.items i where i.id = v_existing)
        || coalesce((select jsonb_object_agg(e.k, e.v) from jsonb_each(r - 'name' - 'id') as e(k, v)
                      where e.v <> 'null'::jsonb and e.v <> '""'::jsonb), '{}'::jsonb)
        || jsonb_build_object('adjust_note', 'Import'));
      v_updated := v_updated + 1;
    end if;
  end loop;
  return jsonb_build_object('added', v_added, 'updated', v_updated);
end $$;

-- Record a delivery. p_lines: [{"item_id": "...", "qty": 24}]
create or replace function public.receive_stock(p_token uuid, p_lines jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); l jsonb; v_qty int; v_n int := 0;
begin
  for l in select * from jsonb_array_elements(p_lines) loop
    v_qty := (l->>'qty')::int;
    continue when v_qty is null or v_qty = 0;
    if v_qty < 0 or v_qty > 100000 then perform krd_private.err('Invalid quantity.'); end if;
    update public.items set on_hand = on_hand + v_qty, updated_at = now() where id = (l->>'item_id')::uuid and active;
    if not found then perform krd_private.err('Item not found.'); end if;
    insert into public.transactions(item_id, staff_id, kind, qty, note)
    values ((l->>'item_id')::uuid, s.id, 'receive', v_qty, nullif(trim(coalesce(p_note,'')),''));
    v_n := v_n + 1;
  end loop;
  perform krd_private.refresh_alerts();
  return jsonb_build_object('lines', v_n);
end $$;

-- Ledger for reports. Dates are Brisbane calendar days (inclusive).
create or replace function public.list_transactions(p_token uuid, p_from date, p_to date, p_kind text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true);
begin
  return coalesce((select jsonb_agg(x order by x.id desc) from (
    select t.id, t.kind, t.qty, t.note, t.created_at, t.undone, t.exported_at,
           it.id as item_id, it.name as item, it.category, it.unit, it.code, st.name as who
      from public.transactions t join public.items it on it.id = t.item_id left join public.staff st on st.id = t.staff_id
     where t.created_at >= (p_from::timestamp at time zone 'Australia/Brisbane')
       and t.created_at <  ((p_to + 1)::timestamp at time zone 'Australia/Brisbane')
       and (p_kind is null or t.kind = p_kind)
     order by t.id desc limit 5000) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
--  ADMIN — TRACKS EXPORT (what still needs entering manually)
-- ---------------------------------------------------------------------
create or replace function public.tracks_pending(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true);
begin
  return jsonb_build_object(
    'by_item', coalesce((select jsonb_agg(x order by lower(x.item)) from (
        select it.name as item, it.code, it.unit, sum(-t.qty)::int as qty, count(*) as entries,
               min(t.created_at) as first_at, max(t.created_at) as last_at
          from public.transactions t join public.items it on it.id = t.item_id
         where t.kind = 'take' and not t.undone and t.exported_at is null
         group by it.id, it.name, it.code, it.unit) x), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(x order by x.id) from (
        select t.id, t.created_at, it.name as item, it.code, it.unit, -t.qty as qty, st.name as who, t.note
          from public.transactions t join public.items it on it.id = t.item_id left join public.staff st on st.id = t.staff_id
         where t.kind = 'take' and not t.undone and t.exported_at is null) x), '[]'::jsonb),
    'max_id', (select max(id) from public.transactions where kind = 'take' and not undone and exported_at is null));
end $$;

-- Marks everything up to p_max_id as entered (so takes logged meanwhile aren't skipped).
create or replace function public.tracks_mark_entered(p_token uuid, p_max_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); v_n int;
begin
  update public.transactions set exported_at = now()
   where kind = 'take' and not undone and exported_at is null and id <= p_max_id;
  get diagnostics v_n = row_count;
  return jsonb_build_object('marked', v_n);
end $$;

-- ---------------------------------------------------------------------
--  ADMIN — BLIND STOCKTAKE
--  While counting, the system quantity is never sent to the phone.
--  Each count stores the system qty at that moment, so takes that happen
--  during a long stocktake are handled correctly when it is completed.
-- ---------------------------------------------------------------------
create or replace function public.start_stocktake(p_token uuid, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); v_id uuid;
begin
  select id into v_id from public.stocktakes where status = 'open';
  if v_id is not null then return v_id; end if;
  insert into public.stocktakes(note, started_by) values (nullif(trim(coalesce(p_note,'')),''), s.id) returning id into v_id;
  return v_id;
end $$;

create or replace function public.get_stocktake(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); st public.stocktakes;
begin
  select * into st from public.stocktakes where status = 'open';
  if not found then return null; end if;
  return jsonb_build_object(
    'id', st.id, 'note', st.note, 'started_at', st.started_at,
    'started_by', (select name from public.staff where id = st.started_by),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                'id', i.id, 'name', i.name, 'category', i.category, 'unit', i.unit,
                'counted', c.counted) order by lower(i.category), lower(i.name))
              from public.items i left join public.stocktake_counts c on c.item_id = i.id and c.stocktake_id = st.id
             where i.active), '[]'::jsonb));
end $$;

create or replace function public.save_count(p_token uuid, p_stocktake_id uuid, p_item_id uuid, p_counted int)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true);
begin
  if not exists(select 1 from public.stocktakes where id = p_stocktake_id and status = 'open') then
    perform krd_private.err('This stocktake is no longer open.');
  end if;
  if p_counted is null then
    delete from public.stocktake_counts where stocktake_id = p_stocktake_id and item_id = p_item_id;
    return;
  end if;
  if p_counted < 0 or p_counted > 1000000 then perform krd_private.err('Invalid count.'); end if;
  insert into public.stocktake_counts(stocktake_id, item_id, counted, expected_at_count, counted_by)
  select p_stocktake_id, i.id, p_counted, i.on_hand, s.id from public.items i where i.id = p_item_id
  on conflict (stocktake_id, item_id) do update
    set counted = excluded.counted, expected_at_count = excluded.expected_at_count,
        counted_by = excluded.counted_by, counted_at = now();
end $$;

create or replace function public.complete_stocktake(p_token uuid, p_stocktake_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); c record;
begin
  perform 1 from public.stocktakes where id = p_stocktake_id and status = 'open' for update;
  if not found then perform krd_private.err('This stocktake is no longer open.'); end if;
  for c in select * from public.stocktake_counts where stocktake_id = p_stocktake_id loop
    if c.counted <> c.expected_at_count then
      update public.items set on_hand = on_hand + (c.counted - c.expected_at_count), updated_at = now() where id = c.item_id;
      insert into public.transactions(item_id, staff_id, kind, qty, note, stocktake_id)
      values (c.item_id, s.id, 'stocktake', c.counted - c.expected_at_count, 'Stocktake variance', p_stocktake_id);
    end if;
  end loop;
  update public.stocktakes set status = 'completed', completed_by = s.id, completed_at = now() where id = p_stocktake_id;
  perform krd_private.refresh_alerts();
  return public.stocktake_report(p_token, p_stocktake_id);
end $$;

create or replace function public.cancel_stocktake(p_token uuid, p_stocktake_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true);
begin
  update public.stocktakes set status = 'cancelled', completed_by = s.id, completed_at = now()
   where id = p_stocktake_id and status = 'open';
end $$;

create or replace function public.stocktake_report(p_token uuid, p_stocktake_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); st public.stocktakes;
begin
  select * into st from public.stocktakes where id = p_stocktake_id;
  if not found then perform krd_private.err('Stocktake not found.'); end if;
  if st.status = 'open' then perform krd_private.err('Results are hidden until the stocktake is completed.'); end if;
  return jsonb_build_object(
    'id', st.id, 'status', st.status, 'note', st.note, 'started_at', st.started_at, 'completed_at', st.completed_at,
    'started_by', (select name from public.staff where id = st.started_by),
    'completed_by', (select name from public.staff where id = st.completed_by),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
                'item', i.name, 'category', i.category, 'unit', i.unit, 'code', i.code,
                'expected', c.expected_at_count, 'counted', c.counted, 'variance', c.counted - c.expected_at_count,
                'who', (select name from public.staff where id = c.counted_by), 'counted_at', c.counted_at)
                order by abs(c.counted - c.expected_at_count) desc, lower(i.name))
              from public.stocktake_counts c join public.items i on i.id = c.item_id
             where c.stocktake_id = st.id), '[]'::jsonb),
    'not_counted', coalesce((select jsonb_agg(i.name order by lower(i.name)) from public.items i
             where i.active and i.created_at < coalesce(st.completed_at, now())
               and not exists(select 1 from public.stocktake_counts c where c.stocktake_id = st.id and c.item_id = i.id)), '[]'::jsonb));
end $$;

create or replace function public.list_stocktakes(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true);
begin
  return coalesce((select jsonb_agg(x order by x.started_at desc) from (
    select st.id, st.status, st.note, st.started_at, st.completed_at,
           (select name from public.staff where id = st.started_by) as started_by,
           (select count(*) from public.stocktake_counts c where c.stocktake_id = st.id) as counted,
           (select count(*) from public.stocktake_counts c where c.stocktake_id = st.id and c.counted <> c.expected_at_count) as variances
      from public.stocktakes st order by st.started_at desc limit 50) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
--  ADMIN — STAFF
-- ---------------------------------------------------------------------
create or replace function public.list_staff(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
            'id', id, 'name', name, 'role', role, 'active', active, 'last_login', last_login, 'can_broadcast', can_broadcast,
            'locked', (locked_until is not null and locked_until > now())) order by active desc, lower(name))
          from public.staff), '[]'::jsonb);
end $$;

-- p_person: {id?, name, role, active, pin?}  (pin required for new people)
create or replace function public.save_staff(p_token uuid, p_person jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); v_id uuid := nullif(p_person->>'id','')::uuid;
        v_pin text := nullif(p_person->>'pin',''); v_role text := coalesce(p_person->>'role','staff');
        v_active boolean := coalesce((p_person->>'active')::boolean, true);
        v_bc boolean := coalesce((p_person->>'can_broadcast')::boolean, false);
begin
  if coalesce(trim(p_person->>'name'),'') = '' then perform krd_private.err('Name is required.'); end if;
  if v_pin is not null and v_pin !~ '^[0-9]{4,8}$' then perform krd_private.err('PIN must be 4 to 8 digits.'); end if;
  if v_role not in ('staff','admin') then perform krd_private.err('Invalid role.'); end if;
  if v_id is null then
    if v_pin is null then perform krd_private.err('Set a PIN for the new person.'); end if;
    insert into public.staff(name, pin_hash, role, active, can_broadcast) values (trim(p_person->>'name'), crypt(v_pin, gen_salt('bf', 8)), v_role, v_active, v_bc)
    returning id into v_id;
  else
    if v_id = s.id and (v_role <> 'admin' or not v_active) then
      perform krd_private.err('You cannot remove your own admin access.');
    end if;
    update public.staff set name = trim(p_person->>'name'), role = v_role, active = v_active, can_broadcast = v_bc,
           pin_hash = case when v_pin is not null then crypt(v_pin, gen_salt('bf', 8)) else pin_hash end,
           failed_attempts = case when v_pin is not null then 0 else failed_attempts end,
           locked_until = case when v_pin is not null then null else locked_until end
     where id = v_id;
    if not v_active or v_pin is not null then delete from public.sessions where staff_id = v_id and v_id <> s.id; end if;
  end if;
  return jsonb_build_object('id', v_id);
exception when unique_violation then
  perform krd_private.err('Someone with that name already exists.');
end $$;

-- ---------------------------------------------------------------------
--  ADMIN — SETTINGS & EMAIL
-- ---------------------------------------------------------------------
create or replace function public.get_settings(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); v_key text := krd_private.setting('resend_api_key');
begin
  return jsonb_build_object(
    'alert_email', krd_private.setting('alert_email'),
    'email_from', krd_private.setting('email_from'),
    'instant_alerts', krd_private.setting('instant_alerts') = 'true',
    'daily_summary', krd_private.setting('daily_summary') = 'true',
    'app_url', krd_private.setting('app_url'),
    'resend_key_set', v_key <> '',
    'resend_key_hint', case when length(v_key) > 6 then '••••' || right(v_key, 4) else '' end,
    'email_ready', v_key <> '' and krd_private.setting('alert_email') <> '',
    'cron_ready', exists(select 1 from pg_extension where extname = 'pg_cron'),
    'net_ready', exists(select 1 from pg_extension where extname = 'pg_net'));
end $$;

create or replace function public.save_settings(p_token uuid, p_settings jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); k text;
begin
  foreach k in array array['alert_email','email_from','app_url'] loop
    if p_settings ? k then
      update public.settings set value = trim(coalesce(p_settings->>k,'')) where key = k;
    end if;
  end loop;
  foreach k in array array['instant_alerts','daily_summary'] loop
    if p_settings ? k then
      update public.settings set value = case when (p_settings->>k)::boolean then 'true' else 'false' end where key = k;
    end if;
  end loop;
  if coalesce(trim(p_settings->>'resend_api_key'),'') <> '' then
    update public.settings set value = trim(p_settings->>'resend_api_key') where key = 'resend_api_key';
  end if;
end $$;

create or replace function public.send_test_email(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); v_req bigint;
begin
  if krd_private.setting('resend_api_key') = '' or krd_private.setting('alert_email') = '' then
    perform krd_private.err('Add your alert email and Resend API key first.');
  end if;
  v_req := krd_private.send_email('Test email from Kippa Ring Depot Stores',
    '<div style="font-family:Arial,sans-serif"><h2 style="color:#0b3d2e">It works!</h2><p>Reorder alerts and the daily summary will arrive at this address.</p></div>');
  return jsonb_build_object('request_id', v_req);
end $$;

-- Shows whether recent emails were accepted by Resend.
create or replace function public.email_status(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token, true); v jsonb;
begin
  begin
    execute $q$
      select coalesce(jsonb_agg(x order by x.id desc), '[]'::jsonb) from (
        select l.id, l.subject, l.created_at, r.status_code, left(coalesce(r.content::text, r.error_msg, ''), 300) as detail
          from public.email_log l left join net._http_response r on r.id = l.request_id
         order by l.id desc limit 10) x $q$ into v;
  exception when others then
    select coalesce(jsonb_agg(x order by x.id desc), '[]'::jsonb) into v
      from (select id, subject, created_at, null::int as status_code, '' as detail from public.email_log order by id desc limit 10) x;
  end;
  return v;
end $$;

-- Daily summary email (scheduled below for 7:00am Brisbane).
create or replace function krd_private.send_daily_summary()
returns void language plpgsql security definer set search_path = public as $$
declare v_low text; v_used text; v_n_low int; v_url text := krd_private.setting('app_url');
        v_from timestamptz := (date_trunc('day', now() at time zone 'Australia/Brisbane') - interval '1 day') at time zone 'Australia/Brisbane';
        v_to   timestamptz := date_trunc('day', now() at time zone 'Australia/Brisbane') at time zone 'Australia/Brisbane';
begin
  if krd_private.setting('daily_summary') <> 'true' then return; end if;
  select count(*), string_agg(format('<tr><td style="padding:5px 10px;border-bottom:1px solid #eee">%s</td><td style="padding:5px 10px;border-bottom:1px solid #eee;text-align:right;color:#b42318"><b>%s</b></td><td style="padding:5px 10px;border-bottom:1px solid #eee;text-align:right">%s</td><td style="padding:5px 10px;border-bottom:1px solid #eee;text-align:right"><b>%s %s</b></td></tr>',
                                     krd_private.html_escape(i.name), i.on_hand, i.par, krd_private.suggest_order(i), krd_private.html_escape(i.unit)), '' order by i.name)
    into v_n_low, v_low
    from public.items i where i.active and i.par > 0 and i.on_hand <= i.par;

  select string_agg(format('<tr><td style="padding:5px 10px;border-bottom:1px solid #eee">%s</td><td style="padding:5px 10px;border-bottom:1px solid #eee;text-align:right">%s %s</td></tr>',
                           krd_private.html_escape(x.name), x.q, krd_private.html_escape(x.unit)), '' order by x.q desc)
    into v_used
    from (select it.name, it.unit, sum(-t.qty) q from public.transactions t join public.items it on it.id = t.item_id
           where t.kind = 'take' and not t.undone and t.created_at >= v_from and t.created_at < v_to
           group by it.name, it.unit) x;

  if v_n_low = 0 and v_used is null then return; end if;  -- nothing to say

  perform krd_private.send_email(
    format('Daily stores summary — %s to reorder', v_n_low),
    '<div style="font-family:Arial,sans-serif;max-width:560px"><h2 style="color:#0b3d2e;margin:0 0 10px">Kippa Ring Depot Stores — daily summary</h2>'
    || case when v_n_low > 0 then
         '<h3 style="margin:14px 0 6px">To reorder</h3><table style="border-collapse:collapse;width:100%;font-size:14px"><tr style="background:#f3f6f4"><th style="padding:5px 10px;text-align:left">Item</th><th style="padding:5px 10px;text-align:right">On hand</th><th style="padding:5px 10px;text-align:right">Par</th><th style="padding:5px 10px;text-align:right">Suggested order</th></tr>' || v_low || '</table>'
       else '<p>Everything is above par. 👍</p>' end
    || case when v_used is not null then
         '<h3 style="margin:18px 0 6px">Taken yesterday</h3><table style="border-collapse:collapse;width:100%;font-size:14px">' || v_used || '</table>'
       else '' end
    || case when v_url <> '' then format('<p style="margin-top:16px"><a href="%s">Open the app</a></p>', v_url) else '' end
    || '</div>');
end $$;

do $$ begin
  if exists(select 1 from pg_extension where extname = 'pg_cron') then
    execute $c$ select cron.schedule('krd-daily-summary', '0 21 * * *', 'select krd_private.send_daily_summary()') $c$;  -- 21:00 UTC = 7:00am Brisbane
  end if;
exception when others then raise notice 'Could not schedule daily summary: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
--  MESSAGES
--  Conversations: 'team' (everyone) or a direct chat with one person.
--  Staff can message admins directly; admins can message anyone.
-- ---------------------------------------------------------------------
create or replace function public.unread_total_for(p_staff uuid, p_role text)
returns int language sql stable security definer set search_path = public as $$
  select (
    (select count(*) from public.messages m
      where m.recipient_id is null and m.sender_id <> p_staff
        and m.id > coalesce((select last_read_id from public.message_reads where staff_id = p_staff and convo = 'team'), 0))
  + (select count(*) from public.messages m
      where m.recipient_id = p_staff
        and m.id > coalesce((select last_read_id from public.message_reads where staff_id = p_staff and convo = m.sender_id::text), 0))
  )::int
$$;
revoke all on function public.unread_total_for(uuid, text) from public;
do $$ begin execute 'revoke all on function public.unread_total_for(uuid, text) from anon, authenticated';
exception when undefined_object then null; end $$;

create or replace function krd_private.can_chat(p_me public.staff, p_other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.staff o where o.id = p_other and o.active and o.id <> p_me.id
                 and (p_me.role = 'admin' or o.role = 'admin'))
$$;

create or replace function public.list_conversations(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token);
begin
  return jsonb_build_object('team', (
      select jsonb_build_object('key', 'team', 'name', 'Team (everyone)',
        'last', (select jsonb_build_object('body', m.body, 'at', m.created_at, 'who', st.name)
                   from public.messages m join public.staff st on st.id = m.sender_id
                  where m.recipient_id is null order by m.id desc limit 1),
        'unread', (select count(*) from public.messages m where m.recipient_id is null and m.sender_id <> s.id
                     and m.id > coalesce((select last_read_id from public.message_reads where staff_id = s.id and convo = 'team'), 0)))),
    'people', coalesce((select jsonb_agg(x order by (x->'last'->>'at') desc nulls last, lower(x->>'name')) from (
      select jsonb_build_object('key', o.id::text, 'name', o.name, 'role', o.role,
        'last', (select jsonb_build_object('body', m.body, 'at', m.created_at, 'mine', m.sender_id = s.id)
                   from public.messages m
                  where (m.sender_id = s.id and m.recipient_id = o.id) or (m.sender_id = o.id and m.recipient_id = s.id)
                  order by m.id desc limit 1),
        'unread', (select count(*) from public.messages m where m.sender_id = o.id and m.recipient_id = s.id
                     and m.id > coalesce((select last_read_id from public.message_reads where staff_id = s.id and convo = o.id::text), 0))) as x
        from public.staff o where krd_private.can_chat(s, o.id)) y), '[]'::jsonb));
end $$;

create or replace function public.get_messages(p_token uuid, p_with text, p_after bigint default 0)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token); v_other uuid; v jsonb; v_max bigint;
begin
  if p_with <> 'team' then
    v_other := p_with::uuid;
    if not krd_private.can_chat(s, v_other) then perform krd_private.err('You cannot message this person.'); end if;
  end if;
  select coalesce(jsonb_agg(x order by x.id), '[]'::jsonb), max(x.id) into v, v_max from (
    select * from (
      select m.id, m.body, m.created_at, m.sender_id = s.id as mine, st.name as who
        from public.messages m join public.staff st on st.id = m.sender_id
       where m.id > coalesce(p_after, 0)
         and case when p_with = 'team' then m.recipient_id is null
                  else (m.sender_id = s.id and m.recipient_id = v_other) or (m.sender_id = v_other and m.recipient_id = s.id) end
       order by m.id desc limit 200) z) x;
  if v_max is not null then
    insert into public.message_reads(staff_id, convo, last_read_id) values (s.id, p_with, v_max)
    on conflict (staff_id, convo) do update set last_read_id = greatest(public.message_reads.last_read_id, excluded.last_read_id);
  end if;
  return v;
end $$;

create or replace function public.send_message(p_token uuid, p_to text, p_body text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token); v_other uuid; v_id bigint;
begin
  if coalesce(trim(p_body),'') = '' then perform krd_private.err('Message is empty.'); end if;
  if p_to <> 'team' then
    v_other := p_to::uuid;
    if not krd_private.can_chat(s, v_other) then perform krd_private.err('You cannot message this person.'); end if;
  end if;
  -- simple flood guard
  if (select count(*) from public.messages where sender_id = s.id and created_at > now() - interval '1 minute') >= 20 then
    perform krd_private.err('Slow down a little — too many messages.');
  end if;
  insert into public.messages(sender_id, recipient_id, body) values (s.id, v_other, left(trim(p_body), 2000)) returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- ---------------------------------------------------------------------
--  TOI BROADCASTS
--  Managers, and anyone ticked "Can send TOI broadcasts", can send a
--  notice to everyone, with PDF / image attachments, an optional
--  "urgent" pop-up and "read & understood" acknowledgement tracking.
--  Files are stored in the database (bytea) so they are protected by the
--  same PIN sessions as everything else. Max 6 files, 10 MB each.
-- ---------------------------------------------------------------------
create table if not exists public.broadcasts (
  id           bigserial primary key,
  sender_id    uuid not null references public.staff(id),
  title        text not null check (length(title) between 1 and 150),
  body         text not null default '' check (length(body) <= 5000),
  urgent       boolean not null default false,
  require_ack  boolean not null default true,
  published    boolean not null default false,
  deleted      boolean not null default false,
  created_at   timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists broadcasts_pub_idx on public.broadcasts(published_at desc) where published and not deleted;

create table if not exists public.broadcast_files (
  id           bigserial primary key,
  broadcast_id bigint not null references public.broadcasts(id) on delete cascade,
  name         text not null,
  mime         text not null,
  size         int  not null,
  data         bytea not null,
  created_at   timestamptz not null default now()
);
create index if not exists bfiles_b_idx on public.broadcast_files(broadcast_id);

create table if not exists public.broadcast_reads (
  broadcast_id bigint not null references public.broadcasts(id) on delete cascade,
  staff_id     uuid not null references public.staff(id) on delete cascade,
  seen_at      timestamptz,
  acked_at     timestamptz,
  primary key (broadcast_id, staff_id)
);

do $$
declare t text;
begin
  foreach t in array array['broadcasts','broadcast_files','broadcast_reads'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    begin execute format('revoke all on public.%I from anon, authenticated', t);
    exception when undefined_object then null; end;
  end loop;
end $$;

create or replace function krd_private.can_send(s public.staff) returns boolean
language sql immutable as $$ select s.role = 'admin' or s.can_broadcast $$;

create or replace function krd_private.unseen_broadcasts(p_staff uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.broadcasts b
   where b.published and not b.deleted and b.sender_id <> p_staff
     and not exists(select 1 from public.broadcast_reads r where r.broadcast_id = b.id and r.staff_id = p_staff and r.seen_at is not null)
$$;

-- Urgent broadcasts (last 14 days) this person still has to read / acknowledge.
create or replace function krd_private.urgent_broadcasts(p_staff uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'title', b.title, 'at', b.published_at,
           'who', (select name from public.staff where id = b.sender_id)) order by b.published_at desc), '[]'::jsonb)
    from public.broadcasts b
    left join public.broadcast_reads r on r.broadcast_id = b.id and r.staff_id = p_staff
   where b.published and not b.deleted and b.urgent and b.sender_id <> p_staff
     and b.published_at > now() - interval '14 days'
     and (case when b.require_ack then r.acked_at is null else r.seen_at is null end)
$$;

create or replace function krd_private.broadcast_json(b public.broadcasts, p_me public.staff)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', b.id, 'title', b.title, 'body', b.body, 'urgent', b.urgent, 'require_ack', b.require_ack,
    'published_at', b.published_at, 'sender', (select name from public.staff where id = b.sender_id),
    'mine', b.sender_id = p_me.id,
    'can_manage', (b.sender_id = p_me.id or p_me.role = 'admin'),
    'files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'mime', f.mime, 'size', f.size) order by f.id)
                         from public.broadcast_files f where f.broadcast_id = b.id), '[]'::jsonb),
    'seen_at', (select seen_at from public.broadcast_reads where broadcast_id = b.id and staff_id = p_me.id),
    'acked_at', (select acked_at from public.broadcast_reads where broadcast_id = b.id and staff_id = p_me.id),
    'audience', case when b.sender_id = p_me.id or p_me.role = 'admin' then
                  (select count(*) from public.staff st where st.active and st.id <> b.sender_id) end,
    'seen_count', case when b.sender_id = p_me.id or p_me.role = 'admin' then
                  (select count(*) from public.broadcast_reads r join public.staff st on st.id = r.staff_id
                    where r.broadcast_id = b.id and st.active and st.id <> b.sender_id and r.seen_at is not null) end,
    'ack_count', case when b.sender_id = p_me.id or p_me.role = 'admin' then
                  (select count(*) from public.broadcast_reads r join public.staff st on st.id = r.staff_id
                    where r.broadcast_id = b.id and st.active and st.id <> b.sender_id and r.acked_at is not null) end)
$$;

-- Step 1: create a draft (not visible to anyone yet)
create or replace function public.create_broadcast(p_token uuid, p_title text, p_body text, p_urgent boolean, p_require_ack boolean)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token); v_id bigint;
begin
  if not krd_private.can_send(s) then perform krd_private.err('You are not allowed to send TOI broadcasts.'); end if;
  if coalesce(trim(p_title),'') = '' then perform krd_private.err('Give the broadcast a title.'); end if;
  -- tidy up abandoned drafts from this sender
  delete from public.broadcasts where sender_id = s.id and not published and created_at < now() - interval '1 day';
  insert into public.broadcasts(sender_id, title, body, urgent, require_ack)
  values (s.id, left(trim(p_title), 150), left(coalesce(trim(p_body),''), 5000), coalesce(p_urgent,false), coalesce(p_require_ack,true))
  returning id into v_id;
  return v_id;
end $$;

-- Step 2: attach files one at a time (base64), so each upload stays small
create or replace function public.add_broadcast_file(p_token uuid, p_broadcast_id bigint, p_name text, p_mime text, p_data text)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token); b public.broadcasts; v_bytes bytea; v_id bigint;
begin
  select * into b from public.broadcasts where id = p_broadcast_id;
  if not found or b.sender_id <> s.id or b.published then perform krd_private.err('Draft not found.'); end if;
  if p_mime not in ('application/pdf','image/jpeg','image/png','image/webp','image/gif') then
    perform krd_private.err('Only PDF and image files (JPG, PNG, WebP, GIF) can be attached.');
  end if;
  if (select count(*) from public.broadcast_files where broadcast_id = b.id) >= 6 then perform krd_private.err('Maximum 6 attachments.'); end if;
  begin v_bytes := decode(p_data, 'base64');
  exception when others then perform krd_private.err('The file could not be read.'); end;
  if length(v_bytes) > 10 * 1024 * 1024 then perform krd_private.err(format('%s is larger than 10 MB.', p_name)); end if;
  if p_mime = 'application/pdf' and substring(v_bytes from 1 for 4) <> '\x25504446'::bytea then
    perform krd_private.err(format('%s is not a valid PDF.', p_name));
  end if;
  insert into public.broadcast_files(broadcast_id, name, mime, size, data)
  values (b.id, left(coalesce(nullif(trim(p_name),''),'attachment'), 200), p_mime, length(v_bytes), v_bytes)
  returning id into v_id;
  return v_id;
end $$;

-- Step 3: send it
create or replace function public.publish_broadcast(p_token uuid, p_broadcast_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token); b public.broadcasts;
begin
  update public.broadcasts set published = true, published_at = now()
   where id = p_broadcast_id and sender_id = s.id and not published
  returning * into b;
  if not found then perform krd_private.err('Draft not found.'); end if;
  insert into public.broadcast_reads(broadcast_id, staff_id, seen_at, acked_at) values (b.id, s.id, now(), now())
  on conflict do nothing;
  return krd_private.broadcast_json(b, s);
end $$;

create or replace function public.list_broadcasts(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token);
begin
  return jsonb_build_object(
    'can_send', krd_private.can_send(s),
    'items', coalesce((select jsonb_agg(krd_private.broadcast_json(b, s) order by b.published_at desc)
                         from (select * from public.broadcasts where published and not deleted
                               order by published_at desc limit 100) b), '[]'::jsonb));
end $$;

create or replace function public.get_broadcast(p_token uuid, p_broadcast_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token); b public.broadcasts;
begin
  select * into b from public.broadcasts where id = p_broadcast_id and published and not deleted;
  if not found then perform krd_private.err('This broadcast is no longer available.'); end if;
  insert into public.broadcast_reads(broadcast_id, staff_id, seen_at) values (b.id, s.id, now())
  on conflict (broadcast_id, staff_id) do update set seen_at = coalesce(public.broadcast_reads.seen_at, now());
  return krd_private.broadcast_json(b, s);
end $$;

create or replace function public.ack_broadcast(p_token uuid, p_broadcast_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token);
begin
  if not exists(select 1 from public.broadcasts where id = p_broadcast_id and published and not deleted) then
    perform krd_private.err('This broadcast is no longer available.');
  end if;
  insert into public.broadcast_reads(broadcast_id, staff_id, seen_at, acked_at) values (p_broadcast_id, s.id, now(), now())
  on conflict (broadcast_id, staff_id) do update
    set seen_at = coalesce(public.broadcast_reads.seen_at, now()), acked_at = coalesce(public.broadcast_reads.acked_at, now());
end $$;

-- Returns {name, mime, data(base64)} for one attachment.
create or replace function public.get_broadcast_file(p_token uuid, p_file_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token); f record;
begin
  select bf.name, bf.mime, bf.data into f
    from public.broadcast_files bf join public.broadcasts b on b.id = bf.broadcast_id
   where bf.id = p_file_id and not b.deleted and (b.published or b.sender_id = s.id);
  if not found then perform krd_private.err('File not found.'); end if;
  return jsonb_build_object('name', f.name, 'mime', f.mime, 'data', translate(encode(f.data, 'base64'), E'\n', ''));
end $$;

-- Who has seen / acknowledged (sender and managers only)
create or replace function public.broadcast_receipts(p_token uuid, p_broadcast_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token); b public.broadcasts;
begin
  select * into b from public.broadcasts where id = p_broadcast_id and published;
  if not found then perform krd_private.err('Broadcast not found.'); end if;
  if b.sender_id <> s.id and s.role <> 'admin' then perform krd_private.err('Only the sender or a manager can see this.'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('name', st.name, 'seen_at', r.seen_at, 'acked_at', r.acked_at)
                     order by (r.acked_at is null), (r.seen_at is null), lower(st.name))
                     from public.staff st left join public.broadcast_reads r on r.broadcast_id = b.id and r.staff_id = st.id
                    where st.active and st.id <> b.sender_id), '[]'::jsonb);
end $$;

-- Removes a broadcast for everyone and frees the space its files used.
create or replace function public.delete_broadcast(p_token uuid, p_broadcast_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s public.staff := krd_private.auth(p_token); b public.broadcasts;
begin
  select * into b from public.broadcasts where id = p_broadcast_id;
  if not found then return; end if;
  if b.sender_id <> s.id and s.role <> 'admin' then perform krd_private.err('Only the sender or a manager can delete this.'); end if;
  update public.broadcasts set deleted = true where id = b.id;
  delete from public.broadcast_files where broadcast_id = b.id;
end $$;

-- ---------------------------------------------------------------------
--  PERMISSIONS: the app (anon key) may call only the public API functions.
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'krd_private' loop
    execute format('revoke all on function %s from public', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any(array[
              'app_status','setup_first_admin','list_people','login','logout','me','heartbeat','change_my_pin',
              'list_items','take_items','my_history','undo_take',
              'admin_dashboard','save_item','archive_item','import_items','receive_stock','list_transactions',
              'tracks_pending','tracks_mark_entered',
              'start_stocktake','get_stocktake','save_count','complete_stocktake','cancel_stocktake','stocktake_report','list_stocktakes',
              'list_staff','save_staff','get_settings','save_settings','send_test_email','email_status',
              'list_conversations','get_messages','send_message',
              'create_broadcast','add_broadcast_file','publish_broadcast','list_broadcasts','get_broadcast',
              'ack_broadcast','get_broadcast_file','broadcast_receipts','delete_broadcast']) loop
    begin
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    exception when undefined_object then null; end;
  end loop;
end $$;

-- Done. 🎉
