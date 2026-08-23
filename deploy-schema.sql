-- =====================================================================
-- DEPLOY SCHEMA — Supabase project "up-cash-office"
-- Generated from the live project (xgcdbtahappoqegheitd) on 2026-08-07.
-- Run this against a FRESH Supabase project (public schema empty) to
-- recreate the current schema: extensions, tables, constraints,
-- indexes, functions, triggers, RLS policies, function grants, the
-- scheduled retention job, the realtime publication, and the storage
-- bucket the news and calendar images live in.
--
-- It does NOT recreate the three Edge Functions (notify-approval,
-- admin-delete-user, ai-assistant). A database built from this file is
-- complete; the deployment on top of it is not until those are pushed
-- too. Their source is in the repo at supabase/functions/<slug>/index.ts
-- and each deploys with `supabase functions deploy <slug> --no-verify-jwt`.
-- See the Edge Functions section of the README.
--
-- Note that ai_assistant_take_token() below is currently called by
-- nothing: the ai-assistant function does its own authorization checks
-- but skips the rate limit. The function and ai_assistant_usage are
-- correct and ready; the caller is what is missing.
--
-- NOTES
--  * Table-level GRANTs (SELECT/INSERT/UPDATE/DELETE to anon,
--    authenticated, service_role) are Supabase's default privileges on
--    the public schema and do not need to be re-created here. Access
--    control on these tables is enforced by Row Level Security (see
--    the policies at the bottom) and by SECURITY DEFINER RPCs, not by
--    table grants.
--  * pg_trgm's own C functions (similarity, word_similarity, etc.) are
--    created automatically by `CREATE EXTENSION pg_trgm` and are not
--    reproduced here.
--  * This script is meant to run once, top-to-bottom, on an empty
--    schema. It is not idempotent (no IF NOT EXISTS/OR REPLACE
--    guards on tables) by design, so it fails loudly instead of
--    silently doing nothing on a project that already has objects.
--
-- CURRENT INVENTORY (this file, as of 2026-08-11 -- see SECTIONS 11-14):
--
--     17 tables            29 indexes           72 functions
--     15 row triggers       1 event trigger     17 public policies
--      1 storage bucket     4 storage policies  RLS on 17 tables
--      1 cron job           1 realtime table
--
-- These numbers are asserted by check-drift.js, which counts them out of
-- this file on every run. If you add an object and the script complains,
-- the header is what is wrong -- fix it here. The previous header carried
-- five wrong counts for a year because nothing ever checked them.
--
-- ---------------------------------------------------------------------
-- REGENERATED 2026-08-09 after auditing this file against the live
-- project a second time. The 2026-08-08 pass below was correct about
-- everything it looked at and simply did not look at storage.
--
-- Restored (live had these; this file did not, so a fresh deploy
-- produced a portal where news and calendar images were broken):
--   news.image_path, news.thumb_data
--   calendar_events.image_path, calendar_events.thumb_data
--                                 sheets-config.js selects and inserts
--                                 all four; page-dashboard.js renders
--                                 them. Missing columns mean PostgREST
--                                 rejects those requests outright.
--   the news-images bucket        private, 2 MiB, four image MIME types.
--                                 Nothing in this file had ever created
--                                 a bucket, so there was nowhere for an
--                                 upload to go (new section 10).
--   4 policies on storage.objects news_images_read/write/update/delete.
--   rls_auto_enable() + ensure_rls the event trigger that switches RLS on
--                                 for any table added later. Absent here,
--                                 a fresh project silently lost the
--                                 backstop that the live one has.
--
-- Also corrected: the header's own counts (see the inventory above) and
-- the matching line in the README. Both claimed 13 tables, 55 functions,
-- 10 triggers and 14 policies. Only the index count was right.
--
-- Deliberately still absent: explicit GRANT lines for the six pure
-- helpers (split_list, format_account_number, parse_full_name,
-- join_account_numbers, split_account_numbers,
-- up_mail_restriction_enabled). Live carries redundant explicit grants
-- for them, but they also keep Postgres's default PUBLIC EXECUTE, which
-- section 7 relies on and explains. A fresh deploy from this file gives
-- the same effective access. Nothing to fix.
--
-- ---------------------------------------------------------------------
-- REGENERATED 2026-08-08 against the live project, after a full audit of
-- the schema against the client code.
--
-- WHAT CHANGED IN THAT PASS
--
-- Columns dropped (each verified unreferenced, or its references
-- patched, before removal):
--   profiles.user_id              identical to profiles.id on every row;
--                                 both were FKs to auth.users
--   profiles.notified_at          mark_notified() only ever set `notified`
--   transactions.user_email       NULL on all 1,959 rows; the table is
--                                 joined by acct_no, and `email` is now
--                                 the portal user's address
--   available_transactions.dvno   NULL on every row (+ its index)
--   released_transactions.dvno    NULL on every row (+ its index)
--   profile_change_requests.note  byte-identical copy of rejection_reason
--   profile_change_requests.admin_note   written and read by nothing
--
-- Functions dropped: admin_set_main(), cancel_admin_removal_request().
-- Neither had a caller in the client, in another function, in a policy
-- or in a trigger.
--
-- New: sync_email_change() and the on_auth_user_email_changed trigger.
-- Identity is auth.uid(); every join here is by email, and nothing kept
-- the two ends together. See the trigger in section 5 for the failure it
-- prevents.
--
-- New: section 8 schedules purge_expired_records(). It implements the
-- RA 10173 retention window and had never once run.
--
-- BUGS FOUND AND FIXED
--
--   * enforce_profile_uniqueness() excluded the row being written by
--     comparing EMAIL. It is a BEFORE trigger, so mid-rename the table
--     still holds the old address, the row fails to exclude itself, and
--     the profile is refused for holding its own name and its own
--     account number. Any email change on an approved profile was
--     blocked by itself. Self is now identified by id.
--
--   * sync_profile_accounts() cleared the rows for the NEW address on an
--     update but never the old one, so a rename orphaned the previous
--     account rows -- which then went on holding the number against
--     everyone else.
--
--   * is_admin() and is_main_admin() matched only on
--     admins.user_id = auth.uid(). user_id is nullable and admin_list()
--     reports has_account = (user_id is not null), so an administrator
--     added by address before they had a login appeared in the list and
--     failed every permission check. Both now match on user_id OR the
--     JWT email claim, and handle_new_user()/normalize_admin_email()
--     adopt an orphaned admin row as soon as a uid exists for it.
--
-- DRIFT IN THIS FILE THAT THE AUDIT CAUGHT
--
--   * split_list() was missing entirely. Three RLS policies in section 6
--     call it, so a fresh deploy failed there with "function
--     public.split_list(text) does not exist" -- leaving a database with
--     tables and no row-level security.
--   * The unique index on profile_accounts.account_number was still
--     here; live dropped it deliberately, because that table now holds
--     PENDING applicants' numbers and a pending row must not block
--     anybody. Now a plain index, matching live.
--   * enforce_profile_uniqueness() was an older revision than live: it
--     checked the name only when the name changed, never filtered on
--     approval_status, and read profile_accounts without joining
--     profiles. Replaced wholesale from live.
--   * The previous header documented account_numbers_taken() and
--     full_name_taken() as ahead of live. Live now carries the lowered
--     comparison, so file and database agree and that note is gone.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. EXTENSIONS
-- ---------------------------------------------------------------------
create extension if not exists pg_stat_statements with schema public;
create extension if not exists pg_trgm           with schema public;
create extension if not exists pgcrypto           with schema public;
create extension if not exists "uuid-ossp"         with schema public;
-- supabase_vault is managed by Supabase itself; do not create manually.

-- ---------------------------------------------------------------------
-- 2. TABLES
-- ---------------------------------------------------------------------

-- profiles ------------------------------------------------------------
create table public.profiles (
  id                          uuid primary key,
  email                       text not null,   -- the join key for the whole schema; kept in step with auth.users by sync_email_change()
  full_name                   text,
  account_number              text,
  created_at                  timestamptz default now(),
  approval_status             text not null default 'pending'
                                 check (approval_status = any (array['pending','approved','rejected'])),
  submitted_at                timestamptz default now(),
  reviewed_at                 timestamptz,
  reviewed_by                 text,
  rejection_reason            text,
  suffix                      text,
  middle_initial              text,
  first_name                  text,
  last_name                   text,
  notified                    boolean not null default false,
  disabled                    boolean not null default false,
  disabled_at                 timestamptz,
  disabled_by                 text,
  disabled_reason             text,
  privacy_notice_ack_at       timestamptz,
  privacy_notice_ack_version  text,
  constraint profiles_email_key unique (email),
  constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade
);
comment on column public.profiles.suffix is 'Optional name suffix (Jr., Sr., III, ...). Already included at the end of full_name; kept separately so the parts of a name can be rebuilt without parsing the string.';
comment on column public.profiles.middle_initial is 'Optional middle initial(s), stored with the trailing period as entered — "D." or "D.L.". Already included in full_name.';
comment on column public.profiles.first_name is 'Derived from full_name by the normalize_profile_fields trigger. Do not write to it directly — change full_name and it follows.';
comment on column public.profiles.last_name is 'Derived from full_name by the normalize_profile_fields trigger. Do not write to it directly — change full_name and it follows.';
comment on column public.profiles.privacy_notice_ack_at is 'When this person acknowledged the privacy notice (RA 10173 s.16). Null = never shown one.';
comment on column public.profiles.privacy_notice_ack_version is 'Which version of privacy.html they acknowledged, so a reissued notice can be re-acknowledged.';

-- admins ----------------------------------------------------------------
create table public.admins (
  email     text primary key,
  added_at  timestamptz not null default now(),
  note      text,
  added_by  text,
  is_main   boolean not null default false,
  user_id   uuid,
  constraint admins_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade
);

-- admin_invites -----------------------------------------------------
create table public.admin_invites (
  email       text primary key,
  note        text,
  invited_by  text,
  invited_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '30 days')
);

-- admin_actions -------------------------------------------------------
create table public.admin_actions (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  actor_email    text not null,
  action         text not null,
  subject_email  text,
  subject_name   text,
  account_number text,
  detail         jsonb
);

-- admin_removal_requests ---------------------------------------------
create table public.admin_removal_requests (
  id            uuid primary key default gen_random_uuid(),
  target_email  text not null,
  requested_by  text not null,
  reason        text,
  status        text not null default 'pending'
                  check (status = any (array['pending','approved','rejected'])),
  requested_at  timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    text,
  note          text
);

-- profile_accounts ------------------------------------------------------
create table public.profile_accounts (
  id              bigint generated by default as identity primary key,
  user_email      text not null,
  account_number  text not null,
  "position"      smallint not null default 1,
  created_at      timestamptz not null default now(),
  constraint profile_accounts_user_email_account_number_key unique (user_email, account_number)
);

-- profile_change_requests --------------------------------------------
create table public.profile_change_requests (
  id                          uuid primary key default gen_random_uuid(),
  user_email                  text not null,
  current_full_name           text,
  current_account_number      text,
  requested_full_name         text,
  requested_account_number    text,
  status                      text not null default 'pending'
                                 check (status = any (array['pending','approved','rejected','cancelled'])),
  requested_at                timestamptz not null default now(),
  reviewed_at                 timestamptz,
  reviewed_by                 text,
  decided_at                  timestamptz,
  rejection_reason            text,
  decided_by                  text
);

-- available_transactions ---------------------------------------------
create table public.available_transactions (
  id                uuid primary key default gen_random_uuid(),
  user_email        text,
  status            text,
  txn_date          date,
  ada_rada_check    text,
  name              text,
  amount            numeric,
  description_unit  text,
  span              text,
  created_at        timestamptz default now(),
  row_hash          text generated always as (
    md5(
      coalesce(user_email, '') || '|' ||
      coalesce(status, '') || '|' ||
      coalesce(((txn_date - date '1970-01-01'))::text, '') || '|' ||
      coalesce(ada_rada_check, '') || '|' ||
      coalesce(name, '') || '|' ||
      coalesce((trim_scale(amount))::text, '') || '|' ||
      coalesce(description_unit, '') || '|' ||
      coalesce(span, '')
    )
  ) stored
);

-- released_transactions (duplicate of available_transactions, plus dreleased) --
create table public.released_transactions (
  id                uuid primary key default gen_random_uuid(),
  user_email        text,
  status            text,
  txn_date          date,
  ada_rada_check    text,
  name              text,
  amount            numeric,
  description_unit  text,
  span              text,
  created_at        timestamptz default now(),
  row_hash          text generated always as (
    md5(
      coalesce(user_email, '') || '|' ||
      coalesce(status, '') || '|' ||
      coalesce(((txn_date - date '1970-01-01'))::text, '') || '|' ||
      coalesce(ada_rada_check, '') || '|' ||
      coalesce(name, '') || '|' ||
      coalesce((trim_scale(amount))::text, '') || '|' ||
      coalesce(description_unit, '') || '|' ||
      coalesce(span, '')
    )
  ) stored,
  dreleased         date
);
comment on table public.released_transactions is 'This is a duplicate of available_transactions';

-- transactions ----------------------------------------------------------
create table public.transactions (
  id           integer generated by default as identity primary key,
  dvno         varchar,
  ada          varchar,
  txn_date     date,
  amount       numeric,
  name         varchar,
  description  text,
  acct_no      varchar,
  email        varchar,   -- the portal user's address; backfilled from profiles via acct_no
  sent_at      timestamp,
  created_at   timestamptz default now(),
  row_hash     text generated always as (
    md5(
      coalesce(dvno, '') || '|' ||
      coalesce(ada, '') || '|' ||
      coalesce(((txn_date - date '1970-01-01'))::text, '') || '|' ||
      coalesce((trim_scale(amount))::text, '') || '|' ||
      coalesce(name, '') || '|' ||
      coalesce(description, '')
    )
  ) stored
);

-- data_versions ---------------------------------------------------------
--
-- Realtime refresh signal. One row per dataset: a name, a counter and a
-- timestamp, and deliberately nothing else -- no personal data crosses
-- the WebSocket.
--
-- Pages subscribe to THIS table and refetch their own data through the
-- normal RLS-protected queries when a counter moves. Subscribing to the
-- transaction tables directly would emit one event per ROW per
-- SUBSCRIBER, so a 1,555-row cheque import becomes 1,555 events for
-- every signed-in user, each re-running transactions_select_own.
create table public.data_versions (
  dataset     text primary key,
  version     bigint not null default 1,
  updated_at  timestamptz not null default now()
);

comment on table public.data_versions is
  'Realtime refresh signal. Holds no personal data by design: a dataset name, a counter and a timestamp. Bumped by statement-level triggers, never written by the client.';

insert into public.data_versions (dataset) values
  ('transactions'), ('released_transactions'), ('available_transactions'),
  ('news'), ('calendar_events');

-- news ------------------------------------------------------------------
create table public.news (
  id          uuid primary key default gen_random_uuid(),
  news_date   date not null default current_date,
  title       text not null,
  content     text not null,
  created_at  timestamptz default now(),
  image_path  text,
  thumb_data  text
);
comment on column public.news.image_path is
  'Object path inside the private news-images bucket (see section 10). Read via a signed URL; never a stored URL.';
comment on column public.news.thumb_data is
  'Inline base64 WebP thumbnail (~48px) for instant render. The full image lives in Storage at image_path. Rows predating this column have image_path but no thumb_data, and page-dashboard.js signs those on demand -- see the needSigning filter there.';

-- calendar_events -------------------------------------------------------
create table public.calendar_events (
  id          uuid primary key default gen_random_uuid(),
  event_date  date not null,
  title       text not null,
  created_at  timestamptz default now(),
  image_path  text,
  thumb_data  text
);
comment on column public.calendar_events.image_path is
  'Object path inside the private news-images bucket (see section 10). Calendar images share the news bucket; there is no separate one.';
comment on column public.calendar_events.thumb_data is
  'Inline base64 WebP thumbnail (~48px) for instant render. The full image lives in Storage at image_path.';

-- ai_assistant_usage ------------------------------------------------
create table public.ai_assistant_usage (
  user_email    text primary key,
  window_start  timestamptz not null default now(),
  calls         integer not null default 0
);

-- ---------------------------------------------------------------------
-- 3. INDEXES (beyond those implied by PK/UNIQUE constraints above)
-- ---------------------------------------------------------------------

-- profiles
create index profiles_approval_status_idx  on public.profiles using btree (approval_status);
create index profiles_full_name_upper_idx  on public.profiles using btree (upper(btrim(full_name)));
create index idx_profiles_disabled         on public.profiles using btree (disabled) where disabled;

-- admins
create index admins_user_id_idx on public.admins using btree (user_id);

-- admin_actions
create index admin_actions_actor_idx    on public.admin_actions using btree (lower(actor_email));
create index admin_actions_at_idx       on public.admin_actions using btree (at desc);
create index admin_actions_subject_idx  on public.admin_actions using btree (lower(subject_email));

-- admin_removal_requests
create unique index idx_arr_one_pending on public.admin_removal_requests using btree (target_email) where (status = 'pending');

-- profile_accounts
create index profile_accounts_email_idx on public.profile_accounts using btree (lower(user_email));
-- NOT unique. profile_accounts holds pending applicants' numbers as well
-- as approved ones, so two people may sit in the queue claiming the same
-- number until an administrator decides between them. Uniqueness among
-- APPROVED profiles is enforced by enforce_profile_uniqueness() instead,
-- which is the only place that can tell the two states apart.
create index profile_accounts_number_idx on public.profile_accounts using btree (account_number);

-- profile_change_requests
create index pcr_email_idx on public.profile_change_requests using btree (user_email);
create index pcr_status_idx on public.profile_change_requests using btree (status);
create unique index pcr_one_pending_per_user on public.profile_change_requests using btree (user_email) where (status = 'pending');

-- available_transactions
create unique index available_transactions_row_hash_uidx on public.available_transactions using btree (row_hash);
create index available_transactions_user_email_trgm_idx on public.available_transactions using gin (user_email gin_trgm_ops);
create index idx_avail_txn_txn_date on public.available_transactions using btree (txn_date desc);
create index idx_avail_txn_user_email on public.available_transactions using btree (user_email);

-- released_transactions
create unique index released_transactions_row_hash_idx on public.released_transactions using btree (row_hash);
create index released_transactions_dreleased_idx on public.released_transactions using btree (dreleased desc);
create index released_transactions_txn_date_idx on public.released_transactions using btree (txn_date desc);
create index released_transactions_user_email_idx on public.released_transactions using btree (user_email);
create index released_transactions_user_email_trgm_idx on public.released_transactions using gin (user_email gin_trgm_ops);

-- transactions
create unique index transactions_row_hash_uidx on public.transactions using btree (row_hash);
create index idx_transactions_acct_no on public.transactions using btree (acct_no);
create index idx_transactions_dvno on public.transactions using btree (dvno);
create index idx_transactions_txn_date on public.transactions using btree (txn_date desc);
create index transactions_name_trgm_idx on public.transactions using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------
-- 4. FUNCTIONS
-- ---------------------------------------------------------------------

create or replace function public.max_account_numbers()
 returns integer
 language sql
 immutable
 set search_path to 'public'
as $function$ select 3; $function$;

create or replace function public.up_mail_restriction_enabled()
 returns boolean
 language sql
 immutable
 set search_path to 'public'
as $function$ select false; $function$;

