// Version marker for the build stamp in config.js. Bump with the
// BUILD_ID there whenever this file changes, so a stale copy on the
// server announces itself instead of looking like a broken feature.
window.__BUILD = window.__BUILD || {};
window.__BUILD["index"] = "2026-08-07-h";

const form = document.getElementById("authForm");
const statusEl = document.getElementById("status");
const submitBtn = document.getElementById("submitBtn");
const passwordInput = document.getElementById("password");
const ssoBtn = document.getElementById("ssoBtn");
const forgotRow = document.getElementById("forgotRow");
const forgotBtn = document.getElementById("forgotBtn");
const resetPanel = document.getElementById("resetPanel");
const resetEmailInput = document.getElementById("resetEmail");
const sendResetBtn = document.getElementById("sendResetBtn");
const emailInput = document.getElementById("email");

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status visible ${type}`;
}

// Same thing with a bold first line, for the longer
// approval-related messages.
function showStatusRich(heading, message, type) {
  statusEl.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = heading;
  statusEl.appendChild(strong);
  statusEl.appendChild(document.createTextNode(message));
  statusEl.className = `status visible ${type}`;
}

// Turns an approval state into what the person needs to read.
function showAccessMessage(state, reason) {
  if (state === "pending") {
    showStatusRich(
      "Waiting for approval",
      "Your registration is still with the Cash Office. You'll get an email " +
      "as soon as it's approved, and you can sign in from here after that.",
      "notice"
    );
  } else if (state === "rejected") {
    showStatusRich(
      "Access not approved",
      reason
        ? `The Cash Office didn't approve this account: ${reason}`
        : "The Cash Office didn't approve this account. Contact the Cash Office if you think this is a mistake.",
      "error"
    );
  } else if (state === "disabled") {
    showStatusRich(
      "Account disabled",
      reason
        ? `This account has been switched off by the Cash Office: ${reason}`
        : "This account has been switched off by the Cash Office. Contact them if you need it back.",
      "error"
    );
  } else if (state === "setup") {
    showStatusRich(
      "Portal not set up yet",
      "The approval tables are missing from the database. Whoever installed " +
      "this needs to run deploy-schema.sql in the Supabase SQL Editor.",
      "error"
    );
  } else if (state === "missing") {
    showStatusRich(
      "No profile on file",
      "This login exists but has no profile record yet. Contact the Cash Office so they can set it up.",
      "error"
    );
  }
}

// Shown when the password was right but the address hasn't been
// verified — which only happens if "Confirm email" is switched on
// in Supabase. Without this, Supabase's own wording ("Email not
// confirmed") reads like a rejection and there's nowhere to go
// from it.
function showEmailNotConfirmed(target) {
  statusEl.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = "Confirm your email first";
  statusEl.appendChild(strong);
  statusEl.appendChild(document.createTextNode(
    "Open the confirmation link we emailed you, then sign in again."
  ));

  const resendBtn = document.createElement("button");
  resendBtn.type = "button";
  resendBtn.className = "status-action";
  resendBtn.textContent = "Resend confirmation email";
  resendBtn.addEventListener("click", async () => {
    resendBtn.disabled = true;
    resendBtn.textContent = "Sending…";
    try {
      const { error } = await supabaseClient.auth.resend({
        type: "signup",
        email: target,
        options: { emailRedirectTo: new URL("index.html", window.location.href).href },
      });
      if (error) throw error;
      resendBtn.textContent = "Sent — check your inbox";
    } catch (err) {
      console.error("Couldn't resend the confirmation email:", err);
      resendBtn.textContent = "Couldn't resend — try again";
      resendBtn.disabled = false;
    }
  });
  statusEl.appendChild(resendBtn);
  statusEl.className = "status visible error";
}

// ---- forgot password ----
//
// Supabase mails a one-time link that lands on reset-password.html
// with a short-lived recovery session attached. The new password is
// set there, not here.
//
// Note the wording of the confirmation: Supabase deliberately
// reports success whether or not the address has an account, so
// that this form can't be used to find out who's registered. The
// message says "if" for the same reason.

