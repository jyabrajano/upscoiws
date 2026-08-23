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

function showStatusRich(heading, message, type) {
  statusEl.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = heading;
  statusEl.appendChild(strong);
  statusEl.appendChild(document.createTextNode(message));
  statusEl.className = `status visible ${type}`;
}

function showAccessMessage(state, reason) {
  if (state === "pending") {
    showStatusRich("Account Status:", "Under review. Contact the administrator for more information.", "notice");
  } else if (state === "rejected") {
    showStatusRich("Access not approved", reason ? `The Cash Office didn't approve this account: ${reason}` : "The Cash Office didn't approve this account. Contact the Cash Office if you think this is a mistake.", "error");
  } else if (state === "disabled") {
    showStatusRich("Account disabled", reason ? `This account has been switched off by the Cash Office: ${reason}` : "This account has been switched off by the Cash Office. Contact them if you need it back.", "error");
  } else if (state === "setup") {
    showStatusRich("Portal not set up yet", "The approval tables are missing from the database. Whoever installed " + "this needs to run deploy-schema.sql in the Supabase SQL Editor.", "error");
  } else if (state === "missing") {
    showStatusRich("No profile on file", "This login exists but has no profile record yet. Contact the Cash Office so they can set it up.", "error");
  }
}

function showEmailNotConfirmed(target) {
  statusEl.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = "Confirm your email first";
  statusEl.appendChild(strong);
  statusEl.appendChild(document.createTextNode("Open the confirmation link we emailed you, then sign in again."));
  const resendBtn = document.createElement("button");
  resendBtn.type = "button";
  resendBtn.className = "status-action";
  resendBtn.textContent = "Resend confirmation email";
  resendBtn.addEventListener("click", async () => {
    resendBtn.disabled = true;
    resendBtn.textContent = "Sending…";
    try {
      const {error: error} = await supabaseClient.auth.resend({
        type: "signup",
        email: target,
        options: {
          emailRedirectTo: new URL("index.html", window.location.href).href
        }
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
    const {error: error} = await supabaseClient.auth.resetPasswordForEmail(target, {
      redirectTo: redirectTo
    });
    if (error) throw error;
    showStatusRich("Check your email", `If ${target} is registered, a reset link is on its way.`, "notice");
    resetPanel.classList.remove("open");
    resetEmailInput.value = "";
  } catch (err) {
    console.error("Couldn't send the reset link:", err);
    showStatus("Couldn't send the reset link. Try again.", "error");
  } finally {
    refreshResetGate();
  }
});

resetEmailInput.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendResetBtn.click();
  }
});

ssoBtn.addEventListener("click", async () => {
  try {
    const {error: error} = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: new URL("index.html", window.location.href).href,
        queryParams: {
          hd: "up.edu.ph"
        }
      }
    });
    if (error) throw error;
  } catch (err) {
    showStatus(err.message || "Failed to authenticate with UP Mail. Please try again.", "error");
  }
});

const DENIED = "Access denied: if the given details are valid, Please contact the administrator.";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const gateEl = document.getElementById("signInGate");

const touched = new WeakSet;

let refused = false;

let signingIn = false;

let asked = false;

function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "status";
}

function refreshGate() {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const filled = Boolean(email && password);
  const badEmail = Boolean(email) && !EMAIL_RE.test(email);
  emailInput.classList.toggle("is-invalid", asked && touched.has(emailInput) && (!email || badEmail));
  passwordInput.classList.toggle("is-invalid", asked && touched.has(passwordInput) && !password);
  submitBtn.disabled = signingIn || !filled || refused;
  if (signingIn) {
    gateEl.textContent = "";
    return;
  }
  if (!filled) {
    gateEl.textContent = "Enter your email and password to continue.";
    return;
  }
  gateEl.textContent = "";
}

[ emailInput, passwordInput ].forEach(el => {
  el.addEventListener("input", () => {
    if (refused) {
      refused = false;
      clearStatus();
    }
    refreshGate();
  });
  el.addEventListener("blur", () => {
    touched.add(el);
    refreshGate();
  });
});

function refreshResetGate() {
  sendResetBtn.disabled = !EMAIL_RE.test(resetEmailInput.value.trim());
}

resetEmailInput.addEventListener("input", refreshResetGate);

refreshGate();

refreshResetGate();

