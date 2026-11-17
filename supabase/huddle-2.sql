-- Huddle build 2: profile photos (small JPEG data, one row per person). RLS on, server-only.
create table if not exists huddle_avatars (
  person_id text primary key references huddle_people(id) on delete cascade,
  data text not null,
  updated_at timestamptz not null default now()
);
alter table huddle_avatars enable row level security;
