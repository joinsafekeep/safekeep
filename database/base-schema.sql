
create table public.user_profiles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 first_name text not null check(length(trim(first_name)) between 1 and 100),
 last_name text check(length(last_name)<=100), preferred_name text check(length(preferred_name)<=100),
 date_of_birth date, timezone text not null default 'America/New_York',
 locale text not null default 'en-US', created_at timestamptz not null default now()
);
create table public.user_contacts (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check(kind in ('email','mobile','home','office','other')),
 label text, normalized_value text not null check(length(normalized_value) between 3 and 320),
 extension text, verified_at timestamptz, created_at timestamptz not null default now(),
 unique(user_id,kind,normalized_value), unique(id,user_id)
);
create index user_contacts_user_idx on public.user_contacts(user_id);
create table public.user_preferences (
 user_id uuid primary key references auth.users(id) on delete cascade,
 practice_enabled boolean not null default false,
 max_practices_per_week int not null default 1 check(max_practices_per_week between 0 and 7),
 quiet_hours_start time not null default '20:00', quiet_hours_end time not null default '09:00',
 created_at timestamptz not null default now()
);
create table public.practice_scams (
 id uuid primary key default gen_random_uuid(), stable_code text not null unique,
 name text not null, category text not null, created_at timestamptz not null default now(),
 archived_at timestamptz
);
create table public.practice_scam_versions (
 id uuid primary key default gen_random_uuid(),
 scam_id uuid not null references public.practice_scams(id),
 version_number int not null check(version_number>0),
 format text not null check(format in ('text','email','phone')),
 language text not null default 'en', difficulty int not null check(difficulty between 1 and 5),
 subject text, content text not null, learning_objective text not null,
 warning_signs text[] not null default '{}', debrief text not null,
 status text not null default 'draft' check(status in ('draft','published','retired')),
 created_at timestamptz not null default now(), unique(scam_id,version_number)
);
create table public.user_practices (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 scam_version_id uuid not null references public.practice_scam_versions(id),
 destination_contact_id uuid not null,
 scheduled_at timestamptz not null, sent_at timestamptz, delivered_at timestamptz,
 delivery_status text not null default 'scheduled' check(delivery_status in ('scheduled','queued','sent','delivered','failed','cancelled')),
 result text not null default 'pending' check(result in ('pending','engaged','reported','declined','completed','no_observed_engagement','inconclusive')),
 engaged_at timestamptz, completed_at timestamptz, observation_ends_at timestamptz,
 provider_message_id text unique, idempotency_key uuid not null unique default gen_random_uuid(),
 created_at timestamptz not null default now(),
 foreign key(destination_contact_id,user_id) references public.user_contacts(id,user_id)
);
create index user_practices_user_idx on public.user_practices(user_id,created_at desc);
create index user_practices_version_idx on public.user_practices(scam_version_id);
create index user_practices_contact_idx on public.user_practices(destination_contact_id,user_id);
create index user_practices_queue_idx on public.user_practices(scheduled_at) where delivery_status in ('scheduled','queued');
create table public.practice_events (
 id uuid primary key default gen_random_uuid(),
 user_practice_id uuid not null references public.user_practices(id) on delete cascade,
 event_type text not null check(event_type in ('queued','sent','delivered','failed','link_clicked','replied','call_answered','reported','debrief_completed')),
 occurred_at timestamptz not null, received_at timestamptz not null default now(),
 provider_event_id text unique, evidence_source text not null
);
create index practice_events_practice_idx on public.practice_events(user_practice_id,occurred_at);
create table public.consent_events (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 contact_id uuid not null,
 channel text not null check(channel in ('text','email','phone')),
 action text not null check(action in ('grant','revoke')),
 policy_version text not null, source text not null,
 recorded_at timestamptz not null default now(),
 foreign key(contact_id,user_id) references public.user_contacts(id,user_id)
);
create index consent_events_contact_idx on public.consent_events(contact_id,user_id,channel,recorded_at desc);
create index consent_events_user_idx on public.consent_events(user_id);
create table public.caregiver_invitations (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 invitee_email text not null, token_hash text not null unique,
 expires_at timestamptz not null, accepted_at timestamptz, revoked_at timestamptz,
 created_at timestamptz not null default now(),
 check(expires_at>created_at)
);
create index caregiver_invitations_owner_idx on public.caregiver_invitations(owner_user_id);
create table public.caregiver_access (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 caregiver_user_id uuid not null references auth.users(id) on delete cascade,
 can_view_summary boolean not null default true,
 can_manage_schedule boolean not null default false,
 granted_at timestamptz not null default now(), revoked_at timestamptz,
 check(owner_user_id<>caregiver_user_id)
);
create unique index caregiver_access_active_idx on public.caregiver_access(owner_user_id,caregiver_user_id) where revoked_at is null;
create index caregiver_access_caregiver_idx on public.caregiver_access(caregiver_user_id);

