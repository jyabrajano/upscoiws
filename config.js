// ============================================================
// Supabase connection config
//
// >>> REQUIRED SETUP <<<
// Go to your Supabase Project → Settings → API and copy:
//   - "Project URL"       → paste into SUPABASE_URL below
//   - "anon public" key   → paste into SUPABASE_ANON_KEY below
//
// This app will NOT work until both values below are replaced.
// Everything else (dashboard, statement of account, news, calendar,
// sign in) depends on this file being configured correctly.
// ============================================================
const SUPABASE_URL = "https://xgcdbtahappoqegheitd.supabase.co"; // e.g. https://abcdefgh.supabase.co
const SUPABASE_ANON_KEY = "sb_publishable_XscnC62J5m1WS0I55kBb8A_fjEyFOpu";

if (SUPABASE_URL.includes("YOUR_SUPABASE") || SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")) {
  console.error(
    "[config.js] Supabase is NOT configured yet. " +
    "Open config.js and replace SUPABASE_URL and SUPABASE_ANON_KEY with the real values " +
    "from Supabase → Settings → API. Until then, sign-in, the dashboard, and the " +
    "statement of account will silently fail to load data."
  );
  document.addEventListener("DOMContentLoaded", () => {
    const banner = document.createElement("div");
    banner.textContent =
      "⚠ Supabase is not configured. Edit config.js with your project URL and anon key.";
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9999;background:#b91c1c;color:#fff;" +
      "font:600 13px/1.4 sans-serif;text-align:center;padding:10px;";
    document.body.prepend(banner);
  });
}

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ------------------------------------------------------------
// Today's date as YYYY-MM-DD, in the reader's own timezone.
//
// The obvious spelling, new Date().toISOString().slice(0, 10), is UTC.
// Manila is UTC+8, so between midnight and 8am it returns yesterday —
// while anything built from getFullYear()/getMonth()/getDate(), which
// is every other date in this app, returns today. The two disagree for
// a third of every day, and only for the third nobody tests in.
// ------------------------------------------------------------
function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ------------------------------------------------------------
// Reads the signed-in user's approval state.
// Returns status: "approved" | "pending" | "rejected" | "disabled"
// | "missing" | "unavailable", plus the reason when there is one.
//
// "unavailable" means the status could not be read — the network is
// down, PostgREST is reloading its schema cache, Supabase is briefly
// unreachable. It is NOT a verdict on the account, and it is kept
// distinct from "pending" for that reason: this used to return
// "pending" for every error, so a five-second outage signed an
// approved user out and told them their registration was still
// awaiting approval. Both halves of that were false.
//
// Administrators are always treated as approved — an admin whose own
// row somehow sat pending would otherwise have no way back in to
// approve it. A DISABLED administrator is not: is_admin() returns
// false for them (see deploy-schema.sql), so they fall through
// to the profile read below and are refused like anyone else.
// ------------------------------------------------------------
async function getApprovalState(email) {
  try {
    const { data: isAdmin } = await supabaseClient.rpc("is_admin");
    if (isAdmin === true) return { status: "approved", isAdmin: true, reason: null };
  } catch (_) {
    // is_admin() missing means deploy-schema.sql hasn't been run yet.
  }

  const { data, error } = await supabaseClient
    .from("profiles")
    .select("approval_status, rejection_reason, disabled, disabled_reason")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    // 42703 = column does not exist, i.e. deploy-schema.sql hasn't
    // been run against this project yet. Called out separately so it
    // doesn't look like every account is stuck pending.
    if (error.code === "42703") {
      console.error(
        "[config.js] The approval columns are missing from `profiles`. " +
        "Run deploy-schema.sql in Supabase → SQL Editor."
      );
      return { status: "setup", isAdmin: false, reason: null };
    }
    console.error("Couldn't read your approval status:", error);
    // Still fails closed — "unavailable" is not "approved", and
    // requireSession() blocks the page either way. What changes is
    // that it no longer claims to know something it doesn't, and no
    // longer destroys a valid session over a transient error.
    return { status: "unavailable", isAdmin: false, reason: null };
  }
  if (!data) return { status: "missing", isAdmin: false, reason: null };

  // Disabled outranks everything else. An approved account that was
  // switched off is still switched off, and the person needs to be
  // told that rather than shown an empty dashboard.
  if (data.disabled === true) {
    return { status: "disabled", isAdmin: false, reason: data.disabled_reason || null };
  }

  return {
    status: data.approval_status || "pending",
    isAdmin: false,
    reason: data.rejection_reason || null,
  };
}

// Redirects to login if there's no active session, or if the account
// is still waiting on (or was refused) administrator approval.
// Call this at the top of every protected page.
async function requireSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = "index.html";
    return null;
  }

  const state = await getApprovalState(session.user.email);

  // A status we couldn't read is not a status we can act on. Block the
  // page — returning null stops every caller the same way a refusal
  // does — but leave the session alone and say what actually happened,
  // so the person can retry instead of being bounced to the sign-in
  // page and told to wait for an approval they already have.
  if (state.status === "unavailable") {
    showConnectionNotice();
    return null;
  }

  if (state.status !== "approved") {
    await supabaseClient.auth.signOut();
    // Only the status travels in the URL, never the reason.
    //
    // index.html renders whatever it is handed as a Cash Office notice,
    // so a reason in the query string is text anyone can write into the
    // portal's own voice: index.html?access=disabled&reason=Call+0917...
    // reads exactly like an official message. It is escaped, so this was
    // never XSS — it is content spoofing, which needs no script.
    //
    // Nothing is lost by dropping it. The reason still reaches the
    // account holder on the sign-in path, where index.html gets it from
    // getApprovalState() after the password has already been checked —
    // the one place it can be trusted, and the only place it was ever
    // useful.
    window.location.href = `index.html?access=${encodeURIComponent(state.status)}`;
    return null;
  }

  return session;
}

