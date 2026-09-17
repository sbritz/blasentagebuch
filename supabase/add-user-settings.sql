-- Blasentagebuch: Nachtzeit zwischen Geräten synchronisieren
-- Diesen Inhalt einmal im Supabase SQL Editor ausführen.

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  night_start time not null default '22:00',
  night_end time not null default '06:00',
  updated_at timestamptz not null default now(),
  constraint user_settings_night_period_check check (night_start <> night_end)
);

alter table public.user_settings enable row level security;
alter table public.user_settings force row level security;

revoke all on table public.user_settings from anon;
grant select, insert, update, delete on table public.user_settings to authenticated;

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
