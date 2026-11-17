-- Huddle build 3: private calendar feed link per person
alter table huddle_people add column if not exists cal_token text unique;