forgotBtn.addEventListener("click", () => {
  const opening = !resetPanel.classList.contains("open");
  resetPanel.classList.toggle("open", opening);
  if (opening) {
    if (!resetEmailInput.value) resetEmailInput.value = emailInput.value.trim();
    resetEmailInput.focus();
  }
});

sendResetBtn.addEventListener("click", async () => {
  const target = resetEmailInput.value.trim();
  if (sendResetBtn.disabled || !EMAIL_RE.test(target)) return;

  sendResetBtn.disabled = true;
  try {
    const redirectTo = new URL("reset-password.html", window.location.href).href;
    const { error } = await supabaseClient.auth.resetPasswordForEmail(target, { redirectTo });
    if (error) throw error;

    showStatusRich("Check your email", `If ${target} is registered, a reset link is on its way.`, "notice");
    resetPanel.classList.remove("open");
    resetEmailInput.value = "";
  } catch (err) {
    // Same wording whatever went wrong — a rate-limit message
    // would tell someone their guess was worth repeating.
    console.error("Couldn't send the reset link:", err);
    showStatus("Couldn't send the reset link. Try again.", "error");
  } finally {
    refreshResetGate();
  }
});

resetEmailInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendResetBtn.click();
  }
});

// UP Mail (@up.edu.ph) SSO via Google OAuth domain restriction
ssoBtn.addEventListener("click", async () => {
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        // Back to THIS page, not straight to dashboard.html, for two
        // reasons.
        //
        // Supabase only redirects to an address on its own allowlist
        // (Authentication -> URL Configuration). Sending people to
        // dashboard.html meant that page had to be listed too, and
        // when it wasn't, Google sign-in failed with "requested path
        // is invalid" before it ever reached the portal -- nothing
        // here could report that.
        //
        // And when Supabase rejects a Google sign-in outright it hands
        // the reason back in the URL fragment. index.html is the page
        // that reads that fragment -- see the linkError branch at the
        // bottom of this file, which already anticipates exactly this
        // -- and the page that knows how to show an approval state.
        // dashboard.html would have bounced them back here with the
        // reason discarded.
        //
        // Relative to this page, not to the origin root, so serving
        // the portal from a subpath (https://host/upscoiws/) still
        // resolves correctly.
        redirectTo: new URL("index.html", window.location.href).href,
        queryParams: {
          // A hint to Google's account picker, NOT a restriction —
          // it is a query parameter the client controls and can drop.
          // The domain rule is enforced in handle_new_user(), gated by
          // up_mail_restriction_enabled(), which currently returns
          // false. Nothing restricts the domain today.
          //
          // To turn it on, change that SQL function and nothing else.
          // This comment used to say to flip it "together with
          // UP_MAIL_RESTRICTION_ENABLED in registration.html", which
          // has not been true since that second copy was removed —
          // config.js explains at length why one switch replaced two.
          // Following the old instruction sends you looking for a
          // constant that isn't there, and the natural next move is to
          // add it back.
          hd: 'up.edu.ph'
        }
      }
    });
    if (error) throw error;
  } catch (err) {
    showStatus(err.message || "Failed to authenticate with UP Mail. Please try again.", "error");
  }
});

// ---- the sign-in gate ----
//
// Sign In stays disabled until both boxes are filled and the
// address is shaped like one. A refused attempt disables it
// again until something is edited, and says the same single
// line whatever the reason: a wrong password, an address with
// no account, and a rate limit all read alike. Telling them
// apart is how a stranger finds out who has an account here.
//
// The gate is a convenience, not the guard. Supabase Auth and
// the RLS policies in deploy-schema.sql are what actually refuse.

const DENIED =
  "Access denied: if the given details are valid, Please contact the administrator.";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const gateEl = document.getElementById("signInGate");
const touched = new WeakSet();
let refused = false;
let signingIn = false;

function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "status";
}

function refreshGate() {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const filled = Boolean(email && password);
  const badEmail = Boolean(email) && !EMAIL_RE.test(email);

  emailInput.classList.toggle("is-invalid", touched.has(emailInput) && (!email || badEmail));
  passwordInput.classList.toggle("is-invalid", touched.has(passwordInput) && !password);

  submitBtn.disabled = signingIn || !filled || badEmail || refused;

  if (signingIn)  { gateEl.textContent = ""; return; }
  if (!filled)    { gateEl.textContent = "Enter your email and password to continue."; return; }
  gateEl.textContent = "";
  if (badEmail || refused) showStatus(DENIED, "error");
}