// Shown when the portal is reachable enough to have a session but not
// enough to confirm what the session is allowed to do. Deliberately
// says nothing about the account: the whole point is that we don't
// know. Retry is a reload, because whatever failed happened before any
// page state existed to preserve.
//
// Built in JS rather than markup so it works on all six protected
// pages without editing six files, and styled with a style attribute
// because script-src has no 'unsafe-inline' but style-src does.
function showConnectionNotice() {
  if (document.getElementById("connNotice")) return;

  const build = () => {
    const box = document.createElement("div");
    box.id = "connNotice";
    box.setAttribute("role", "alert");
    box.style.cssText =
      "position:fixed;inset:0;z-index:9998;display:flex;align-items:center;" +
      "justify-content:center;background:#f8fafc;padding:24px;" +
      "font:14px/1.55 system-ui,sans-serif;color:#0f172a;";

    const card = document.createElement("div");
    card.style.cssText =
      "max-width:380px;text-align:center;background:#fff;border:1px solid #e2e8f0;" +
      "border-radius:12px;padding:28px 26px;box-shadow:0 8px 28px rgba(15,23,42,0.08);";

    const h = document.createElement("h2");
    h.textContent = "Can't reach the portal";
    h.style.cssText = "margin:0 0 10px;font-size:17px;font-weight:700;";

    const p = document.createElement("p");
    p.textContent =
      "Your sign-in is still valid — we just couldn't load your account " +
      "details. This is usually a brief connection problem.";
    p.style.cssText = "margin:0 0 18px;color:#475569;";

    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Try again";
    retry.style.cssText =
      "background:#7b1113;color:#fff;border:none;padding:11px 22px;border-radius:8px;" +
      "font:700 14px/1 inherit;cursor:pointer;";
    retry.addEventListener("click", () => window.location.reload());

    card.append(h, p, retry);
    box.appendChild(card);
    document.body.appendChild(box);
  };

  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build);
}

async function logout() {
  await supabaseClient.auth.signOut();
  window.location.href = "index.html";
}

// ============================================================
// LBP account numbers
//
// Ten digits, always shown as 4-4-2: 3072100742 -> 3072-1007-42.
// Whatever gets pasted or typed — spaces, dashes in the wrong
// place, none at all — comes out in that shape.
//
// Every account number box on every page runs through here, so
// what's stored is consistent no matter where it was entered.
// Mark a field with data-account-number and it's picked up
// automatically on page load.
// ============================================================
function accountNumberDigits(raw) {
  return String(raw == null ? "" : raw).replace(/\D/g, "").slice(0, 10);
}

function formatAccountNumber(raw) {
  const digits = accountNumberDigits(raw);
  if (digits.length <= 4) return digits;
  if (digits.length <= 8) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`;
}

// Returns { ok, value } or { ok: false, message }. Partial numbers
// are rejected on submit rather than while typing — nobody wants to
// be told their number is too short after the first keystroke.
function validateAccountNumber(value, opts) {
  const required = !!(opts && opts.required);
  const digits = accountNumberDigits(value);

  if (!digits) {
    return required
      ? { ok: false, message: "Enter your LBP account number." }
      : { ok: true, value: "" };
  }
  if (digits.length !== 10) {
    return {
      ok: false,
      message: `An LBP account number is 10 digits — that's ${digits.length}.`,
    };
  }
  return { ok: true, value: formatAccountNumber(digits) };
}

// Puts the caret back after the nth digit. Working in digits rather
// than characters is what keeps editing the middle of the number
// from throwing the caret to the end.
function setCaretAfterDigits(input, digitCount) {
  if (digitCount <= 0) {
    try { input.setSelectionRange(0, 0); } catch (_) {}
    return;
  }
  const value = input.value;
  let seen = 0;
  let i = 0;
  for (; i < value.length; i++) {
    if (value[i] >= "0" && value[i] <= "9") seen++;
    if (seen === digitCount) { i++; break; }
  }
  // Step over a dash so the next digit typed lands after it.
  while (i < value.length && value[i] === "-") i++;
  try { input.setSelectionRange(i, i); } catch (_) {}
}

function countDigits(str) {
  return (String(str).match(/\d/g) || []).length;
}

