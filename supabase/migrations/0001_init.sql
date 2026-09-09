-- Reichweite – Tank- & Ladestopp-Navigation
-- Initiales Schema: Fahrzeugprofile, Einstellungen, Favoriten, Verlauf.
--
-- Alle Tabellen hängen an auth.users und sind per Row Level Security so
-- abgeriegelt, dass ein angemeldeter Nutzer ausschließlich eigene Zeilen sieht.
-- Der anon-Key im Browser ist damit unbedenklich: ohne gültige Session gibt
-- es keinen Zugriff, und mit Session nur auf die eigenen Daten.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type vehicle_kind as enum ('combustion', 'electric', 'hybrid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type fuel_kind as enum ('e5', 'e10', 'diesel');
exception when duplicate_object then null; end $$;

do $$ begin
  create type stop_kind as enum ('fuel', 'charging', 'rest_area', 'toilets');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- profiles: öffentlich sichtbarer Teil eines Kontos
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- vehicles: Fahrzeugtyp, Kraftstoffart, Steckertypen
-- ---------------------------------------------------------------------------

create table if not exists public.vehicles (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  name             text not null,
  kind             vehicle_kind not null,
  -- Nur für combustion/hybrid relevant.
  fuel             fuel_kind,
  -- Freitext-Steckertypen (ccs, chademo, type2, …); nur für electric/hybrid.
  connectors       text[] not null default '{}',
  typical_range_km integer,
  consumption_per_100km numeric(6, 2),
  is_default       boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Ein Verbrenner ohne Kraftstoffart wäre für die Preisabfrage unbrauchbar.
  constraint vehicles_fuel_required
    check (kind = 'electric' or fuel is not null),
  constraint vehicles_range_positive
    check (typical_range_km is null or typical_range_km > 0)
);

create index if not exists vehicles_user_id_idx on public.vehicles (user_id);

-- Höchstens ein Standardfahrzeug pro Nutzer.
create unique index if not exists vehicles_one_default_per_user
  on public.vehicles (user_id)
  where is_default;

-- ---------------------------------------------------------------------------
-- settings: Schwellenwert, Suchradius, Nachfrage-Intervall
--
-- Pro Nutzer und optional pro Fahrzeug: ein Wohnmobil braucht andere Werte als
-- ein E-Auto. `vehicle_id is null` ist die Voreinstellung des Nutzers.
-- ---------------------------------------------------------------------------

create table if not exists public.settings (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  vehicle_id            uuid references public.vehicles (id) on delete cascade,

  range_threshold_km    integer not null default 215,
  search_radius_km      integer not null default 12,
  re_ask_interval_km    integer not null default 50,
  max_suggestions       integer not null default 6,
  detour_cost_per_km    numeric(4, 2) not null default 0.18,
  min_charging_power_kw integer not null default 50,

  voice_guidance        boolean not null default true,
  keep_screen_awake     boolean not null default true,
  push_notifications    boolean not null default true,
  avoid_tolls           boolean not null default false,
  avoid_motorways       boolean not null default false,
  avoid_ferries         boolean not null default false,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Die gleichen Grenzen, die die UI erzwingt — die Datenbank ist die letzte
  -- Instanz, falls jemand direkt schreibt.
  constraint settings_threshold_range
    check (range_threshold_km between 20 and 600),
  -- Tankerkönig erlaubt maximal 25 km Radius.
  constraint settings_radius_range
    check (search_radius_km between 1 and 25),
  constraint settings_interval_range
    check (re_ask_interval_km between 5 and 200),
  constraint settings_suggestions_range
    check (max_suggestions between 3 and 12),
  constraint settings_power_range
    check (min_charging_power_kw between 0 and 350)
);

create index if not exists settings_user_id_idx on public.settings (user_id);

-- Genau ein Einstellungssatz pro Nutzer/Fahrzeug-Kombination. Zwei Indizes,
-- weil `null` in einem Unique-Index nicht als Duplikat gilt.
create unique index if not exists settings_user_vehicle_unique
  on public.settings (user_id, vehicle_id)
  where vehicle_id is not null;

create unique index if not exists settings_user_default_unique
  on public.settings (user_id)
  where vehicle_id is null;

-- ---------------------------------------------------------------------------
-- favorites: häufig genutzte Stationen
-- ---------------------------------------------------------------------------

create table if not exists public.favorites (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- Quellen-präfixierte ID, z. B. `tankerkoenig:4429…`.
  stop_id    text not null,
  kind       stop_kind not null,
  name       text not null,
  lng        double precision not null,
  lat        double precision not null,
  note       text,
  created_at timestamptz not null default now(),

  constraint favorites_lng_range check (lng between -180 and 180),
  constraint favorites_lat_range check (lat between -90 and 90),
  unique (user_id, stop_id)
);

create index if not exists favorites_user_id_idx on public.favorites (user_id);

-- ---------------------------------------------------------------------------
-- trips: Verlauf gefahrener Routen
-- ---------------------------------------------------------------------------

create table if not exists public.trips (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  vehicle_id        uuid references public.vehicles (id) on delete set null,

  origin_name       text not null,
  origin_lng        double precision not null,
  origin_lat        double precision not null,
  destination_name  text not null,
  destination_lng   double precision not null,
  destination_lat   double precision not null,

  distance_m        integer not null,
  duration_s        integer not null,
  -- Manuell eingegebene Startreichweite, für die späteren Auswertungen.
  start_range_km    integer,
  -- [{ id, kind, name }] der tatsächlich angefahrenen Stopps.
  stops             jsonb not null default '[]'::jsonb,

  started_at        timestamptz not null default now(),
  finished_at       timestamptz,

  constraint trips_distance_positive check (distance_m >= 0),
  constraint trips_stops_is_array check (jsonb_typeof(stops) = 'array')
);

create index if not exists trips_user_started_idx
  on public.trips (user_id, started_at desc);

-- ---------------------------------------------------------------------------
-- push_subscriptions: Web-Push-Endpunkte pro Gerät
-- ---------------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- updated_at automatisch pflegen
-- ---------------------------------------------------------------------------

-- Benannte Dollar-Quotes ($fn$) statt $$: der Funktionsrumpf steht sonst im
-- selben Quoting wie die do-$$-Blöcke weiter unten, was beim Ausführen über
-- Werkzeuge, die die Datei als einen String weiterreichen, zerbricht.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'vehicles', 'settings']
  loop
    execute format(
      'drop trigger if exists touch_%1$s_updated_at on public.%1$s', t
    );
    execute format(
      'create trigger touch_%1$s_updated_at before update on public.%1$s
         for each row execute function public.touch_updated_at()', t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Neues Konto: Profil, Standardfahrzeug-freie Einstellungen anlegen
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name')
  on conflict (id) do nothing;

  insert into public.settings (user_id)
  values (new.id)
  on conflict do nothing;

  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles           enable row level security;
alter table public.vehicles           enable row level security;
alter table public.settings           enable row level security;
alter table public.favorites          enable row level security;
alter table public.trips              enable row level security;
alter table public.push_subscriptions enable row level security;

-- Eine Policy pro Tabelle und Operation. `(select auth.uid())` statt
-- `auth.uid()`, damit Postgres den Aufruf einmal pro Query auswertet und nicht
-- pro Zeile — bei einem langen Verlauf ist das messbar.
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'vehicles', 'settings', 'favorites', 'trips', 'push_subscriptions'
  ]
  loop
    execute format('drop policy if exists %1$s_select_own on public.%1$s', t);
    execute format('drop policy if exists %1$s_insert_own on public.%1$s', t);
    execute format('drop policy if exists %1$s_update_own on public.%1$s', t);
    execute format('drop policy if exists %1$s_delete_own on public.%1$s', t);
  end loop;
end $$;

-- profiles nutzt `id` als Nutzerbezug, alle anderen `user_id`.
create policy profiles_select_own on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles
  for update to authenticated using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

do $$
declare
  t text;
begin
  foreach t in array array[
    'vehicles', 'settings', 'favorites', 'trips', 'push_subscriptions'
  ]
  loop
    execute format(
      'create policy %1$s_select_own on public.%1$s
         for select to authenticated using ((select auth.uid()) = user_id)', t
    );
    execute format(
      'create policy %1$s_insert_own on public.%1$s
         for insert to authenticated with check ((select auth.uid()) = user_id)', t
    );
    execute format(
      'create policy %1$s_update_own on public.%1$s
         for update to authenticated using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id)', t
    );
    execute format(
      'create policy %1$s_delete_own on public.%1$s
         for delete to authenticated using ((select auth.uid()) = user_id)', t
    );
  end loop;
end $$;
