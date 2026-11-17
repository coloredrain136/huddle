-- Huddle build 4: time polls, suggested changes, bring list, system lines in chat
alter table huddle_events add column if not exists bring_list boolean not null default false;
alter table huddle_messages add column if not exists kind text not null default 'text';

-- kind 'time' = an option in a time poll (time of day only); kind 'change' = a suggested new date and/or time
create table if not exists huddle_proposals (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references huddle_events(id) on delete cascade,
  kind text not null check (kind in ('time','change')),
  day date,
  time time,
  time_mode text check (time_mode in ('set','allday','tbd')),
  reason text,
  added_by text references huddle_people(id) on delete set null,
  status text not null default 'open' check (status in ('open','accepted','dismissed')),
  resolved_by text references huddle_people(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists huddle_proposals_event on huddle_proposals(event_id, status);

create table if not exists huddle_proposal_votes (
  proposal_id uuid not null references huddle_proposals(id) on delete cascade,
  person_id text not null references huddle_people(id) on delete cascade,
  vote text not null check (vote in ('yes','no')),
  primary key (proposal_id, person_id)
);

create table if not exists huddle_bring_items (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references huddle_events(id) on delete cascade,
  label text not null,
  added_by text references huddle_people(id) on delete set null,
  claimed_by text references huddle_people(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists huddle_bring_items_event on huddle_bring_items(event_id);

alter table huddle_proposals enable row level security;
alter table huddle_proposal_votes enable row level security;
alter table huddle_bring_items enable row level security;
