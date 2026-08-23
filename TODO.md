# TODO — UPSCOIWS

Standing list of what is left. Last updated 11 August 2026.

Everything below is either **not started** or **built but not deployed**. Work
that is finished and verified is in the change log sections of `README.md`, not
here.

---

## Right now

### 1. Deploy `repo/` to git and Vercel

The only thing standing between the current site and four finished fixes.

| Item | What it does |
|---|---|
| 3 | `?returnTo=` — a bookmarked `soa.html` lands on the statement after sign-in, not the dashboard |
| 4 | `waitForSession()` replaces two polling loops that guessed at SDK timing |
| 6 | 8-hour absolute session cap, plus a "this is a shared computer" checkbox |
| 8 | Dashboard tells an administrator when the access check *failed*, instead of silently hiding the admin tools |
| 7 | **half-live** — `my_session_state()` is in the database, nothing calls it until this deploys |

The SRI hashes are in these files too. Until this goes out, the live site still
serves bare `<script>` tags.

**After deploying, four checks:**

- [ ] Signed out, open `soa.html` directly → sign-in with `?returnTo=soa.html`,
      then the statement (not the dashboard)
- [ ] Tick "shared computer", sign in, close the browser fully, reopen → signed out
- [ ] Run one export from `soa.html` → proves the SheetJS SRI hash. This is the
      only way to test it: a blocked script there fails at click time with
      `XLSX is not defined`, not on page load
- [ ] Dashboard still shows admin tools for an administrator

### 2. ~~Prove the probe budget works~~ — DONE 11 Aug 2026

Confirmed live. `client_ip()` resolved a real address (`180.190.110.245`) and a
single form fill counted 4 probes. Anonymous registration is not broken and the
meter is doing its job.

Two things learned, neither urgent:

- **4 probes per form fill**, not 1 — the name and account-number checks each
  spend one per triggered check. So the real budget is roughly ten form-fills per
  address per 15 minutes, not forty. Ample for a person, useless for walking a
  keyspace, which is the balance intended. Revisit only if the Cash Office ever
  registers people in bulk from one office IP.
- **This table holds real IP addresses.** Retention purges rows older than a day,
  but the cron runs weekly, so in practice they sit up to seven days. Fine — and
  far better than the five-year default it would otherwise have inherited — but
  `anon_probe_budget` now belongs on any list of personal data the portal stores
  if the UDPO asks.

---

## Deferred by choice

### AI assistant — no provider key

`ai-assistant` v2 is deployed and the rate limiter is **confirmed working**
(`ai_assistant_usage` recorded real calls). What is missing is
`ANTHROPIC_API_KEY`, so the function returns 503 and the panel shows its
fallback line — exactly the behaviour before any of this work.

