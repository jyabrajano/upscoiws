// Version marker for the build stamp in config.js. Bump with the
// BUILD_ID there whenever this file changes, so a stale copy on the
// server announces itself instead of looking like a broken feature.
window.__BUILD = window.__BUILD || {};
window.__BUILD["reset-password"] = "2026-08-07-i";

const statusEl   = document.getElementById("status");
const checkingEl = document.getElementById("checking");
const formEl     = document.getElementById("resetForm");
const deadEndEl  = document.getElementById("deadEnd");
const deadEndTxt = document.getElementById("deadEndText");
const doneEl     = document.getElementById("done");
const pwInput    = document.getElementById("newPassword");
const pwConfirm  = document.getElementById("confirmPassword");
const saveBtn    = document.getElementById("saveBtn");
const gateEl     = document.getElementById("gateHint");

function showStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status visible " + kind;
}

function showStatusRich(title, text, kind) {
  statusEl.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = title;
  statusEl.appendChild(strong);
  statusEl.appendChild(document.createTextNode(text));
  statusEl.className = "status visible " + kind;
}

function deadEnd(title, message, hint) {
  checkingEl.hidden = true;
  formEl.hidden = true;
  doneEl.hidden = true;
  deadEndTxt.textContent = hint;
  deadEndEl.hidden = false;
  showStatusRich(title, message, "error");
}

// ---- the gate ----
//
// Same floor and same wording as editaccount.html, deliberately: those
// are the two places in the app where a password gets set, so they
// should refuse the same things for the same reasons. The floor is 8.
// index.html's sign-in box has no floor at all, and that is also
// deliberate — a floor there would lock out anyone still on an older,
// shorter password, i.e. exactly the people who need to reach this page.

const pwTouched = new Set();
let saving = false;

function refreshGate() {
  const pw = pwInput.value;
  const confirm = pwConfirm.value;
  const longEnough = passwordLongEnough(pw);
  const matches = Boolean(confirm) && confirm === pw;

  pwInput.classList.toggle("is-invalid", pwTouched.has(pwInput) && Boolean(pw) && !longEnough);
  pwConfirm.classList.toggle("is-invalid", pwTouched.has(pwConfirm) && Boolean(confirm) && !matches);

  saveBtn.disabled = saving || !longEnough || !matches;

  if (saving)                gateEl.textContent = "Saving…";
  else if (!pw && !confirm)  gateEl.textContent = passwordPolicyText();
  else if (!longEnough)      gateEl.textContent = passwordTooShortText();
  else if (!matches)         gateEl.textContent = "Type the same password in both boxes.";
  else                       gateEl.textContent = "";
}

[pwInput, pwConfirm].forEach(el => {
  el.addEventListener("input", refreshGate);
  el.addEventListener("blur", () => { pwTouched.add(el); refreshGate(); });
});

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (saveBtn.disabled) return;

  saving = true;
  refreshGate();

  try {
    const { error } = await supabaseClient.auth.updateUser({ password: pwInput.value });
    if (error) throw error;

    // The recovery session is a one-time key to this page and nothing
    // else. Ending it here means a shared or borrowed browser isn't
    // left signed in, and it forces the new password to be used at
    // least once — which is how someone finds out immediately if they
    // mistyped the same thing into both boxes.
    await supabaseClient.auth.signOut();

    formEl.hidden = true;
    doneEl.hidden = false;
    showStatusRich("Password updated", "Sign in with your new password.", "success");
  } catch (err) {
    console.error("Couldn't set the new password:", err);

    // Supabase rejects a password identical to the current one. Worth
    // saying plainly — a generic "couldn't save" sends someone hunting
    // for a problem that isn't there.
    const msg = String(err && err.message ? err.message : "");
    if (/should be different|same.*password/i.test(msg)) {
      showStatus("That's already your password. Choose a different one.", "error");
    } else if (/short|at least|characters/i.test(msg)) {
      showStatus("That password is too short. " + passwordTooShortText(), "error");
    } else if (/expired|invalid|token|session/i.test(msg)) {
      deadEnd(
        "Link expired",
        "Reset links are single-use and last about an hour. Request a new one from the sign-in page.",
        "Head back and send yourself a fresh link."
      );
    } else {
      showStatus("Couldn't save the new password. Try again.", "error");
    }
  } finally {
    saving = false;
    refreshGate();
  }
});

// ---- was this page reached from a recovery link? ----
//
// Read before anything else on this page runs, because the Supabase
// client strips the token out of the URL as soon as it has parsed it
// and this is the only chance to see it.
//
// This gate used to be "is there a session?", which is not the same
// question. Any signed-in person who navigated here — or anyone
// sitting at an unattended, still-signed-in browser — got the form
// and could set a new password without knowing the old one. Setting a
// password is exactly the operation that must not ride on an existing
// session: the whole point of a recovery link is that it proves
// control of the mailbox.
//
// The first attempt at that fix corroborated the session with
// "type=recovery appeared in the URL", which reintroduced the same
// hole in a quieter form. type=recovery is a LABEL, not a credential:
// it is four words anyone can type into the address bar. Navigating an
// already-signed-in browser to
//
//     reset-password.html#type=recovery
//
// satisfied the check, the poll below found the ordinary dashboard
// session, and the form unlocked. updateUser() then changed the
// password of whoever was signed in, without the old one — exactly the
// takeover the comment above says is being prevented.
//
// So the gate now asks for two things that cannot be typed:
//
//   a credential   #access_token=... (implicit) or ?code=... (PKCE).
//                  type= is ignored entirely; it carries no proof.
//   a NEW session  the session in hand must not be the one that was
//                  already in storage when this page loaded.
//
// The second is what closes the remaining gap. A forged or expired
// access_token in the fragment fails to parse, leaves the pre-existing
// session untouched, and would otherwise still look like "credential
// present + session present".
const RECOVERY_CREDENTIAL_IN_URL = (() => {
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const q = new URLSearchParams(window.location.search);
  return Boolean(h.get("access_token")) || Boolean(q.get("code"));
})();

