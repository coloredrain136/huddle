-- Huddle build 1: tables (huddle_ prefix, RLS on, no policies = only server functions with the secret key can touch them)

create table if not exists huddle_people (
  id text primary key,
  name text not null,
  bday_month int check (bday_month between 1 and 12),
  bday_day int check (bday_day between 1 and 31),
  has_account boolean not null default true,
  is_admin boolean not null default false,
  pin_hash text,
  pin_fails int not null default 0,
  pin_locked_until timestamptz,
  lead_time_days int,
  partner_id text references huddle_people(id) on delete set null,
  theme text,
  accent text,
  sort int not null default 0,
  removed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists huddle_name_overrides (
  subject_id text not null references huddle_people(id) on delete cascade,
  viewer_id text not null references huddle_people(id) on delete cascade,
  name text not null,
  primary key (subject_id, viewer_id)
);

create table if not exists huddle_dependents (
  dependent_id text not null references huddle_people(id) on delete cascade,
  guardian_id text not null references huddle_people(id) on delete cascade,
  primary key (dependent_id, guardian_id)
);

create table if not exists huddle_sessions (
  token_hash text primary key,
  person_id text not null references huddle_people(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  is_standalone boolean not null default false,
  push_enabled boolean not null default false
);
create index if not exists huddle_sessions_person on huddle_sessions(person_id);

create table if not exists huddle_events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  kind text not null check (kind in ('holiday','birthday','custom')),
  preset_key text,
  subject_id text references huddle_people(id) on delete set null,
  state text not null default 'planning' check (state in ('planning','locked')),
  final_date date,
  final_time time,
  time_mode text not null default 'tbd' check (time_mode in ('set','allday','tbd')),
  location text,
  notes text,
  creator_id text references huddle_people(id) on delete set null,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists huddle_invites (
  event_id uuid not null references huddle_events(id) on delete cascade,
  person_id text not null references huddle_people(id) on delete cascade,
  primary key (event_id, person_id)
);
create index if not exists huddle_invites_person on huddle_invites(person_id);

create table if not exists huddle_rsvps (
  event_id uuid not null references huddle_events(id) on delete cascade,
  person_id text not null references huddle_people(id) on delete cascade,
  answer text not null check (answer in ('going','cant','maybe')),
  answered_by text references huddle_people(id) on delete set null,
  bringing boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (event_id, person_id)
);

create table if not exists huddle_date_options (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references huddle_events(id) on delete cascade,
  day date not null,
  time time,
  added_by text references huddle_people(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists huddle_date_options_event on huddle_date_options(event_id);

create table if not exists huddle_votes (
  option_id uuid not null references huddle_date_options(id) on delete cascade,
  person_id text not null references huddle_people(id) on delete cascade,
  primary key (option_id, person_id)
);

create table if not exists huddle_messages (
  id bigint generated always as identity primary key,
  event_id uuid not null references huddle_events(id) on delete cascade,
  person_id text references huddle_people(id) on delete set null,
  body text not null default '',
  photo_path text,
  deleted boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists huddle_messages_event on huddle_messages(event_id, id);

create table if not exists huddle_settings (
  key text primary key,
  value jsonb
);

alter table huddle_people enable row level security;
alter table huddle_name_overrides enable row level security;
alter table huddle_dependents enable row level security;
alter table huddle_sessions enable row level security;
alter table huddle_events enable row level security;
alter table huddle_invites enable row level security;
alter table huddle_rsvps enable row level security;
alter table huddle_date_options enable row level security;
alter table huddle_votes enable row level security;
alter table huddle_messages enable row level security;
alter table huddle_settings enable row level security;

-- ---------- Seed: the roster ----------
insert into huddle_people (id, name, bday_month, bday_day, has_account, is_admin, sort) values
  ('joe',      'Joe',          11, 27, true,  true,  1),
  ('jeremiah', 'Miah',         11, 13, true,  false, 2),
  ('dad',      'Dad',          12, 15, true,  false, 3),
  ('dalana',   'Dalana',        3, 23, true,  false, 4),
  ('elayna',   'Elayna',        4, 11, true,  false, 5),
  ('nic',      'Nic',           5, 24, true,  false, 6),
  ('peyton',   'Peyton',        3, 25, true,  false, 7),
  ('mary',     'Grandma Mary',  9, 21, true,  false, 8),
  ('liz',      'Liz',          11, 15, false, false, 9)
on conflict (id) do nothing;

-- Partner links (both directions)
update huddle_people set partner_id = 'dalana' where id = 'dad';
update huddle_people set partner_id = 'dad'    where id = 'dalana';
update huddle_people set partner_id = 'nic'    where id = 'elayna';
update huddle_people set partner_id = 'elayna' where id = 'nic';

-- Names per viewer (subject, viewer, name)
insert into huddle_name_overrides (subject_id, viewer_id, name) values
  ('jeremiah', 'jeremiah', 'Jeremiah'),
  ('dad',      'peyton',   'Mike'),
  ('dad',      'elayna',   'Mike')
on conflict do nothing;

-- Liz has no account: Dad and Dalana answer for her
insert into huddle_dependents (dependent_id, guardian_id) values
  ('liz', 'dad'),
  ('liz', 'dalana')
on conflict do nothing;

insert into huddle_settings (key, value) values ('default_lead_days', '21') on conflict (key) do nothing;
