# Deploying to Vercel

## The one thing that will bite you

**`.htaccess` does nothing on Vercel.** It is Apache configuration. Vercel
never reads it, never warns about it, and serves the site perfectly well
without it — which is the problem, because everything in it silently
stops applying.

`.htaccess` already says this about Netlify and Cloudflare Pages ("use
`_headers` there instead"). Vercel is the same class of host and wants
`vercel.json`, which is what that file is. It is a translation of the
`.htaccess` header block, not an addition to it.

What is lost if `vercel.json` is missing:

| Lost | Why it matters |
|---|---|
| `frame-ancestors 'none'` | The `<meta>` CSP in the nine pages **ignores `frame-ancestors` entirely** — that directive only works as a response header. Without `vercel.json` there is no clickjacking protection at all. The `<meta>` tags do not carry it and cannot. |
| `X-Frame-Options: DENY` | The fallback for the above. |
| `Cache-Control: no-store` on HTML | Signed-in pages hold a name and account numbers. On a shared cash-office terminal the back button becomes a way to read the last person's statement. |
| `Cache-Control: no-cache` on JS | A deploy lands as new markup driven by cached old code — new elements nothing wires up, functions the pages call and cannot find. Reproduces only for people who have visited before, never in a fresh browser. |
| `nosniff`, `Referrer-Policy`, `Permissions-Policy` | Straightforward hardening. |

`Options -Indexes`, `DirectoryIndex` and the MIME types have no equivalent
here and need none — Vercel does not serve directory listings, serves
`index.html` at `/` by default, and gets JS content types right.

## connect-src drift — read this before changing Supabase projects

`vercel.json` carries a **second copy** of the CSP, on top of the nine
`<meta>` tags. When a response header and a `<meta>` tag both carry a CSP,
the browser enforces **both, independently** — a request has to satisfy
every policy in force, so the effective rule is the intersection.

A stale project ref here therefore does not lose to the fresh ones in the
pages. It blocks every request they allow, and the symptom is a portal
that renders fine and cannot reach Supabase — which reads as a backend
outage with nothing in the network tab pointing at the CSP.

This is the exact failure `sync-csp.js` was written to prevent, and it is
why `vercel.json` is now one of its targets. After changing
`SUPABASE_URL` in `config.js`:

```
node sync-csp.js
```

and it rewrites the nine pages, `.htaccess` **and** `vercel.json` together.
Do not hand-edit the `connect-src` in any of the eleven.

## cleanUrls must stay false

`"cleanUrls": false` is set deliberately, not left at the default by
accident.

With it on, Vercel 308-redirects `/dashboard.html` to `/dashboard`. Every
internal link in this site is a relative `.html` (`href="soa.html"`,
`href="privacy.html"`), so they would all still work via an extra hop —
but the OAuth redirect would not. `page-index.js` sends Supabase
`new URL("index.html", window.location.href).href`, and Supabase matches
its redirect allowlist **exactly**. Add `https://host/index.html` to the
allowlist and let Vercel rewrite it to `https://host/` and Google sign-in
fails with "requested path is invalid" before it ever reaches the portal,
where nothing in the app can report it.

## Before the first deploy

1. **Run `node sync-sri.js`.** The pages load supabase-js and xlsx from
   CDNs. Until this has run they carry no `integrity=` hash, so a
   compromised CDN response executes with full privileges on the sign-in
   page. The script needs network access; it downloads both libraries,
   hashes them, writes the attributes into the nine pages and records the
   result in `sri-lock.json`. Commit the pages and the lockfile together.
2. **Run `node sync-csp.js`.** Confirms all eleven CSP copies agree and
   fails if anything reintroduced inline script.
3. **Apply `patch-2026-08-08.sql`** in Supabase → SQL Editor, after running
   the orphan check at the bottom of that file.
4. **Add the deployed origin to Supabase → Authentication → URL
   Configuration**, including `https://<your-host>/index.html`.

## Still not in this repo

Three Edge Functions are invoked by name from the client and have no
source here — `notify-approval`, `admin-delete-user`, `ai-assistant`. A
deploy without them produces a portal where approval emails silently
fail, deleting a user throws, and the assistant is dead: three unrelated-
looking faults, none of which point at a missing function. They belong in
`supabase/functions/<name>/index.ts`.