// The access token already in storage at page load, or null.
//
// Read synchronously, as the first thing this file does, so it happens
// before the client's asynchronous URL parse can overwrite it. Reaching
// into supabase-js's storage key is not lovely, but the alternative is
// asking the library a question it has no API for: "is this session the
// one you just minted, or the one you found?"
//
// Both failure modes are safe. Can't find the key, or it isn't
// JSON: returns null, no session matches null, and the freshness test
// passes on the strength of the credential alone. Read too late (the
// client already swapped in the new session): the tokens compare equal,
// the test FAILS, and a legitimate reset is refused with "link
// expired" — annoying, recoverable in one click, and not a takeover.
// PASSWORD_RECOVERY below is what keeps that case rare.
const PRIOR_ACCESS_TOKEN = (() => {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.*-auth-token$/.test(key)) continue;
      const parsed = JSON.parse(localStorage.getItem(key));
      if (parsed && typeof parsed.access_token === "string") return parsed.access_token;
    }
  } catch (_) {
    // Private mode, storage disabled, a shape we don't recognise.
  }
  return null;
})();

// A session is evidence only if the link produced it.
function sessionIsFromThisLink(session) {
  return Boolean(session) &&
         RECOVERY_CREDENTIAL_IN_URL &&
         session.access_token !== PRIOR_ACCESS_TOKEN;
}

// ---- getting a session out of the link ----
//
// The Supabase client parses the recovery token out of the URL itself
// (detectSessionInUrl), but asynchronously, so the session is usually
// not there yet on the first tick. Two things are watched rather than
// one: the PASSWORD_RECOVERY event, and a poll of getSession() — the
// event alone misses the case where the client finished before this
// listener attached, and the poll alone adds latency the event doesn't.

(async () => {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const params     = new URLSearchParams(window.location.search);

  // Supabase reports a dead link as an error in the fragment rather
  // than by failing the redirect, so the expired/already-used case
  // arrives looking like a perfectly successful page load.
  const linkError = hashParams.get("error_description") || hashParams.get("error")
                 || params.get("error_description")     || params.get("error");
  if (linkError) {
    history.replaceState(null, "", window.location.pathname);
    deadEnd(
      "Link expired",
      "Reset links are single-use and last about an hour. Request a new one from the sign-in page.",
      "Head back and send yourself a fresh link."
    );
    return;
  }

  // `settled` means "a verdict has been shown", not "no further
  // verdict is possible". The poll gives up after 2.5s, and on a slow
  // connection the client can finish parsing the token after that —
  // so unlock() has to be able to overturn a dead end that has already
  // been drawn. It guards only against unlocking twice, which would
  // steal focus from someone mid-keystroke.
  let settled = false;
  let unlocked = false;

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    settled = true;

    // Take the token out of the address bar. It stays valid for the
    // life of this session either way, but leaving it in history and
    // in any URL someone copies is free risk for no benefit.
    history.replaceState(null, "", window.location.pathname);

    checkingEl.hidden = true;
    deadEndEl.hidden = true;
    formEl.hidden = false;
    refreshGate();
    pwInput.focus();
  }

  // PASSWORD_RECOVERY is Supabase's own confirmation that what it just
  // consumed was a recovery token. It is the only signal here that
  // comes from the library rather than from the URL, so it stands on
  // its own and is the path almost every real reset takes.
  //
  // A plain session never stands on its own: it has to be a session
  // this link produced, which is what sessionIsFromThisLink() checks.

  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      unlock();
      return;
    }
    if (sessionIsFromThisLink(session)) unlock();
  });

  // Poll alongside the listener. Ten tries at 250ms covers a slow
  // network without leaving anyone staring at "Checking your link…"
  // forever when the token was never there to begin with.
  //
  // `sawSession` deliberately records that SOME session exists, which
  // is a different thing from the link having worked — it is what
  // picks the "Already signed in" wording at the bottom rather than
  // "No reset link found".
  let sawSession = false;
  for (let i = 0; i < 10 && !settled; i++) {
    const { data } = await supabaseClient.auth.getSession();
    if (data && data.session) {
      sawSession = true;
      if (sessionIsFromThisLink(data.session)) { unlock(); return; }
      break;
    }
    await new Promise(r => setTimeout(r, 250));
  }

  if (!settled) {
    settled = true;
    if (sawSession) {
      // Signed in, but not from a reset link. Point them at the two
      // routes that do prove something, rather than at a form that
      // would change the password of whoever happens to be logged in.
      deadEnd(
        "Already signed in",
        "This page only works from a password reset link. To change your " +
        "password while signed in, use Edit Account — it will ask for your " +
        "current password.",
        "Or sign out and request a reset link from the sign-in page."
      );
    } else {
      deadEnd(
        "No reset link found",
        "Open this page from the link in your password reset email.",
        "If your link has expired, request a new one from the sign-in page."
      );
    }
  }
})();

// Eye buttons on both password boxes, from config.js — the same
// treatment sign-in, registration and Edit Account get.
if (typeof initSharedBehaviour === "function") initSharedBehaviour();