function attachAccountNumberInput(input) {
  if (!input || input.dataset.acctFormatReady === "1") return;
  input.dataset.acctFormatReady = "1";

  input.setAttribute("inputmode", "numeric");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("maxlength", "12"); // 10 digits + 2 dashes

  // Backspace onto a dash should take the digit in front of it. The
  // formatter puts the dash straight back, so without this the key
  // looks like it did nothing.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Backspace") return;
    const pos = input.selectionStart;
    if (pos === null || pos !== input.selectionEnd || pos < 2) return;
    if (input.value[pos - 1] !== "-") return;

    e.preventDefault();
    const kept = input.value.slice(0, pos - 2) + input.value.slice(pos);
    const digitsBefore = countDigits(input.value.slice(0, pos - 2));
    input.value = formatAccountNumber(kept);
    setCaretAfterDigits(input, digitsBefore);
  });

  input.addEventListener("input", () => {
    const caret = input.selectionStart === null ? input.value.length : input.selectionStart;
    const digitsBefore = countDigits(input.value.slice(0, caret));
    input.value = formatAccountNumber(input.value);
    setCaretAfterDigits(input, digitsBefore);
  });

  // Anything already in the box when the page loads gets tidied too.
  if (input.value) input.value = formatAccountNumber(input.value);
}

function enableAccountNumberInputs(root) {
  (root || document)
    .querySelectorAll("[data-account-number]")
    .forEach(attachAccountNumberInput);
}

// ============================================================
// Up to three account numbers
//
// They're held in one string — "3072-1007-42, 3072-1007-43" — so
// the approval functions in the database can pass them straight
// through without knowing there's more than one. A trigger splits
// them into profile_accounts on the way in; see
// deploy-schema.sql.
//
// The cap lives in the database — max_account_numbers() — and is
// enforced there by normalize_account_numbers(), which every write
// path goes through. The value below is only what the boxes assume
// until the database answers; syncMaxAccountNumbers() replaces it on
// load. Change the SQL, not this line.
// ============================================================
let MAX_ACCOUNT_NUMBERS = 3;

// Account-number lists built before the answer arrives register a
// refresh here so they can pick up a different cap without the page
// being reloaded.
const accountListRefreshers = new Set();

// Reads the cap from the database. Granted to `anon` as well as
// `authenticated`, so this works on registration.html too, where
// nobody is signed in yet. A failure leaves the default in place —
// the database still refuses anything over the real limit, so a
// stale number here is a cosmetic problem, not a hole.
async function syncMaxAccountNumbers() {
  try {
    const { data, error } = await supabaseClient.rpc("max_account_numbers");
    if (error) throw error;

    const limit = Number(data);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      console.warn("[config.js] max_account_numbers() returned an odd value:", data);
      return MAX_ACCOUNT_NUMBERS;
    }
    if (limit !== MAX_ACCOUNT_NUMBERS) {
      MAX_ACCOUNT_NUMBERS = limit;
      accountListRefreshers.forEach((refresh) => {
        try { refresh(); } catch (_) {}
      });
    }
  } catch (err) {
    console.warn("Couldn't read the account-number limit; using", MAX_ACCOUNT_NUMBERS, err);
  }
  return MAX_ACCOUNT_NUMBERS;
}

// ============================================================
// UP Mail restriction
//
// Same shape as MAX_ACCOUNT_NUMBERS above, and for the same reason:
// the toggle lives in the database — up_mail_restriction_enabled() —
// and is enforced there by handle_new_user(), which refuses a signup
// outright when it is on. The value below is only what the
// registration form assumes until the database answers.
//
// It used to be a second `const UP_MAIL_RESTRICTION_ENABLED = false;`
// hardcoded inside registration.html, with a comment asking whoever
// changed the SQL to remember to change the page too. Nothing
// enforced that. Flip the SQL alone and the form would go on quietly
// accepting gmail addresses, then hand them to a signUp the database
// rejects — reported as "registration is broken", nowhere near the
// toggle. There is now one switch, and it is the SQL one.
//
// The default is false (fail-open) on purpose. A stale `false` here
// costs a wasted round trip and a refusal from the database, which
// is the authority either way. A stale `true` would refuse a valid
// address in the browser and never reach the database at all.
// ============================================================
let UP_MAIL_RESTRICTION_ENABLED = false;
const UP_MAIL_RE = /@up\.edu\.ph$/i;

// Which domain the portal accepts is not sensitive — the database
// says so to anyone who tries — so naming it in the message is a
// help, not a leak.
const UP_MAIL_MSG =
  "Use your UP Mail address — this portal only accepts accounts ending in @up.edu.ph.";

const upMailRestrictionListeners = new Set();

// Granted to `anon` as well as `authenticated`: registration.html is
// a pre-authentication page, so there is no session when this runs.
async function syncUpMailRestriction() {
  try {
    const { data, error } = await supabaseClient.rpc("up_mail_restriction_enabled");
    if (error) throw error;

    if (typeof data !== "boolean") {
      console.warn("[config.js] up_mail_restriction_enabled() returned a non-boolean:", data);
      return UP_MAIL_RESTRICTION_ENABLED;
    }
    if (data !== UP_MAIL_RESTRICTION_ENABLED) {
      UP_MAIL_RESTRICTION_ENABLED = data;
      upMailRestrictionListeners.forEach((notify) => {
        try { notify(data); } catch (_) {}
      });
    }
  } catch (err) {
    console.warn(
      "Couldn't read the UP Mail restriction; assuming",
      UP_MAIL_RESTRICTION_ENABLED,
      err
    );
  }
  return UP_MAIL_RESTRICTION_ENABLED;
}

// Forms built before the answer arrives register here so they can
// re-validate without the page being reloaded.
function onUpMailRestrictionChange(notify) {
  upMailRestrictionListeners.add(notify);
}

