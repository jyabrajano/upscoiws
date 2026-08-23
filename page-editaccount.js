const DENIED = "Access denied: if the given details are valid, Please contact the administrator.";

const ACCT_LENGTH_MSG = "LBP account numbers are default 10 digit, please input the valid account number!";

const NO_CHANGES = "No changes applied.";

const statusEl = document.getElementById("status");

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status visible ${type}`;
  statusEl.scrollIntoView({
    block: "nearest",
    behavior: "smooth"
  });
}

function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "status";
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let refreshActivity = null;

const submitBtn = document.getElementById("eaSubmit");

const gateEl = document.getElementById("eaGate");

submitBtn.disabled = false;

(async () => {
  const session = await requireSession();
  if (!session) return;
  const {data: profile, error: error} = await supabaseClient.from("profiles").select("id, email, full_name, account_number").eq("email", session.user.email).maybeSingle();
  if (error || !profile) {
    console.error("Couldn't load your profile:", error);
    showStatus("Couldn't load your details. Try again later.", "error");
    gateEl.textContent = "";
    return;
  }
  const isMainAdmin = await checkIsMainAdmin();
  const firstInput = document.getElementById("eaFirstName");
  const miInput = document.getElementById("eaMiddleInitial");
  const lastInput = document.getElementById("eaLastName");
  const suffixInput = document.getElementById("eaSuffix");
  const fullNameInput = document.getElementById("eaFullName");
  const acctListEl = document.getElementById("eaAcctList");
  if (isMainAdmin) {
    fullNameInput.readOnly = false;
    fullNameInput.placeholder = "Type the full name directly, or build it from the fields above";
    const fullNameHint = document.getElementById("eaFullNameHint");
    if (fullNameHint) fullNameHint.style.display = "block";
  }
  const nameBuilder = attachNameBuilder({
    firstInput: firstInput,
    miInput: miInput,
    lastInput: lastInput,
    suffixInput: suffixInput,
    fullNameInput: fullNameInput
  });
  nameBuilder.fill(profile.full_name || "");
  const acctList = attachAccountNumberList(acctListEl, {
    id: "eaAccountNumber",
    initial: profile.account_number || "",
    required: false,
    onChange: () => fieldsChanged()
  });
  let nameClash = false;
  let acctClash = false;
  let checking = false;
  let acctAsked = false;
  let asked = false;
  const touched = new WeakSet;
  let onFileName = profile.full_name || "";
  let onFileAccounts = joinAccountNumbers(parseAccountNumbers(profile.account_number || ""));
  function acctInputs() {
    return Array.from(acctListEl.querySelectorAll("input"));
  }
  function problems() {
    const bad = new Set;
    const short = new Set;
    [ firstInput, lastInput ].forEach(el => {
      if (!el.value.trim()) bad.add(el);
    });
    const seen = new Set;
    acctInputs().forEach(input => {
      const value = input.value.trim();
      if (!value) return;
      const check = validateAccountNumber(value, {
        required: true
      });
      if (!check.ok) {
        short.add(input);
        return;
      }
      if (seen.has(check.value)) {
        bad.add(input);
        return;
      }
      seen.add(check.value);
    });
    return {
      bad: bad,
      short: short
    };
  }
  function currentAccounts() {
    const accts = acctList.validate();
    return accts.ok ? accts.value : acctList.value();
  }
  function edited() {
    return nameBuilder.value() !== onFileName || currentAccounts() !== onFileAccounts;
  }
  function paint(bad, short) {
    [ firstInput, lastInput, ...acctInputs() ].forEach(el => {
      const flagged = bad.has(el) && touched.has(el) || short.has(el) && acctAsked;
      el.classList.toggle("is-invalid", flagged);
    });
  }
  function refresh() {
    const {bad: bad, short: short} = problems();
    paint(bad, short);
    submitBtn.disabled = false;
    if (!asked) {
      gateEl.textContent = "";
      return;
    }
    const complete = Boolean(firstInput.value.trim() && lastInput.value.trim());
    if (!complete) gateEl.textContent = "Enter at least a first and last name."; else if (checking) gateEl.textContent = "Checking…"; else gateEl.textContent = "";
  }
  let round = 0;
  const runChecks = debounce(async () => {
    const mine = ++round;
    const name = nameBuilder.value();
    const accts = acctList.validate();
    try {
      const [takenName, clashes] = await Promise.all([ name && name !== onFileName ? fullNameTaken(name, profile.email) : Promise.resolve(false), accts.ok && accts.value ? accountNumbersTaken(accts.value, profile.email) : Promise.resolve([]) ]);
      if (mine !== round) return;
      nameClash = takenName === true;
      acctClash = clashes.length > 0;
    } finally {
      if (mine === round) {
        checking = false;
        refresh();
      }
    }
  }, 450);
  function fieldsChanged() {
    if (asked) clearStatus();
    acctAsked = false;
    checking = true;
    refresh();
    runChecks();
  }
  [ firstInput, miInput, lastInput, suffixInput ].forEach(el => el.addEventListener("input", fieldsChanged));
  if (isMainAdmin) fullNameInput.addEventListener("input", fieldsChanged);
  acctListEl.addEventListener("input", fieldsChanged);
  document.getElementById("eaForm").addEventListener("blur", e => {
    if (e.target && e.target.tagName === "INPUT") {
      touched.add(e.target);
      refresh();
    }
  }, true);
  refresh();
  document.getElementById("eaForm").addEventListener("submit", e => {
    asked = true;
    if (!edited()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showStatus(NO_CHANGES, "notice");
      refresh();
      return;
    }
    if (!acctList.validate().ok) {
      e.preventDefault();
      e.stopImmediatePropagation();
      acctAsked = true;
      showStatus(ACCT_LENGTH_MSG, "error");
      refresh();
      return;
    }
    if (checking) {
      e.preventDefault();
      e.stopImmediatePropagation();
      gateEl.textContent = "Checking…";
      return;
    }
    if (nameClash || acctClash) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showStatus(DENIED, "error");
      refresh();
      return;
    }
    refresh();
  });
  // The account holder's own view of what has happened to their account.
  // admin_actions answers "what did staff do"; this answers "did somebody
  // get in as me", which nothing here could answer before.
  const activityEl = document.getElementById("eaActivity");
  if (activityEl) {
    refreshActivity = () => mountAccountActivity(activityEl, 15);
    refreshActivity();
  }
  const mfaEl = document.getElementById("eaMfa");
  if (mfaEl) mountMfaPanel(mfaEl);
  try {
    await initEditAccountApproval({
      profile: profile,
      fullNameInput: fullNameInput,
      acctInput: document.getElementById("eaAccountNumber"),
      nameApi: isMainAdmin ? null : nameBuilder,
      acctApi: acctList,
      form: document.getElementById("eaForm"),
      submitBtn: submitBtn,
      statusEl: statusEl,
      noticeSlot: document.getElementById("approvalNotice"),
      onProfileChanged: updated => {
        profile.full_name = updated.full_name;
        profile.account_number = updated.account_number;
        onFileName = updated.full_name || "";
        onFileAccounts = joinAccountNumbers(parseAccountNumbers(updated.account_number || ""));
        refresh();
      },
      refreshGate: refresh,
      onClash: () => {}
    });
  } catch (err) {
    console.error("Approval wiring failed:", err);
    showStatus("Account editing is unavailable right now.", "error");
    gateEl.textContent = "";
  }
})();

const pwCurrentInput = document.getElementById("eaCurrentPassword");

const pwInput = document.getElementById("eaNewPassword");

const pwConfirmInput = document.getElementById("eaConfirmPassword");

const pwBtn = document.getElementById("eaPasswordSubmit");

const pwGateEl = document.getElementById("eaPwGate");

const pwTouched = new WeakSet;

let pwSending = false;

let pwAsked = false;

pwBtn.disabled = false;

function refreshPasswordGate() {
  const current = pwCurrentInput.value;
  const pw = pwInput.value;
  const confirm = pwConfirmInput.value;
  const longEnough = passwordLongEnough(pw);
  const matches = Boolean(confirm) && confirm === pw;
  pwInput.classList.toggle("is-invalid", pwTouched.has(pwInput) && Boolean(pw) && !longEnough);
  pwConfirmInput.classList.toggle("is-invalid", pwTouched.has(pwConfirmInput) && Boolean(confirm) && !matches);
  if (pwSending) {
    pwGateEl.textContent = "";
    return;
  }
  if (!pwAsked) {
    pwGateEl.textContent = "";
    return;
  }
  if (!pw && !confirm && !current) pwGateEl.textContent = "Leave blank to keep your current password."; else if (!longEnough) pwGateEl.textContent = passwordTooShortText(); else if (!matches) pwGateEl.textContent = "Type the same password in both boxes."; else if (!current) pwGateEl.textContent = "Enter your current password to confirm the change."; else pwGateEl.textContent = "";
}

[ pwCurrentInput, pwInput, pwConfirmInput ].forEach(el => {
  el.addEventListener("input", () => {
    if (pwAsked) clearStatus();
    refreshPasswordGate();
  });
  el.addEventListener("blur", () => {
    pwTouched.add(el);
    refreshPasswordGate();
  });
});

refreshPasswordGate();

document.getElementById("eaPasswordForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (pwSending) return;
  pwAsked = true;
  const current = pwCurrentInput.value;
  const pw = pwInput.value;
  const confirm = pwConfirmInput.value;
  const longEnough = passwordLongEnough(pw);
  const matches = Boolean(confirm) && confirm === pw;
  if (!current || !longEnough || !matches) {
    refreshPasswordGate();
    if (!longEnough) showStatus(passwordTooShortText(), "error"); else if (!matches) showStatus("Type the same password in both boxes.", "error"); else if (!current) showStatus("Enter your current password to confirm the change.", "error");
    return;
  }
  pwSending = true;
  pwBtn.textContent = "Updating…";
  refreshPasswordGate();
  try {
    const {data: who, error: whoErr} = await supabaseClient.auth.getUser();
    if (whoErr || !who?.user?.email) {
      showStatus("You've been signed out. Sign in again to change your password.", "error");
      return;
    }
    // Verified on a THROWAWAY client, not this one.
    //
    // Calling signInWithPassword on supabaseClient proves the old
    // password, but it also replaces the live session with a fresh one
    // — and a fresh password sign-in is aal1. Once MFA enforcement is
    // on, an administrator changing their password would silently lose
    // their admin tools for the rest of the session, with nothing on
    // screen explaining why.
    //
    // persistSession:false keeps this instance out of storage entirely,
    // so the real session is untouched and its assurance level survives.
    const verifier = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false}
    });
    const {error: reauthError} = await verifier.auth.signInWithPassword({
      email: who.user.email,
      password: pwCurrentInput.value
    });
    try {
      await verifier.auth.signOut();
    } catch (_) {}
    if (reauthError) {
      showStatus("That isn't your current password.", "error");
      pwCurrentInput.classList.add("is-invalid");
      pwCurrentInput.focus();
      return;
    }
    pwCurrentInput.classList.remove("is-invalid");
    const {error: error} = await supabaseClient.auth.updateUser({
      password: pwInput.value
    });
    if (error) throw error;
    pwCurrentInput.value = "";
    pwInput.value = "";
    pwConfirmInput.value = "";
    pwAsked = false;
    // Anyone else holding a session on this account is signed out.
    // Someone changing their password because they think they have been
    // compromised expects that to end the intruder's access; without
    // this it does not, and the old session keeps working until it
    // expires on its own.
    let othersEnded = true;
    try {
      const {error: scopeErr} = await supabaseClient.auth.signOut({scope: "others"});
      if (scopeErr) throw scopeErr;
    } catch (scopeErr) {
      othersEnded = false;
      console.warn("Couldn't sign out other sessions:", scopeErr);
    }
    showStatus(othersEnded ? "Password updated. Any other devices signed in to this account have been signed out." : "Password updated. We couldn't sign out your other devices — sign out and back in on those to be sure.", "success");
    await recordAccountEvent("password_changed", othersEnded ? {other_sessions_ended: true} : null);
    if (typeof refreshActivity === "function" && refreshActivity) refreshActivity();
  } catch (err) {
    console.error("Couldn't update the password:", err);
    showStatus("Couldn't update your password.", "error");
  } finally {
    pwSending = false;
    pwBtn.textContent = "Update Password";
    refreshPasswordGate();
  }
});

const exportBtn = document.getElementById("eaExportBtn");

const exportNote = document.getElementById("eaExportNote");

if (exportBtn) {
  exportBtn.addEventListener("click", async () => {
    exportBtn.disabled = true;
    exportNote.textContent = "Preparing your file…";
    try {
      const {data: data, error: error} = await supabaseClient.rpc("export_my_data");
      if (error) throw error;
      const stamp = todayLocalISO();
      const blob = new Blob([ JSON.stringify(data, null, 2) ], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `my-data-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      exportNote.textContent = "Downloaded. The file contains your personal data — keep it somewhere safe.";
      await recordAccountEvent("data_exported");
      if (typeof refreshActivity === "function" && refreshActivity) refreshActivity();
    } catch (err) {
      console.error("Data export failed:", err);
      exportNote.textContent = "Couldn't prepare the file. Try again, or contact the Cash Office.";
    } finally {
      exportBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------
// Two-step verification panel
//
// Three states, and the difference between them is the whole point:
//
//   not enrolled          offer to set it up
//   enrolled, aal1        already protected; this session just hasn't
//                         entered a code, which only matters to admins
//   enrolled, aal2        fully verified this session
//
// Administrators get an extra line, because for them this stops being
// optional the moment enforcement is switched on — and the panel is
// where they find that out, not a support call afterwards.
// ---------------------------------------------------------------------

function injectMfaStyles() {
  if (document.getElementById("eaMfaStyles")) return;
  const style = document.createElement("style");
  style.id = "eaMfaStyles";
  style.textContent = `
    .mfa-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:12px; }
    .mfa-pill { font-size:12px; font-weight:700; padding:4px 10px; border-radius:999px; }
    .mfa-pill.on  { background:#f0fdf4; color:#14532d; border:1px solid #bbf7d0; }
    .mfa-pill.off { background:#fef2f2; color:#7f1d1d; border:1px solid #fecaca; }
    .mfa-note { font-size:12.5px; line-height:1.55; color:var(--muted,#64748b); margin:10px 0 0; }
    .mfa-warn { margin:10px 0 0; padding:10px 12px; border-radius:8px; background:#fffbeb;
      border:1px solid #fde68a; border-left:3px solid #d97706; font-size:12.5px;
      line-height:1.55; color:#78350f; }
    .mfa-setup { margin-top:14px; padding:16px; border:1px solid var(--card-border,#e2e8f0);
      border-radius:10px; background:#fff; }
    .mfa-setup img { display:block; width:180px; height:180px; margin:12px auto; }
    .mfa-secret { font:600 13px/1.5 ui-monospace,monospace; word-break:break-all;
      background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:8px 10px;
      margin:0 0 12px; text-align:center; }
    .mfa-setup input { width:100%; padding:11px; font:600 20px/1 ui-monospace,monospace;
      letter-spacing:.3em; text-align:center; border:1.5px solid #cbd5e1;
      border-radius:8px; box-sizing:border-box; }
    .mfa-msg { min-height:18px; margin:8px 0 0; font-size:12.5px; }
    .mfa-msg.err { color:#b91c1c; } .mfa-msg.ok { color:#14532d; }
    .mfa-btns { display:flex; gap:8px; margin-top:12px; }
    .mfa-btns button { flex:1; border:0; border-radius:8px; padding:11px;
      font:700 13px/1 inherit; cursor:pointer; }
    .mfa-btns .go { background:var(--maroon,#7b1113); color:#fff; }
    .mfa-btns .go:disabled { opacity:.45; cursor:default; }
    .mfa-btns .cancel { background:#e2e8f0; color:#0f172a; }
  `;
  document.head.appendChild(style);
}

async function mountMfaPanel(container) {
  if (!container) return;
  injectMfaStyles();
  container.innerHTML = '<p class="mfa-note">Loading…</p>';

  let state, factors;
  try {
    state = await mfaState();
    factors = await mfaListFactors();
  } catch (err) {
    console.error("Couldn't load two-step verification state:", err);
    container.innerHTML = '<p class="mfa-note">Couldn\'t load this just now. Reload the page to try again.</p>';
    return;
  }

  const verified = factors.filter(f => f.status === "verified");
  const isAdmin = state.is_admin_row === true;
  const required = state.required_for_admins === true;

  if (verified.length) {
    const atAal2 = state.aal === "aal2";
    container.innerHTML =
      '<div class="mfa-row"><span class="mfa-pill on">On</span>' +
      `<span class="mfa-note" style="margin:0">${escapeHtml(verified[0].friendly_name || "Authenticator app")}</span></div>` +
      (atAal2
        ? '<p class="mfa-note">You entered a code this session.</p>'
        : '<p class="mfa-note">You signed in without a code this session. Sign out and back in if you need administrator tools.</p>') +
      '<div class="mfa-btns"><button type="button" class="cancel" id="mfaRemoveBtn">Turn off two-step verification</button></div>' +
      '<p class="mfa-msg" id="mfaMsg" aria-live="polite"></p>' +
      (isAdmin && required
        ? '<p class="mfa-warn">Two-step verification is required for administrators. Turning it off will remove your administrator tools until you set it up again.</p>'
        : "");

    container.querySelector("#mfaRemoveBtn").addEventListener("click", async () => {
      const msg = container.querySelector("#mfaMsg");
      if (!confirm("Turn off two-step verification? Your account will be protected by your password alone.")) return;
      msg.className = "mfa-msg";
      msg.textContent = "Removing…";
      try {
        for (const f of verified) await mfaUnenroll(f.id);
        if (typeof refreshActivity === "function" && refreshActivity) refreshActivity();
        mountMfaPanel(container);
      } catch (err) {
        console.error("Couldn't remove the factor:", err);
        msg.className = "mfa-msg err";
        msg.textContent = "Couldn't turn it off. Try again.";
      }
    });
    return;
  }

  container.innerHTML =
    '<div class="mfa-row"><span class="mfa-pill off">Off</span></div>' +
    (isAdmin
      ? (required
          ? '<p class="mfa-warn"><strong>Required for administrators.</strong> Your administrator tools stay unavailable until you set this up.</p>'
          : '<p class="mfa-warn"><strong>You are an administrator.</strong> This will become required. Setting it up now avoids being caught out when it is.</p>')
      : "") +
    '<div class="mfa-btns"><button type="button" class="go" id="mfaSetupBtn">Set up two-step verification</button></div>' +
    '<p class="mfa-msg" id="mfaMsg" aria-live="polite"></p>';

  container.querySelector("#mfaSetupBtn").addEventListener("click", () => startMfaSetup(container));
}

async function startMfaSetup(container) {
  const msg = container.querySelector("#mfaMsg");
  msg.className = "mfa-msg";
  msg.textContent = "Preparing…";

  let enrolment;
  try {
    enrolment = await mfaStartEnrolment("Authenticator app");
  } catch (err) {
    console.error("Couldn't start enrolment:", err);
    msg.className = "mfa-msg err";
    // The commonest cause by far, and the least obvious.
    msg.textContent = "Couldn't start setup. If you already have a half-finished setup, reload and try again.";
    return;
  }

  container.insertAdjacentHTML("beforeend",
    '<div class="mfa-setup" id="mfaSetup">' +
    "<p class=\"mfa-note\" style=\"margin-top:0\">Scan this with Google Authenticator, Microsoft Authenticator, or any TOTP app.</p>" +
    `<img src="${escapeHtml(enrolment.qr)}" alt="QR code for setting up two-step verification">` +
    '<p class="mfa-note" style="margin:0 0 6px">Can\'t scan? Type this key into the app instead:</p>' +
    `<p class="mfa-secret">${escapeHtml(enrolment.secret || "")}</p>` +
    '<p class="mfa-note" style="margin:0 0 8px">Then enter the six-digit code it shows:</p>' +
    '<input type="text" id="mfaSetupCode" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code" aria-label="Six-digit code from your authenticator app">' +
    '<div class="mfa-btns">' +
    '<button type="button" class="cancel" id="mfaSetupCancel">Cancel</button>' +
    '<button type="button" class="go" id="mfaSetupConfirm" disabled>Confirm</button>' +
    "</div></div>");

  msg.textContent = "";
  const panel = container.querySelector("#mfaSetup");
  const input = panel.querySelector("#mfaSetupCode");
  const confirmBtn = panel.querySelector("#mfaSetupConfirm");

  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 6);
    confirmBtn.disabled = !mfaCodeLooksValid(input.value);
  });

  // Cancelling deletes the half-made factor. Leaving it would put an
  // unverified row in auth.mfa_factors that confers nothing but blocks
  // a second enrolment attempt with a confusing error.
  panel.querySelector("#mfaSetupCancel").addEventListener("click", async () => {
    try {
      await mfaUnenroll(enrolment.factorId, true);
    } catch (err) {
      console.warn("Couldn't clean up the cancelled enrolment:", err);
    }
    mountMfaPanel(container);
  });

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    input.disabled = true;
    msg.className = "mfa-msg";
    msg.textContent = "Checking…";
    try {
      await mfaVerifyEnrolment(enrolment.factorId, input.value);
      msg.className = "mfa-msg ok";
      msg.textContent = "Two-step verification is on.";
      if (typeof refreshActivity === "function" && refreshActivity) refreshActivity();
      setTimeout(() => mountMfaPanel(container), 900);
    } catch (err) {
      console.warn("Verification failed:", err);
      msg.className = "mfa-msg err";
      msg.textContent = "That code didn't work. Codes change every 30 seconds — try the current one.";
      input.disabled = false;
      input.value = "";
      input.focus();
      confirmBtn.disabled = true;
    }
  });

  input.focus();
}
