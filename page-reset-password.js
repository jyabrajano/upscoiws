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
const RECOVERY_IN_URL = (() => {
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const q = new URLSearchParams(window.location.search);
  return h.get("type") === "recovery" ||
         q.get("type") === "recovery" ||
         Boolean(h.get("access_token")) ||
         Boolean(q.get("code"));
})();

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

  let settled = false;

  function unlock() {
    if (settled) return;
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

  // PASSWORD_RECOVERY is Supabase's own confirmation that what it
  // just consumed was a recovery token, so it stands on its own.
  // A plain session does not: it has to be corroborated by a recovery
  // token having been in the URL when the page loaded.
  let recoveryConfirmed = RECOVERY_IN_URL;

  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      recoveryConfirmed = true;
      unlock();
      return;
    }
    if (session && recoveryConfirmed) unlock();
  });

  // Poll alongside the listener. Ten tries at 250ms covers a slow
  // network without leaving anyone staring at "Checking your link…"
  // forever when the token was never there to begin with.
  let sawSession = false;
  for (let i = 0; i < 10 && !settled; i++) {
    const { data } = await supabaseClient.auth.getSession();
    if (data && data.session) {
      sawSession = true;
      if (recoveryConfirmed) { unlock(); return; }
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
