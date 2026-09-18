-- Blasentagebuch: Tabellen und Row Level Security
-- In einem neuen Supabase-Projekt einmal im SQL Editor ausführen.

create table if not exists public.diary_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('drink', 'urination')),
  amount_ml integer not null check (amount_ml between 1 and 5000),
  occurred_at timestamptz not null,
  drink_name text check (char_length(drink_name) <= 60),
  note text check (char_length(note) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.drink_presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  amount_ml integer not null check (amount_ml between 10 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  night_start time not null default '22:00',
  night_end time not null default '06:00',
  updated_at timestamptz not null default now(),
  constraint user_settings_night_period_check check (night_start <> night_end)
);

create table if not exists public.sleep_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('sleep_start', 'wake_up')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists diary_entries_user_occurred_idx
  on public.diary_entries (user_id, occurred_at desc);
create index if not exists diary_entries_user_updated_idx
  on public.diary_entries (user_id, updated_at);
create index if not exists drink_presets_user_updated_idx
  on public.drink_presets (user_id, updated_at);
create index if not exists sleep_events_user_occurred_idx
  on public.sleep_events (user_id, occurred_at desc);
create index if not exists sleep_events_user_updated_idx
  on public.sleep_events (user_id, updated_at);

alter table public.diary_entries enable row level security;
alter table public.drink_presets enable row level security;
alter table public.user_settings enable row level security;
alter table public.sleep_events enable row level security;
alter table public.diary_entries force row level security;
alter table public.drink_presets force row level security;
alter table public.user_settings force row level security;
alter table public.sleep_events force row level security;

revoke all on table public.diary_entries from anon;
revoke all on table public.drink_presets from anon;
revoke all on table public.user_settings from anon;
revoke all on table public.sleep_events from anon;
grant select, insert, update, delete on table public.diary_entries to authenticated;
grant select, insert, update, delete on table public.drink_presets to authenticated;
grant select, insert, update, delete on table public.user_settings to authenticated;
grant select, insert, update, delete on table public.sleep_events to authenticated;

drop policy if exists "read own diary entries" on public.diary_entries;
drop policy if exists "insert own diary entries" on public.diary_entries;
drop policy if exists "update own diary entries" on public.diary_entries;
drop policy if exists "delete own diary entries" on public.diary_entries;

create policy "read own diary entries"
  on public.diary_entries for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "insert own diary entries"
  on public.diary_entries for insert to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "update own diary entries"
  on public.diary_entries for update to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "delete own diary entries"
  on public.diary_entries for delete to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "read own drink presets" on public.drink_presets;
drop policy if exists "insert own drink presets" on public.drink_presets;
drop policy if exists "update own drink presets" on public.drink_presets;
drop policy if exists "delete own drink presets" on public.drink_presets;

create policy "read own drink presets"
  on public.drink_presets for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "insert own drink presets"
  on public.drink_presets for insert to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "update own drink presets"
  on public.drink_presets for update to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "delete own drink presets"
  on public.drink_presets for delete to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "read own user settings" on public.user_settings;
drop policy if exists "insert own user settings" on public.user_settings;
drop policy if exists "update own user settings" on public.user_settings;
drop policy if exists "delete own user settings" on public.user_settings;

create policy "read own user settings"
  on public.user_settings for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "insert own user settings"
  on public.user_settings for insert to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "update own user settings"
  on public.user_settings for update to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "delete own user settings"
  on public.user_settings for delete to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "read own sleep events" on public.sleep_events;
drop policy if exists "insert own sleep events" on public.sleep_events;
drop policy if exists "update own sleep events" on public.sleep_events;
drop policy if exists "delete own sleep events" on public.sleep_events;

create policy "read own sleep events"
  on public.sleep_events for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "insert own sleep events"
  on public.sleep_events for insert to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "update own sleep events"
  on public.sleep_events for update to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "delete own sleep events"
  on public.sleep_events for delete to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

-- Sicherheitskontrolle: Für anonyme Besucher sind keine Tabellenrechte vorhanden.
-- Der service_role-Schlüssel gehört ausschließlich in eine geschützte Server-Umgebung
-- und darf nie in diese Web-App oder in ein GitHub-Repository kopiert werden.
