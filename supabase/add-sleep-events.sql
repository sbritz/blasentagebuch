-- Blasentagebuch: Schlaf- und Aufstehzeiten zwischen Geräten synchronisieren
-- Diesen Inhalt einmal im Supabase SQL Editor ausführen.

create table if not exists public.sleep_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('sleep_start', 'wake_up')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists sleep_events_user_occurred_idx
  on public.sleep_events (user_id, occurred_at desc);
create index if not exists sleep_events_user_updated_idx
  on public.sleep_events (user_id, updated_at);

alter table public.sleep_events enable row level security;
alter table public.sleep_events force row level security;

revoke all on table public.sleep_events from anon;
grant select, insert, update, delete on table public.sleep_events to authenticated;

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