function parseAccountNumbers(value) {
  return String(value == null ? "" : value)
    .split(/[,;\n]+/)
    .map(formatAccountNumber)
    .filter((n, i, all) => n && all.indexOf(n) === i)
    .slice(0, MAX_ACCOUNT_NUMBERS);
}

function joinAccountNumbers(numbers) {
  return (numbers || []).filter(Boolean).join(", ");
}

// Renders up to MAX_ACCOUNT_NUMBERS rows into `container`, each an
// account number box with a remove button, plus an "add another"
// button underneath. Returns the same read/fill/value shape as
// attachNameBuilder so the two behave alike.
function attachAccountNumberList(container, opts) {
  const options = opts || {};
  const required = !!options.required;
  const rows = document.createElement("div");
  rows.className = "acct-rows";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "acct-add";
  addBtn.textContent = "+ Add another account number";

  container.appendChild(rows);
  container.appendChild(addBtn);

  function values() {
    return Array.from(rows.querySelectorAll("input"))
      .map(i => i.value.trim())
      .filter(Boolean);
  }

  function refresh() {
    const count = rows.children.length;
    Array.from(rows.children).forEach((row, i) => {
      const remove = row.querySelector(".acct-remove");
      // The first box can't be removed when one is required —
      // there'd be nothing left to submit.
      remove.style.visibility = count > 1 || (!required && i > 0) ? "visible" : "hidden";
    });
    addBtn.style.display = count >= MAX_ACCOUNT_NUMBERS ? "none" : "block";
  }

  function addRow(value) {
    if (rows.children.length >= MAX_ACCOUNT_NUMBERS) return null;

    const row = document.createElement("div");
    row.className = "acct-row";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "####-####-##";
    input.setAttribute("data-account-number", "");
    if (rows.children.length === 0 && options.id) input.id = options.id;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "acct-remove";
    remove.setAttribute("aria-label", "Remove this account number");
    remove.innerHTML = "&times;";
    remove.addEventListener("click", () => {
      row.remove();
      if (rows.children.length === 0) addRow("");
      refresh();
      if (options.onChange) options.onChange();
    });

    row.appendChild(input);
    row.appendChild(remove);
    rows.appendChild(row);

    attachAccountNumberInput(input);
    if (value) input.value = formatAccountNumber(value);
    if (options.onChange) input.addEventListener("change", options.onChange);

    refresh();
    return input;
  }

  addBtn.addEventListener("click", () => {
    const input = addRow("");
    if (input) input.focus();
  });

  function fill(value) {
    rows.innerHTML = "";
    const numbers = parseAccountNumbers(value);
    if (numbers.length === 0) addRow("");
    else numbers.forEach(addRow);
    refresh();
  }

  fill(options.initial || "");
  accountListRefreshers.add(refresh);

  return {
    values,
    fill,
    value: () => joinAccountNumbers(values()),
    // Every box has to hold a complete number, or none at all when
    // they're optional.
    validate() {
      const raw = values();
      if (raw.length === 0) {
        return required
          ? { ok: false, message: "Enter at least one account number." }
          : { ok: true, value: "" };
      }
      for (const one of raw) {
        const check = validateAccountNumber(one, { required: true });
        if (!check.ok) return check;
      }
      const cleaned = parseAccountNumbers(raw.join(","));
      if (cleaned.length !== raw.length) {
        return { ok: false, message: "That account number is listed twice." };
      }
      return { ok: true, value: joinAccountNumbers(cleaned) };
    },
  };
}

// ---------- already registered? ----------
//
// Both go through SECURITY DEFINER functions, because RLS stops one
// user reading another's profile. They answer yes or no and never
// say whose it is. A failure is treated as "can't tell" rather than
// as a duplicate — a warning that can't be checked shouldn't block
// anyone from submitting.
//
// These two are the only functions on the site an unauthenticated
// visitor can call, so they're the ones worth putting a lid on:
// each is a yes/no question about whether a name or a number is
// already registered, and enough of them in a row is an enumeration.
//
// Two lids, both cheap:
//
//   a cache   the same question inside CHECK_CACHE_MS is answered
//             from memory. Registration re-asks constantly — every
//             blur, every submit — and almost always about a value
//             it just asked about.
//   a window  no more than CHECK_BURST calls in CHECK_WINDOW_MS.
//             Over that, callers get "can't tell" until the window
//             clears.
//
// This is a courtesy limit in the browser, not a security control —
// anyone can skip it by calling PostgREST directly. The real limit
// has to be Supabase's own (Dashboard → Auth → Rate Limits). What
// this does stop is the ordinary version: a script pointed at the
// live page, or a form that's gone into a loop.

const CHECK_CACHE_MS = 30000;
const CHECK_BURST = 12;
const CHECK_WINDOW_MS = 10000;

const checkCache = new Map();   // key -> { at, value }
const checkCalls = [];          // timestamps inside the window

function checkWindowHasRoom() {
  const now = Date.now();
  while (checkCalls.length && now - checkCalls[0] > CHECK_WINDOW_MS) checkCalls.shift();
  if (checkCalls.length >= CHECK_BURST) return false;
  checkCalls.push(now);
  return true;
}