create or replace function public.format_account_number(p_value text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  select case
    when p_value is null then null
    when length(regexp_replace(p_value, '\D', '', 'g')) = 10
      then substr(regexp_replace(p_value, '\D', '', 'g'), 1, 4) || '-' ||
           substr(regexp_replace(p_value, '\D', '', 'g'), 5, 4) || '-' ||
           substr(regexp_replace(p_value, '\D', '', 'g'), 9, 2)
    else p_value
  end;
$function$;

create or replace function public.split_list(p_value text)
 returns text[]
 language sql
 immutable
 set search_path to 'public'
as $function$
  -- One definition of "a list in a text column", used by every policy in
  -- section 6 so they cannot drift from each other the way they drifted
  -- from the browser. Matches /[,;\n]+/ in config.js and page-soa.js.
  select coalesce(
    array(
      select btrim(part)
      from unnest(regexp_split_to_array(coalesce(p_value, ''), '[,;\n]+')) as part
      where btrim(part) <> ''
    ),
    '{}'::text[]
  );
$function$;

create or replace function public.split_account_numbers(p_value text)
 returns text[]
 language plpgsql
 immutable
 set search_path to 'public'
as $function$
declare
  raw   text;
  out_a text[] := '{}';
  one   text;
begin
  if p_value is null or btrim(p_value) = '' then
    return out_a;
  end if;
  foreach raw in array regexp_split_to_array(p_value, '[,;\n]+')
  loop
    one := public.format_account_number(btrim(raw));
    if one is not null and one <> '' and not (one = any (out_a)) then
      out_a := array_append(out_a, one);
    end if;
  end loop;
  return out_a;
end;
$function$;

create or replace function public.join_account_numbers(p_numbers text[])
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  select nullif(array_to_string(p_numbers, ', '), '')
$function$;

create or replace function public.normalize_account_numbers(p_value text)
 returns text
 language plpgsql
 immutable
 set search_path to 'public'
as $function$
declare
  v_parts  text[];
  v_out    text[] := '{}';
  v_one    text;
  v_digits text;
  v_max    int := public.max_account_numbers();
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;

  v_parts := regexp_split_to_array(p_value, '\s*[,;]\s*');

  foreach v_one in array v_parts loop
    v_digits := regexp_replace(coalesce(v_one, ''), '\D', '', 'g');
    continue when v_digits = '';

    if length(v_digits) <> 10 then
      raise exception 'invalid_account_number: An LBP account number is 10 digits.';
    end if;

    v_one := substr(v_digits, 1, 4) || '-' || substr(v_digits, 5, 4) || '-' || substr(v_digits, 9, 2);

    if not (v_one = any (v_out)) then
      v_out := array_append(v_out, v_one);
    end if;
  end loop;

  if array_length(v_out, 1) is null then
    return null;
  end if;

  if array_length(v_out, 1) > v_max then
    raise exception 'too_many_account_numbers: At most % account numbers are allowed.', v_max;
  end if;

  return array_to_string(v_out, ', ');
end;
$function$;

create or replace function public.parse_full_name(p_name text)
 returns jsonb
 language plpgsql
 immutable
 set search_path to 'public'
as $function$
declare
  v        text := btrim(coalesce(p_name, ''));
  v_last   text;
  v_rest   text;
  toks     text[];
  n        integer;
  v_suffix text := null;
  v_mi     text := null;
  v_first  text;
  suffixes text[] := array[
    'JR', 'JR.', 'SR', 'SR.',
    'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'
  ];
begin
  if v = '' then
    return jsonb_build_object(
      'first_name', null, 'middle_initial', null,
      'last_name',  null, 'suffix',         null);
  end if;

  if position(',' in v) = 0 then
    return jsonb_build_object(
      'first_name', null, 'middle_initial', null,
      'last_name',  v,    'suffix',         null);
  end if;

  v_last := btrim(split_part(v, ',', 1));
  v_rest := btrim(substr(v, position(',' in v) + 1));

  toks := array_remove(regexp_split_to_array(v_rest, '\s+'), '');
  n    := coalesce(array_length(toks, 1), 0);

  if n > 0 and upper(toks[n]) = any (suffixes) then
    v_suffix := upper(toks[n]);
    toks     := toks[1:n - 1];
    n        := n - 1;
  end if;

  if n > 1 and (toks[n] ~ '^[A-Za-z](\.[A-Za-z])*\.$' or toks[n] ~ '^[A-Za-z]$') then
    v_mi := upper(toks[n]);
    if right(v_mi, 1) <> '.' then
      v_mi := v_mi || '.';
    end if;
    toks := toks[1:n - 1];
    n    := n - 1;
  end if;

  v_first := btrim(array_to_string(toks, ' '));

  return jsonb_build_object(
    'first_name',     nullif(v_first, ''),
    'middle_initial', v_mi,
    'last_name',      nullif(v_last, ''),
    'suffix',         v_suffix
  );
end;
$function$;

create or replace function public.is_disabled()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(
    (select p.disabled from public.profiles p where p.id = auth.uid()),
    false
  );
$function$;

create or replace function public.is_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  -- Matches on EITHER arm. user_id is nullable and admin_list() reports
  -- has_account = (user_id is not null), so the schema already expects
  -- administrators added by address before they have a login -- and with
  -- a uid-only test those appeared in the list while failing every
  -- permission check. The JWT email claim is signed, so it is no weaker
  -- a proof than auth.uid(); nullif() keeps an anon caller (no claim)
  -- from matching a row whose email is somehow blank.
  select exists (
           select 1 from public.admins a
            where a.user_id = auth.uid()
               or lower(a.email) = lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''))
         )
     and not public.is_disabled();
$function$;


create or replace function public.is_main_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
           select 1 from public.admins a
            where a.is_main
              and (a.user_id = auth.uid()
                or lower(a.email) = lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '')))
         )
     and not public.is_disabled();
$function$;


create or replace function public.is_approved_user()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.approval_status = 'approved'
      and coalesce(p.disabled, false) = false
  );
$function$;

create or replace function public.account_numbers_taken(p_value text, p_email text default null::text)
 returns setof text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  -- lower() on both sides of the self-exclusion. Everywhere else in
  -- this schema compares addresses case-insensitively; these two
  -- functions were the exception, and the exception fails in the
  -- direction that looks like a bug in the form. profiles.email is
  -- lowercased on write by normalize_profile_fields(), so a caller
  -- passing the address as the person typed it -- "J.Reyes@up.edu.ph"
  -- -- would fail to match its own row, drop out of the exclusion, and
  -- be told its own account number is already registered to someone
  -- else.
  select unnest(string_to_array(p_value, ', '))
  intersect
  select unnest(string_to_array(account_number, ', '))
  from public.profiles
  where account_number is not null
    and (p_email is null or lower(email) <> lower(p_email));
$function$;