form.addEventListener("submit", async e => {
  e.preventDefault();
  if (submitBtn.disabled) return;
  asked = true;
  touched.add(emailInput);
  touched.add(passwordInput);
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!EMAIL_RE.test(email)) {
    refused = true;
    showStatus(DENIED, "error");
    refreshGate();
    return;
  }
  signingIn = true;
  submitBtn.disabled = true;
  clearStatus();
  try {
    const {data: data, error: error} = await supabaseClient.auth.signInWithPassword({
      email: email,
      password: password
    });
    if (error) {
      const notConfirmed = error.code === "email_not_confirmed" || /email not confirmed/i.test(error.message || "");
      if (notConfirmed) {
        showEmailNotConfirmed(email);
        return;
      }
      throw error;
    }
    if (redeemPendingPrivacyAck(data.user.email)) {
      await recordPrivacyNoticeAck();
    }
    if (await mfaNeedsChallenge()) {
      const passed = await promptForMfaCode();
      if (!passed) {
        // Signed out on purpose: a session that stopped halfway must not
        // survive the page. But say so — the previous version dropped
        // the person back to a blank form with no explanation, which
        // reads as "sign-in is broken" rather than "you cancelled".
        await supabaseClient.auth.signOut();
        showStatusRich("Sign-in not completed", "You'll need the code from your authenticator app to finish signing in.", "notice");
        return;
      }
    }
    const state = await getApprovalState(data.user.email);
    if (state.status !== "approved") {
      await supabaseClient.auth.signOut();
      showAccessMessage(state.status, state.reason);
      return;
    }
    await recordAccountEvent("sign_in", sharedDevice() ? {shared_device: true} : null);
    window.location.href = safeReturnTarget();
    return;
  } catch (err) {
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
  if (hashParams.get("type") === "recovery" || params.get("type") === "recovery") {
    window.location.replace("reset-password.html" + window.location.search + window.location.hash);
    return;
  }
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
  if (hashParams.get("type") === "signup" || params.get("type") === "signup") {
    history.replaceState(null, "", window.location.pathname);
    const session = await waitForSession(8e3);
    if (session) {
      const state = await getApprovalState(session.user.email);
      if (state.status === "approved") {
        await recordAccountEvent("sign_in");
        window.location.href = safeReturnTarget();
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
  const registered = params.get("registered");
  if (registered) {
    showStatusRich(registered === "confirm" ? "Check your email" : "Request received", registered === "confirm" ? "Confirm your address, then wait for Cash Office approval." : "The Cash Office will review it and email you when it's approved.", "notice");
    history.replaceState(null, "", window.location.pathname);
    return;
  }
  if (params.get("reset") === "done") {
    showStatusRich("Password updated", "Sign in with your new password.", "success");
    history.replaceState(null, "", window.location.pathname);
    return;
  }
  if (params.get("expired") === "1") {
    showStatusRich("Session expired", "Sign-ins last eight hours, however busy the tab is. " + "Sign in again to carry on.", "notice");
    history.replaceState(null, "", window.location.pathname);
    return;
  }
  if (params.get("timeout") === "1") {
    showStatusRich("Signed out", "You were signed out after five minutes of inactivity, so your " + "account details aren't left on screen. Sign in again to carry on.", "notice");
    history.replaceState(null, "", window.location.pathname);
    return;
  }
  const access = params.get("access");
  if (access) {
    showAccessMessage(access, null);
    history.replaceState(null, "", window.location.pathname);
    return;
  }
  if (hashParams.get("access_token") || params.get("code")) {
    const session = await waitForSession(1e4);
    history.replaceState(null, "", window.location.pathname);
    if (!session) {
      showStatusRich("Couldn't complete sign-in", "UP Mail didn't return a valid session. Try again, or sign in with your email and password.", "error");
      return;
    }
    if (await mfaNeedsChallenge()) {
      const passed = await promptForMfaCode();
      if (!passed) {
        // Signed out on purpose: a session that stopped halfway must not
        // survive the page. But say so — the previous version dropped
        // the person back to a blank form with no explanation, which
        // reads as "sign-in is broken" rather than "you cancelled".
        await supabaseClient.auth.signOut();
        showStatusRich("Sign-in not completed", "You'll need the code from your authenticator app to finish signing in.", "notice");
        return;
      }
    }
    const state = await getApprovalState(session.user.email);
    if (state.status === "approved") {
      await recordAccountEvent("sign_in");
      window.location.href = safeReturnTarget();
      return;
    }
    await supabaseClient.auth.signOut();
    showAccessMessage(state.status, state.reason);
    return;
  }
  try {
    const {data: {session: session}} = await supabaseClient.auth.getSession();
    if (session) window.location.href = safeReturnTarget();
  } catch (_) {}
})();


// "This is a shared computer" — read at sign-in time by the storage
// adapter in config.js, which routes the session to sessionStorage so it
// dies with the browser. Set on change rather than on submit, because
// the UP Mail button leaves the page without ever submitting the form.
const sharedDeviceBox = document.getElementById("sharedDevice");
if (sharedDeviceBox) {
  sharedDeviceBox.checked = sharedDevice();
  sharedDeviceBox.addEventListener("change", () => setSharedDevice(sharedDeviceBox.checked));
}


// ---------------------------------------------------------------------
// The sign-in code prompt
//
// Shown only when a verified factor exists and this session has not yet
// reached aal2. Resolves true once the code is accepted, false if the
// person gives up — and the caller signs them out on false, so a
// half-authenticated session never survives the page.
//
// Built here rather than as markup in index.html because it must not be
// present in the DOM for the great majority of sign-ins that never see
// it.
// ---------------------------------------------------------------------
async function promptForMfaCode() {
  let factors;
  try {
    factors = await mfaListFactors();
  } catch (err) {
    console.error("Couldn't list your verification methods:", err);
    showStatusRich("Couldn't complete sign-in", "We couldn't check your two-step verification. Try again in a moment.", "error");
    return false;
  }
  const factor = factors.find(f => f.status === "verified");
  if (!factor) return true;

  if (!document.getElementById("mfaPromptStyles")) {
    const style = document.createElement("style");
    style.id = "mfaPromptStyles";
    style.textContent = ".mfa-back{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.6);font:14px/1.55 system-ui,sans-serif;}" + ".mfa-card{max-width:380px;width:100%;background:#fff;border-radius:14px;padding:26px;box-shadow:0 12px 40px rgba(15,23,42,.28);color:#0f172a;text-align:center;}" + ".mfa-card h2{margin:0 0 6px;font-size:17px;}" + ".mfa-card p{margin:0 0 16px;font-size:13px;color:#475569;}" + ".mfa-card input{width:100%;padding:12px;font:600 22px/1 ui-monospace,monospace;letter-spacing:.32em;text-align:center;border:1.5px solid #cbd5e1;border-radius:10px;box-sizing:border-box;}" + ".mfa-card input:focus{outline:none;border-color:#7b1113;box-shadow:0 0 0 3px rgba(123,17,19,.08);}" + ".mfa-err{min-height:18px;margin:8px 0 0;font-size:12.5px;color:#b91c1c;}" + ".mfa-actions{display:flex;gap:8px;margin-top:14px;}" + ".mfa-actions button{flex:1;border:0;border-radius:10px;padding:12px;font:700 13.5px/1 inherit;cursor:pointer;}" + ".mfa-go{background:#7b1113;color:#fff;}.mfa-go:disabled{opacity:.45;cursor:default;}" + ".mfa-cancel{background:#e2e8f0;color:#0f172a;}";
    document.head.appendChild(style);
  }

  return new Promise(resolve => {
    const back = document.createElement("div");
    back.className = "mfa-back";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    back.innerHTML = '<div class="mfa-card">' + "<h2>Enter your verification code</h2>" + "<p>Open your authenticator app and type the six-digit code for the Cash Office portal.</p>" + '<input type="text" id="mfaCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-label="Six-digit verification code">' + '<p class="mfa-err" id="mfaErr" aria-live="polite"></p>' + '<div class="mfa-actions">' + '<button type="button" class="mfa-cancel" id="mfaCancel">Cancel</button>' + '<button type="button" class="mfa-go" id="mfaGo" disabled>Verify</button>' + "</div></div>";
    document.body.appendChild(back);

    const input = back.querySelector("#mfaCode");
    const go = back.querySelector("#mfaGo");
    const err = back.querySelector("#mfaErr");

    function close(value) {
      back.remove();
      resolve(value);
    }

    async function submit() {
      if (!mfaCodeLooksValid(input.value)) return;
      go.disabled = true;
      input.disabled = true;
      err.textContent = "";
      try {
        await mfaChallengeExisting(factor.id, input.value);
        close(true);
      } catch (e) {
        // A wrong code is the ordinary case, not an incident. Clear the
        // field and let them try again rather than dropping them back
        // to a blank sign-in form.
        console.warn("Verification failed:", e);
        err.textContent = "That code didn't work. Codes change every 30 seconds — try the current one.";
        input.disabled = false;
        input.value = "";
        input.focus();
        go.disabled = true;
      }
    }

    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 6);
      go.disabled = !mfaCodeLooksValid(input.value);
      if (mfaCodeLooksValid(input.value)) submit();
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") submit();
    });
    go.addEventListener("click", submit);
    back.querySelector("#mfaCancel").addEventListener("click", () => close(false));

    input.focus();
  });
}