// `fallback` is the "can't tell" answer for this check — the same
// one a network failure produces, so a throttled call and a failed
// call are indistinguishable to the caller. Neither blocks anyone:
// the database still refuses a real duplicate on submit.
async function cachedCheck(key, fallback, run) {
  const hit = checkCache.get(key);
  if (hit && Date.now() - hit.at < CHECK_CACHE_MS) return hit.value;

  if (!checkWindowHasRoom()) {
    console.warn("Duplicate checks are being made too quickly; skipping this one.");
    return hit ? hit.value : fallback;
  }

  const value = await run();
  checkCache.set(key, { at: Date.now(), value });

  // Nothing prunes this otherwise, and a form left open for an hour
  // would grow it without bound.
  if (checkCache.size > 200) {
    const cutoff = Date.now() - CHECK_CACHE_MS;
    checkCache.forEach((entry, k) => {
      if (entry.at < cutoff) checkCache.delete(k);
    });
  }

  return value;
}

async function accountNumbersTaken(value, email) {
  return cachedCheck(`acct:${email || ""}:${value}`, [], async () => {
    try {
      const { data, error } = await supabaseClient.rpc("account_numbers_taken", {
        p_value: value,
        p_email: email || null,
      });
      if (error) throw error;
      return data || [];
    } catch (err) {
      console.warn("Couldn't check account numbers:", err);
      return [];
    }
  });
}

async function fullNameTaken(name, email) {
  return cachedCheck(`name:${email || ""}:${name}`, false, async () => {
    try {
      const { data, error } = await supabaseClient.rpc("full_name_taken", {
        p_name: name,
        p_email: email || null,
      });
      if (error) throw error;
      return data === true;
    } catch (err) {
      console.warn("Couldn't check the name:", err);
      return false;
    }
  });
}

// The submit path needs the current answer, not one from up to
// thirty seconds ago — someone else may have taken the name while
// the form sat open. Clearing the cache first makes the last look
// before signUp a real one.
function forgetDuplicateChecks() {
  checkCache.clear();
}

// ============================================================
// Names
//
// One place that knows how a name is put together and taken apart,
// used by the registration form and by Edit Account on both pages,
// so the two can't drift.
//
//   LAST NAME, FIRST NAME M.I. SUFFIX
// ============================================================

// Bare, no trailing period — a middle initial always carries one,
// which is what tells "REYES, JORDAN V." (initial) apart from
// "REYES, JORDAN D. V" (suffix).
const NAME_SUFFIXES = [
  "JR", "JR.", "SR", "SR.",
  "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
];

// One period per letter, and only one: D -> "D.", DC -> "D.C.",
// "D..C" or "d.c" -> "D.C." Whatever gets typed or pasted comes out
// in that shape, so two people with the same initials can't end up
// filed under "D.C." and "DC".
function tidyMiddleInitial(raw) {
  const letters = String(raw == null ? "" : raw).replace(/[^A-Za-z]/g, "").toUpperCase();
  if (!letters) return "";
  return letters.split("").map(letter => `${letter}.`).join("");
}

function countLetters(str) {
  return (String(str).match(/[A-Za-z]/g) || []).length;
}

// Every letter takes two characters once its period is on, so the
// caret belongs at twice the number of letters in front of it.
function setCaretAfterLetters(input, letterCount) {
  const pos = Math.max(0, Math.min(letterCount * 2, input.value.length));
  try { input.setSelectionRange(pos, pos); } catch (_) {}
}

// Puts the periods in as you type rather than waiting for the field
// to lose focus.
function attachMiddleInitialInput(input) {
  if (!input || input.dataset.miFormatReady === "1") return;
  input.dataset.miFormatReady = "1";

  input.setAttribute("autocapitalize", "characters");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("spellcheck", "false");

  // Backspace lands on a period, and the formatter would put it
  // straight back — so the key has to take the letter with it or it
  // looks like it did nothing.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Backspace") return;
    const pos = input.selectionStart;
    if (pos === null || pos !== input.selectionEnd || pos === 0) return;

    e.preventDefault();
    const before = countLetters(input.value.slice(0, pos));
    const letters = input.value.replace(/[^A-Za-z]/g, "").toUpperCase().split("");
    if (before > 0) letters.splice(before - 1, 1);
    input.value = tidyMiddleInitial(letters.join(""));
    setCaretAfterLetters(input, before - 1);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  input.addEventListener("input", () => {
    const caret = input.selectionStart === null ? input.value.length : input.selectionStart;
    const before = countLetters(input.value.slice(0, caret));
    const tidied = tidyMiddleInitial(input.value);
    if (tidied !== input.value) {
      input.value = tidied;
      setCaretAfterLetters(input, before);
    }
  });

  if (input.value) input.value = tidyMiddleInitial(input.value);
}

function buildFullName(parts) {
  const first = String(parts.first || "").trim();
  const mi = String(parts.middleInitial || "").trim().replace(/\.$/, "");
  const last = String(parts.last || "").trim();
  const suffix = String(parts.suffix || "").trim().replace(/^,\s*/, "");

  const middlePart = mi ? ` ${mi}.` : "";
  const firstAndMiddle = `${first}${middlePart}`.trim();

  let name = "";
  if (last && firstAndMiddle) name = `${last}, ${firstAndMiddle}`;
  else if (last) name = last;
  else name = firstAndMiddle;

  if (suffix) name = name ? `${name} ${suffix}` : suffix;
  return name.toUpperCase();
}