To finish later: [platform.claude.com](https://platform.claude.com) → billing
(min $5) → Settings → API keys → Create Key. Then in Supabase → Project Settings
→ Edge Functions → Secrets:

```
ANTHROPIC_API_KEY   sk-ant-...
APP_ORIGIN          https://upscoiws.vercel.app
```

No redeploy needed; secrets are read at runtime.

> Consider `AI_MODEL=claude-haiku-4-5-20251001`. This assistant answers "how do I
> change my account number" — it does not need Sonnet, and Haiku is far cheaper.
> If it still 503s after the key is set, an unavailable model ID returns a 404
> that looks identical, so set the model explicitly to isolate it.

**Whose card?** This bills to whoever owns the account. If it is university
infrastructure it should sit under a department account with a spending limit,
not a personal card.

---

## Security — not started

### MFA for administrators — BUILT, ENFORCEMENT OFF

The database and client are done and deployed to the schema.
`admin_mfa_required()` returns **false**, so nothing is enforced yet.

**Do not flip the switch until both administrators have enrolled.** There are
currently two admins, both main, and turning it on with zero factors removes
administrator rights from everyone at once.

It is survivable — enrolling does not require being an admin, so a locked-out
administrator can sign in at aal1, go to Edit Account and enrol themselves back
in. But nobody will guess that unprompted.

**Rollout:**

- [ ] Deploy the client (Edit Account gains a "Two-step verification" panel;
      sign-in gains a code prompt)
- [ ] `jyabrajano@up.edu.ph` enrols and confirms sign-in with a code
- [ ] `upcashoffice@up.edu.ph` enrols and confirms sign-in with a code
- [ ] Check nobody is stranded:

```sql
select a.email,
       coalesce(a.is_main,false) as is_main,
       count(f.id) filter (where f.status='verified') as verified_factors
  from public.admins a
  join auth.users u on (u.id = a.user_id or lower(u.email) = lower(a.email))
  left join auth.mfa_factors f on f.user_id = u.id
 group by a.email, a.is_main
 order by verified_factors, a.email;
```

- [ ] Flip it on:

```sql
create or replace function public.admin_mfa_required()
 returns boolean language sql immutable set search_path to 'public'
as $$ select true; $$;
```

- [ ] Confirm admin tools still work after signing in **with** a code, and are
      absent after signing in without one

**No backup codes.** Supabase TOTP does not have them. A lost device is
recovered by someone with SQL access deleting the factor — the procedure is in
the BREAK GLASS section of `patch-2026-08-11d.sql`. **Keep that somewhere
reachable without signing in to the portal.** A recovery procedure that lives
only inside the thing it recovers is not a procedure.

> Verify identity by some means **other than email** before deleting anyone's
> factor. Whoever controls the mailbox can already reset the password; if the
> factor can also be removed by an email request, it was never a second factor.

Later, when there are more than two admins, an admin-initiated reset (a
service-role Edge Function, same shape as `admin-delete-user`) would beat SQL
break-glass. Not worth it for two people.

### UP Mail restriction only fires at signup

`handle_new_user()` raises `up_mail_required` on insert into `auth.users`. The
`hd: "up.edu.ph"` parameter on the Google button is a hint Google honours, not a
control an attacker is bound by.

So the domain is checked when an account is **created**, never when it is
**used**. Any account predating the restriction — or created while
`up_mail_restriction_enabled()` was off — signs in forever.

Fix: move the test into `is_approved_user()`, or a *before-user-created* auth
hook.

### No alert on an unrecognised-device sign-in

`account_events` records `sign_in_new_device` and Edit Account displays it.
Nothing pushes it to the person, so it only helps somebody who goes looking.

Needs a fourth Edge Function. Note `notify-approval` already exists and is
deployed — its source is just not in the archive (see below).

### `PRIOR_ACCESS_TOKEN` is fragile

`page-reset-password.js` regex-scans `localStorage` for `/^sb-.*-auth-token$/` to
decide whether a session came from *this* recovery link. It breaks silently if
supabase-js renames that key.

Left alone deliberately — rewriting it means touching password recovery, which is
not something to fold into a batch of other work. Its own change, its own test.

### Main-admin break-glass procedure

Two main admins exist, so the lockout risk is closed. What is missing is the
written procedure: what to do if both accounts are lost, who has SQL editor
access, and how a new main admin gets promoted. There is still no promote-to-main
UI.

---

## Housekeeping

### `notify-approval/index.ts` is not in the archive

The function is **deployed and ACTIVE** on the project, but its source was never
in the working set. A rebuild from `deploy-schema.sql` plus this repo would
produce a portal with no approval emails and nothing to say why.

Retrieve it from wherever it lives and put it in
`supabase/functions/notify-approval/index.ts`.

### No `sri-lock.json`

The eight integrity hashes were computed by hand in PowerShell, so there is no
lockfile. The pages are protected; what is missing is the tripwire that catches a
**future** silent change at jsdelivr or sheetjs.

Install Node, then `node sync-sri.js` — it verifies the existing hashes and
writes the lockfile in seconds. Installing Node also unblocks `check-drift.js`
and `sync-csp.js`, which is the whole pre-push chain.

### Backup project is behind

`gtovoxodozpgjspfllvz` is now **four patches** behind production:

- `patch-2026-08-11.sql` — paging, statements, account events, verified changes
- `patch-2026-08-11b.sql` — probe budget, session state, self-approval, own-actions log
- `patch-2026-08-11c.sql` — retention
- the `extensions.digest` fix

Plus what it was already missing before any of this: columns on
`news`/`calendar_events`, the `news-images` bucket and policies, `rls_auto_enable`,
the `ensure_rls` event trigger, and no Edge Functions at all.

A backup running a different schema is not a backup. Either bring it to parity or
write down that it is a data snapshot only and cannot be failed over to.

---

## Before real payroll data lands

The database is a test project today. These become live concerns the moment it
is not.

- [ ] **Rows with no email are invisible to their owner.** Under the dual-proof
      rule a transaction with a blank email matches nobody — no error, no
      warning, the statement is just short. The import style (truncate then
      insert, emails cleaned beforehand) handles this upstream, but the control
      lives in a person's habits rather than the system. Worth one line in any
      handover doc: *emails must be populated before upload; rows without them
      are invisible to the payee.*

- [ ] **Post-import sanity check**, thirty seconds, worth doing every time:

```sql
select count(*) as rows_loaded,
       to_char(sum(amount),'FM999,999,999,990.00') as total_loaded,
       count(*) filter (where nullif(btrim(coalesce(email,'')),'') is null) as invisible_rows
  from public.transactions;
```

Compare the first two against the source file. Truncate-then-insert makes the
whole table the batch, so this is exact. It catches a load that succeeded
cleanly but landed short — a skipped row, a CSV field split on an embedded
comma, an encoding failure. That failure looks identical to success otherwise.

- [ ] **Retention windows are set but have never fired on real data.** Session
      events purge at 1 year, account history and statements at 5, probe budget
      at 1 day. The cron runs Sundays 18:30 UTC (Monday 02:30 Manila). Confirm
      the UDPO is content with those numbers, particularly that purging
      `statements_issued` makes an old reference stop resolving —
      `verify_statement()` will answer "not found" for a real statement, and
      that answer is deliberately identical to what a forged reference gets.

---

## Reference

**Projects**
- production `xgcdbtahappoqegheitd` — 17 tables, 17 policies, 70 functions, RLS
  on all 17, 1 cron job. Matches `deploy-schema.sql` exactly, no drift.
- backup `gtovoxodozpgjspfllvz` — four patches behind, see above.

**Deployed Edge Functions:** `notify-approval` (v1), `admin-delete-user` (v1),
`ai-assistant` (v2, rate-limited, no provider key).

**Pre-push chain:** `node check-drift.js` → `node --check <each js>` →
`node sync-csp.js` → `node sync-sri.js`

**Do not run `deploy-schema.sql` against a live project.** It is the
fresh-deploy script and will fail on tables that already exist. Migrations are
the numbered `patch-*.sql` files.