alter table public.user_profiles enable row level security;
revoke all on public.user_profiles from public, anon, authenticated;
grant all on public.user_profiles to service_role;

alter table public.user_contacts enable row level security;
revoke all on public.user_contacts from public, anon, authenticated;
grant all on public.user_contacts to service_role;

alter table public.user_preferences enable row level security;
revoke all on public.user_preferences from public, anon, authenticated;
grant all on public.user_preferences to service_role;

alter table public.practice_scams enable row level security;
revoke all on public.practice_scams from public, anon, authenticated;
grant all on public.practice_scams to service_role;

alter table public.practice_scam_versions enable row level security;
revoke all on public.practice_scam_versions from public, anon, authenticated;
grant all on public.practice_scam_versions to service_role;

alter table public.user_practices enable row level security;
revoke all on public.user_practices from public, anon, authenticated;
grant all on public.user_practices to service_role;

alter table public.practice_events enable row level security;
revoke all on public.practice_events from public, anon, authenticated;
grant all on public.practice_events to service_role;

alter table public.consent_events enable row level security;
revoke all on public.consent_events from public, anon, authenticated;
grant all on public.consent_events to service_role;

alter table public.caregiver_invitations enable row level security;
revoke all on public.caregiver_invitations from public, anon, authenticated;
grant all on public.caregiver_invitations to service_role;

alter table public.caregiver_access enable row level security;
revoke all on public.caregiver_access from public, anon, authenticated;
grant all on public.caregiver_access to service_role;

grant select on public.user_profiles to authenticated;
create policy own_read on public.user_profiles for select to authenticated using(user_id=(select auth.uid()));

grant select on public.user_contacts to authenticated;
create policy own_read on public.user_contacts for select to authenticated using(user_id=(select auth.uid()));

grant select on public.user_preferences to authenticated;
create policy own_read on public.user_preferences for select to authenticated using(user_id=(select auth.uid()));

grant select on public.user_practices to authenticated;
create policy own_read on public.user_practices for select to authenticated using(user_id=(select auth.uid()));

grant select on public.consent_events to authenticated;
create policy own_read on public.consent_events for select to authenticated using(user_id=(select auth.uid()));

grant insert(user_id,first_name,last_name,preferred_name,date_of_birth,timezone,locale) on public.user_profiles to authenticated;
grant update(first_name,last_name,preferred_name,date_of_birth,timezone,locale) on public.user_profiles to authenticated;
create policy own_insert on public.user_profiles for insert to authenticated with check(user_id=(select auth.uid()));
create policy own_update on public.user_profiles for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
grant insert(user_id) on public.user_preferences to authenticated;
grant update(practice_enabled,max_practices_per_week,quiet_hours_start,quiet_hours_end) on public.user_preferences to authenticated;
create policy own_insert on public.user_preferences for insert to authenticated with check(user_id=(select auth.uid()));
create policy own_update on public.user_preferences for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
grant select on public.caregiver_access to authenticated;
create policy participants_read on public.caregiver_access for select to authenticated using(owner_user_id=(select auth.uid()) or caregiver_user_id=(select auth.uid()));
grant update(revoked_at) on public.caregiver_access to authenticated;
create policy owner_revoke on public.caregiver_access for update to authenticated using(owner_user_id=(select auth.uid()) and revoked_at is null) with check(owner_user_id=(select auth.uid()) and revoked_at is not null);