// The reverse, for filling the Edit Account boxes from what's on
// file. A name with no comma can't be split with any confidence, so
// the whole thing goes in Last Name rather than being guessed at —
// nothing is lost either way.
function splitFullName(fullName) {
  const parts = { first: "", middleInitial: "", last: "", suffix: "" };
  const value = String(fullName == null ? "" : fullName).trim();
  if (!value) return parts;

  const comma = value.indexOf(",");
  if (comma === -1) {
    parts.last = value;
    return parts;
  }

  parts.last = value.slice(0, comma).trim();
  const tokens = value.slice(comma + 1).trim().split(/\s+/).filter(Boolean);

  if (tokens.length && NAME_SUFFIXES.includes(tokens[tokens.length - 1].toUpperCase())) {
    parts.suffix = tokens.pop();
  }

  // "D.", "D.L." — or a bare letter, for names saved before the
  // period was added automatically. Only when something is left to
  // be the first name.
  const looksLikeInitial = (t) => /^[A-Za-z](\.[A-Za-z])*\.$/.test(t) || /^[A-Za-z]$/.test(t);
  if (tokens.length > 1 && looksLikeInitial(tokens[tokens.length - 1])) {
    parts.middleInitial = tidyMiddleInitial(tokens.pop());
  }

  parts.first = tokens.join(" ");
  return parts;
}

// Wires a set of name boxes to a read-only full-name box: keeps the
// derived name current as you type, tidies the M.I. on blur, and can
// fill everything back in from a stored name.
function attachNameBuilder(fields) {
  const { firstInput, miInput, lastInput, suffixInput, fullNameInput } = fields;

  function read() {
    return {
      first: firstInput ? firstInput.value : "",
      middleInitial: miInput ? miInput.value : "",
      last: lastInput ? lastInput.value : "",
      suffix: suffixInput ? suffixInput.value : "",
    };
  }

  function update() {
    const name = buildFullName(read());
    if (fullNameInput) fullNameInput.value = name;
    return name;
  }

  // On blur, not on every keystroke — adding the period mid-word
  // would fight with someone still typing.
  function tidy() {
    if (miInput) miInput.value = tidyMiddleInitial(miInput.value);
    return update();
  }

  function fill(fullName) {
    const parts = splitFullName(fullName);
    if (firstInput) firstInput.value = parts.first;
    if (miInput) miInput.value = parts.middleInitial;
    if (lastInput) lastInput.value = parts.last;
    if (suffixInput) suffixInput.value = parts.suffix;
    return update();
  }

  function clear() {
    [firstInput, miInput, lastInput, suffixInput].forEach(el => { if (el) el.value = ""; });
    return update();
  }

  // Formatting first, so update() reads the tidied value.
  if (miInput) attachMiddleInitialInput(miInput);

  [firstInput, miInput, lastInput, suffixInput]
    .filter(Boolean)
    .forEach(el => el.addEventListener("input", update));

  if (miInput) miInput.addEventListener("blur", tidy);

  update();
  return { read, update, tidy, fill, clear, value: () => (fullNameInput ? fullNameInput.value.trim() : "") };
}

// ============================================================
// Privacy notice (RA 10173 — Data Privacy Act of 2012)
//
// Bump this whenever privacy.html changes in a way a person would
// want to know about. registration.html records the version each
// person acknowledged, so a reissued notice can be re-acknowledged
// rather than silently swapped underneath them — "they accepted a
// privacy notice" is not worth much without "which one".
//
// Date-shaped on purpose: it sorts, it reads, and it makes a stale
// version obvious at a glance.
//
// This is an ACKNOWLEDGEMENT, not consent. See the note at the top of
// privacy.html for why the distinction matters here.
// ============================================================
const PRIVACY_NOTICE_VERSION = "2026-08-06";

