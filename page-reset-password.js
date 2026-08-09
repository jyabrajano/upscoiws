const statusEl = document.getElementById("status");

const checkingEl = document.getElementById("checking");

const formEl = document.getElementById("resetForm");

const deadEndEl = document.getElementById("deadEnd");

const deadEndTxt = document.getElementById("deadEndText");

const doneEl = document.getElementById("done");

const pwInput = document.getElementById("newPassword");

const pwConfirm = document.getElementById("confirmPassword");

const saveBtn = document.getElementById("saveBtn");

const gateEl = document.getElementById("gateHint");

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

const pwTouched = new Set;

let saving = false;

function refreshGate() {
  const pw = pwInput.value;
  const confirm = pwConfirm.value;
  const longEnough = passwordLongEnough(pw);
  const matches = Boolean(confirm) && confirm === pw;
  pwInput.classList.toggle("is-invalid", pwTouched.has(pwInput) && Boolean(pw) && !longEnough);
  pwConfirm.classList.toggle("is-invalid", pwTouched.has(pwConfirm) && Boolean(confirm) && !matches);
  saveBtn.disabled = saving || !longEnough || !matches;
  if (saving) gateEl.textContent = "Saving…"; else if (!pw && !confirm) gateEl.textContent = passwordPolicyText(); else if (!longEnough) gateEl.textContent = passwordTooShortText(); else if (!matches) gateEl.textContent = "Type the same password in both boxes."; else gateEl.textContent = "";
}

[ pwInput, pwConfirm ].forEach(el => {
  el.addEventListener("input", refreshGate);
  el.addEventListener("blur", () => {
    pwTouched.add(el);
    refreshGate();
  });
});

formEl.addEventListener("submit", async e => {
  e.preventDefault();
  if (saveBtn.disabled) return;
  saving = true;
  refreshGate();
  try {
    const {error: error} = await supabaseClient.auth.updateUser({
      password: pwInput.value
    });
    if (error) throw error;
    await supabaseClient.auth.signOut();
    formEl.hidden = true;
    doneEl.hidden = false;
    showStatusRich("Password updated", "Sign in with your new password.", "success");
  } catch (err) {
    console.error("Couldn't set the new password:", err);
    const msg = String(err && err.message ? err.message : "");
    if (/should be different|same.*password/i.test(msg)) {
      showStatus("That's already your password. Choose a different one.", "error");
    } else if (/short|at least|characters/i.test(msg)) {
      showStatus("That password is too short. " + passwordTooShortText(), "error");
    } else if (/expired|invalid|token|session/i.test(msg)) {
      deadEnd("Link expired", "Reset links are single-use and last about an hour. Request a new one from the sign-in page.", "Head back and send yourself a fresh link.");
    } else {
      showStatus("Couldn't save the new password. Try again.", "error");
    }
  } finally {
    saving = false;
    refreshGate();
  }
});

const RECOVERY_CREDENTIAL_IN_URL = (() => {
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const q = new URLSearchParams(window.location.search);
  return Boolean(h.get("access_token")) || Boolean(q.get("code"));
})();

const PRIOR_ACCESS_TOKEN = (() => {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.*-auth-token$/.test(key)) continue;
      const parsed = JSON.parse(localStorage.getItem(key));
      if (parsed && typeof parsed.access_token === "string") return parsed.access_token;
    }
  } catch (_) {}
  return null;
})();

function sessionIsFromThisLink(session) {
  return Boolean(session) && RECOVERY_CREDENTIAL_IN_URL && session.access_token !== PRIOR_ACCESS_TOKEN;
}

(async () => {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const params = new URLSearchParams(window.location.search);
  const linkError = hashParams.get("error_description") || hashParams.get("error") || params.get("error_description") || params.get("error");
  if (linkError) {
    history.replaceState(null, "", window.location.pathname);
    deadEnd("Link expired", "Reset links are single-use and last about an hour. Request a new one from the sign-in page.", "Head back and send yourself a fresh link.");
    return;
  }
  let settled = false;
  let unlocked = false;
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    settled = true;
    history.replaceState(null, "", window.location.pathname);
    checkingEl.hidden = true;
    deadEndEl.hidden = true;
    formEl.hidden = false;
    refreshGate();
    pwInput.focus();
  }
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      unlock();
      return;
    }
    if (sessionIsFromThisLink(session)) unlock();
  });
  let sawSession = false;
  for (let i = 0; i < 10 && !settled; i++) {
    const {data: data} = await supabaseClient.auth.getSession();
    if (data && data.session) {
      sawSession = true;
      if (sessionIsFromThisLink(data.session)) {
        unlock();
        return;
      }
      break;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!settled) {
    settled = true;
    if (sawSession) {
      deadEnd("Already signed in", "This page only works from a password reset link. To change your " + "password while signed in, use Edit Account — it will ask for your " + "current password.", "Or sign out and request a reset link from the sign-in page.");
    } else {
      deadEnd("No reset link found", "Open this page from the link in your password reset email.", "If your link has expired, request a new one from the sign-in page.");
    }
  }
})();

if (typeof initSharedBehaviour === "function") initSharedBehaviour();
