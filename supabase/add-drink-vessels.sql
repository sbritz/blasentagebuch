-- Einmal im Supabase SQL Editor ausführen, um private Trinkgefäße
-- mit komprimiertem Foto zwischen den eigenen Geräten zu synchronisieren.

create table if not exists public.drink_vessels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  amount_ml integer not null check (amount_ml between 10 and 5000),
  image_data text not null check (char_length(image_data) between 20 and 500000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists drink_vessels_user_updated_idx
  on public.drink_vessels (user_id, updated_at);

alter table public.drink_vessels enable row level security;
alter table public.drink_vessels force row level security;

revoke all on table public.drink_vessels from anon;
grant select, insert, update, delete on table public.drink_vessels to authenticated;

drop policy if exists "read own drink vessels" on public.drink_vessels;
drop policy if exists "insert own drink vessels" on public.drink_vessels;
drop policy if exists "update own drink vessels" on public.drink_vessels;
drop policy if exists "delete own drink vessels" on public.drink_vessels;

create policy "read own drink vessels"
  on public.drink_vessels for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "insert own drink vessels"
  on public.drink_vessels for insert to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "update own drink vessels"
  on public.drink_vessels for update to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "delete own drink vessels"
  on public.drink_vessels for delete to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