// Called after signUp() succeeds. Deliberately does not block the
// registration if it fails: the person has already been shown the
// notice by then, and losing the receipt is a smaller problem than
// refusing an otherwise valid registration.
async function recordPrivacyNoticeAck() {
  try {
    const { error } = await supabaseClient.rpc("record_privacy_notice_ack", {
      p_version: PRIVACY_NOTICE_VERSION,
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn("Couldn't record the privacy notice acknowledgement:", err);
    return false;
  }
}

// ------------------------------------------------------------
// Deferred acknowledgements
//
// With email confirmation on, signUp() returns no session, so
// registration.html has no JWT to write the receipt with even though
// it is the page that actually showed the notice and watched the box
// get ticked. The receipt has to wait for first sign-in.
//
// It used to wait by simply calling recordPrivacyNoticeAck() on EVERY
// successful sign-in. That wrote a timestamped, versioned
// acknowledgement for people who had never been shown anything —
// Google SSO goes nowhere near registration.html, so an SSO user got a
// receipt attesting to a reading that did not happen. A record like
// that is worse than no record: it is the document you would produce
// to demonstrate compliance, and it would be false.
//
// So the intent is parked here at the moment it is genuinely formed,
// and only redeemed for the address that formed it.
//
// localStorage rather than a cookie or the URL: it survives the round
// trip through the mail client, it is scoped to this origin, and it
// cannot be set by a link someone was sent. Losing it — different
// device, cleared browser — costs an acknowledgement the person makes
// once more in the gate below. It never costs them access.
// ------------------------------------------------------------
const PENDING_ACK_KEY = "scoiws:pending-privacy-ack";

function rememberPendingPrivacyAck(email) {
  try {
    localStorage.setItem(PENDING_ACK_KEY, JSON.stringify({
      email: String(email || "").trim().toLowerCase(),
      version: PRIVACY_NOTICE_VERSION,
      at: new Date().toISOString(),
    }));
  } catch (_) {
    // Private mode or storage disabled. The gate below is the backstop.
  }
}

// True only when this browser holds an unredeemed acknowledgement from
// THIS person for THIS version of the notice. A stale version doesn't
// carry over — that is the whole reason the version is recorded.
function redeemPendingPrivacyAck(email) {
  try {
    const raw = localStorage.getItem(PENDING_ACK_KEY);
    if (!raw) return false;
    const pending = JSON.parse(raw);
    const matches =
      pending &&
      pending.version === PRIVACY_NOTICE_VERSION &&
      pending.email === String(email || "").trim().toLowerCase();
    if (matches) localStorage.removeItem(PENDING_ACK_KEY);
    return Boolean(matches);
  } catch (_) {
    return false;
  }
}

// ------------------------------------------------------------
// The acknowledgement gate
//
// Shown to anyone signed in whose profile carries no acknowledgement,
// or one for an older version of the notice. That covers the people
// the registration form never sees — Google SSO, accounts set up by
// the Cash Office — and everyone at once when the notice is reissued.
//
// RA 10173 s.16(a) is a right to be INFORMED, so what this owes the
// person is the notice itself and a moment to read it, not a consent
// bargain. Hence: links that open in a new tab, one button, and no
// second option to weigh it against. It is not a cookie banner.
//
// Non-blocking on failure. If the profile can't be read, the person
// gets on with their work and is asked again next time — refusing
// someone their own statement of account over an unreadable column
// would be the wrong trade in both directions.
// ------------------------------------------------------------
async function ensurePrivacyNoticeAck(email) {
  try {
    const { data, error } = await supabaseClient
      .from("profiles")
      .select("privacy_notice_ack_at, privacy_notice_ack_version")
      .eq("email", email)
      .maybeSingle();

    if (error) throw error;
    if (data && data.privacy_notice_ack_at &&
        data.privacy_notice_ack_version === PRIVACY_NOTICE_VERSION) {
      return true;
    }

    // Ticked the box at registration, first sign-in on this browser.
    if (redeemPendingPrivacyAck(email)) return recordPrivacyNoticeAck();

    return showPrivacyNoticeGate();
  } catch (err) {
    console.warn("Couldn't check the privacy notice acknowledgement:", err);
    return false;
  }
}

// Built in JS for the same reason showConnectionNotice() is: it has to
// work on every protected page without editing each one, and inline
// style is allowed by style-src where inline script is not.
function showPrivacyNoticeGate() {
  return new Promise((resolve) => {
    if (document.getElementById("privacyGate")) return resolve(false);

    const build = () => {
      const box = document.createElement("div");
      box.id = "privacyGate";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", "privacyGateTitle");
      box.style.cssText =
        "position:fixed;inset:0;z-index:9997;display:flex;align-items:center;" +
        "justify-content:center;background:rgba(15,23,42,0.55);padding:24px;" +
        "font:14px/1.55 system-ui,sans-serif;color:#0f172a;";

      const card = document.createElement("div");
      card.style.cssText =
        "max-width:440px;background:#fff;border-radius:12px;padding:28px 26px;" +
        "box-shadow:0 12px 40px rgba(15,23,42,0.25);";

      const h = document.createElement("h2");
      h.id = "privacyGateTitle";
      h.textContent = "Before you continue";
      h.style.cssText = "margin:0 0 10px;font-size:17px;font-weight:700;";

      const p = document.createElement("p");
      p.style.cssText = "margin:0 0 18px;color:#475569;";
      p.append(
        document.createTextNode("This portal holds your name and account numbers. Please read the "),
      );

      const privacyLink = document.createElement("a");
      privacyLink.href = "privacy.html";
      privacyLink.target = "_blank";
      privacyLink.rel = "noopener";
      privacyLink.textContent = "Privacy Notice";
      privacyLink.style.cssText = "color:#7b1113;font-weight:600;";

      const termsLink = document.createElement("a");
      termsLink.href = "terms.html";
      termsLink.target = "_blank";
      termsLink.rel = "noopener";
      termsLink.textContent = "Terms of Use";
      termsLink.style.cssText = "color:#7b1113;font-weight:600;";

      p.append(
        privacyLink,
        document.createTextNode(" and the "),
        termsLink,
        document.createTextNode("."),
      );

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "I have read the Privacy Notice";
      btn.style.cssText =
        "background:#7b1113;color:#fff;border:none;padding:11px 22px;border-radius:8px;" +
        "font:700 14px/1 inherit;cursor:pointer;";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Saving…";
        const ok = await recordPrivacyNoticeAck();
        box.remove();
        resolve(ok);
      });

      card.append(h, p, btn);
      box.appendChild(card);
      document.body.appendChild(box);
      btn.focus();
    };

    if (document.body) build();
    else document.addEventListener("DOMContentLoaded", build);
  });
}