[emailInput, passwordInput].forEach(el => {
  el.addEventListener("input", () => {
    if (refused) { refused = false; clearStatus(); }
    refreshGate();
  });
  el.addEventListener("blur", () => { touched.add(el); refreshGate(); });
});

// Send link follows the same rule — no half-typed address goes out.
function refreshResetGate() {
  sendResetBtn.disabled = !EMAIL_RE.test(resetEmailInput.value.trim());
}
resetEmailInput.addEventListener("input", refreshResetGate);

refreshGate();
refreshResetGate();

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (submitBtn.disabled) return;

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  signingIn = true;
  submitBtn.disabled = true;
  clearStatus();

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      const notConfirmed =
        error.code === "email_not_confirmed" ||
        /email not confirmed/i.test(error.message || "");
      if (notConfirmed) {
        showEmailNotConfirmed(email);
        return;
      }
      throw error;
    }

    // With email confirmation on, signUp() returns no session, so
    // registration.html had no JWT to write the privacy-notice receipt
    // with. First sign-in is the earliest moment there is one.
    //
    // This used to call recordPrivacyNoticeAck() unconditionally, on
    // the reasoning that the RPC is idempotent so calling it always is
    // harmless. Idempotent it is; harmless it is not. It writes an
    // acknowledgement for whoever is signing in, and only people who
    // came through registration.html have acknowledged anything --
    // Google SSO never loads that page, so those users were being
    // issued a timestamped, versioned receipt for a notice they had
    // never seen. The receipt is the artefact you would produce to
    // show compliance with RA 10173 s.16, which makes a false one
    // considerably worse than a missing one.
    //
    // Now it redeems only a marker that registration.html actually
    // parked for this address. Everyone else is asked properly, by the
    // gate on the dashboard.
    //
    // Awaited, unlike before: the very next branch can call signOut(),
    // and a write racing its own JWT out of existence is not a receipt
    // anyone should rely on.
    if (redeemPendingPrivacyAck(data.user.email)) {
      await recordPrivacyNoticeAck();
    }

    // The credentials were right, but that isn't the same as
    // having access. The database enforces this too (see
    // deploy-schema.sql) — this check is so the person gets a
    // straight answer instead of an empty dashboard.
    const state = await getApprovalState(data.user.email);
    if (state.status !== "approved") {
      await supabaseClient.auth.signOut();
      // This one stays specific. The password was right, so it's
      // the account holder reading it, and "waiting for approval"
      // is the only thing that tells them what to do next.
      showAccessMessage(state.status, state.reason);
      return;
    }

    window.location.href = "dashboard.html";
    return;
  } catch (err) {
    // The console keeps the real reason for whoever maintains
    // this. The page doesn't.
    console.error("Sign-in failed:", err);
    refused = true;
    showStatus(DENIED, "error");
  } finally {
    signingIn = false;
    refreshGate();
  }
});

