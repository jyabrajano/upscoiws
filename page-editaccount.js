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
    const {error: reauthError} = await supabaseClient.auth.signInWithPassword({
      email: who.user.email,
      password: pwCurrentInput.value
    });
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
    showStatus("Password updated.", "success");
    await recordAccountEvent("password_changed");
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
