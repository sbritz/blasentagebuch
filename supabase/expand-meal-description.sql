-- Erweitert die Mahlzeitenbeschreibung von 80 auf 500 Zeichen.
-- In einem bereits eingerichteten Supabase-Projekt einmal im SQL Editor ausführen.

alter table public.diary_entries
  drop constraint if exists diary_entries_meal_name_check;

alter table public.diary_entries
  add constraint diary_entries_meal_name_check
    check (meal_name is null or char_length(meal_name) <= 500);