(async () => {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  // If the Site URL in Supabase points at index.html, a recovery
  // link lands here instead of on the reset page. Hand it over
  // with the token intact rather than dropping the person on a
  // sign-in form they can't get past.
  if (hashParams.get("type") === "recovery" || params.get("type") === "recovery") {
    window.location.replace(
      "reset-password.html" + window.location.search + window.location.hash
    );
    return;
  }

  // Expired or already-used link, OR a Google sign-in Supabase
  // rejected outright — both land here as an error in the
  // fragment rather than by failing the redirect, so they're
  // told apart by message rather than by which flow sent them.
  // handle_new_user() in deploy-schema.sql raises with the
  // "up_mail_required:" prefix specifically so this check works.
  const linkError = hashParams.get("error_description") || hashParams.get("error");
  if (linkError) {
    history.replaceState(null, "", window.location.pathname);
    if (/up_mail_required/i.test(linkError)) {
      showStatusRich("UP Mail required", "This portal only accepts up.edu.ph Google accounts. Sign in with your UP Mail address instead.", "error");
    } else {
      showStatusRich("Link expired", "Reset links are single-use and last about an hour. Request a new one below.", "error");
    }
    return;
  }

  // The link from a confirmation email lands back here with
  // type=signup. supabase-js reads the token out of the URL on its
  // own, but not instantly, so give it a moment before deciding
  // whether it worked.
  if (hashParams.get("type") === "signup" || params.get("type") === "signup") {
    history.replaceState(null, "", window.location.pathname);

    let session = null;
    const started = Date.now();
    while (!session && Date.now() - started < 2500) {
      ({ data: { session } } = await supabaseClient.auth.getSession());
      if (!session) await new Promise(r => setTimeout(r, 250));
    }

    // Confirming an address isn't the same as being approved. An
    // account that's already been through the Cash Office goes
    // straight in; everyone else gets told where they stand.
    if (session) {
      const state = await getApprovalState(session.user.email);
      if (state.status === "approved") {
        window.location.href = "dashboard.html";
        return;
      }
      await supabaseClient.auth.signOut();
      if (state.status === "rejected" || state.status === "setup") {
        showAccessMessage(state.status, state.reason);
        return;
      }
    }

    showStatusRich("Email confirmed", "Waiting on Cash Office approval. We'll email you.", "success");
    return;
  }

  // Sent back here from registration.html.
  const registered = params.get("registered");
  if (registered) {
    showStatusRich(
      registered === "confirm" ? "Check your email" : "Request received",
      registered === "confirm"
        ? "Confirm your address, then wait for Cash Office approval."
        : "The Cash Office will review it and email you when it's approved.",
      "notice"
    );
    history.replaceState(null, "", window.location.pathname);
    return;
  }

  // Sent back here after a successful password change.
  if (params.get("reset") === "done") {
    showStatusRich("Password updated", "Sign in with your new password.", "success");
    history.replaceState(null, "", window.location.pathname);
    return;
  }

  // Sent back here by the idle timeout in config.js. Worth saying
  // plainly: an unexplained return to the sign-in page reads as the
  // portal having dropped the session on its own, and the natural
  // response to that is to stop trusting it.
  if (params.get("timeout") === "1") {
    showStatusRich(
      "Signed out",
      "You were signed out after five minutes of inactivity, so your " +
      "account details aren't left on screen. Sign in again to carry on.",
      "notice"
    );
    history.replaceState(null, "", window.location.pathname);
    return;
  }

  // A protected page will bounce someone back here with
  // ?access=pending / ?access=rejected when their account hasn't
  // been approved. Show why rather than an unexplained login screen.
  const access = params.get("access");
  if (access) {
    // No reason is read from the URL — see the note in config.js's
    // requireSession(). Anything here was written by whoever built
    // the link, and this page renders it as a Cash Office notice.
    showAccessMessage(access, null);
    history.replaceState(null, "", window.location.pathname);
    return;
  }

  // Back from Google. Two shapes depending on which flow supabase-js
  // used: #access_token=... (implicit) or ?code=... (PKCE). Either way
  // the library reads the credential out of the URL itself, and -- as
  // with the confirmation link above -- not instantly. The plain
  // getSession() below would often run first and find nothing, leaving
  // someone who had just signed in successfully sitting on the
  // sign-in form.
  //
  // The URL is cleaned up only AFTER the session is in hand, so
  // nothing is taken away from the library while it is still reading.
  if (hashParams.get("access_token") || params.get("code")) {
    let session = null;
    const started = Date.now();
    while (!session && Date.now() - started < 5000) {
      ({ data: { session } } = await supabaseClient.auth.getSession());
      if (!session) await new Promise(r => setTimeout(r, 250));
    }
    history.replaceState(null, "", window.location.pathname);

    if (!session) {
      showStatusRich("Couldn't complete sign-in", "UP Mail didn't return a valid session. Try again, or sign in with your email and password.", "error");
      return;
    }

    // Signing in is not the same as being allowed in. A UP Mail
    // account that has never been through the Cash Office is a pending
    // registration like any other.
    const state = await getApprovalState(session.user.email);
    if (state.status === "approved") {
      window.location.href = "dashboard.html";
      return;
    }
    await supabaseClient.auth.signOut();
    showAccessMessage(state.status, state.reason);
    return;
  }

  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) window.location.href = "dashboard.html";
  } catch (_) {}
})();