// ============================================================
// Password policy
//
// The floor lived in three pages at once — registration.html,
// editaccount.html and reset-password.html — as a bare `>= 8` next
// to a sentence with "8" typed into it. Six copies of one number, in
// three files, with nothing tying them together. Raise the floor and
// you are relying on whoever does it to find all six; miss one and
// the page still says "at least 8 characters" while the button
// unlocks at 8 and Supabase refuses at 10.
//
// One constant now, and every message built from it, so the number
// and the sentence describing it cannot disagree.
//
// This is the browser's copy. The floor that actually holds is
// Supabase's own (Dashboard → Authentication → Providers → Email →
// Minimum password length), which applies to signUp() and
// updateUser() no matter what any page believes. Keep this value at
// or above that one: below it and the form promises to accept a
// password the API then refuses, which is the confusing direction.
// See §2.2 of DEPLOYMENT-README.md.
//
// The sign-in box on index.html deliberately has no floor at all —
// see the comment beside it. A minimum on a box that only *checks* a
// password locks out anyone still holding a shorter one, including
// from the page they'd use to change it.
// ============================================================
const PASSWORD_MIN_LENGTH = 8;

function passwordLongEnough(password) {
  return String(password == null ? "" : password).length >= PASSWORD_MIN_LENGTH;
}

// "At least 8 characters." — the neutral statement of the rule,
// shown before anyone has typed anything.
function passwordPolicyText() {
  return `At least ${PASSWORD_MIN_LENGTH} characters.`;
}

// "Use at least 8 characters." — the correction, shown once there is
// something too short in the box.
function passwordTooShortText() {
  return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
}

// Puts minlength on every box that *sets* a password, from the same
// constant, so the browser's own bubble agrees with the gate text.
//
// Opt-in by attribute rather than by input[type=password], because
// the two are not the same set: index.html's sign-in box and
// editaccount.html's "current password" box are both password
// fields, and neither should carry a floor. Mark a box with
// data-password-policy and it gets one.
function applyPasswordPolicy(root) {
  (root || document)
    .querySelectorAll("[data-password-policy]")
    .forEach((input) => {
      input.setAttribute("minlength", String(PASSWORD_MIN_LENGTH));
    });
}

// ============================================================
// Show / hide password
//
// Every <input type="password"> on the page gets an eye button
// inside its right edge. Lives here because config.js is the one
// file all four pages load, so sign-in, Edit Account on the
// dashboard, Edit Account on the statement of account, and the
// reset-password page all behave the same way without repeating
// this markup four times.
//
// Add data-no-toggle to a password field to leave it alone.
// ============================================================
function injectPasswordToggleStyles() {
  if (document.getElementById("pwToggleStyles")) return;
  const style = document.createElement("style");
  style.id = "pwToggleStyles";
  style.textContent = `
  .pw-wrap { position: relative; display: block; }
  .pw-wrap > input { padding-right: 44px !important; }
  .pw-toggle {
    position: absolute;
    top: 50%;
    right: 4px;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: #94a3b8;
    cursor: pointer;
    transition: color 0.15s, background-color 0.15s;
  }
  .pw-toggle:hover { color: var(--maroon, #7b1113); background: rgba(123, 17, 19, 0.07); }
  .pw-toggle:focus-visible {
    outline: 2px solid var(--maroon, #7b1113);
    outline-offset: 1px;
  }
  .pw-toggle svg { width: 18px; height: 18px; pointer-events: none; }
  .pw-toggle .icon-hide { display: none; }
  .pw-toggle.is-showing .icon-show { display: none; }
  .pw-toggle.is-showing .icon-hide { display: block; }
  .pw-toggle.is-showing { color: var(--maroon, #7b1113); }`;
  document.head.appendChild(style);
}

function attachPasswordToggle(input) {
  if (!input || input.dataset.pwToggleReady === "1") return;
  if (input.hasAttribute("data-no-toggle")) return;
  input.dataset.pwToggleReady = "1";

  const wrap = document.createElement("div");
  wrap.className = "pw-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pw-toggle";
  btn.setAttribute("aria-label", "Show password");
  btn.setAttribute("title", "Show password");
  btn.innerHTML = `
    <svg class="icon-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
    <svg class="icon-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path>
      <line x1="1" y1="1" x2="23" y2="23"></line>
    </svg>`;

  btn.addEventListener("click", () => {
    const showing = input.type === "password";
    input.type = showing ? "text" : "password";
    btn.classList.toggle("is-showing", showing);
    btn.setAttribute("aria-label", showing ? "Hide password" : "Show password");
    btn.setAttribute("title", showing ? "Hide password" : "Show password");
    // Keep the caret where the person left it.
    input.focus();
    const end = input.value.length;
    try { input.setSelectionRange(end, end); } catch (_) {}
  });

  wrap.appendChild(btn);
}

// Safe to call again after adding password fields to the page —
// fields that already have a toggle are skipped.
function enablePasswordToggles(root) {
  injectPasswordToggleStyles();
  (root || document)
    .querySelectorAll('input[type="password"]')
    .forEach(attachPasswordToggle);
}

function initSharedBehaviour() {
  enablePasswordToggles();
  enableAccountNumberInputs();
  applyPasswordPolicy();
  // Neither is awaited: the boxes work on the built-in defaults
  // straight away, and adjust if the database says otherwise.
  syncMaxAccountNumbers();
  syncUpMailRestriction();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSharedBehaviour);
} else {
  initSharedBehaviour();
}
