-- =====================================================================
-- patch-2026-08-11d.sql — MFA for administrators (database half)
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