create or replace function public.full_name_taken(p_name text, p_email text default null::text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  -- See the note in account_numbers_taken() above: lower() on both
  -- sides, so someone editing their own profile is excluded from the
  -- duplicate check no matter how they typed their own address.
  select exists (
    select 1 from public.profiles
    where upper(full_name) = upper(p_name)
      and (p_email is null or lower(email) <> lower(p_email))
  );
$function$;

create or replace function public.require_admin()
 returns void
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
end;
$function$;

create or replace function public.require_main_admin()
 returns void
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_main_admin() then raise exception 'not authorized'; end if;
end;
$function$;

create or replace function public.admin_rank(p_email text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case
           when not public.is_admin() then 'none'
           when p_email is null then 'none'
           when exists (select 1 from public.admins
                         where lower(email) = lower(p_email) and is_main) then 'main'
           when exists (select 1 from public.admins
                         where lower(email) = lower(p_email))             then 'assigned'
           else 'none'
         end;
$function$;

create or replace function public.admin_act_refusal(p_email text, p_verb text)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_self   boolean;
  v_target text := lower(btrim(coalesce(p_email, '')));
  v_rank   text;
begin
  if not public.is_admin() then return 'not authorized'; end if;
  if v_target = '' then return 'an email address is required'; end if;

  -- By uuid, not by the JWT email, for the same reason section 4 moved:
  -- an email is something a person can change.
  v_self := exists (
    select 1 from public.profiles p
     where lower(p.email) = v_target and p.id = auth.uid()
  );
  v_rank := public.admin_rank(v_target);

  if p_verb = 'edit' then
    if v_rank = 'main' and not public.is_main_admin() then
      return 'not authorized';
    end if;
    return null;

  elsif p_verb = 'disable' then
    if v_self then return 'cannot disable your own account'; end if;
    if v_rank = 'main' then return 'a main administrator cannot be disabled'; end if;
    if v_rank = 'assigned' and not public.is_main_admin() then return 'not authorized'; end if;
    return null;

  elsif p_verb = 'remove_admin' then
    if not public.is_main_admin() then return 'not authorized'; end if;
    if v_self then return 'cannot remove your own administrator access'; end if;
    if v_rank = 'main' then return 'a main administrator''s access cannot be removed here'; end if;
    return null;

  elsif p_verb = 'request_removal' then
    if public.is_main_admin() then
      return 'main administrators remove access directly, without a request';
    end if;
    if v_self then return 'cannot request removal of your own access'; end if;
    if v_rank <> 'assigned' then return 'not authorized'; end if;
    return null;

  else
    -- An unknown verb is a programming error, and the safe answer to
    -- a question nobody defined is no.
    return 'not authorized';
  end if;
end;
$function$;

create or replace function public.require_can_act(p_email text, p_verb text)
 returns void
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_refusal text := public.admin_act_refusal(p_email, p_verb);
begin
  if v_refusal is not null then raise exception '%', v_refusal; end if;
end;
$function$;

create or replace function public.log_admin_action(p_action text, p_subject_email text default null::text, p_subject_name text default null::text, p_account_number text default null::text, p_detail jsonb default null::jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  insert into public.admin_actions (
    actor_email, action, subject_email, subject_name, account_number, detail
  ) values (
    coalesce(auth.email(), 'system'),
    p_action,
    nullif(btrim(coalesce(p_subject_email, '')), ''),
    nullif(btrim(coalesce(p_subject_name, '')), ''),
    nullif(btrim(coalesce(p_account_number, '')), ''),
    p_detail
  );
end;
$function$;

create or replace function public.admin_action_log(p_query text default ''::text, p_limit integer default 200)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  q text := btrim(coalesce(p_query, ''));
  digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  cap int := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if not public.is_main_admin() then
    raise exception 'Only a main administrator can view the action log.';
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(entry)::jsonb order by entry.at desc)
      from (
        select l.id, l.at, l.actor_email, l.action,
               l.subject_email, l.subject_name, l.account_number, l.detail
          from public.admin_actions l
         where q = ''
            or l.actor_email ilike '%' || q || '%'
            or l.subject_email ilike '%' || q || '%'
            or l.subject_name ilike '%' || q || '%'
            or l.action ilike '%' || q || '%'
            or (
              digits <> '' and
              regexp_replace(coalesce(l.account_number, ''), '\D', '', 'g') like '%' || digits || '%'
            )
         order by l.at desc
         limit cap
      ) entry
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.admin_user_actions(p_email text)
 returns table(at timestamp with time zone, action text, side text, actor_email text, subject_email text, subject_name text, detail jsonb)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    aa.at, aa.action,
    case when lower(aa.actor_email) = lower(btrim(p_email)) then 'by_them' else 'by_you' end as side,
    aa.actor_email, aa.subject_email, aa.subject_name, aa.detail
  from public.admin_actions aa
  where public.is_admin()
    and (public.is_main_admin() or public.admin_rank(p_email) <> 'main')
    and (lower(aa.actor_email) = lower(btrim(p_email)) or lower(aa.subject_email) = lower(btrim(p_email)))
  order by aa.at desc;
$function$;

create or replace function public.admin_list()
 returns table(email text, is_main boolean, is_you boolean, has_account boolean, note text, has_pending_removal boolean, is_invite boolean, invited_by text, expires_at timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    a.email, a.is_main,
    coalesce(a.user_id = auth.uid(), false) as is_you,
    (a.user_id is not null) as has_account,
    a.note,
    exists (
      select 1 from public.admin_removal_requests r
      where lower(r.target_email) = lower(a.email) and r.status = 'pending'
    ) as has_pending_removal,
    false as is_invite,
    null::text as invited_by,
    null::timestamptz as expires_at
  from public.admins a
  where public.is_admin()

  union all

  select
    i.email, false, false, false, i.note, false, true, i.invited_by, i.expires_at
  from public.admin_invites i
  where public.is_admin()

  order by 7 asc, 2 desc, 1;
$function$;

create or replace function public.admin_search_users(p_query text default ''::text)
 returns table(email text, full_name text, account_number text, approval_status text, is_admin boolean, is_main boolean, has_pending_change boolean, disabled boolean, has_pending_removal boolean)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    p.email, p.full_name, p.account_number, p.approval_status,
    (a.email is not null)      as is_admin,
    coalesce(a.is_main, false) as is_main,
    exists (
      select 1 from public.profile_change_requests c
      where lower(c.user_email) = lower(p.email) and c.status = 'pending'
    ) as has_pending_change,
    coalesce(p.disabled, false) as disabled,
    exists (
      select 1 from public.admin_removal_requests r
      where lower(r.target_email) = lower(p.email) and r.status = 'pending'
    ) as has_pending_removal
  from public.profiles p
  left join public.admins a on lower(a.email) = lower(p.email)
  where public.is_admin()
    and (
      p_query is null or p_query = ''
      or p.full_name ilike '%' || p_query || '%'
      or p.email ilike '%' || p_query || '%'
      or p.account_number ilike '%' || p_query || '%'
    )
  order by p.full_name nulls last
  limit 50;
$function$;

create or replace function public.admin_pending_queue()
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;

  return json_build_object(
    'registrations', (
      select coalesce(json_agg(json_build_object(
               'email', email,
               'full_name', full_name,
               'account_number', account_number,
               'submitted_at', created_at
             ) order by created_at asc), '[]'::json)
      from public.profiles
      where approval_status = 'pending'
    ),
    'profile_changes', (
      select coalesce(json_agg(json_build_object(
               'id', id,
               'user_email', user_email,
               'requested_at', requested_at,
               'current_full_name', current_full_name,
               'current_account_number', current_account_number,
               'requested_full_name', requested_full_name,
               'requested_account_number', requested_account_number
             ) order by requested_at asc), '[]'::json)
      from public.profile_change_requests
      where status = 'pending'
    )
  );
end;
$function$;

create or replace function public.admin_removal_queue()
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_main_admin() then raise exception 'not authorized'; end if;

  return (
    select coalesce(json_agg(json_build_object(
             'id', r.id,
             'target_email', r.target_email,
             'target_name', p.full_name,
             'requested_by', r.requested_by,
             'reason', r.reason,
             'requested_at', r.requested_at
           ) order by r.requested_at asc), '[]'::json)
    from public.admin_removal_requests r
    left join public.profiles p on lower(p.email) = lower(r.target_email)
    where r.status = 'pending'
  );
end;
$function$;

create or replace function public.admin_add(p_email text, p_note text default null::text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_actor text := auth.jwt() ->> 'email';
  v_id    uuid;
begin
  perform public.require_main_admin();
  p_email := lower(btrim(coalesce(p_email, '')));
  if p_email = '' then raise exception 'an email address is required'; end if;

  select p.id into v_id from public.profiles p where lower(p.email) = p_email;

  if v_id is null then
    insert into public.admin_invites (email, note, invited_by, invited_at, expires_at)
    values (p_email, nullif(btrim(coalesce(p_note, '')), ''), v_actor, now(), now() + interval '30 days')
    on conflict (email) do update
      set note       = excluded.note,
          invited_by = excluded.invited_by,
          invited_at = now(),
          expires_at = excluded.expires_at;

    insert into public.admin_actions (action, actor_email, subject_email, detail)
    values ('admin_invited', v_actor, p_email,
            jsonb_build_object('expires_at', now() + interval '30 days'));

    return json_build_object('email', p_email, 'has_account', false, 'invited', true);
  end if;

  insert into public.admins (email, note, added_by)
  values (p_email, nullif(btrim(coalesce(p_note, '')), ''), v_actor)
  on conflict (email) do update set note = excluded.note;

  delete from public.admin_invites where email = p_email;

  insert into public.admin_actions (action, actor_email, subject_email)
  values ('admin_added', v_actor, p_email);

  return json_build_object('email', p_email, 'has_account', true, 'invited', false);
end;
$function$;

create or replace function public.admin_invite_cancel(p_email text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_actor   text := auth.jwt() ->> 'email';
  v_deleted integer;
begin
  perform public.require_main_admin();
  p_email := lower(btrim(coalesce(p_email, '')));

  delete from public.admin_invites where email = p_email;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then raise exception 'no invitation is open for that address'; end if;

  insert into public.admin_actions (action, actor_email, subject_email)
  values ('admin_invite_cancelled', v_actor, p_email);

  return json_build_object('email', p_email);
end;
$function$;

create or replace function public.admin_remove(p_email text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_actor   text := auth.jwt() ->> 'email';
  v_deleted integer;
begin
  p_email := lower(btrim(coalesce(p_email, '')));
  perform public.require_can_act(p_email, 'remove_admin');

  delete from public.admins where email = p_email and is_main = false;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then raise exception 'that person is not an administrator'; end if;

  update public.admin_removal_requests
  set status = 'approved', decided_at = now(), decided_by = v_actor,
      note = 'removed directly by a main administrator'
  where target_email = p_email and status = 'pending';

  insert into public.admin_actions (action, actor_email, subject_email)
  values ('admin_removed', v_actor, p_email);

  return json_build_object('email', p_email);
end;
$function$;

create or replace function public.admin_request_admin_removal(p_email text, p_reason text default null::text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_actor text := auth.jwt() ->> 'email';
  v_id    uuid;
begin
  p_email := lower(btrim(coalesce(p_email, '')));
  perform public.require_can_act(p_email, 'request_removal');

  delete from public.admin_removal_requests
  where target_email = p_email and status = 'pending';

  insert into public.admin_removal_requests (target_email, requested_by, reason)
  values (p_email, v_actor, nullif(btrim(coalesce(p_reason, '')), ''))
  returning id into v_id;

  insert into public.admin_actions (action, actor_email, subject_email, detail)
  values ('admin_removal_requested', v_actor, p_email,
          case when nullif(btrim(coalesce(p_reason, '')), '') is not null
               then jsonb_build_object('reason', btrim(p_reason)) else null end);

  return json_build_object('id', v_id, 'email', p_email);
end;
$function$;

create or replace function public.admin_decide_removal(p_request_id uuid, p_approve boolean, p_note text default null::text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_actor text := auth.jwt() ->> 'email';
  v_req   public.admin_removal_requests;
begin
  if not public.is_main_admin() then raise exception 'not authorized'; end if;
  if p_approve is null then raise exception 'a decision is required'; end if;

  select * into v_req from public.admin_removal_requests
  where id = p_request_id and status = 'pending';
  if v_req is null then raise exception 'request not found or already decided'; end if;

  if p_approve then
    if public.admin_rank(v_req.target_email) = 'main' then
      raise exception 'not authorized';
    end if;
    delete from public.admins
     where lower(email) = lower(btrim(v_req.target_email)) and is_main = false;
  end if;

  update public.admin_removal_requests
  set status     = case when p_approve then 'approved' else 'rejected' end,
      decided_at = now(),
      decided_by = v_actor,
      note       = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_request_id;

  insert into public.admin_actions (action, actor_email, subject_email, detail)
  values (
    case when p_approve then 'admin_removed' else 'admin_removal_declined' end,
    v_actor, v_req.target_email,
    json_build_object('requested_by', v_req.requested_by, 'note', nullif(btrim(coalesce(p_note, '')), ''))
  );

  return json_build_object('email', v_req.target_email, 'approved', p_approve);
end;
$function$;

create or replace function public.admin_set_account_disabled(p_email text, p_disabled boolean, p_reason text default null::text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_actor  text := auth.jwt() ->> 'email';
  v_before public.profiles;
begin
  if p_disabled is null then raise exception 'disabled flag is required'; end if;
  p_email := lower(btrim(coalesce(p_email, '')));
  perform public.require_can_act(p_email, 'disable');

  select * into v_before from public.profiles where email = p_email;
  if v_before is null then raise exception 'user not found'; end if;

  if coalesce(v_before.disabled, false) = p_disabled then
    return json_build_object('email', p_email, 'disabled', p_disabled, 'changed', false);
  end if;

  update public.profiles
     set disabled        = p_disabled,
         disabled_at     = case when p_disabled then now() else null end,
         disabled_by     = case when p_disabled then v_actor else null end,
         disabled_reason = case when p_disabled then nullif(btrim(coalesce(p_reason, '')), '') else null end
   where email = p_email;

  insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
  values (case when p_disabled then 'account_disabled' else 'account_enabled' end,
          v_actor, p_email, v_before.full_name,
          case when nullif(btrim(coalesce(p_reason, '')), '') is not null
               then jsonb_build_object('reason', btrim(p_reason)) else null end);

  return json_build_object('email', p_email, 'disabled', p_disabled, 'changed', true);
end;
$function$;

create or replace function public.admin_update_user(p_email text, p_full_name text, p_account_number text default null::text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_before  public.profiles;
  v_changed boolean;
begin
  p_email := lower(btrim(coalesce(p_email, '')));
  perform public.require_can_act(p_email, 'edit');

  p_account_number := public.normalize_account_numbers(p_account_number);

  select * into v_before from public.profiles where email = p_email;
  if v_before is null then raise exception 'user not found'; end if;

  v_changed := (v_before.full_name is distinct from p_full_name)
            or (v_before.account_number is distinct from p_account_number);

  if v_changed then
    update public.profiles set full_name = p_full_name, account_number = p_account_number
    where email = p_email;

    insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
    values ('user_edited', auth.jwt() ->> 'email', p_email, p_full_name,
            jsonb_build_object(
              'from', jsonb_build_object('full_name', v_before.full_name, 'account_number', v_before.account_number),
              'to',   jsonb_build_object('full_name', p_full_name, 'account_number', p_account_number)
            ));
  end if;

  return json_build_object('email', p_email, 'changed', v_changed);
end;
$function$;

-- ---------------------------------------------------------------------
-- admin_delete_user_data(): full purge of the person's email.
--
-- Every table carrying the address is cleared EXCEPT the three payment
-- tables -- transactions, available_transactions, released_transactions.
-- Those are disbursement records kept under COA rules; an earlier
-- version of this function deleted from two of them, which it should
-- not have.
--
-- THREE KINDS OF COLUMN, HANDLED DIFFERENTLY
--
--   1. "this row IS about them"  -> delete the row
--      profiles.email, profile_accounts.user_email,
--      profile_change_requests.user_email, admin_invites.email,
--      admin_removal_requests.target_email, ai_assistant_usage.user_email
--
--   2. "this row is about SOMEONE ELSE, and merely names them"
--      -> null the reference, KEEP the row
--      profiles.reviewed_by / disabled_by, admins.added_by,
--      admin_invites.invited_by, profile_change_requests.reviewed_by /
--      decided_by, admin_removal_requests.decided_by
--
--      This distinction is the whole point. A departing administrator
--      has reviewed other people's registrations, so a naive
--      "delete where email appears" would delete THOSE USERS' PROFILES
--      because someone else once approved them. Null the reference,
--      keep the row.
--
--   3. "this row is a request THEY filed"  -> delete
--      admin_removal_requests.requested_by is NOT NULL, so it cannot be
--      nulled; the request is theirs, so it goes with them.
--
-- ON admin_actions
--
--   Every row naming them is deleted, as either actor or subject. Be
--   aware of what that costs: an administrator is typically the ACTOR on
--   far more rows than they are the subject, and those rows record
--   decisions about OTHER people -- they are how those people can see
--   who approved their registration or rejected their change request.
--   Deleting the administrator erases that from their history too.
--
--   To keep the accountability trail while still removing this person's
--   own records, replace the combined delete below with:
--
--     update public.admin_actions set actor_email = 'deleted-user'
--      where lower(actor_email) = p_email;
--     delete from public.admin_actions
--      where lower(subject_email) = p_email;
--
--   The 'user_deleted' entry is written AFTER the purge, so the record
--   that the deletion happened survives it.
-- ---------------------------------------------------------------------
create or replace function public.admin_delete_user_data(p_actor_email text, p_email text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_before         public.profiles;
  v_actor_is_main  boolean;
  v_target_is_main boolean;
  v_jwt_email      text;
  v_jwt_role       text;
  v_counts         jsonb := '{}'::jsonb;
  n                integer;
begin
  if p_actor_email is null or btrim(p_actor_email) = '' then
    raise exception 'actor email is required';
  end if;

  p_actor_email := lower(btrim(p_actor_email));
  p_email       := lower(btrim(coalesce(p_email, '')));
  if p_email = '' then raise exception 'a target email is required'; end if;

  v_jwt_email := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_jwt_role  := coalesce(auth.jwt() ->> 'role', '');

  if v_jwt_role <> 'service_role' then
    if v_jwt_email = '' then raise exception 'not authorized'; end if;
    if v_jwt_email <> p_actor_email then raise exception 'not authorized'; end if;
  end if;

  if not exists (select 1 from public.admins where email = p_actor_email) then
    raise exception 'not authorized';
  end if;

  if coalesce((select p.disabled from public.profiles p
                where p.email = p_actor_email), false) then
    raise exception 'not authorized';
  end if;

  select coalesce(bool_or(is_main), false) into v_actor_is_main
  from public.admins where email = p_actor_email;

  if not v_actor_is_main then
    raise exception 'not authorized';
  end if;

  if p_actor_email = p_email then
    raise exception 'cannot delete your own account';
  end if;

  select coalesce(bool_or(is_main), false) into v_target_is_main
  from public.admins where email = p_email;

  if v_target_is_main then
    raise exception 'a main administrator cannot be deleted';
  end if;

  select * into v_before from public.profiles where email = p_email;
  if v_before is null then raise exception 'user not found'; end if;

  -- ---- 2. references from other people's rows: null, do not delete ----
  update public.profiles set reviewed_by = null where lower(reviewed_by) = p_email;
  update public.profiles set disabled_by = null where lower(disabled_by) = p_email;
  update public.admins   set added_by    = null where lower(added_by)    = p_email;
  update public.admin_invites set invited_by = null where lower(invited_by) = p_email;
  update public.profile_change_requests set reviewed_by = null where lower(reviewed_by) = p_email;
  update public.profile_change_requests set decided_by  = null where lower(decided_by)  = p_email;
  update public.admin_removal_requests  set decided_by  = null where lower(decided_by)  = p_email;

  -- ---- 3. requests they filed (requested_by is NOT NULL) ----
  delete from public.admin_removal_requests where lower(requested_by) = p_email;
  get diagnostics n = row_count; v_counts := v_counts || jsonb_build_object('removal_requests_filed', n);

  -- ---- 1. rows that ARE about them ----
  delete from public.admin_removal_requests where lower(target_email) = p_email;
  get diagnostics n = row_count; v_counts := v_counts || jsonb_build_object('removal_requests_against', n);

  delete from public.profile_change_requests where lower(user_email) = p_email;
  get diagnostics n = row_count; v_counts := v_counts || jsonb_build_object('change_requests', n);

  delete from public.admin_invites where lower(email) = p_email;
  get diagnostics n = row_count; v_counts := v_counts || jsonb_build_object('admin_invites', n);

  delete from public.ai_assistant_usage where lower(user_email) = p_email;
  get diagnostics n = row_count; v_counts := v_counts || jsonb_build_object('ai_usage', n);

  delete from public.profile_accounts where lower(user_email) = p_email;
  get diagnostics n = row_count; v_counts := v_counts || jsonb_build_object('account_links', n);

  -- ---- audit log: every row naming them, as actor or subject ----
  delete from public.admin_actions
   where lower(actor_email) = p_email or lower(subject_email) = p_email;
  get diagnostics n = row_count; v_counts := v_counts || jsonb_build_object('audit_entries', n);

  -- ---- the account itself ----
  delete from public.profiles where email = p_email;
  delete from public.admins   where email = p_email;

  -- ---- NOT touched, by design ----
  -- transactions, available_transactions, released_transactions.
  -- Disbursement records outlive the portal account. Their user_email /
  -- email still carries this address, so if the same person registers
  -- again their statement reappears intact.

  insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
  values ('user_deleted', p_actor_email, p_email, v_before.full_name,
          v_counts || jsonb_build_object(
            'payment_records_kept', true,
            'kept_tables', 'transactions, available_transactions, released_transactions'));

  return json_build_object(
    'user_id',   v_before.id,
    'full_name', v_before.full_name,
    'deleted',   v_counts
  );
end;
$function$;

create or replace function public.approve_registration(p_email text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_row     public.profiles;
  v_actor   text := auth.jwt() ->> 'email';
  v_invite  public.admin_invites;
  v_granted boolean := false;
begin
  perform public.require_admin();
  p_email := lower(btrim(coalesce(p_email, '')));

  update public.profiles set approval_status = 'approved', rejection_reason = null
  where email = p_email
  returning * into v_row;
  if v_row is null then raise exception 'user not found'; end if;

  insert into public.admin_actions (action, actor_email, subject_email, subject_name)
  values ('registration_approved', v_actor, p_email, v_row.full_name);

  select * into v_invite from public.admin_invites where email = p_email;

  -- Tested on a column, not on the record. `v_invite is not null` is
  -- true only when EVERY field is non-null, and note and invited_by are
  -- routinely null — the invitation would never convert.
  if v_invite.email is not null then
    if v_invite.expires_at < now() then
      -- Left in place rather than deleted: an expired invitation is
      -- still a record that somebody meant this, and re-issuing it is
      -- one call to admin_add().
      insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
      values ('admin_invite_expired', v_actor, p_email, v_row.full_name,
              jsonb_build_object('invited_by', v_invite.invited_by,
                                 'expired_at', v_invite.expires_at));
    else
      insert into public.admins (email, note, added_by)
      values (p_email, v_invite.note, v_invite.invited_by)
      on conflict (email) do nothing;

      delete from public.admin_invites where email = p_email;
      v_granted := true;

      insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
      values ('admin_added_from_invite', v_actor, p_email, v_row.full_name,
              jsonb_build_object('invited_by', v_invite.invited_by,
                                 'invited_at', v_invite.invited_at));
    end if;
  end if;

  return json_build_object(
    'email', v_row.email,
    'full_name', v_row.full_name,
    'decision', 'approved',
    'became_admin', v_granted
  );
end;
$function$;

create or replace function public.reject_registration(p_email text, p_reason text default null::text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_row public.profiles;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  p_email := lower(btrim(coalesce(p_email, '')));

  update public.profiles set approval_status = 'rejected', rejection_reason = p_reason
  where email = p_email
  returning * into v_row;
  if v_row is null then raise exception 'user not found'; end if;

  insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
  values ('registration_rejected', auth.jwt() ->> 'email', p_email, v_row.full_name,
          case when p_reason is not null then json_build_object('reason', p_reason) else null end);

  return json_build_object('email', v_row.email, 'full_name', v_row.full_name, 'decision', 'rejected', 'reason', p_reason);
end;
$function$;

create or replace function public.request_profile_change(p_full_name text, p_account_number text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_current public.profiles;
  v_id      uuid;
begin
  p_account_number := public.normalize_account_numbers(p_account_number);

  select * into v_current from public.profiles
   where lower(email) = lower(coalesce(v_email, ''));
  if v_current is null then raise exception 'profile not found'; end if;

  delete from public.profile_change_requests
  where lower(user_email) = lower(coalesce(v_email, '')) and status = 'pending';

  if public.is_main_admin() then
    update public.profiles
    set full_name = p_full_name, account_number = p_account_number
    where lower(email) = lower(coalesce(v_email, ''));

    insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
    values ('user_edited', v_email, v_email, p_full_name,
            json_build_object(
              'from', json_build_object('full_name', v_current.full_name, 'account_number', v_current.account_number),
              'to',   json_build_object('full_name', p_full_name, 'account_number', p_account_number)
            ));

    return json_build_object(
      'immediate', true,
      'full_name', p_full_name,
      'account_number', p_account_number
    );
  end if;

  insert into public.profile_change_requests
    (user_email, current_full_name, current_account_number,
     requested_full_name, requested_account_number, status)
  values
    (v_email, v_current.full_name, v_current.account_number,
     p_full_name, p_account_number, 'pending')
  returning id into v_id;

  return json_build_object('immediate', false, 'id', v_id);
end;
$function$;

create or replace function public.cancel_my_profile_change()
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  delete from public.profile_change_requests
  where lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and status = 'pending';
$function$;

create or replace function public.approve_profile_change(p_request_id uuid)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_req  public.profile_change_requests;
  v_name text;
  v_acct text;
  v_by   text := auth.jwt() ->> 'email';
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;

  select * into v_req from public.profile_change_requests
  where id = p_request_id and status = 'pending'
  for update;
  if v_req is null then raise exception 'request not found or already decided'; end if;

  if lower(btrim(coalesce(v_req.user_email, ''))) = lower(btrim(coalesce(v_by, '')))
     and not public.is_main_admin() then
    raise exception 'You cannot approve your own profile change.'
      using hint = 'Ask another administrator to review it.',
            errcode = 'insufficient_privilege';
  end if;

  v_name := coalesce(v_req.requested_full_name, v_req.current_full_name);
  v_acct := coalesce(v_req.requested_account_number, v_req.current_account_number);

  update public.profiles set full_name = v_name, account_number = v_acct
  where lower(email) = lower(v_req.user_email);

  update public.profile_change_requests
  set status = 'approved',
      decided_at = now(),  decided_by = v_by,
      reviewed_at = now(), reviewed_by = v_by
  where id = p_request_id;

  insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
  values ('change_approved', v_by, v_req.user_email, v_name,
          json_build_object(
            'request_id', p_request_id,
            'from', json_build_object('full_name', v_req.current_full_name, 'account_number', v_req.current_account_number),
            'to',   json_build_object('full_name', v_name, 'account_number', v_acct)
          ));

  return json_build_object('email', v_req.user_email, 'full_name', v_name, 'account_number', v_acct, 'decision', 'approved');
end;
$function$;

create or replace function public.reject_profile_change(p_request_id uuid, p_note text default null::text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_req public.profile_change_requests;
  v_by  text := auth.jwt() ->> 'email';
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;

  select * into v_req from public.profile_change_requests
  where id = p_request_id and status = 'pending'
  for update;
  if v_req is null then raise exception 'request not found or already decided'; end if;

  if lower(btrim(coalesce(v_req.user_email, ''))) = lower(btrim(coalesce(v_by, '')))
     and not public.is_main_admin() then
    raise exception 'You cannot reject your own profile change.'
      using hint = 'Cancel it from Edit Account instead, or ask another administrator to review it.',
            errcode = 'insufficient_privilege';
  end if;

  update public.profile_change_requests
  set status = 'rejected',
      rejection_reason = p_note,
      decided_at = now(),  decided_by = v_by,
      reviewed_at = now(), reviewed_by = v_by
  where id = p_request_id;

  insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
  values ('change_rejected', v_by, v_req.user_email, v_req.current_full_name,
          json_build_object('request_id', p_request_id, 'reason', p_note));

  return json_build_object('email', v_req.user_email, 'full_name', v_req.current_full_name, 'account_number', v_req.current_account_number, 'decision', 'rejected', 'reason', p_note);
end;
$function$;

create or replace function public.mark_notified(p_email text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  update public.profiles set notified = true where email = lower(btrim(coalesce(p_email, '')));
end;
$function$;

create or replace function public.export_my_data()
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  -- nullif/btrim, not a bare read. A blank email passes an `is null`
  -- test, and this function ends by writing an admin_actions row —
  -- so the access log, which exists precisely so an odd pattern of
  -- exports gets noticed, would gain an entry attributed to nobody.
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  v_out   json;
begin
  if v_email is null then raise exception 'not authorized'; end if;

  select json_build_object(
    'export_generated_at', now(),
    'export_format_note',  'JSON. Provided under RA 10173 (Data Privacy Act of 2012), sections 16 and 18.',
    'data_subject',        lower(v_email),

    'profile', (
      select json_build_object(
        'email', p.email, 'full_name', p.full_name,
        'first_name', p.first_name, 'middle_initial', p.middle_initial,
        'last_name', p.last_name, 'suffix', p.suffix,
        'account_numbers', p.account_number,
        'approval_status', p.approval_status, 'disabled', p.disabled,
        'privacy_notice_acknowledged_at', p.privacy_notice_ack_at)
      from public.profiles p where lower(p.email) = lower(v_email)),

    'linked_account_numbers', coalesce((
      select json_agg(pa.account_number order by pa.position)
      from public.profile_accounts pa
      where lower(pa.user_email) = lower(v_email)), '[]'::json),

    'change_requests', coalesce((
      select json_agg(json_build_object(
        'requested_at', r.requested_at,
        'requested_full_name', r.requested_full_name,
        'requested_account_number', r.requested_account_number,
        'status', r.status, 'decided_at', r.decided_at,
        'rejection_reason', r.rejection_reason))
      from public.profile_change_requests r
      where lower(r.user_email) = lower(v_email)), '[]'::json),

    'atm_transactions', coalesce((
      select json_agg(json_build_object(
        'date', t.txn_date, 'amount', t.amount, 'account_number', t.acct_no,
        'description', t.description, 'dv_no', t.dvno))
      from public.transactions t
      -- Account number AND email, matching transactions_select_own. An
      -- export that disagrees with the statement is worse than either.
      where exists (
        select 1 from public.profiles p
        where lower(p.email) = lower(v_email)
          and p.approval_status = 'approved'
          and public.format_account_number(btrim(t.acct_no)) in (
                select public.format_account_number(n)
                from unnest(public.split_list(p.account_number)) n))
        and lower(btrim(v_email)) in (
              select lower(btrim(e)) from unnest(public.split_list(t.email)) e)
      ), '[]'::json),

    'released_cheques', coalesce((
      select json_agg(json_build_object(
        'date', rt.txn_date, 'amount', rt.amount,
        'description_unit', rt.description_unit,
        'ada_rada_check', rt.ada_rada_check,
        'status', rt.status, 'date_released', rt.dreleased))
      from public.released_transactions rt
      where lower(btrim(v_email)) in (
        select lower(btrim(e)) from unnest(string_to_array(coalesce(rt.user_email, ''), ',')) e
        where btrim(e) <> '')), '[]'::json)
  ) into v_out;

  insert into public.admin_actions (action, actor_email, subject_email, detail)
  values ('data_export_self', lower(v_email), lower(v_email),
          jsonb_build_object('basis', 'RA 10173 s.18 data subject access'));

  return v_out;
end;
$function$;

create or replace function public.record_privacy_notice_ack(p_version text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  -- nullif/btrim, not a bare read: `is null` alone lets a JWT carrying
  -- an empty-string email through the guard below, and the update then
  -- matches on lower(email) = '' — a write aimed at nobody.
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  v_ver   text := nullif(btrim(coalesce(p_version, '')), '');
  v_at    timestamptz;
  v_had   text;
begin
  if v_email is null then raise exception 'not authorized'; end if;
  if v_ver is null then raise exception 'a notice version is required'; end if;

  select privacy_notice_ack_at, privacy_notice_ack_version
    into v_at, v_had
    from public.profiles where lower(email) = lower(v_email);

  if v_at is not null and v_had is not distinct from v_ver then
    return json_build_object('acknowledged_at', v_at, 'version', v_had, 'changed', false);
  end if;

  update public.profiles
     set privacy_notice_ack_at      = now(),
         privacy_notice_ack_version = v_ver
   where lower(email) = lower(v_email)
  returning privacy_notice_ack_at into v_at;

  return json_build_object('acknowledged_at', v_at, 'version', v_ver, 'changed', true);
end;
$function$;

create or replace function public.ai_assistant_take_token()
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email  text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_window interval := interval '1 hour';
  v_cap    integer := 60;
  v_calls  integer;
begin
  if v_email = '' then return false; end if;
  if not (public.is_approved_user() or public.is_admin()) then return false; end if;
  if public.is_disabled() then return false; end if;

  insert into public.ai_assistant_usage (user_email, window_start, calls)
  values (v_email, now(), 1)
  on conflict (user_email) do update
    set window_start = case
          when public.ai_assistant_usage.window_start < now() - v_window
          then now() else public.ai_assistant_usage.window_start end,
        calls = case
          when public.ai_assistant_usage.window_start < now() - v_window
          then 1 else public.ai_assistant_usage.calls + 1 end
  returning calls into v_calls;

  return v_calls <= v_cap;
end;
$function$;

create or replace function public.purge_expired_records(p_days integer default 1825)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_cutoff    timestamptz;
  v_actions   integer;
  v_requests  integer;
  v_stale     integer;
begin
  if not (public.is_main_admin() or auth.jwt() is null) then
    raise exception 'not authorized';
  end if;
  if p_days is null or p_days < 1 then
    raise exception 'retention window must be at least 1 day';
  end if;

  v_cutoff := now() - make_interval(days => p_days);

  delete from public.admin_actions where at < v_cutoff;
  get diagnostics v_actions = row_count;

  delete from public.profile_change_requests
  where status <> 'pending' and decided_at is not null and decided_at < v_cutoff;
  get diagnostics v_requests = row_count;

  select count(*) into v_stale
  from public.profiles
  where approval_status = 'rejected' and created_at < v_cutoff;

  return json_build_object(
    'cutoff',                    v_cutoff,
    'admin_actions_deleted',     v_actions,
    'change_requests_deleted',   v_requests,
    'rejected_profiles_pending_review', v_stale
  );
end;
$function$;

-- --- trigger functions -------------------------------------------------

create or replace function public.normalize_profile_fields()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  parts jsonb;
  accts text[];
begin
  -- Lowercased here, before enforce_profile_uniqueness runs (same BEFORE
  -- timing, and "normalize_" sorts ahead of "unique_"), so the uniqueness
  -- guard and every lower()-based helper see one spelling per person.
  new.email := lower(btrim(new.email));

  accts := public.split_account_numbers(new.account_number);

  if array_length(accts, 1) > public.max_account_numbers() then
    raise exception
      'A profile can hold at most % account numbers; % were given (%).',
      public.max_account_numbers(), array_length(accts, 1), new.account_number
      using hint = 'Remove the extras and try again.';
  end if;

  new.account_number := public.join_account_numbers(accts);

  if position(',' in coalesce(new.full_name, '')) > 0 then
    parts := public.parse_full_name(new.full_name);
    new.first_name     := parts ->> 'first_name';
    new.middle_initial := parts ->> 'middle_initial';
    new.last_name      := parts ->> 'last_name';
    new.suffix         := parts ->> 'suffix';
  elsif nullif(btrim(coalesce(new.full_name, '')), '') is not null then
    new.last_name := btrim(new.full_name);
  end if;

  return new;
end;
$function$;

create or replace function public.enforce_profile_uniqueness()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  clash_email text;
  clash_acct  text;
  wanted      text[];
  ordered     text[];
  one_acct    text;
begin
  -- Pending and rejected rows are not checked at all: a registration may
  -- land carrying a name or an account number somebody else already has,
  -- and wait in the queue for an administrator to decide.
  if coalesce(new.approval_status, 'pending') <> 'approved' then
    return new;
  end if;

  wanted := public.split_account_numbers(new.account_number);

  -- Locks first, before any check reads anything, or the check is still
  -- reading a snapshot taken before the lock was granted. Ordered, so two
  -- concurrent approvals touching the same pair of numbers cannot take
  -- them in opposite orders and deadlock.
  if coalesce(array_length(wanted, 1), 0) > 0 then
    select array_agg(a order by a) into ordered from unnest(wanted) as a;
    foreach one_acct in array ordered
    loop
      perform pg_advisory_xact_lock(hashtext('scoiws:account_number:' || one_acct));
    end loop;
  end if;

  if nullif(btrim(coalesce(new.full_name, '')), '') is not null then
    perform pg_advisory_xact_lock(
      hashtext('scoiws:full_name:' || upper(btrim(new.full_name))));
  end if;

  -- Name, against other APPROVED profiles.
  --
  -- Self is excluded by id, not email. This is a BEFORE trigger, so
  -- during an email change the table still holds the old address: an
  -- email-based self-test fails to exclude the row being written, and the
  -- profile is refused for holding its own name. id cannot drift.
  if nullif(btrim(coalesce(new.full_name, '')), '') is not null then
    select p.email into clash_email
      from public.profiles p
     where p.approval_status = 'approved'
       and upper(btrim(coalesce(p.full_name, ''))) = upper(btrim(new.full_name))
       and p.id <> new.id
     limit 1;

    if clash_email is not null then
      raise exception
        'The name "%" is already registered to an approved account.', btrim(new.full_name)
        using hint = 'Reject this registration, or change the name on the other account first.',
              errcode = 'unique_violation';
    end if;
  end if;

  -- Account numbers, against other APPROVED profiles.
  --
  -- Joined through profiles rather than read straight off
  -- profile_accounts, because that table also holds pending applicants'
  -- numbers and a pending row must not block anybody. Self is excluded on
  -- the joined row's id, for the same reason as above -- profile_accounts
  -- is keyed by email and still carries the old address at this point.
  if coalesce(array_length(wanted, 1), 0) > 0 then
    select pa.account_number into clash_acct
      from public.profile_accounts pa
      join public.profiles p on lower(p.email) = lower(pa.user_email)
     where p.approval_status = 'approved'
       and pa.account_number = any (wanted)
       and p.id <> new.id
     limit 1;

    if clash_acct is not null then
      raise exception
        'Account number % is already registered to an approved account.', clash_acct
        using hint = 'Reject this registration, or release the number on the other account first.',
              errcode = 'unique_violation';
    end if;
  end if;

  return new;
end;
$function$;


create or replace function public.sync_profile_accounts()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  accts text[];
  i     integer;
begin
  if tg_op = 'DELETE' then
    delete from public.profile_accounts where lower(user_email) = lower(old.email);
    return old;
  end if;

  if tg_op = 'UPDATE'
     and coalesce(new.account_number, '') is not distinct from coalesce(old.account_number, '')
     and lower(new.email) = lower(old.email) then
    return new;
  end if;

  -- The old address too, when this is a rename. Without it the previous
  -- rows survive under an address no profile answers to, and
  -- enforce_profile_uniqueness still sees them holding the number.
  if tg_op = 'UPDATE' and lower(new.email) is distinct from lower(old.email) then
    delete from public.profile_accounts where lower(user_email) = lower(old.email);
  end if;

  delete from public.profile_accounts where lower(user_email) = lower(new.email);

  accts := public.split_account_numbers(new.account_number);
  if accts is not null then
    for i in 1 .. coalesce(array_length(accts, 1), 0) loop
      -- The ON CONFLICT clause covers only the (email, number) unique
      -- constraint: the same person listing the same number twice, which
      -- is harmless. A DIFFERENT person already holding the number is not
      -- harmless, is not covered, and is the one a race actually hits --
      -- so it is caught and re-raised in the same words
      -- enforce_profile_uniqueness() uses for the same situation. Whether
      -- the clash was spotted by the check or by the index is an
      -- implementation detail the person saving the form should not see.
      begin
        insert into public.profile_accounts (user_email, account_number, position)
        values (new.email, accts[i], i)
        on conflict (user_email, account_number) do nothing;
      exception
        when unique_violation then
          -- Deliberately still not naming the holder. Who owns a number
          -- is not something the portal tells the person who guessed it.
          raise exception
            'Account number % is already registered to another account.', accts[i]
            using hint = 'Check the number, or ask the Cash Office to release it.',
                  errcode = 'unique_violation';
      end;
    end loop;
  end if;

  return new;
end;
$function$;


create or replace function public.revoke_admin_on_profile_delete()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_was_admin boolean;
  v_was_main  boolean;
  v_mains     integer;
  v_actor     text;
begin
  select true, coalesce(bool_or(a.is_main), false)
    into v_was_admin, v_was_main
    from public.admins a
   where lower(a.email) = lower(old.email);

  if not coalesce(v_was_admin, false) then
    return old;
  end if;

  if v_was_main then
    select count(*) into v_mains from public.admins where is_main;
    if v_mains <= 1 then
      raise exception
        'Cannot delete %: they are the only main administrator.', old.email
        using hint = 'Promote another administrator to main first, then delete this account.',
              errcode = 'restrict_violation';
    end if;
  end if;

  delete from public.admins where lower(email) = lower(old.email);

  -- Any removal request naming them is now about nobody. Left behind
  -- it sits in admin_removal_queue() forever, un-actionable, because
  -- admin_decide_removal() deletes from admins by address and would
  -- find nothing to delete.
  delete from public.admin_removal_requests
   where lower(target_email) = lower(old.email);

  -- actor_email is NOT NULL, and the actor here is often nobody a JWT
  -- can name: a cascade from auth.users, or psql. 'system' is the
  -- honest answer in that case, and it is worth a row either way —
  -- "when did this address stop being an administrator" is the first
  -- question asked when one unexpectedly is not.
  v_actor := coalesce(nullif(btrim(auth.jwt() ->> 'email'), ''), 'system');

  insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
  values (
    'admin_revoked_with_profile',
    v_actor,
    lower(old.email),
    old.full_name,
    jsonb_build_object('was_main', v_was_main)
  );

  return old;
end;
$function$;

create or replace function public.normalize_admin_email()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  new.email := lower(btrim(new.email));
  -- Adopt the login if one already exists for this address, so the row
  -- does not sit on a null user_id waiting for a signup that already
  -- happened.
  if new.user_id is null then
    select u.id into new.user_id from auth.users u
     where lower(u.email) = new.email;
  end if;
  return new;
end;
$function$;


create or replace function public.normalize_removal_request_emails()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  new.target_email := lower(btrim(new.target_email));
  new.requested_by := lower(btrim(new.requested_by));
  return new;
end;
$function$;

create or replace function public.normalize_change_request()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  accts text[];
begin
  new.user_email := lower(btrim(new.user_email));

  accts := public.split_account_numbers(new.requested_account_number);

  if array_length(accts, 1) > public.max_account_numbers() then
    raise exception
      'A profile can hold at most % account numbers; % were requested.',
      public.max_account_numbers(), array_length(accts, 1);
  end if;

  new.requested_account_number := public.join_account_numbers(accts);
  return new;
end;
$function$;

create or replace function public.reject_duplicate_change_request()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  wanted     text[];
  clash_acct text;
  me         text := lower(coalesce(new.user_email, ''));
  wanted_nm  text := upper(btrim(coalesce(new.requested_full_name, '')));
begin
  if coalesce(new.status, 'pending') <> 'pending' then
    return new;
  end if;

  if wanted_nm <> '' then
    if exists (
      select 1 from public.profiles p
       where upper(btrim(coalesce(p.full_name, ''))) = wanted_nm
         and lower(p.email) <> me
    ) then
      raise exception
        'The name "%" is already registered to another account.', btrim(new.requested_full_name)
        using hint = 'Add a middle initial or suffix to tell the two apart.',
              errcode = 'unique_violation';
    end if;

    if exists (
      select 1 from public.profile_change_requests r
       where r.status = 'pending'
         and r.id is distinct from new.id
         and lower(r.user_email) <> me
         and upper(btrim(coalesce(r.requested_full_name, ''))) = wanted_nm
    ) then
      raise exception
        'The name "%" is already on another pending request.', btrim(new.requested_full_name)
        using hint = 'Wait for that request to be decided, or use a different name.',
              errcode = 'unique_violation';
    end if;
  end if;

  wanted := public.split_account_numbers(new.requested_account_number);

  if coalesce(array_length(wanted, 1), 0) > 0 then
    select pa.account_number into clash_acct
      from public.profile_accounts pa
     where pa.account_number = any (wanted)
       and lower(pa.user_email) <> me
     limit 1;

    if clash_acct is not null then
      raise exception
        'Account number % is already registered to another account.', clash_acct
        using hint = 'Check the number, or ask the Cash Office to release it.',
              errcode = 'unique_violation';
    end if;

    select x.n into clash_acct
      from public.profile_change_requests r
      cross join lateral unnest(public.split_account_numbers(r.requested_account_number)) as x(n)
     where r.status = 'pending'
       and r.id is distinct from new.id
       and lower(r.user_email) <> me
       and x.n = any (wanted)
     limit 1;

    if clash_acct is not null then
      raise exception
        'Account number % is already on another pending request.', clash_acct
        using hint = 'Wait for that request to be decided.',
              errcode = 'unique_violation';
    end if;
  end if;

  return new;
end;
$function$;

create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_existing uuid;
begin
  if public.up_mail_restriction_enabled() and new.email !~* '@up\.edu\.ph$' then
    raise exception 'up_mail_required: This portal only accepts up.edu.ph accounts.';
  end if;

  select p.id into v_existing
    from public.profiles p
   where lower(p.email) = lower(new.email);

  if v_existing is not null then
    if v_existing = new.id then
      return new;  -- same user, trigger ran twice; nothing to do
    end if;
    raise exception
      'profile_email_conflict: a profile already exists for % under a different account id (%). Resolve it before this address can sign up again.',
      new.email, v_existing
      using hint = 'Almost always a profiles row that outlived its auth.users row. Delete the orphan, or point it at the new id.';
  end if;

  -- profiles.id is the primary key and has no default: it is meant to
  -- BE auth.users.id (that's what the foreign key says).
  insert into public.profiles (id, email, full_name, account_number, approval_status)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    public.normalize_account_numbers(new.raw_user_meta_data ->> 'account_number'),
    'pending'
  );

  -- An administrator row may have been created by address before this
  -- person ever signed in. Claim it now that there is a uid to claim it with.
  update public.admins
     set user_id = new.id
   where lower(email) = lower(new.email) and user_id is null;

  return new;
end;
$function$;


create or replace function public.sync_email_change()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_old text := lower(btrim(coalesce(old.email, '')));
  v_new text := lower(btrim(coalesce(new.email, '')));
  v_clash uuid;
begin
  if v_new = '' or v_old = '' or v_old = v_new then
    return new;
  end if;

  -- profiles.email is unique. Let the collision fail here, with wording
  -- that says what happened, rather than as a raw constraint error two
  -- statements later.
  select p.id into v_clash
    from public.profiles p
   where lower(p.email) = v_new and p.id <> new.id;

  if v_clash is not null then
    raise exception
      'email_in_use: % is already registered to another profile.', v_new
      using hint = 'Resolve or delete that profile before moving this address.',
            errcode = 'unique_violation';
  end if;

  -- Keyed to the row by id, not by the old address, because id is the
  -- one link that cannot have drifted.
  update public.profiles set email = v_new where id = new.id;

  update public.admins                  set email = v_new         where lower(email) = v_old;
  update public.admin_invites           set email = v_new         where lower(email) = v_old;
  update public.profile_change_requests set user_email = v_new    where lower(user_email) = v_old;
  update public.admin_removal_requests  set target_email = v_new  where lower(target_email) = v_old;
  update public.admin_removal_requests  set requested_by = v_new  where lower(requested_by) = v_old;
  update public.transactions            set email = v_new         where lower(btrim(email)) = v_old;

  -- available_ and released_transactions hold a comma-separated list on
  -- some rows (one cheque, several contacts at the same supplier), so the
  -- address is replaced element-wise and the co-payees are left alone.
  update public.available_transactions a
     set user_email = (
       select string_agg(case when lower(btrim(e)) = v_old then v_new else btrim(e) end, ', ')
         from unnest(string_to_array(a.user_email, ',')) e
        where btrim(e) <> '')
   where exists (
     select 1 from unnest(string_to_array(coalesce(a.user_email, ''), ',')) e
      where lower(btrim(e)) = v_old);

  update public.released_transactions r
     set user_email = (
       select string_agg(case when lower(btrim(e)) = v_old then v_new else btrim(e) end, ', ')
         from unnest(string_to_array(r.user_email, ',')) e
        where btrim(e) <> '')
   where exists (
     select 1 from unnest(string_to_array(coalesce(r.user_email, ''), ',')) e
      where lower(btrim(e)) = v_old);

  -- The rate-limit bucket moves with the person, so a changed address is
  -- not a way to reset the counter. Any stale bucket already sitting on
  -- the new address is cleared first (user_email is the PK).
  delete from public.ai_assistant_usage where user_email = v_new;
  update public.ai_assistant_usage set user_email = v_new where user_email = v_old;

  -- admin_actions is deliberately NOT rewritten. It is the audit log: it
  -- records the address that acted or was acted on at the time, and
  -- back-dating it would destroy the record it exists to keep. The row
  -- below is what ties the two identities together.
  --
  -- from_email/to_email, not from/to: approval.js actionDetail() and
  -- logEntryDetail() treat detail.from/detail.to as OBJECTS carrying
  -- full_name and account_number (the shape profile-change entries use),
  -- and would render this row as "— → —".
  insert into public.admin_actions (action, actor_email, subject_email, detail)
  values (
    'email_changed',
    coalesce(nullif(btrim(auth.jwt() ->> 'email'), ''), 'system'),
    v_new,
    jsonb_build_object('from_email', v_old, 'to_email', v_new, 'user_id', new.id));

  return new;
end;
$function$;

create or replace function public.bump_data_version()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- FOR EACH STATEMENT, so this runs once per import rather than once
  -- per row. tg_argv[0] is the dataset name, passed by each trigger.
  insert into public.data_versions (dataset, version, updated_at)
  values (tg_argv[0], 1, now())
  on conflict (dataset) do update
     set version = public.data_versions.version + 1,
         updated_at = now();
  return null;
end;
$function$;

-- rls_auto_enable() -----------------------------------------------------
--
-- Backs the `ensure_rls` EVENT trigger in section 5. Every table created
-- in `public` from here on gets RLS switched on the moment it is created,
-- whether or not whoever created it remembered to.
--
-- This is a backstop, not the policy layer. Enabling RLS with no policy
-- denies everything to anon and authenticated, which is the safe way to
-- fail: a new table is unreadable until somebody writes a policy for it,
-- rather than world-readable until somebody notices. Section 6 is still
-- where access is actually granted.
--
-- It is deliberately quiet. A failure to enable RLS is logged, not
-- raised, because raising would abort the CREATE TABLE that triggered
-- it -- turning a missing safety net into a broken migration.
--
-- search_path is pinned to pg_catalog rather than public: this runs as
-- SECURITY DEFINER inside another session's DDL, and the whole point is
-- that it must not resolve anything through a schema a caller controls.
create or replace function public.rls_auto_enable()
 returns event_trigger
 language plpgsql
 security definer
 set search_path to 'pg_catalog'
as $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- ---------------------------------------------------------------------
-- 5. TRIGGERS
-- ---------------------------------------------------------------------

create trigger normalize_profile_fields_trg
  before insert or update on public.profiles
  for each row execute function public.normalize_profile_fields();

create trigger unique_profile_guard_trg
  before insert or update on public.profiles
  for each row execute function public.enforce_profile_uniqueness();

create trigger sync_profile_accounts_trg
  after insert or update or delete on public.profiles
  for each row execute function public.sync_profile_accounts();

-- named zz_ so it runs after sync_profile_accounts_trg on DELETE (alphabetical trigger order)
create trigger zz_revoke_admin_on_profile_delete_trg
  after delete on public.profiles
  for each row execute function public.revoke_admin_on_profile_delete();

create trigger normalize_admin_email_trg
  before insert or update on public.admins
  for each row execute function public.normalize_admin_email();

create trigger normalize_removal_request_emails_trg
  before insert or update on public.admin_removal_requests
  for each row execute function public.normalize_removal_request_emails();

create trigger normalize_change_request_trg
  before insert or update on public.profile_change_requests
  for each row execute function public.normalize_change_request();

create trigger reject_duplicate_change_request_trg
  before insert or update on public.profile_change_requests
  for each row execute function public.reject_duplicate_change_request();

-- auth.users -> public.profiles bootstrap trigger
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- auth.users -> every email-keyed table.
--
-- Identity is auth.uid(); every join in this schema is by email. Nothing
-- kept the two ends together: handle_new_user() fires on INSERT only, and
-- no constraint ties profiles.email to auth.users.email. A changed
-- address moved the JWT claim and left every email-keyed row pointing at
-- the old one -- profile invisible, statement empty, sign-in refused with
-- "No profile on file", while is_admin() kept working off the uid.
--
-- Not reachable from the portal itself (updateUser() is only ever called
-- with a password), but reachable from the Supabase dashboard, from a
-- direct updateUser({email}) call with the public anon key, and from a
-- Google SSO account whose primary address changes.
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.sync_email_change();

-- data_versions bumps. FOR EACH STATEMENT is the whole point: a bulk
-- import fires each of these once, not once per row.
create trigger transactions_version_trg
  after insert or update or delete or truncate on public.transactions
  for each statement execute function public.bump_data_version('transactions');

create trigger released_transactions_version_trg
  after insert or update or delete or truncate on public.released_transactions
  for each statement execute function public.bump_data_version('released_transactions');

create trigger available_transactions_version_trg
  after insert or update or delete or truncate on public.available_transactions
  for each statement execute function public.bump_data_version('available_transactions');

create trigger news_version_trg
  after insert or update or delete or truncate on public.news
  for each statement execute function public.bump_data_version('news');

create trigger calendar_events_version_trg
  after insert or update or delete or truncate on public.calendar_events
  for each statement execute function public.bump_data_version('calendar_events');

-- ensure_rls (EVENT trigger) -------------------------------------------
--
-- Fires on every CREATE TABLE in the database and hands it to
-- rls_auto_enable(), which switches RLS on if the table landed in
-- `public`. See the function in section 4 for why it fails quietly.
--
-- It is created HERE, after section 2, on purpose. Every table in this
-- script already gets `enable row level security` explicitly in section
-- 6, so the trigger has nothing to do for them -- it exists for the
-- table somebody adds next year in the SQL Editor and forgets to
-- protect. Creating it before section 2 would only mean the same tables
-- get RLS enabled twice.
--
-- PRIVILEGES: CREATE EVENT TRIGGER is not an ordinary table-owner
-- privilege. On Supabase the `postgres` role can do it (this trigger is
-- owned by postgres on the live project), but on a self-hosted Postgres
-- it needs a superuser. If this statement is the one that fails on a
-- fresh deploy, the rest of the schema is still correct -- comment out
-- these two objects, deploy, and add them back as the superuser. You
-- lose the backstop, not the database.
create event trigger ensure_rls
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();

-- ---------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------

alter table public.profiles                 enable row level security;
alter table public.admins                    enable row level security;
alter table public.admin_invites             enable row level security;
alter table public.admin_actions             enable row level security;
alter table public.admin_removal_requests    enable row level security;
alter table public.profile_accounts          enable row level security;
alter table public.profile_change_requests   enable row level security;
alter table public.available_transactions    enable row level security;
alter table public.released_transactions     enable row level security;
alter table public.transactions              enable row level security;
alter table public.news                      enable row level security;
alter table public.calendar_events           enable row level security;
alter table public.ai_assistant_usage        enable row level security;
alter table public.data_versions            enable row level security;

-- profiles: each person sees their own row; admins see everyone
create policy profiles_select_own on public.profiles
  for select to public
  using (lower(email) = lower(coalesce((auth.jwt() ->> 'email'), '')) or public.is_admin());

-- profile_accounts: each person sees their own linked accounts; admins see everyone
create policy profile_accounts_select_own on public.profile_accounts
  for select to public
  using (lower(user_email) = lower(coalesce((auth.jwt() ->> 'email'), '')) or public.is_admin());

-- profile_change_requests: each person sees their own requests; admins see everyone
create policy pcr_select_own on public.profile_change_requests
  for select to public
  using (lower(user_email) = lower(coalesce((auth.jwt() ->> 'email'), '')) or public.is_admin());

-- admin_actions: visible only to a main administrator
create policy admin_actions_select_main_only on public.admin_actions
  for select to public
  using (public.is_main_admin());

-- news: any approved (non-disabled) user or admin can read; only admins write
create policy news_select_own on public.news
  for select to public
  using ((not public.is_disabled()) and (public.is_approved_user() or public.is_admin()));

create policy news_admin_write on public.news
  for all to public
  using (public.is_admin())
  with check (public.is_admin());

-- calendar_events: same shape as news
create policy calendar_events_select_own on public.calendar_events
  for select to public
  using ((not public.is_disabled()) and (public.is_approved_user() or public.is_admin()));

create policy calendar_events_admin_write on public.calendar_events
  for all to public
  using (public.is_admin())
  with check (public.is_admin());

-- available_transactions: a person sees rows addressed to their own email; only admins write
create policy available_transactions_select_own on public.available_transactions
  for select to public
  using (
    (not public.is_disabled())
    and (public.is_admin() or public.owns_email_row(available_transactions.user_email))
  );

create policy available_transactions_admin_write on public.available_transactions
  for all to public
  using (public.is_admin())
  with check (public.is_admin());

-- released_transactions: same shape as available_transactions
create policy released_transactions_select_own on public.released_transactions
  for select to public
  using (
    (not public.is_disabled())
    and (public.is_admin() or public.owns_email_row(released_transactions.user_email))
  );

create policy released_transactions_admin_write on public.released_transactions
  for all to public
  using (public.is_admin())
  with check (public.is_admin());

-- transactions (ATM): BOTH proofs required, not either one.
--
--   * the account number on the row is one the person registered and an
--     administrator approved (proven ownership), AND
--   * the person's address is named in transactions.email (named on the
--     payment itself).
--
-- This is narrower than the account-number-only rule it replaces.
-- Verified against live before applying: 226 rows visible before, 226
-- after, 0 hidden.
--
-- The cost is a coupled failure mode. A row with a correct account
-- number but a blank or misspelled email is invisible to the person it
-- belongs to, where before it showed -- and nothing raises an error.
-- Nothing is in that state today, but 607 of 1,959 rows carry no email
-- at all, so the shape is there. Run the monitoring query in README.md
-- after every ATM import; it must return 0.
--
-- NOTE: the two cheque tables use email ALONE. Only this table requires
-- both, because only this table has an account number to check.
create policy transactions_select_own on public.transactions
  for select to public
  using (
    (not public.is_disabled())
    and (
      public.is_admin()
      or public.owns_atm_row(transactions.acct_no, transactions.email)
    )
  );

-- data_versions: readable by anyone signed in and not disabled. No write
-- policy at all -- only the statement triggers above write here.
create policy data_versions_select on public.data_versions
  for select to public
  using (
    nullif(btrim(coalesce((auth.jwt() ->> 'email'), '')), '') is not null
    and not public.is_disabled()
  );

create policy transactions_admin_write on public.transactions
  for all to public
  using (public.is_admin())
  with check (public.is_admin());

-- admins, admin_invites, admin_removal_requests, ai_assistant_usage have RLS
-- enabled with NO policies: all access to these tables goes through the
-- SECURITY DEFINER RPCs above (admin_list, admin_add, ai_assistant_take_token,
-- etc.), never directly from the client.

-- ---------------------------------------------------------------------
-- 7. FUNCTION EXECUTE GRANTS
-- ---------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC by default on function creation, which
-- covers the small set of read-only/pure helper functions below (safe for
-- anon and authenticated to call directly). Everything else is locked down:
-- trigger functions and internal helpers get EXECUTE revoked entirely, and
-- privileged RPCs get EXECUTE revoked from PUBLIC/anon and re-granted only
-- to authenticated.

-- internal-only: trigger functions and admin-only maintenance helpers
revoke execute on function public.enforce_profile_uniqueness() from public;
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.log_admin_action(text, text, text, text, jsonb) from public;
revoke execute on function public.normalize_admin_email() from public;
revoke execute on function public.normalize_change_request() from public;
revoke execute on function public.normalize_profile_fields() from public;
revoke execute on function public.normalize_removal_request_emails() from public;
revoke execute on function public.purge_expired_records(integer) from public;
revoke execute on function public.reject_duplicate_change_request() from public;
revoke execute on function public.revoke_admin_on_profile_delete() from public;
-- rls_auto_enable() is only ever invoked by the ensure_rls event trigger,
-- which runs as its owner. Nobody needs to call it by hand, and it is
-- SECURITY DEFINER, so PUBLIC comes off it like the other trigger functions.
revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.sync_profile_accounts() from public;

-- authenticated-only RPCs (anon revoked, authenticated granted)
revoke execute on function public.admin_act_refusal(text, text) from public;
revoke execute on function public.admin_action_log(text, integer) from public;
revoke execute on function public.admin_add(text, text) from public;
revoke execute on function public.admin_decide_removal(uuid, boolean, text) from public;
revoke execute on function public.admin_delete_user_data(text, text) from public;
revoke execute on function public.admin_invite_cancel(text) from public;
revoke execute on function public.admin_list() from public;
revoke execute on function public.admin_pending_queue() from public;
revoke execute on function public.admin_rank(text) from public;
revoke execute on function public.admin_removal_queue() from public;
revoke execute on function public.admin_remove(text) from public;
revoke execute on function public.admin_request_admin_removal(text, text) from public;
revoke execute on function public.admin_search_users(text) from public;
revoke execute on function public.admin_set_account_disabled(text, boolean, text) from public;
revoke execute on function public.admin_update_user(text, text, text) from public;
revoke execute on function public.admin_user_actions(text) from public;
revoke execute on function public.ai_assistant_take_token() from public;
revoke execute on function public.approve_profile_change(uuid) from public;
revoke execute on function public.approve_registration(text) from public;
revoke execute on function public.cancel_my_profile_change() from public;
revoke execute on function public.export_my_data() from public;
revoke execute on function public.mark_notified(text) from public;
revoke execute on function public.record_privacy_notice_ack(text) from public;
revoke execute on function public.reject_profile_change(uuid, text) from public;
revoke execute on function public.reject_registration(text, text) from public;
revoke execute on function public.request_profile_change(text, text) from public;
revoke execute on function public.require_admin() from public;
revoke execute on function public.require_can_act(text, text) from public;
revoke execute on function public.require_main_admin() from public;

grant execute on function public.admin_act_refusal(text, text) to authenticated;
grant execute on function public.admin_action_log(text, integer) to authenticated;
grant execute on function public.admin_add(text, text) to authenticated;
grant execute on function public.admin_decide_removal(uuid, boolean, text) to authenticated;
grant execute on function public.admin_delete_user_data(text, text) to authenticated;
grant execute on function public.admin_invite_cancel(text) to authenticated;
grant execute on function public.admin_list() to authenticated;
grant execute on function public.admin_pending_queue() to authenticated;
grant execute on function public.admin_rank(text) to authenticated;
grant execute on function public.admin_removal_queue() to authenticated;
grant execute on function public.admin_remove(text) to authenticated;
grant execute on function public.admin_request_admin_removal(text, text) to authenticated;
grant execute on function public.admin_search_users(text) to authenticated;
grant execute on function public.admin_set_account_disabled(text, boolean, text) to authenticated;
grant execute on function public.admin_update_user(text, text, text) to authenticated;
grant execute on function public.admin_user_actions(text) to authenticated;
grant execute on function public.ai_assistant_take_token() to authenticated;
grant execute on function public.approve_profile_change(uuid) to authenticated;
grant execute on function public.approve_registration(text) to authenticated;
grant execute on function public.cancel_my_profile_change() to authenticated;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.mark_notified(text) to authenticated;
grant execute on function public.record_privacy_notice_ack(text) to authenticated;
grant execute on function public.reject_profile_change(uuid, text) to authenticated;
grant execute on function public.reject_registration(text, text) to authenticated;
grant execute on function public.request_profile_change(text, text) to authenticated;
grant execute on function public.require_admin() to authenticated;
grant execute on function public.require_can_act(text, text) to authenticated;
grant execute on function public.require_main_admin() to authenticated;

-- client-callable helpers: PUBLIC revoked, anon and authenticated granted
-- explicitly. These are read-only and safe to call before sign-in — the
-- registration form checks a name and account number for duplicates while
-- the caller is still anon — but "safe for anon" is not the same as "safe
-- for PUBLIC", which is every role that exists now or later. Naming the two
-- roles that need it keeps the grant honest about who actually calls these.
revoke execute on function public.account_numbers_taken(text, text) from public;
revoke execute on function public.full_name_taken(text, text) from public;
revoke execute on function public.is_admin() from public;
revoke execute on function public.is_approved_user() from public;
revoke execute on function public.is_disabled() from public;
revoke execute on function public.is_main_admin() from public;
revoke execute on function public.max_account_numbers() from public;
revoke execute on function public.normalize_account_numbers(text) from public;

grant execute on function public.account_numbers_taken(text, text) to anon, authenticated;
grant execute on function public.full_name_taken(text, text) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_approved_user() to anon, authenticated;
grant execute on function public.is_disabled() to anon, authenticated;
grant execute on function public.is_main_admin() to anon, authenticated;
grant execute on function public.max_account_numbers() to anon, authenticated;
grant execute on function public.normalize_account_numbers(text) to anon, authenticated;

-- everything else (format_account_number, join_account_numbers,
-- parse_full_name, split_account_numbers, up_mail_restriction_enabled)
-- keeps the default PUBLIC execute grant. These are pure functions of
-- their arguments — they read no table and consult no session — so there
-- is nothing for a caller to learn from one that it did not already know.

-- sync_email_change() is a trigger function on auth.users. Nothing should
-- be able to call it directly.
revoke execute on function public.sync_email_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. SCHEDULED JOBS
-- ---------------------------------------------------------------------
--
-- purge_expired_records() implements the RA 10173 retention window but
-- had no caller and no schedule, so it had never run once. pg_cron runs
-- it as the table owner with no JWT; the function's own guard already
-- allows that path (`auth.jwt() is null`), so no privilege change is
-- needed to let the job in.
--
-- 1825 days = 5 years. Sundays 18:30 UTC is Monday 02:30 in Manila
-- (PHT, UTC+8) — outside office hours, and cron.schedule is UTC-only.
create extension if not exists pg_cron;

select cron.schedule(
  'purge-expired-records',
  '30 18 * * 0',
  $job$select public.purge_expired_records(1825)$job$
);

-- ---------------------------------------------------------------------
-- 9. REALTIME
-- ---------------------------------------------------------------------
--
-- Realtime publishes only what is in this publication. data_versions is
-- the ONLY table that belongs here: it is the refresh signal, and it
-- carries no personal data. Do not add the transaction tables -- see the
-- note on the table in section 2 for why.
alter publication supabase_realtime add table public.data_versions;

-- ---------------------------------------------------------------------
-- 10. STORAGE
-- ---------------------------------------------------------------------
--
-- One bucket, `news-images`, holding the pictures attached to news items
-- and calendar events. Both tables point into it through their
-- image_path column (section 2); there is no separate calendar bucket.
--
-- PRIVATE, not public. A public bucket hands out permanent unguessable
-- URLs that work for anyone who has ever seen one, forever, with no
-- session behind them. These images are internal announcements, so the
-- client asks Storage for a short-lived signed URL each time instead --
-- see newsImageUrls() in sheets-config.js. That is also why image_path
-- stores a path and never a URL: a stored URL would either expire in
-- the row or never expire at all.
--
-- The size and MIME limits are enforced by Storage itself, server side.
-- The client checks the same things before uploading, but that check is
-- a courtesy to the user, not a control -- this is the control.
--
-- 2 MiB. Large enough for a scanned memo, small enough that the 48px
-- thumb_data on the row is worth having.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'news-images',
  'news-images',
  false,
  2097152,
  array['image/jpeg','image/png','image/webp','image/gif']
);

-- Policies on storage.objects.
--
-- RLS is already enabled on storage.objects by Supabase; these four
-- scope it to this bucket. Every one of them re-tests bucket_id, because
-- a policy on storage.objects applies to EVERY bucket in the project --
-- drop the bucket_id term and you have written a rule about buckets that
-- do not exist yet.
--
-- Read is wider than write on purpose: any approved, non-disabled user
-- can see the announcements; only an administrator can change them.
-- is_disabled() is tested explicitly rather than left to is_approved_user(),
-- so that disabling an account closes this door in the same instant it
-- closes the others.
create policy news_images_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'news-images'
    and not public.is_disabled()
    and (public.is_approved_user() or public.is_admin())
  );

create policy news_images_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'news-images' and public.is_admin());

-- UPDATE needs both halves: USING decides which existing object may be
-- touched, WITH CHECK decides what it may be turned into. Only USING
-- would let an administrator move an object out of this bucket.
create policy news_images_update on storage.objects
  for update to authenticated
  using (bucket_id = 'news-images' and public.is_admin())
  with check (bucket_id = 'news-images' and public.is_admin());

create policy news_images_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'news-images' and public.is_admin());

commit;

-- =====================================================================
-- SECTION 11 - PATCH 2026-08-11 (folded in from patch-2026-08-11.sql)
--
-- Four changes, in dependency order. Each section is independent except
-- where noted; read the header before running.
--
--   1. ENTITLEMENT HELPERS   owns_atm_row() / owns_email_row()
--                            Extracts the row-ownership rule out of the
--                            RLS policies so the statement and paging
--                            functions can reuse the SAME predicate
--                            instead of restating it. This is the only
--                            section that rewrites an existing policy.
--
--   2. ACCOUNT EVENTS        account_events + record_account_event()
--                            The user-visible half of the audit trail.
--                            admin_actions answers "what did staff do";
--                            this answers "what happened to my account",
--                            which is the question the account holder
--                            has and currently cannot ask.
--
--   3. VERIFIED CHANGES      approve_profile_change() now REQUIRES a
--                            recorded verification method when the LBP
--                            account number changes, and surfaces the
--                            takeover-shaped signals that should stop a
--                            reviewer approving on autopilot.
--
--   4. ISSUED STATEMENTS     statements_issued + issue_statement()
--                            A print/export becomes a referenced,
--                            dated, digest-stamped artifact the Cash
--                            Office can look up, instead of an
--                            anonymous spreadsheet.
--
--   5. SERVER-SIDE PAGING    my_transactions() returns one page plus
--                            exact totals, replacing the 5,000-row
--                            client fetch.
--
-- ---------------------------------------------------------------------
-- BEFORE YOU RUN THIS
-- ---------------------------------------------------------------------
--
-- Section 1 replaces `transactions_select_own`, the policy that decides
-- who can see an ATM payment. It is written to be EXACTLY equivalent to
-- what is there now. Prove that rather than trust it -- run the
-- verification query at the very bottom of this file BEFORE and AFTER,
-- as a normal (non-admin) test user, and confirm the row counts match.
-- If they do not, roll back and stop.
--
-- pgcrypto lives in the `extensions` schema on Supabase, NOT in public,
-- despite what an earlier comment in this file claimed. Every call to
-- digest() and gen_random_bytes() below is schema-qualified for that
-- reason. Qualify rather than adding `extensions` to a SECURITY DEFINER
-- function's search_path -- widening the path is the risk that setting
-- exists to prevent.
--
-- Everything is inside one transaction. A failure anywhere leaves the
-- database untouched.
-- =====================================================================

begin;

-- =====================================================================
-- SECTION 1 — ENTITLEMENT HELPERS
-- =====================================================================
--
-- The ATM rule ("account number AND email") lived only inside the RLS
-- policy. Any other function that needed to answer the same question had
-- to restate it, and a restatement that drifts is how a payment becomes
-- visible to the wrong person. Now there is one copy.
--
-- These test the CURRENT caller's JWT, so they are only meaningful in a
-- request context. Called with no JWT (pg_cron, SQL editor as postgres)
-- they return false, which is the safe direction.

create or replace function public.owns_atm_row(p_acct_no text, p_email_list text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  -- proof 1: the account number on the row is one this approved,
  -- non-disabled profile has registered.
  select exists (
           select 1
           from public.profiles p
           where lower(p.email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
             and p.approval_status = 'approved'
             and coalesce(p.disabled, false) = false
             and public.format_account_number(btrim(p_acct_no)) in (
                   select public.format_account_number(n.n)
                   from unnest(public.split_list(p.account_number)) n(n))
         )
     -- proof 2: and the caller is named on the row itself. split_list
     -- because email carries a comma-separated list on some rows.
     and nullif(btrim(coalesce((auth.jwt() ->> 'email'), '')), '') is not null
     and lower(btrim((auth.jwt() ->> 'email'))) in (
           select lower(e.e)
           from unnest(public.split_list(p_email_list)) e(e));
$function$;

comment on function public.owns_atm_row(text, text) is
  'True when the current caller owns this ATM row under the dual-proof rule '
  '(registered account number AND named on the row). Single source of truth: '
  'used by transactions_select_own, my_transactions() and issue_statement().';

create or replace function public.owns_email_row(p_email_list text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select public.is_approved_user()
     and nullif(btrim(coalesce((auth.jwt() ->> 'email'), '')), '') is not null
     and lower(btrim((auth.jwt() ->> 'email'))) in (
           select lower(btrim(e))
           from unnest(string_to_array(coalesce(p_email_list, ''), ',')) e(e)
           where btrim(e) <> '');
$function$;

comment on function public.owns_email_row(text) is
  'True when the current caller is named in this comma-separated email list. '
  'The cheque-table rule: email alone, no account number.';

-- Rewritten to call the helper. Semantically identical to the previous
-- inline version -- the `ilike` pre-filter is dropped because it was an
-- index-assist on top of the exact test that follows it, and the exact
-- test is what decides. Keeping it would have meant two copies of the
-- rule again, one of which (substring match) is wrong on its own.



-- =====================================================================
-- SECTION 2 — ACCOUNT EVENTS
-- =====================================================================
--
-- Why a second log rather than reusing admin_actions:
--
--   admin_actions is the STAFF record. It is main-admin-readable, it is
--   written by staff actions, and its retention is tied to the audit
--   window. Exposing it to account holders would leak who reviewed
--   whom.
--
--   account_events is the ACCOUNT HOLDER's record. Each person reads
--   only their own rows. It answers "did someone sign in as me on
--   Sunday", which nothing in this system could answer before.
--
-- Some things land in both, deliberately: an administrator changing
-- someone's account number is a staff action AND something the payee
-- must be told about.

create table public.account_events (
  id          uuid primary key default gen_random_uuid(),
  user_email  text not null,
  user_id     uuid,
  kind        text not null,
  at          timestamptz not null default now(),
  ip          text,
  user_agent  text,
  detail      jsonb,
  constraint account_events_kind_check check (kind = any (array[
    'sign_in',
    'sign_in_new_device',
    'password_changed',
    'email_changed',
    'profile_change_requested',
    'profile_change_withdrawn',
    'profile_change_approved',
    'profile_change_rejected',
    'account_number_changed',
    'data_exported',
    'statement_issued',
    'access_disabled',
    'access_restored'
  ]))
);

create index account_events_email_at_idx
  on public.account_events using btree (lower(user_email), at desc);

-- The request headers Supabase forwards. Wrapped because
-- current_setting() raises outside a request context unless told not
-- to, and because the header name differs by hop.
create or replace function public.client_ip()
 returns text
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare h json;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  if h is null then return null; end if;
  -- x-forwarded-for is a chain; the first entry is the client.
  return nullif(btrim(split_part(coalesce(h ->> 'x-forwarded-for',
                                          h ->> 'cf-connecting-ip', ''), ',', 1)), '');
end;
$function$;

create or replace function public.client_user_agent()
 returns text
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare h json;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  if h is null then return null; end if;
  return left(nullif(btrim(coalesce(h ->> 'user-agent', '')), ''), 400);
end;
$function$;

-- record_account_event() -----------------------------------------------
--
-- Callable by the signed-in user, but it writes ONLY for that user:
-- user_email comes from the JWT, never from an argument. The client
-- chooses the kind, not the subject. The worst a malicious caller can
-- do is litter their own history.
--
-- Sign-ins are deduplicated within two minutes so a page that reloads,
-- or three tabs opening at once, produce one line rather than three.
create or replace function public.record_account_event(p_kind text, p_detail jsonb default null::jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  v_ip    text := public.client_ip();
  v_ua    text := public.client_user_agent();
  v_seen  boolean;
begin
  if v_email is null then return; end if;

  -- Not every kind is the client's to claim. The ones a browser may
  -- report are the ones only the browser knows it did.
  if p_kind not in ('sign_in', 'password_changed', 'data_exported') then
    raise exception 'record_account_event: % is recorded by the server, not the client', p_kind
      using errcode = 'insufficient_privilege';
  end if;

  if p_kind = 'sign_in' then
    select exists (
      select 1 from public.account_events e
       where lower(e.user_email) = lower(v_email)
         and e.kind = 'sign_in'
         and e.at > now() - interval '2 minutes'
    ) into v_seen;
    if v_seen then return; end if;

    -- "New device" is a weak signal deliberately: same IP + same UA
    -- seen before in 90 days counts as familiar. It is here to make an
    -- unfamiliar sign-in stand out in the list, not to block anything.
    select not exists (
      select 1 from public.account_events e
       where lower(e.user_email) = lower(v_email)
         and e.kind in ('sign_in', 'sign_in_new_device')
         and e.at > now() - interval '90 days'
         and coalesce(e.ip, '') = coalesce(v_ip, '')
         and coalesce(e.user_agent, '') = coalesce(v_ua, '')
    ) into v_seen;
    if v_seen then p_kind := 'sign_in_new_device'; end if;
  end if;

  insert into public.account_events (user_email, user_id, kind, ip, user_agent, detail)
  values (v_email, auth.uid(), p_kind, v_ip, v_ua,
          case when jsonb_typeof(p_detail) = 'object' then p_detail else null end);
end;
$function$;

-- log_account_event() --------------------------------------------------
--
-- The server-side twin. Not client-callable (no grant below): it is for
-- the RPCs in this schema to record something ABOUT a user, including
-- when the actor is somebody else.
create or replace function public.log_account_event(p_email text, p_kind text, p_detail jsonb default null::jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if nullif(btrim(coalesce(p_email, '')), '') is null then return; end if;
  insert into public.account_events (user_email, user_id, kind, ip, user_agent, detail)
  values (
    lower(btrim(p_email)),
    (select p.id from public.profiles p where lower(p.email) = lower(btrim(p_email))),
    p_kind,
    public.client_ip(),
    public.client_user_agent(),
    p_detail);
end;
$function$;

create or replace function public.my_account_events(p_limit integer default 25)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  cap int := least(greatest(coalesce(p_limit, 25), 1), 200);
begin
  if v_email is null then return '[]'::jsonb; end if;

  return coalesce((
    select jsonb_agg(row_to_json(e)::jsonb order by e.at desc)
      from (
        select a.at, a.kind, a.ip, a.user_agent, a.detail
          from public.account_events a
         where lower(a.user_email) = lower(v_email)
         order by a.at desc
         limit cap
      ) e
  ), '[]'::jsonb);
end;
$function$;

-- =====================================================================
-- SECTION 3 — VERIFIED ACCOUNT-NUMBER CHANGES
-- =====================================================================
--
-- The portal cannot check an LBP number against LBP. It can refuse to
-- let the check be skipped silently.
--
-- Before: approving a change of bank account was one click, recorded as
-- "change_approved", indistinguishable from approving a corrected
-- middle initial.
--
-- After: if the ACCOUNT NUMBER changes, the reviewer must record HOW
-- they verified it and against WHAT. A name-only change is unaffected --
-- adding friction there would only train people to click through it.

create or replace function public.profile_change_risk(p_request_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_req  public.profile_change_requests;
  v_acct_changed boolean;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;

  select * into v_req from public.profile_change_requests where id = p_request_id;
  if v_req is null then return '{}'::jsonb; end if;

  v_acct_changed := public.normalize_account_numbers(coalesce(v_req.requested_account_number, ''))
                 is distinct from
                    public.normalize_account_numbers(coalesce(v_req.current_account_number, ''));

  -- The signals below are the shape of an account takeover followed by
  -- a payment diversion: get in, change the credentials, change where
  -- the money lands. Any one of them alone is ordinary. Together with
  -- an account-number change they are the reason to pick up the phone.
  return jsonb_build_object(
    'account_number_changed', v_acct_changed,
    'name_changed', coalesce(v_req.requested_full_name, '') is distinct from coalesce(v_req.current_full_name, ''),
    'password_changed_recently', exists (
      select 1 from public.account_events e
       where lower(e.user_email) = lower(v_req.user_email)
         and e.kind = 'password_changed'
         and e.at > v_req.requested_at - interval '14 days'),
    'email_changed_recently', exists (
      select 1 from public.account_events e
       where lower(e.user_email) = lower(v_req.user_email)
         and e.kind = 'email_changed'
         and e.at > v_req.requested_at - interval '14 days'),
    'new_device_sign_in_recently', exists (
      select 1 from public.account_events e
       where lower(e.user_email) = lower(v_req.user_email)
         and e.kind = 'sign_in_new_device'
         and e.at > v_req.requested_at - interval '14 days'),
    'account_age_days', (
      select floor(extract(epoch from (now() - p.created_at)) / 86400)::int
        from public.profiles p where lower(p.email) = lower(v_req.user_email)),
    'previous_account_changes', (
      select count(*) from public.account_events e
       where lower(e.user_email) = lower(v_req.user_email)
         and e.kind = 'account_number_changed')
  );
end;
$function$;

-- Replaces the existing two-argument version. The old signature is
-- dropped explicitly: leaving it in place would mean an un-updated
-- approval.js kept approving account-number changes with no
-- verification and no error, which is the failure this section exists
-- to prevent.
drop function if exists public.approve_profile_change(uuid);

create or replace function public.approve_profile_change(p_request_id uuid, p_verification jsonb default null::jsonb)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_req    public.profile_change_requests;
  v_name   text;
  v_acct   text;
  v_by     text := auth.jwt() ->> 'email';
  v_acct_changed boolean;
  v_method text;
  v_ref    text;
  v_clash  text;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;

  select * into v_req from public.profile_change_requests
  where id = p_request_id and status = 'pending'
  for update;
  if v_req is null then raise exception 'request not found or already decided'; end if;

  if lower(btrim(coalesce(v_req.user_email, ''))) = lower(btrim(coalesce(v_by, '')))
     and not public.is_main_admin() then
    raise exception 'You cannot approve your own profile change.'
      using hint = 'Ask another administrator to review it.',
            errcode = 'insufficient_privilege';
  end if;

  v_name := coalesce(v_req.requested_full_name, v_req.current_full_name);
  v_acct := coalesce(v_req.requested_account_number, v_req.current_account_number);

  v_acct_changed := public.normalize_account_numbers(coalesce(v_acct, ''))
                 is distinct from
                    public.normalize_account_numbers(coalesce(v_req.current_account_number, ''));

  if v_acct_changed then
    v_method := nullif(btrim(coalesce(p_verification ->> 'method', '')), '');
    v_ref    := nullif(btrim(coalesce(p_verification ->> 'reference', '')), '');

    if v_method is null then
      raise exception 'Changing an LBP account number needs a recorded verification method.'
        using hint = 'Confirm the number against a bank document, payroll record, '
                     'presented ID, or a callback to a number you already hold -- '
                     'then record which.',
              errcode = 'insufficient_privilege';
    end if;

    if v_method not in ('bank_document', 'hr_payroll_record', 'in_person_id', 'phone_callback') then
      raise exception 'Unknown verification method: %', v_method
        using errcode = 'invalid_parameter_value';
    end if;

    if v_ref is null or length(v_ref) < 3 then
      raise exception 'Record what you checked against -- a document reference, '
                      'payroll period, ID type and number, or who you spoke to and when.'
        using errcode = 'invalid_parameter_value';
    end if;

    -- The uniqueness trigger would catch this on write, but as a
    -- constraint violation with a message written for a developer. The
    -- reviewer needs to know before they commit to the decision.
    select n into v_clash
      from unnest(public.split_account_numbers(v_acct)) as n
     where exists (
       select 1 from public.profiles p
        where lower(p.email) <> lower(v_req.user_email)
          and n = any (public.split_account_numbers(p.account_number)))
     limit 1;
    if v_clash is not null then
      raise exception 'Account number % is already registered to somebody else.', v_clash
        using hint = 'Two people cannot be paid into the same number through this portal. '
                     'Resolve it with the Cash Office before approving.',
              errcode = 'unique_violation';
    end if;
  end if;

  update public.profiles set full_name = v_name, account_number = v_acct
  where lower(email) = lower(v_req.user_email);

  update public.profile_change_requests
  set status = 'approved',
      decided_at = now(),  decided_by = v_by,
      reviewed_at = now(), reviewed_by = v_by
  where id = p_request_id;

  insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
  values ('change_approved', v_by, v_req.user_email, v_name,
          json_build_object(
            'request_id', p_request_id,
            'from', json_build_object('full_name', v_req.current_full_name, 'account_number', v_req.current_account_number),
            'to',   json_build_object('full_name', v_name, 'account_number', v_acct),
            'account_number_changed', v_acct_changed,
            'verification', case when v_acct_changed
                                 then jsonb_build_object('method', v_method, 'reference', v_ref)
                                 else null end
          )::jsonb);

  -- Tell the payee. A change of where their money lands is the single
  -- most important thing this portal can notify somebody about, and
  -- until now it happened silently.
  perform public.log_account_event(v_req.user_email, 'profile_change_approved',
            jsonb_build_object('request_id', p_request_id, 'decided_by', v_by));

  if v_acct_changed then
    perform public.log_account_event(v_req.user_email, 'account_number_changed',
              jsonb_build_object(
                'from', v_req.current_account_number,
                'to', v_acct,
                'decided_by', v_by,
                'verification_method', v_method));
  end if;

  return json_build_object('email', v_req.user_email, 'full_name', v_name,
                           'account_number', v_acct, 'decision', 'approved',
                           'account_number_changed', v_acct_changed);
end;
$function$;

-- =====================================================================
-- SECTION 4 — ISSUED STATEMENTS
-- =====================================================================
--
-- What this does and does not claim.
--
--   DOES: give every printed or exported statement a reference the Cash
--   Office can look up, a server-side timestamp, an exact row count and
--   peso total computed on the server, and a digest over the rows as
--   they were at issue. If somebody brings back a spreadsheet, the
--   totals on it can be checked against the registry in one query.
--
--   DOES NOT: sign anything. This is not a digital signature and must
--   not be described as one. A determined forger can edit the
--   spreadsheet, including the header. What they cannot do is make the
--   reference resolve to their edited totals -- the registry row is
--   server-written and the client never supplies its contents.
--
--   The threat this actually addresses is the ordinary one: a
--   spreadsheet of unknown vintage arriving at a counter with no way to
--   tell which run of the data it came from.

create table public.statements_issued (
  id           uuid primary key default gen_random_uuid(),
  reference    text not null unique,
  user_email   text not null,
  kind         text not null check (kind = any (array['ATM','CHECK'])),
  issued_at    timestamptz not null default now(),
  coverage_from date,
  coverage_to   date,
  account_filter text,
  row_count    integer not null,
  total_amount numeric(18,2) not null,
  digest       text not null,
  ip           text
);

create index statements_issued_email_at_idx
  on public.statements_issued using btree (lower(user_email), issued_at desc);

create or replace function public.issue_statement(
  p_kind text,
  p_from date default null,
  p_to date default null,
  p_account text default null)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  v_ref   text;
  v_rows  int := 0;
  v_total numeric(18,2) := 0;
  v_canon text;
  v_digest text;
  v_acct  text := nullif(btrim(coalesce(p_account, '')), '');
begin
  if v_email is null then raise exception 'not signed in'; end if;
  if not (public.is_approved_user() or public.is_admin()) then
    raise exception 'not authorized';
  end if;
  if public.is_disabled() then raise exception 'not authorized'; end if;
  if p_kind not in ('ATM', 'CHECK') then
    raise exception 'kind must be ATM or CHECK';
  end if;

  -- The canonical text is built from the same predicate the RLS policy
  -- uses (section 1), so a statement can never contain a row the
  -- statement page would not show, and vice versa.
  if p_kind = 'ATM' then
    select count(*), coalesce(sum(t.amount), 0),
           coalesce(string_agg(
             t.txn_date::text || '|' || coalesce(t.dvno,'') || '|' ||
             coalesce(t.ada,'') || '|' || coalesce(t.description,'') || '|' ||
             to_char(coalesce(t.amount,0), 'FM9999999999990.00'),
             E'\n' order by t.txn_date desc, t.dvno, t.amount), '')
      into v_rows, v_total, v_canon
      from public.transactions t
     where public.owns_atm_row(t.acct_no, t.email)
       and (p_from is null or t.txn_date >= p_from)
       and (p_to   is null or t.txn_date <= p_to)
       and (v_acct is null or public.format_account_number(btrim(t.acct_no))
                              = public.format_account_number(v_acct));
  else
    select count(*), coalesce(sum(r.amount), 0),
           coalesce(string_agg(
             r.dreleased::text || '|' || coalesce(r.txn_date::text,'') || '|' ||
             coalesce(r.ada_rada_check,'') || '|' || coalesce(r.description_unit,'') || '|' ||
             to_char(coalesce(r.amount,0), 'FM9999999999990.00'),
             E'\n' order by r.dreleased desc, r.ada_rada_check, r.amount), '')
      into v_rows, v_total, v_canon
      from public.released_transactions r
     where public.owns_email_row(r.user_email)
       and (p_from is null or r.dreleased >= p_from)
       and (p_to   is null or r.dreleased <= p_to);
  end if;

  -- Reference: readable at a counter, unambiguous when read aloud, and
  -- carrying its own issue date so a stale one is obvious on sight.
  v_ref := 'SOA-' || p_kind || '-' || to_char(now() at time zone 'Asia/Manila', 'YYYYMMDD')
           || '-' || upper(encode(extensions.gen_random_bytes(3), 'hex'));

  v_digest := encode(extensions.digest(
                coalesce(v_email,'') || E'\n' || p_kind || E'\n' ||
                coalesce(p_from::text,'') || E'\n' || coalesce(p_to::text,'') || E'\n' ||
                coalesce(v_acct,'') || E'\n' || v_rows::text || E'\n' ||
                to_char(v_total, 'FM9999999999990.00') || E'\n' || coalesce(v_canon,''),
                'sha256'), 'hex');

  insert into public.statements_issued
    (reference, user_email, kind, coverage_from, coverage_to, account_filter,
     row_count, total_amount, digest, ip)
  values
    (v_ref, v_email, p_kind, p_from, p_to, v_acct,
     v_rows, v_total, v_digest, public.client_ip());

  perform public.log_account_event(v_email, 'statement_issued',
            jsonb_build_object('reference', v_ref, 'kind', p_kind,
                               'row_count', v_rows, 'total_amount', v_total));

  return json_build_object(
    'reference', v_ref,
    'issued_at', now(),
    'kind', p_kind,
    'coverage_from', p_from,
    'coverage_to', p_to,
    'account_filter', v_acct,
    'row_count', v_rows,
    'total_amount', v_total,
    'digest', v_digest,
    'digest_short', upper(left(v_digest, 12)));
end;
$function$;

-- verify_statement() ---------------------------------------------------
--
-- The counter-side lookup. An administrator can resolve any reference;
-- an account holder can resolve only their own, so somebody handed a
-- reference cannot use this to read another person's totals.
create or replace function public.verify_statement(p_reference text)
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  v_row   public.statements_issued;
begin
  if v_email is null then raise exception 'not signed in'; end if;

  select * into v_row from public.statements_issued
   where upper(reference) = upper(btrim(coalesce(p_reference, '')));

  if v_row is null then
    return json_build_object('found', false);
  end if;

  if not public.is_admin() and lower(v_row.user_email) <> lower(v_email) then
    -- Deliberately identical to the not-found answer. Distinguishing
    -- them would turn this into an oracle for guessing references.
    return json_build_object('found', false);
  end if;

  return json_build_object(
    'found', true,
    'reference', v_row.reference,
    'issued_at', v_row.issued_at,
    'issued_to', case when public.is_admin() then v_row.user_email else null end,
    'kind', v_row.kind,
    'coverage_from', v_row.coverage_from,
    'coverage_to', v_row.coverage_to,
    'row_count', v_row.row_count,
    'total_amount', v_row.total_amount,
    'digest_short', upper(left(v_row.digest, 12)));
end;
$function$;

-- =====================================================================
-- SECTION 5 — SERVER-SIDE PAGING
-- =====================================================================
--
-- Replaces a 5,000-row client fetch that filtered in JavaScript. Three
-- things were wrong with that, in increasing order of seriousness:
-- it shipped rows nobody looked at; the cap was silent past 5,000
-- ("narrow the range" is not something a person knows to do about a
-- statement they cannot see the end of); and the totals shown were
-- totals OF THE FETCH, not of the data.
--
-- This returns one page and the exact count and sum over the whole
-- matching set, computed in the database.

create or replace function public.my_transactions(
  p_kind text,
  p_from date default null,
  p_to date default null,
  p_account text default null,
  p_limit integer default 100,
  p_offset integer default 0)
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  cap  int := least(greatest(coalesce(p_limit, 100), 1), 500);
  off  int := greatest(coalesce(p_offset, 0), 0);
  v_acct text := nullif(btrim(coalesce(p_account, '')), '');
  v_rows json;
  v_count int;
  v_total numeric(18,2);
begin
  if v_email is null then raise exception 'not signed in'; end if;
  if public.is_disabled() then raise exception 'not authorized'; end if;
  if p_kind not in ('ATM', 'CHECK') then
    raise exception 'kind must be ATM or CHECK';
  end if;

  -- Note this is scoped to the CALLER even for an administrator. The
  -- RLS policies let an admin read every row; this function is "my
  -- statement", so it uses the ownership helper alone and an admin
  -- calling it sees their own payments, not everyone's.
  if p_kind = 'ATM' then
    select count(*), coalesce(sum(t.amount), 0) into v_count, v_total
      from public.transactions t
     where public.owns_atm_row(t.acct_no, t.email)
       and (p_from is null or t.txn_date >= p_from)
       and (p_to   is null or t.txn_date <= p_to)
       and (v_acct is null or public.format_account_number(btrim(t.acct_no))
                              = public.format_account_number(v_acct));

    select coalesce(json_agg(row_to_json(x)), '[]'::json) into v_rows
      from (
        select t.txn_date, t.dvno, t.ada, t.description, t.amount, t.acct_no
          from public.transactions t
         where public.owns_atm_row(t.acct_no, t.email)
           and (p_from is null or t.txn_date >= p_from)
           and (p_to   is null or t.txn_date <= p_to)
           and (v_acct is null or public.format_account_number(btrim(t.acct_no))
                                  = public.format_account_number(v_acct))
         order by t.txn_date desc nulls last, t.dvno
         limit cap offset off
      ) x;
  else
    select count(*), coalesce(sum(r.amount), 0) into v_count, v_total
      from public.released_transactions r
     where public.owns_email_row(r.user_email)
       and (p_from is null or r.dreleased >= p_from)
       and (p_to   is null or r.dreleased <= p_to);

    select coalesce(json_agg(row_to_json(x)), '[]'::json) into v_rows
      from (
        select r.dreleased, r.txn_date, r.ada_rada_check, r.description_unit, r.amount
          from public.released_transactions r
         where public.owns_email_row(r.user_email)
           and (p_from is null or r.dreleased >= p_from)
           and (p_to   is null or r.dreleased <= p_to)
         order by r.dreleased desc nulls last, r.ada_rada_check
         limit cap offset off
      ) x;
  end if;

  return json_build_object(
    'rows', v_rows,
    'total_count', v_count,
    'total_amount', v_total,
    'limit', cap,
    'offset', off,
    'has_more', (off + cap) < v_count);
end;
$function$;

-- =====================================================================
-- SECTION 6 — RLS AND GRANTS FOR THE NEW TABLES
-- =====================================================================

alter table public.account_events     enable row level security;
alter table public.statements_issued  enable row level security;

-- Read your own; administrators read everyone's, because "was there a
-- sign-in from Cebu last Tuesday" is a question the Cash Office gets
-- asked when somebody reports a problem.
create policy account_events_select_own on public.account_events
  for select to public
  using (
    lower(user_email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
    or public.is_admin()
  );

create policy statements_issued_select_own on public.statements_issued
  for select to public
  using (
    lower(user_email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
    or public.is_admin()
  );

-- No INSERT/UPDATE/DELETE policy on either table, deliberately. Both are
-- append-only records of what happened; they are written exclusively by
-- the SECURITY DEFINER functions above. A client with the anon key
-- cannot forge, amend or erase a line in its own history.

revoke execute on function public.client_ip() from public;
revoke execute on function public.client_user_agent() from public;
revoke execute on function public.log_account_event(text, text, jsonb) from public;
revoke execute on function public.owns_atm_row(text, text) from public;
revoke execute on function public.owns_email_row(text) from public;
revoke execute on function public.record_account_event(text, jsonb) from public;
revoke execute on function public.my_account_events(integer) from public;
revoke execute on function public.my_transactions(text, date, date, text, integer, integer) from public;
revoke execute on function public.issue_statement(text, date, date, text) from public;
revoke execute on function public.verify_statement(text) from public;
revoke execute on function public.profile_change_risk(uuid) from public;
revoke execute on function public.approve_profile_change(uuid, jsonb) from public;

-- owns_atm_row / owns_email_row are granted because the RLS policies
-- evaluate them as the calling role. They leak nothing: each answers a
-- yes/no about the caller's own entitlement to a row the caller already
-- had to name.
grant execute on function public.owns_atm_row(text, text) to anon, authenticated;
grant execute on function public.owns_email_row(text) to anon, authenticated;

grant execute on function public.record_account_event(text, jsonb) to authenticated;
grant execute on function public.my_account_events(integer) to authenticated;
grant execute on function public.my_transactions(text, date, date, text, integer, integer) to authenticated;
grant execute on function public.issue_statement(text, date, date, text) to authenticated;
grant execute on function public.verify_statement(text) to authenticated;
grant execute on function public.profile_change_risk(uuid) to authenticated;
grant execute on function public.approve_profile_change(uuid, jsonb) to authenticated;

-- log_account_event(), client_ip() and client_user_agent() stay
-- ungranted. They are internal to the functions above; a client that
-- could call log_account_event() directly could write a line naming
-- somebody else.

-- =====================================================================
-- SECTION 7 — RETENTION
-- =====================================================================
--
-- account_events and statements_issued fall under the same window as
-- the rest of the audit trail. purge_expired_records() has to be taught
-- about them or they grow forever -- add these two statements to that
-- function's body alongside the admin_actions purge:
--
--   delete from public.account_events    where at        < now() - (p_days || ' days')::interval;
--   delete from public.statements_issued where issued_at < now() - (p_days || ' days')::interval;
--
-- Left as an edit to make by hand rather than a silent replacement of a
-- function that already carries a retention decision the UDPO has
-- signed off on. Purging a statement registry means an old reference
-- stops resolving; that is a records decision, not a technical one.

commit;

-- =====================================================================
-- VERIFICATION — run these AFTER, and the first one BEFORE as well
-- =====================================================================
--
-- 1. SECTION 1 EQUIVALENCE. Sign in as an ordinary approved user in a
--    browser, open the console, and compare with what you recorded
--    before the patch. The three numbers must be identical.
--
--      select
--        (select count(*) from public.transactions)            as atm_visible,
--        (select count(*) from public.released_transactions)   as check_visible,
--        (select count(*) from public.available_transactions)  as available_visible;
--
--    Run in the SQL editor it returns everything (postgres bypasses
--    RLS) and tells you nothing. It has to be run as the user.
--
-- 2. NO POLICY WAS LOST.
--
--      select tablename, policyname from pg_policies
--       where schemaname = 'public'
--       order by tablename, policyname;
--
-- 3. THE NEW TABLES DENY WRITES FROM THE CLIENT. As a signed-in user:
--
--      insert into public.account_events (user_email, kind)
--      values ('someone.else@up.edu.ph', 'sign_in');
--      -- expected: new row violates row-level security policy
--
-- 4. VERIFICATION IS ACTUALLY REQUIRED. As an administrator, on a
--    pending request that changes an account number:
--
--      select public.approve_profile_change('<uuid>');
--      -- expected: "Changing an LBP account number needs a recorded
--      --            verification method."
--
-- 5. UPDATE check-drift.js. The EXPECTED block at the top counts
--    objects and this patch adds: 2 tables, 2 indexes, 11 functions,
--    2 policies, 2 RLS tables. Do not guess the new totals -- run
--    `node check-drift.js`, read the numbers it reports, and set them.
--    Then fold this file into deploy-schema.sql so a fresh deploy
--    produces the same database as a patched one.
-- =====================================================================

-- =====================================================================
-- SECTION 12 - PATCH 2026-08-11b (folded in from patch-2026-08-11b.sql)
--
-- The database half of items 5, 7, 9 and 11. Items 3, 4, 6 and 8 are
-- client-only; item 12 is the ai-assistant Edge Function.
--
--   5. PROBE BUDGET      account_numbers_taken() and full_name_taken()
--                        are meterd per source address before they will
--                        answer an anonymous caller.
--
--   7. SESSION STATE     my_session_state() -- one round trip for
--                        approved / disabled / admin / main, so an open
--                        tab can notice its access changed.
--
--   9. SELF-APPROVAL     approve_registration() gains the guard
--                        approve_profile_change() already had, and a
--                        main administrator approving their own change
--                        is now recorded under its own action name.
--
--  11. OWN ACTIONS       admin_action_log() shows an assigned admin the
--                        entries where they are the actor.
--
-- Depends on patch-2026-08-11.sql: client_ip() comes from there.
-- =====================================================================

begin;

-- =====================================================================
-- 5. A PROBE BUDGET FOR THE DUPLICATE CHECKS
-- =====================================================================
--
-- The registration form asks, while the caller is still anonymous,
-- whether a full name or an account number is already registered. It
-- has to: finding out after submitting is a worse experience, and the
-- uniqueness trigger's error is written for a developer.
--
-- The cost is that both questions answer honestly to anyone who asks.
-- An unauthenticated visitor could walk the account-number space, or a
-- list of UP staff names, and learn which are registered. Under RA 10173
-- that set is personal data about who is enrolled in a payroll system.
--
-- What is NOT the fix: revoking `anon`. That breaks the form for every
-- legitimate registrant to inconvenience an attacker who could still
-- register an account and ask as `authenticated`.
--
-- What this does instead: meter it. Forty questions per quarter-hour per
-- source address is more than any human filling in one form will ever
-- need, and useless for walking a keyspace. A signed-in caller -- the
-- Edit Account path -- skips the meter entirely; they are checking their
-- own change, and they are identified.

create table public.anon_probe_budget (
  ip           text primary key,
  window_start timestamptz not null default now(),
  probes       integer not null default 0
);

alter table public.anon_probe_budget enable row level security;

-- No policy, deliberately: nothing outside take_probe_token() has any
-- business reading or writing this. Add "anon_probe_budget" to
-- DENY_ALL_BY_DESIGN in check-drift.js or it will flag this as a policy
-- that got lost.

create or replace function public.take_probe_token()
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ip     text := public.client_ip();
  v_window interval := interval '15 minutes';
  v_cap    integer := 40;
  v_n      integer;
begin
  -- A signed-in caller is not probing. They are on Edit Account
  -- checking their own proposed change, and if they abuse it they are
  -- identifiable, which the meter cannot make an anonymous caller.
  if nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '') is not null then
    return true;
  end if;

  -- No address means no meter. Erring open would leave the control
  -- decorative; erring closed is visible immediately -- registration
  -- stops working and somebody says so. Supabase always forwards
  -- x-forwarded-for, so this branch should never be reached. If
  -- registration ever fails wholesale, check here first:
  --   select public.client_ip();   -- as anon, through PostgREST
  if v_ip is null then
    return false;
  end if;

  insert into public.anon_probe_budget (ip, window_start, probes)
  values (v_ip, now(), 1)
  on conflict (ip) do update
    set window_start = case
          when public.anon_probe_budget.window_start < now() - v_window
          then now() else public.anon_probe_budget.window_start end,
        probes = case
          when public.anon_probe_budget.window_start < now() - v_window
          then 1 else public.anon_probe_budget.probes + 1 end
  returning probes into v_n;

  return v_n <= v_cap;
end;
$function$;

-- Both functions become plpgsql and VOLATILE. They were `stable`, and a
-- stable function cannot execute the INSERT the meter needs -- Postgres
-- refuses at runtime, not at definition, so this would have looked fine
-- until the first anonymous call.
create or replace function public.account_numbers_taken(p_value text, p_email text default null::text)
 returns setof text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.take_probe_token() then
    raise exception 'Too many checks from this connection. Wait a few minutes and try again.'
      using errcode = '53400';
  end if;

  -- lower() on both sides of the self-exclusion. Everywhere else in
  -- this schema compares addresses case-insensitively; these two
  -- functions were the exception, and the exception fails in the
  -- direction that looks like a bug in the form. profiles.email is
  -- lowercased on write by normalize_profile_fields(), so a caller
  -- passing the address as the person typed it -- "J.Reyes@up.edu.ph"
  -- -- would fail to match its own row, drop out of the exclusion, and
  -- be told its own account number is already registered to someone
  -- else.
  return query
    select unnest(string_to_array(p_value, ', '))
    intersect
    select unnest(string_to_array(account_number, ', '))
    from public.profiles
    where account_number is not null
      and (p_email is null or lower(email) <> lower(p_email));
end;
$function$;

create or replace function public.full_name_taken(p_name text, p_email text default null::text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.take_probe_token() then
    raise exception 'Too many checks from this connection. Wait a few minutes and try again.'
      using errcode = '53400';
  end if;

  -- See the note in account_numbers_taken() above: lower() on both
  -- sides, so someone editing their own profile is excluded from the
  -- duplicate check no matter how they typed their own address.
  return exists (
    select 1 from public.profiles
    where upper(full_name) = upper(p_name)
      and (p_email is null or lower(email) <> lower(p_email))
  );
end;
$function$;

-- =====================================================================
-- 7. SESSION STATE IN ONE CALL
-- =====================================================================
--
-- Role and account status were read once, at page load, and never
-- again. Revoke someone's admin rights and their open tab keeps the
-- admin panels until they reload; RLS makes every write fail, so the
-- damage is cosmetic, but it surfaces as a red error rather than "your
-- access changed". Disable an account and the same tab keeps rendering.
--
-- One call, cheap enough to poll from the idle watcher that is already
-- running.

create or replace function public.my_session_state()
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
begin
  if v_email is null then
    return json_build_object('signed_in', false);
  end if;
  return json_build_object(
    'signed_in', true,
    'email', v_email,
    'approved', public.is_approved_user(),
    'disabled', public.is_disabled(),
    'is_admin', public.is_admin(),
    'is_main', public.is_main_admin());
end;
$function$;

-- =====================================================================
-- 9. SELF-APPROVAL, CONSISTENTLY
-- =====================================================================
--
-- approve_profile_change() already refused to let an administrator
-- approve their own change unless they are a main administrator.
-- approve_registration() had no such check, so an administrator whose
-- own registration was pending could approve themselves. Narrow -- an
-- admin row implies somebody already vouched for them -- but it is the
-- same check, and an inconsistent rule is one people stop trusting.
--
-- The main-administrator bypass is KEPT, in both. Removing it creates a
-- deadlock in the case that matters most: a sole main administrator
-- whose own record needs correcting and who has nobody senior to ask.
-- The trade is made visible instead of silent -- see the action name
-- change at the end of this section.

create or replace function public.approve_registration(p_email text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_row     public.profiles;
  v_actor   text := auth.jwt() ->> 'email';
  v_invite  public.admin_invites;
  v_granted boolean := false;
begin
  perform public.require_admin();
  p_email := lower(btrim(coalesce(p_email, '')));

  -- Same rule as approve_profile_change(). An administrator does not
  -- decide their own admission.
  if p_email = lower(btrim(coalesce(v_actor, ''))) and not public.is_main_admin() then
    raise exception 'You cannot approve your own registration.'
      using hint = 'Ask another administrator to review it.',
            errcode = 'insufficient_privilege';
  end if;

  update public.profiles set approval_status = 'approved', rejection_reason = null
  where email = p_email
  returning * into v_row;
  if v_row is null then raise exception 'user not found'; end if;

  insert into public.admin_actions (action, actor_email, subject_email, subject_name)
  values (
    case when p_email = lower(btrim(coalesce(v_actor, '')))
         then 'registration_approved_self'
         else 'registration_approved' end,
    v_actor, p_email, v_row.full_name);

  select * into v_invite from public.admin_invites where email = p_email;

  -- Tested on a column, not on the record. `v_invite is not null` is
  -- true only when EVERY field is non-null, and note and invited_by are
  -- routinely null — the invitation would never convert.
  if v_invite.email is not null then
    if v_invite.expires_at < now() then
      -- Left in place rather than deleted: an expired invitation is
      -- still a record that somebody meant this, and re-issuing it is
      -- one call to admin_add().
      insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
      values ('admin_invite_expired', v_actor, p_email, v_row.full_name,
              jsonb_build_object('invited_by', v_invite.invited_by,
                                 'expired_at', v_invite.expires_at));
    else
      insert into public.admins (email, note, added_by)
      values (p_email, v_invite.note, v_invite.invited_by)
      on conflict (email) do nothing;

      delete from public.admin_invites where email = p_email;
      v_granted := true;

      insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
      values ('admin_added_from_invite', v_actor, p_email, v_row.full_name,
              jsonb_build_object('invited_by', v_invite.invited_by,
                                 'invited_at', v_invite.invited_at));
    end if;
  end if;

  return json_build_object(
    'email', v_row.email,
    'full_name', v_row.full_name,
    'decision', 'approved',
    'became_admin', v_granted
  );
end;
$function$;

-- The profile-change twin. Identical to the version in section 11 apart
-- from the action name: a main administrator approving their own change
-- is logged as 'change_approved_self', so the bypass is a line somebody
-- can search for rather than an absence nobody notices.
create or replace function public.approve_profile_change(p_request_id uuid, p_verification jsonb default null::jsonb)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_req    public.profile_change_requests;
  v_name   text;
  v_acct   text;
  v_by     text := auth.jwt() ->> 'email';
  v_self   boolean;
  v_acct_changed boolean;
  v_method text;
  v_ref    text;
  v_clash  text;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;

  select * into v_req from public.profile_change_requests
  where id = p_request_id and status = 'pending'
  for update;
  if v_req is null then raise exception 'request not found or already decided'; end if;

  v_self := lower(btrim(coalesce(v_req.user_email, ''))) = lower(btrim(coalesce(v_by, '')));

  if v_self and not public.is_main_admin() then
    raise exception 'You cannot approve your own profile change.'
      using hint = 'Ask another administrator to review it.',
            errcode = 'insufficient_privilege';
  end if;

  v_name := coalesce(v_req.requested_full_name, v_req.current_full_name);
  v_acct := coalesce(v_req.requested_account_number, v_req.current_account_number);

  v_acct_changed := public.normalize_account_numbers(coalesce(v_acct, ''))
                 is distinct from
                    public.normalize_account_numbers(coalesce(v_req.current_account_number, ''));

  if v_acct_changed then
    v_method := nullif(btrim(coalesce(p_verification ->> 'method', '')), '');
    v_ref    := nullif(btrim(coalesce(p_verification ->> 'reference', '')), '');

    if v_method is null then
      raise exception 'Changing an LBP account number needs a recorded verification method.'
        using hint = 'Confirm the number against a bank document, payroll record, '
                     'presented ID, or a callback to a number you already hold -- '
                     'then record which.',
              errcode = 'insufficient_privilege';
    end if;

    if v_method not in ('bank_document', 'hr_payroll_record', 'in_person_id', 'phone_callback') then
      raise exception 'Unknown verification method: %', v_method
        using errcode = 'invalid_parameter_value';
    end if;

    if v_ref is null or length(v_ref) < 3 then
      raise exception 'Record what you checked against -- a document reference, '
                      'payroll period, ID type and number, or who you spoke to and when.'
        using errcode = 'invalid_parameter_value';
    end if;

    select n into v_clash
      from unnest(public.split_account_numbers(v_acct)) as n
     where exists (
       select 1 from public.profiles p
        where lower(p.email) <> lower(v_req.user_email)
          and n = any (public.split_account_numbers(p.account_number)))
     limit 1;
    if v_clash is not null then
      raise exception 'Account number % is already registered to somebody else.', v_clash
        using hint = 'Two people cannot be paid into the same number through this portal. '
                     'Resolve it with the Cash Office before approving.',
              errcode = 'unique_violation';
    end if;
  end if;

  update public.profiles set full_name = v_name, account_number = v_acct
  where lower(email) = lower(v_req.user_email);

  update public.profile_change_requests
  set status = 'approved',
      decided_at = now(),  decided_by = v_by,
      reviewed_at = now(), reviewed_by = v_by
  where id = p_request_id;

  insert into public.admin_actions (action, actor_email, subject_email, subject_name, detail)
  values (case when v_self then 'change_approved_self' else 'change_approved' end,
          v_by, v_req.user_email, v_name,
          json_build_object(
            'request_id', p_request_id,
            'from', json_build_object('full_name', v_req.current_full_name, 'account_number', v_req.current_account_number),
            'to',   json_build_object('full_name', v_name, 'account_number', v_acct),
            'account_number_changed', v_acct_changed,
            'self_approved', v_self,
            'verification', case when v_acct_changed
                                 then jsonb_build_object('method', v_method, 'reference', v_ref)
                                 else null end
          )::jsonb);

  perform public.log_account_event(v_req.user_email, 'profile_change_approved',
            jsonb_build_object('request_id', p_request_id, 'decided_by', v_by));

  if v_acct_changed then
    perform public.log_account_event(v_req.user_email, 'account_number_changed',
              jsonb_build_object(
                'from', v_req.current_account_number,
                'to', v_acct,
                'decided_by', v_by,
                'verification_method', v_method));
  end if;

  return json_build_object('email', v_req.user_email, 'full_name', v_name,
                           'account_number', v_acct, 'decision', 'approved',
                           'account_number_changed', v_acct_changed);
end;
$function$;

-- =====================================================================
-- 11. AN ADMINISTRATOR CAN READ THEIR OWN ENTRIES
-- =====================================================================
--
-- The log was main-administrator only, which meant the people whose
-- work it records could not read it. An assigned admin asked "did I
-- approve that, and when" had no way to answer.
--
-- Widened by exactly one clause: an assigned administrator sees rows
-- where THEY are the actor. Not rows about them as subject -- being
-- disabled or removed is somebody else's decision, and showing it here
-- would leak who made it.

create or replace function public.admin_action_log(p_query text default ''::text, p_limit integer default 200)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  q      text := btrim(coalesce(p_query, ''));
  digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  cap    int  := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_me   text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_all  boolean;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can view the action log.';
  end if;
  v_all := public.is_main_admin();

  return coalesce((
    select jsonb_agg(row_to_json(entry)::jsonb order by entry.at desc)
      from (
        select l.id, l.at, l.actor_email, l.action,
               l.subject_email, l.subject_name, l.account_number, l.detail
          from public.admin_actions l
         where (v_all or lower(coalesce(l.actor_email, '')) = v_me)
           and (
             q = ''
             or l.actor_email ilike '%' || q || '%'
             or l.subject_email ilike '%' || q || '%'
             or l.subject_name ilike '%' || q || '%'
             or l.action ilike '%' || q || '%'
             or (
               digits <> '' and
               regexp_replace(coalesce(l.account_number, ''), '\D', '', 'g') like '%' || digits || '%'
             )
           )
         order by l.at desc
         limit cap
      ) entry
  ), '[]'::jsonb);
end;
$function$;

-- =====================================================================
-- GRANTS
-- =====================================================================

revoke execute on function public.take_probe_token() from public;
revoke execute on function public.my_session_state() from public;

-- take_probe_token() stays ungranted: it is internal to the two
-- functions above. A client that could call it directly could drain its
-- own budget, which is harmless, or -- more to the point -- there is no
-- reason for it to.

grant execute on function public.my_session_state() to authenticated;

-- account_numbers_taken / full_name_taken keep their existing
-- anon+authenticated grants. The change is what they do before
-- answering, not who may ask.

commit;

-- =====================================================================
-- VERIFICATION
-- =====================================================================
--
-- 1. THE METER LETS A REAL REGISTRANT THROUGH. Open the registration
--    form signed out, type a name and an account number. Both checks
--    should behave exactly as before. Then:
--
--      select ip, probes, window_start from public.anon_probe_budget
--       order by window_start desc limit 5;
--
--    A row for your address with a small probe count. NO ROW AT ALL
--    means client_ip() returned null and every anonymous check is being
--    refused -- see the note in take_probe_token().
--
-- 2. THE METER BITES. From the browser console, signed out:
--
--      for (let i = 0; i < 45; i++) {
--        await supabaseClient.rpc("full_name_taken", { p_name: "Probe " + i });
--      }
--
--    The last few should return an error, not a boolean.
--
-- 3. SELF-APPROVAL IS REFUSED. As a non-main administrator with your own
--    registration pending:
--
--      select public.approve_registration('<your own address>');
--      -- expected: "You cannot approve your own registration."
--
-- 4. AN ASSIGNED ADMIN SEES THEIR OWN ENTRIES. Signed in as one:
--
--      select jsonb_array_length(public.admin_action_log('', 50));
--      -- expected: a number, not "Only a main administrator..."
--      -- and every actor_email in the result is your own address.
--
-- 5. UPDATE check-drift.js:
--      - add "anon_probe_budget" to DENY_ALL_BY_DESIGN
--      - re-run `node check-drift.js` and set the reported counts
-- =====================================================================

-- =====================================================================
-- SECTION 13 - PATCH 2026-08-11c (folded in from patch-2026-08-11c.sql)
-- Retention for the three tables added by patches A and B.
--
-- Until now purge_expired_records() had never heard of account_events,
-- statements_issued or anon_probe_budget. The weekly cron ran, deleted
-- what it knew about, and silently skipped all three. They grow forever.
--
-- ---------------------------------------------------------------------
-- THREE TABLES, THREE WINDOWS — and why not one
-- ---------------------------------------------------------------------
--
-- The temptation is to sweep all three at p_days (5 years) and be done.
-- That would be wrong in both directions at once.
--
-- 1. anon_probe_budget — ONE DAY, and not negotiable by p_days.
--
--    This is operational state with a fifteen-minute window. A row older
--    than a day is dead weight. It is also a table of IP ADDRESSES,
--    which are personal data under RA 10173, collected for a rate limit
--    and for nothing else. Keeping them five years to meter a form would
--    be indefensible if anyone asked, and someone eventually asks.
--
--    Fixed interval, deliberately not exposed as a parameter: there is
--    no legitimate reason to retain these longer, so there is no reason
--    to offer the option.
--
-- 2. account_events — SPLIT, because it holds two different things.
--
--    Session noise (sign_in, sign_in_new_device, data_exported,
--    statement_issued) answers "was that me last Tuesday". Its value
--    collapses after a few months; nobody audits a sign-in from 2029.
--    It also carries an IP and a user agent on every row. One year.
--
--    Account history (password_changed, email_changed, the
--    profile_change_* family, account_number_changed, access_disabled,
--    access_restored) is the user-facing twin of admin_actions. Purging
--    it on a different clock would leave the staff record of an account
--    number change intact while the payee's own copy vanished -- the
--    asymmetry the two-log design exists to avoid. Same window as
--    admin_actions.
--
-- 3. statements_issued — SAME AS admin_actions, and it is the one to
--    think hardest about.
--
--    Purging a reference does not free space worth having; the table
--    gains one small row per export. What it does is make
--    verify_statement() answer "not found" for a statement that was
--    genuinely issued -- and that answer is deliberately identical to
--    the one a forged reference gets. Somebody arriving at the counter
--    with a real printout would be told, in effect, that it is fake.
--
--    So it tracks the audit window rather than getting its own. If the
--    UDPO wants it shorter, that is a decision to take knowingly, with
--    the counter staff told what a stale reference will look like.
--
-- ---------------------------------------------------------------------
-- SIGNATURE CHANGE
-- ---------------------------------------------------------------------
--
-- The old one-argument function is DROPPED before the new one is
-- created. `create or replace` would not have replaced it -- a
-- different argument count is an overload, not a replacement -- and the
-- cron job's `purge_expired_records(1825)` would then match both the
-- old function exactly and the new one through its default, which is an
-- ambiguity error. The job would fail every Sunday, quietly.
--
-- After this runs, `purge_expired_records(1825)` resolves to the new
-- function and the existing cron entry needs no edit.
-- =====================================================================

begin;

drop function if exists public.purge_expired_records(integer);

create or replace function public.purge_expired_records(
  p_days integer default 1825,
  p_event_days integer default 365)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_cutoff       timestamptz;
  v_event_cutoff timestamptz;
  v_actions      integer;
  v_requests     integer;
  v_stale        integer;
  v_ev_session   integer;
  v_ev_account   integer;
  v_statements   integer;
  v_probes       integer;
begin
  -- Unchanged: a main administrator, or pg_cron, which arrives with no
  -- JWT at all.
  if not (public.is_main_admin() or auth.jwt() is null) then
    raise exception 'not authorized';
  end if;
  if p_days is null or p_days < 1 then
    raise exception 'retention window must be at least 1 day';
  end if;
  if p_event_days is null or p_event_days < 1 then
    raise exception 'event retention window must be at least 1 day';
  end if;
  -- Session events must not outlive the audit window; a shorter main
  -- window with a longer event window would be a mistake nobody would
  -- notice for years.
  if p_event_days > p_days then
    raise exception 'event retention (% days) cannot exceed the audit window (% days)',
      p_event_days, p_days;
  end if;

  v_cutoff       := now() - make_interval(days => p_days);
  v_event_cutoff := now() - make_interval(days => p_event_days);

  delete from public.admin_actions where at < v_cutoff;
  get diagnostics v_actions = row_count;

  delete from public.profile_change_requests
  where status <> 'pending' and decided_at is not null and decided_at < v_cutoff;
  get diagnostics v_requests = row_count;

  -- Session noise. Short window, carries IP and user agent.
  delete from public.account_events
  where at < v_event_cutoff
    and kind in ('sign_in', 'sign_in_new_device', 'data_exported', 'statement_issued');
  get diagnostics v_ev_session = row_count;

  -- Account history. Tracks admin_actions, for the reason in the header.
  delete from public.account_events
  where at < v_cutoff
    and kind not in ('sign_in', 'sign_in_new_device', 'data_exported', 'statement_issued');
  get diagnostics v_ev_account = row_count;

  delete from public.statements_issued where issued_at < v_cutoff;
  get diagnostics v_statements = row_count;

  -- Rate-limit state. One day, fixed.
  delete from public.anon_probe_budget where window_start < now() - interval '1 day';
  get diagnostics v_probes = row_count;

  -- Still counted, never deleted. A rejected registration is somebody's
  -- decision to revisit, not a row to sweep.
  select count(*) into v_stale
  from public.profiles
  where approval_status = 'rejected' and created_at < v_cutoff;

  return json_build_object(
    'cutoff',                           v_cutoff,
    'event_cutoff',                     v_event_cutoff,
    'admin_actions_deleted',            v_actions,
    'change_requests_deleted',          v_requests,
    'account_events_session_deleted',   v_ev_session,
    'account_events_account_deleted',   v_ev_account,
    'statements_deleted',               v_statements,
    'probe_budget_deleted',             v_probes,
    'rejected_profiles_pending_review', v_stale
  );
end;
$function$;

revoke execute on function public.purge_expired_records(integer, integer) from public;
grant execute on function public.purge_expired_records(integer, integer) to authenticated;

commit;

-- =====================================================================
-- VERIFICATION
-- =====================================================================
--
-- 1. ONE FUNCTION, NOT TWO. An overload left behind makes the cron job
--    fail with an ambiguity error every Sunday, and nothing surfaces it.
--
--      select proname, pg_get_function_identity_arguments(oid)
--        from pg_proc
--       where pronamespace = 'public'::regnamespace
--         and proname = 'purge_expired_records';
--      -- expected: exactly ONE row, "p_days integer, p_event_days integer"
--
-- 2. THE CRON JOB STILL RESOLVES.
--
--      select jobname, schedule, command from cron.job;
--      -- command is still: select public.purge_expired_records(1825)
--
-- 3. DRY RUN. Nothing here is old enough to delete yet, so every count
--    should be zero -- which proves it runs without proving it works.
--
--      select public.purge_expired_records(1825);
--
-- 4. IT ACTUALLY DELETES. On a TEST database only:
--
--      insert into public.account_events (user_email, kind, at)
--      values ('retention.test@up.edu.ph', 'sign_in', now() - interval '400 days'),
--             ('retention.test@up.edu.ph', 'account_number_changed', now() - interval '400 days');
--
--      select public.purge_expired_records(1825);
--      -- expected: account_events_session_deleted = 1
--      --           account_events_account_deleted = 0
--      -- the sign-in goes at one year; the account change stays for five.
--
--      delete from public.account_events where user_email = 'retention.test@up.edu.ph';
--
-- 5. UPDATE check-drift.js — the function count is unchanged (a
--    replacement, not an addition), so `node check-drift.js` should pass
--    with no edits. If it does not, the drop in this patch did not take.
-- =====================================================================

-- =====================================================================
-- SECTION 14 - PATCH 2026-08-11d (folded in from patch-2026-08-11d.sql)
-- MFA for administrators. Enforcement ships OFF.
--
-- ---------------------------------------------------------------------
-- READ THIS BEFORE RUNNING. THE ORDER IS THE WHOLE POINT.
-- ---------------------------------------------------------------------
--
-- Right now this project has TWO administrators, BOTH main, and ZERO
-- enrolled MFA factors. Turning on enforcement in that state removes
-- administrator rights from every administrator simultaneously, with
-- nobody left who can grant them back through the portal.
--
-- So enforcement ships OFF. `admin_mfa_required()` returns false until
-- somebody deliberately flips it, which is one `create or replace` and
-- is written out at the bottom of this file.
--
-- The rollout is:
--
--   1. Run this patch.                    (nothing changes yet)
--   2. Deploy the client with the         (admins can now enrol)
--      enrolment and challenge UI.
--   3. BOTH administrators enrol and      (verify in the query below)
--      confirm they can sign in with
--      a code.
--   4. Flip admin_mfa_required() to true. (enforcement begins)
--
-- ---------------------------------------------------------------------
-- WHY THIS IS RECOVERABLE, AND WHERE IT IS NOT
-- ---------------------------------------------------------------------
--
-- Enrolling a factor does NOT require being an administrator — any
-- signed-in user can do it. So an administrator locked out by step 4
-- can still sign in at aal1, go to Edit Account, enrol, and get their
-- rights back without anyone's help. That is the safety net, and it is
-- why enforcement is survivable at all.
--
-- What is NOT recoverable through the portal: an administrator who
-- enrolled and then LOST the device. Supabase TOTP has no backup codes.
-- Someone with SQL access must delete the factor. That procedure is at
-- the bottom of this file. Print it, or put it somewhere that does not
-- require signing in to reach.
--
-- ---------------------------------------------------------------------
-- WHAT AAL2 ACTUALLY MEANS HERE
-- ---------------------------------------------------------------------
--
-- Supabase puts an `aal` claim in the access token: aal1 for a password
-- or OAuth sign-in, aal2 once a TOTP code has been verified in that
-- session. Testing the claim inside is_admin() means every admin RPC
-- and every admin RLS policy inherits the requirement at once, with no
-- client change and nothing to forget.
--
-- Note what it does NOT do: an administrator at aal1 is treated as an
-- ordinary approved user, not as a blocked one. They still see their
-- own statement, they still reach Edit Account, they simply have no
-- administrative powers. That is deliberate -- it is what makes step 4
-- survivable, and it is the difference between "you must re-verify"
-- and "you are locked out".
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. THE SWITCH
-- ---------------------------------------------------------------------
--
-- Same shape as up_mail_restriction_enabled(): a function returning a
-- constant, flipped with `create or replace`. No settings table, no
-- cache, nothing to get out of step -- and, importantly, it can be
-- turned off from the SQL editor in one statement when something has
-- gone wrong and the portal is not available to fix it from.

create or replace function public.admin_mfa_required()
 returns boolean
 language sql
 immutable
 set search_path to 'public'
as $function$ select false; $function$;

comment on function public.admin_mfa_required() is
  'Whether administrator powers require a second factor (aal2). Ships false. '
  'Do not turn on until every administrator has a verified factor -- check with '
  'the query in patch-2026-08-11d.sql. To turn off in an emergency: '
  'create or replace function public.admin_mfa_required() returns boolean '
  'language sql immutable set search_path to ''public'' as $$ select false; $$;';

-- ---------------------------------------------------------------------
-- 2. THE GUARD
-- ---------------------------------------------------------------------
--
-- Both functions, not just is_admin(). is_main_admin() does not call
-- is_admin() -- it runs its own query -- so guarding only one would
-- leave every main-admin-only RPC (admin_action_log, admin_remove,
-- purge_expired_records) reachable at aal1. That is the hole this
-- section exists to not have.

create or replace function public.is_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
           select 1 from public.admins a
            where a.user_id = auth.uid()
               or lower(a.email) = lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''))
         )
     and not public.is_disabled()
     -- Absent claim reads as aal1: a token without the claim is not
     -- evidence of a second factor.
     and (not public.admin_mfa_required()
          or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2');
$function$;

create or replace function public.is_main_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
           select 1 from public.admins a
            where a.is_main
              and (a.user_id = auth.uid()
                or lower(a.email) = lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '')))
         )
     and not public.is_disabled()
     and (not public.admin_mfa_required()
          or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2');
$function$;

-- ---------------------------------------------------------------------
-- 3. TELLING THE CLIENT WHERE IT STANDS
-- ---------------------------------------------------------------------
--
-- The client needs to distinguish three states that otherwise look
-- identical: "not an administrator", "an administrator who has not
-- enrolled", and "an administrator who has enrolled but has not entered
-- a code this session". Only the last two are fixable by the person
-- sitting there, and they need different instructions.
--
-- admins_without_mfa is deliberately visible to any administrator, not
-- just main ones: before flipping the switch, whoever does it needs to
-- know they are not about to strand a colleague.

create or replace function public.my_mfa_state()
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_verified int := 0;
  v_pending  int := 0;
begin
  if v_uid is null then
    return json_build_object('signed_in', false);
  end if;

  select count(*) filter (where status = 'verified'),
         count(*) filter (where status <> 'verified')
    into v_verified, v_pending
    from auth.mfa_factors f
   where f.user_id = v_uid;

  return json_build_object(
    'signed_in', true,
    'enrolled', v_verified > 0,
    'verified_factors', v_verified,
    -- Unverified factors are abandoned enrolments. They accumulate
    -- silently every time somebody opens the QR screen and walks away,
    -- and they are worth surfacing so the list can be cleaned up.
    'pending_factors', v_pending,
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'required_for_admins', public.admin_mfa_required(),
    'is_admin_row', exists (
      select 1 from public.admins a
       where a.user_id = v_uid
          or lower(a.email) = lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''))),
    'admins_without_mfa', (
      select count(*) from public.admins a
       join auth.users u on (u.id = a.user_id or lower(u.email) = lower(a.email))
      where not exists (
        select 1 from auth.mfa_factors f
         where f.user_id = u.id and f.status = 'verified'))
  );
end;
$function$;

-- my_session_state() gains the same three facts, so the heartbeat can
-- notice a factor being added or removed mid-session without a second
-- round trip.
--
-- `is_admin_row` is the raw table membership, ignoring aal. The client
-- needs it to tell "you are not an administrator" from "you are one but
-- have not verified" -- is_admin alone cannot distinguish those, and
-- showing the wrong message is how somebody concludes their access was
-- revoked when they just need to enter a code.
create or replace function public.my_session_state()
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
begin
  if v_email is null then
    return json_build_object('signed_in', false);
  end if;
  return json_build_object(
    'signed_in', true,
    'email', v_email,
    'approved', public.is_approved_user(),
    'disabled', public.is_disabled(),
    'is_admin', public.is_admin(),
    'is_main', public.is_main_admin(),
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'mfa_required', public.admin_mfa_required(),
    'is_admin_row', exists (
      select 1 from public.admins a
       where a.user_id = auth.uid()
          or lower(a.email) = lower(v_email)));
end;
$function$;

-- ---------------------------------------------------------------------
-- 4. ENROLMENT BELONGS IN THE ACCOUNT HOLDER'S OWN HISTORY
-- ---------------------------------------------------------------------
--
-- Adding or removing a second factor is exactly the kind of change
-- account_events exists to show the owner. Somebody who did not do it
-- needs to see it, and a factor REMOVED by an attacker is a stronger
-- signal than most things already on that list.

alter table public.account_events drop constraint if exists account_events_kind_check;
alter table public.account_events add constraint account_events_kind_check
  check (kind = any (array[
    'sign_in',
    'sign_in_new_device',
    'password_changed',
    'email_changed',
    'profile_change_requested',
    'profile_change_withdrawn',
    'profile_change_approved',
    'profile_change_rejected',
    'account_number_changed',
    'data_exported',
    'statement_issued',
    'access_disabled',
    'access_restored',
    'mfa_enrolled',
    'mfa_removed'
  ]));

-- record_account_event() gains the two new kinds. Still only the ones a
-- browser legitimately knows it just did; everything else stays
-- server-written.
create or replace function public.record_account_event(p_kind text, p_detail jsonb default null::jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
  v_ip    text := public.client_ip();
  v_ua    text := public.client_user_agent();
  v_seen  boolean;
begin
  if v_email is null then return; end if;

  if p_kind not in ('sign_in', 'password_changed', 'data_exported',
                    'mfa_enrolled', 'mfa_removed') then
    raise exception 'record_account_event: % is recorded by the server, not the client', p_kind
      using errcode = 'insufficient_privilege';
  end if;

  if p_kind = 'sign_in' then
    select exists (
      select 1 from public.account_events e
       where lower(e.user_email) = lower(v_email)
         and e.kind = 'sign_in'
         and e.at > now() - interval '2 minutes'
    ) into v_seen;
    if v_seen then return; end if;

    select not exists (
      select 1 from public.account_events e
       where lower(e.user_email) = lower(v_email)
         and e.kind in ('sign_in', 'sign_in_new_device')
         and e.at > now() - interval '90 days'
         and coalesce(e.ip, '') = coalesce(v_ip, '')
         and coalesce(e.user_agent, '') = coalesce(v_ua, '')
    ) into v_seen;
    if v_seen then p_kind := 'sign_in_new_device'; end if;
  end if;

  insert into public.account_events (user_email, user_id, kind, ip, user_agent, detail)
  values (v_email, auth.uid(), p_kind, v_ip, v_ua,
          case when jsonb_typeof(p_detail) = 'object' then p_detail else null end);
end;
$function$;

-- ---------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------

revoke execute on function public.my_mfa_state() from public;
grant execute on function public.my_mfa_state() to authenticated;

-- admin_mfa_required() keeps the default PUBLIC grant, like
-- up_mail_restriction_enabled(). It is a constant and reveals nothing:
-- whether the portal requires MFA is not a secret, and the registration
-- page reads it while still anon.

commit;

-- =====================================================================
-- STEP 4 — TURNING IT ON. NOT PART OF THIS PATCH.
-- =====================================================================
--
-- FIRST, check nobody gets stranded. Every administrator must appear
-- with verified_factors >= 1:
--
--   select a.email,
--          coalesce(a.is_main, false) as is_main,
--          count(f.id) filter (where f.status = 'verified') as verified_factors
--     from public.admins a
--     join auth.users u on (u.id = a.user_id or lower(u.email) = lower(a.email))
--     left join auth.mfa_factors f on f.user_id = u.id
--    group by a.email, a.is_main
--    order by verified_factors, a.email;
--
-- A zero in that column is an administrator who will lose their powers
-- the moment you run the next statement. They can get them back by
-- enrolling, but they will not know that unless somebody tells them.
-- Tell them first.
--
-- THEN:
--
--   create or replace function public.admin_mfa_required()
--    returns boolean language sql immutable set search_path to 'public'
--   as $$ select true; $$;
--
-- Existing sessions are unaffected until their token refreshes, so give
-- it an hour before concluding it did not work.
--
-- =====================================================================
-- BREAK GLASS
-- =====================================================================
--
-- Keep this somewhere reachable WITHOUT signing in to the portal. A
-- procedure that lives only inside the thing it recovers is not a
-- procedure.
--
-- A) TURN ENFORCEMENT OFF. The blunt instrument. Restores every
--    administrator immediately, at the cost of the control.
--
--      create or replace function public.admin_mfa_required()
--       returns boolean language sql immutable set search_path to 'public'
--      as $$ select false; $$;
--
-- B) ONE PERSON LOST THEIR DEVICE. Delete their factor; they re-enrol
--    on the next sign-in. Preferred over (A) -- it does not weaken the
--    control for everyone else.
--
--      delete from auth.mfa_factors
--       where user_id = (select id from auth.users
--                         where lower(email) = lower('someone@up.edu.ph'));
--
--    Verify the person's identity by some means OTHER than email before
--    doing this. Whoever controls the mailbox can already reset the
--    password; if deleting the factor is also an email-only request,
--    the second factor was never a second factor.
--
--    Record it. There is no automatic audit line for a direct table
--    delete:
--
--      insert into public.admin_actions (action, actor_email, subject_email, detail)
--      values ('mfa_factor_reset_manual', 'you@up.edu.ph', 'someone@up.edu.ph',
--              jsonb_build_object('reason', 'lost phone', 'verified_by', 'in person, ID shown'));
--
-- C) CLEAR ABANDONED ENROLMENTS. Harmless housekeeping -- unverified
--    rows are half-finished enrolments, not working factors.
--
--      delete from auth.mfa_factors where status <> 'verified';
--
-- =====================================================================
-- VERIFICATION FOR THIS PATCH
-- =====================================================================
--
-- 1. NOTHING CHANGED YET.
--
--      select public.admin_mfa_required();   -- false
--      select public.is_admin();             -- as before, signed in as an admin
--
-- 2. THE NEW STATE FUNCTION ANSWERS. Signed in, from the browser console:
--
--      await supabaseClient.rpc("my_mfa_state")
--      -- { enrolled: false, verified_factors: 0, aal: "aal1",
--      --   required_for_admins: false, is_admin_row: true,
--      --   admins_without_mfa: 2 }
--
-- 3. THE NEW EVENT KINDS ARE ACCEPTED.
--
--      select conname from pg_constraint
--       where conrelid = 'public.account_events'::regclass
--         and conname = 'account_events_kind_check';
--
-- 4. check-drift.js: this patch adds ONE function (my_mfa_state) and
--    replaces five. Re-run it and set the reported count.
-- =====================================================================

-- =====================================================================
-- END OF DEPLOY SCHEMA
-- =====================================================================
