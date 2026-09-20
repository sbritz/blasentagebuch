-- Erweiterung für Mahlzeiten, Tagesfaktoren und Tagesnotizen.
-- In einem bereits eingerichteten Supabase-Projekt einmal im SQL Editor ausführen.

alter table public.diary_entries
  add column if not exists meal_name text check (char_length(meal_name) <= 500),
  add column if not exists tags text[] not null default '{}';

alter table public.diary_entries alter column amount_ml drop not null;
alter table public.diary_entries drop constraint if exists diary_entries_kind_check;
alter table public.diary_entries drop constraint if exists diary_entries_amount_ml_check;

alter table public.diary_entries
  add constraint diary_entries_kind_check
    check (kind in ('drink', 'urination', 'meal')),
  add constraint diary_entries_amount_ml_check
    check ((kind = 'meal' and amount_ml is null)
      or (kind in ('drink', 'urination') and amount_ml between 1 and 5000));

create table if not exists public.daily_contexts (
  user_id uuid not null references auth.users(id) on delete cascade,
  day_key date not null,
  tags text[] not null default '{}',
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, day_key)
);

create index if not exists daily_contexts_user_day_idx
  on public.daily_contexts (user_id, day_key);
create index if not exists daily_contexts_user_updated_idx
  on public.daily_contexts (user_id, updated_at);

alter table public.daily_contexts enable row level security;
alter table public.daily_contexts force row level security;

revoke all on table public.daily_contexts from anon;
grant select, insert, update, delete on table public.daily_contexts to authenticated;

drop policy if exists "read own daily contexts" on public.daily_contexts;
drop policy if exists "insert own daily contexts" on public.daily_contexts;
drop policy if exists "update own daily contexts" on public.daily_contexts;
drop policy if exists "delete own daily contexts" on public.daily_contexts;

create policy "read own daily contexts"
  on public.daily_contexts for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "insert own daily contexts"
  on public.daily_contexts for insert to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "update own daily contexts"
  on public.daily_contexts for update to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "delete own daily contexts"
  on public.daily_contexts for delete to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
