-- Cali Coach: camera-scored sessions (holds + sets) feeding the Skill Swirl.
-- [Maker Ollie delivery 2026-07-03] Adjust names to house conventions before applying.

create table if not exists public.coach_sessions (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('handstand','pushups','lsit','plank')),
  -- handstand: secs + alignment; sets: reps + per-rep scores
  secs        numeric,                       -- hold duration (holds)
  avg_score   numeric not null,              -- 0-100
  min_score   numeric,                       -- worst moment (holds)
  reps        jsonb,                         -- [{score,depth,line,cue}...] (sets)
  source      text not null default 'camera' check (source in ('camera','board','fused')),
  board_stability numeric,                   -- CaliHome stability score when fused
  device      text,                          -- 'web-demo' | 'app-ios' | ...
  created_at  timestamptz not null default now()
);

alter table public.coach_sessions enable row level security;

create policy "members read own coach sessions"
  on public.coach_sessions for select
  using (auth.uid() = member_id);

create policy "members insert own coach sessions"
  on public.coach_sessions for insert
  with check (auth.uid() = member_id);

create index if not exists coach_sessions_member_kind_idx
  on public.coach_sessions (member_id, kind, created_at desc);

-- Skill-Swirl evidence: best camera-verified performances per member/kind.
-- The unlock gate can require e.g. handstand >= 15s at avg_score >= 80 —
-- CAMERA-REFEREED level unlocks (closes the loop with the belt-colour store gate).
create or replace view public.coach_best as
  select member_id, kind,
         max(secs)      filter (where avg_score >= 80) as best_secs_at_80,
         max(avg_score)                                as best_avg_score,
         count(*)                                      as sessions,
         max(created_at)                               as last_at
  from public.coach_sessions
  group by member_id, kind;
