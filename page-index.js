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
    const state = await getApprovalState(data.user.email);
    if (state.status !== "approved") {
      await supabaseClient.auth.signOut();
      showAccessMessage(state.status, state.reason);
      return;
    }
    window.location.href = "dashboard.html";
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
    let session = null;
    const started = Date.now();
    while (!session && Date.now() - started < 2500) {
      ({data: {session: session}} = await supabaseClient.auth.getSession());
      if (!session) await new Promise(r => setTimeout(r, 250));
    }
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
    let session = null;
    const started = Date.now();
    while (!session && Date.now() - started < 5e3) {
      ({data: {session: session}} = await supabaseClient.auth.getSession());
      if (!session) await new Promise(r => setTimeout(r, 250));
    }
    history.replaceState(null, "", window.location.pathname);
    if (!session) {
      showStatusRich("Couldn't complete sign-in", "UP Mail didn't return a valid session. Try again, or sign in with your email and password.", "error");
      return;
    }
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
    const {data: {session: session}} = await supabaseClient.auth.getSession();
    if (session) window.location.href = "dashboard.html";
  } catch (_) {}
})();
