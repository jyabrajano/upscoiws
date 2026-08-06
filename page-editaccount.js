
// ------------------------------------------------------------
// Both buttons stay disabled until the form they belong to is
// complete and clean. Nothing on this page says which check
// failed: once the boxes are filled, anything still blocking
// produces the same single line. Naming the detail that clashed
// would let anyone with a login work out who holds which name
// and which account number.
//
// The gate is a convenience, not the guard. Change requests are
// written by request_profile_change() and the uniqueness rules
// live in deploy-schema.sql — they hold whether or not this
// script runs.
// ------------------------------------------------------------

const DENIED =
  "Access denied: if the given details are valid, Please contact the administrator.";

// The one error that names itself, same as on the registration
// page. A wrong length is the person's own typing, not a clue
// about anyone else's record, so saying so gives nothing away —
// and "10 digits" is the only thing that helps them fix it.
const ACCT_LENGTH_MSG =
  "LBP account numbers are default 10 digit, please input the valid account number!";

// Pressing Submit on an untouched form gets an answer rather than
// a dead button — there's nothing to hide about "you didn't
// change anything", so it says so.
const NO_CHANGES = "No changes applied.";

const statusEl = document.getElementById("status");

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status visible ${type}`;
  statusEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "status";
}

// Waits for typing to stop before asking the database. Without
// this every keystroke would be a round trip.
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

const submitBtn = document.getElementById("eaSubmit");
const gateEl = document.getElementById("eaGate");

(async () => {
  const session = await requireSession();
  if (!session) return;

  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("id, email, full_name, account_number")
    .eq("email", session.user.email)
    .maybeSingle();

  if (error || !profile) {
    console.error("Couldn't load your profile:", error);
    showStatus("Couldn't load your details. Try again later.", "error");
    submitBtn.disabled = true;
    gateEl.textContent = "";
    return;
  }

  // checkIsMainAdmin() comes from approval.js, loaded before this
  // script. Known up front, not just inside initEditAccountApproval,
  // because it decides whether eaFullName stays built-only or
  // becomes directly editable below.
  const isMainAdmin = await checkIsMainAdmin();

  const firstInput   = document.getElementById("eaFirstName");
  const miInput      = document.getElementById("eaMiddleInitial");
  const lastInput    = document.getElementById("eaLastName");
  const suffixInput  = document.getElementById("eaSuffix");
  const fullNameInput = document.getElementById("eaFullName");
  const acctListEl   = document.getElementById("eaAcctList");

  // Everyone else keeps the assembled, read-only full name — it's
  // built from the parts above so it can't drift from them. A main
  // administrator can type into it directly instead, since nothing
  // downstream needs the parts to agree with it (see nameApi below
  // and request_profile_change, which takes whatever string arrives).
  if (isMainAdmin) {
    fullNameInput.readOnly = false;
    fullNameInput.placeholder = "Type the full name directly, or build it from the fields above";
    const fullNameHint = document.getElementById("eaFullNameHint");
    if (fullNameHint) fullNameHint.style.display = "block";
  }

  const nameBuilder = attachNameBuilder({
    firstInput,
    miInput,
    lastInput,
    suffixInput,
    fullNameInput,
  });
  nameBuilder.fill(profile.full_name || "");

  const acctList = attachAccountNumberList(
    acctListEl,
    {
      id: "eaAccountNumber",
      initial: profile.account_number || "",
      required: false,
      onChange: () => fieldsChanged(),
    }
  );

  // ---- state the button reads ----

  let nameClash = false;   // the name belongs to someone else
  let acctClash = false;   // a number belongs to someone else
  let checking  = false;   // a check is queued or in flight
  let refused   = false;   // the last attempt was turned down
  let acctAsked = false;   // Submit has been pressed on a short number

  const touched = new WeakSet();

  // Not const: a main administrator's edits apply immediately
  // (see approval.js), so onProfileChanged below moves this
  // baseline forward instead of leaving it pointed at stale values.
  let onFileName = profile.full_name || "";
  let onFileAccounts = joinAccountNumbers(parseAccountNumbers(profile.account_number || ""));

  function acctInputs() {
    return Array.from(acctListEl.querySelectorAll("input"));
  }

  // Every box stopping the form, collected in one pass.
  //
  // Short account numbers are deliberately NOT in `bad`: they
  // don't hold the button down, because the number is only judged
  // when Submit is pressed. The press is what turns a number in
  // progress into a wrong one.
  function problems() {
    const bad = new Set();
    const short = new Set();

    [firstInput, lastInput].forEach(el => { if (!el.value.trim()) bad.add(el); });

    const seen = new Set();
    acctInputs().forEach(input => {
      const value = input.value.trim();
      if (!value) return;
      const check = validateAccountNumber(value, { required: true });
      if (!check.ok) { short.add(input); return; }
      if (seen.has(check.value)) { bad.add(input); return; }
      seen.add(check.value);
    });

    return { bad, short };
  }

  // Nothing to approve if nothing moved. A half-typed number
  // still counts as moved, or the button would be off and there'd
  // be no press to judge it on.
  function currentAccounts() {
    const accts = acctList.validate();
    return accts.ok ? accts.value : acctList.value();
  }

  function edited() {
    return nameBuilder.value() !== onFileName ||
           currentAccounts() !== onFileAccounts;
  }

  function paint(bad, short) {
    [firstInput, lastInput, ...acctInputs()].forEach(el => {
      const flagged = (bad.has(el) && touched.has(el)) || (short.has(el) && acctAsked);
      el.classList.toggle("is-invalid", flagged);
    });
  }

  function refresh() {
    const { bad, short } = problems();
    const complete = Boolean(firstInput.value.trim() && lastInput.value.trim());
    const blocked = bad.size > 0 || nameClash || acctClash || refused;

    // Nothing is said about a number until Submit has been pressed
    // on it. Until then 3072-10 is a number in progress.
    const shortReported = acctAsked && short.size > 0;

    paint(bad, short);
    submitBtn.disabled = checking || !complete || blocked;

    if (!complete)     gateEl.textContent = "Enter at least a first and last name.";
    else if (checking) gateEl.textContent = "Checking\u2026";
    else               gateEl.textContent = "";

    // The length message stands on its own, and outranks the
    // catch-all line.
    if (shortReported)         { showStatus(ACCT_LENGTH_MSG, "error"); return; }
    if (!complete || checking) return;
    if (blocked)               showStatus(DENIED, "error");
  }

  // ---- duplicate checks ----
  //
  // Your own name and numbers don't count as duplicates, which
  // is why the profile email goes through on both. A check that
  // can't be run is treated as "can't tell" — the database still
  // refuses, so a network hiccup shouldn't lock anyone out here.
  //
  // A slow answer to an old question must not unlock the button
  // for a newer one, so each round carries a number and only the
  // latest is allowed to settle anything.
  let round = 0;

  const runChecks = debounce(async () => {
    const mine  = ++round;
    const name  = nameBuilder.value();
    const accts = acctList.validate();

    try {
      const [takenName, clashes] = await Promise.all([
        name && name !== onFileName
          ? fullNameTaken(name, profile.email)
          : Promise.resolve(false),
        accts.ok && accts.value
          ? accountNumbersTaken(accts.value, profile.email)
          : Promise.resolve([]),
      ]);
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
    if (refused) { refused = false; clearStatus(); }
    acctAsked = false;   // back to a number in progress
    checking = true;
    refresh();
    runChecks();
  }

  [firstInput, miInput, lastInput, suffixInput]
    .forEach(el => el.addEventListener("input", fieldsChanged));

  if (isMainAdmin) fullNameInput.addEventListener("input", fieldsChanged);

  // Delegated, because boxes are added and removed as you go.
  acctListEl.addEventListener("input", fieldsChanged);

  // Capture phase: blur doesn't bubble.
  document.getElementById("eaForm").addEventListener("blur", (e) => {
    if (e.target && e.target.tagName === "INPUT") {
      touched.add(e.target);
      refresh();
    }
  }, true);

  refresh();

  // A disabled button doesn't stop the Enter key everywhere, and
  // this listener is registered before approval.js's, so it gets
  // to call it off first.
  document.getElementById("eaForm").addEventListener("submit", (e) => {
    if (submitBtn.disabled) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    // Nothing to send if nothing moved.
    if (!edited()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showStatus(NO_CHANGES, "notice");
      return;
    }

    // This is where a short number gets judged — on the press, not
    // before it. Nothing goes to the Cash Office until it's fixed.
    if (!acctList.validate().ok) {
      e.preventDefault();
      e.stopImmediatePropagation();
      acctAsked = true;
      refresh();
      statusEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  // approval.js owns the submit handler — it writes the change
  // request and paints the pending banner. refreshGate is how it
  // hands the button back: the gate decides, not the handler.
  try {
    await initEditAccountApproval({
      profile,
      fullNameInput,
      acctInput: document.getElementById("eaAccountNumber"),
      // A main administrator types the full name directly; tidy()
      // would rebuild it from the (possibly untouched) parts above
      // and overwrite it right before submit, so it's left out.
      nameApi: isMainAdmin ? null : nameBuilder,
      acctApi: acctList,
      form: document.getElementById("eaForm"),
      submitBtn,
      statusEl,
      noticeSlot: document.getElementById("approvalNotice"),
      onProfileChanged: (updated) => {
        profile.full_name = updated.full_name;
        profile.account_number = updated.account_number;
        onFileName = updated.full_name || "";
        onFileAccounts = joinAccountNumbers(parseAccountNumbers(updated.account_number || ""));
        refresh();
      },
      refreshGate: refresh,
      onClash: () => { refused = true; },
    });
  } catch (err) {
    console.error("Approval wiring failed:", err);
    showStatus("Account editing is unavailable right now.", "error");
    submitBtn.disabled = true;
    gateEl.textContent = "";
  }
})();

// ---- password ----
//
// The exception: no approval, applies at once. Same gate, so the
// button can't be pressed on a password that was never going to
// be accepted.

const pwCurrentInput = document.getElementById("eaCurrentPassword");
const pwInput = document.getElementById("eaNewPassword");
const pwConfirmInput = document.getElementById("eaConfirmPassword");
const pwBtn = document.getElementById("eaPasswordSubmit");
const pwGateEl = document.getElementById("eaPwGate");
const pwTouched = new WeakSet();
let pwSending = false;

function refreshPasswordGate() {
  const current = pwCurrentInput.value;
  const pw = pwInput.value;
  const confirm = pwConfirmInput.value;
  const hasCurrent = Boolean(current);
  const longEnough = passwordLongEnough(pw);
  const matches = Boolean(confirm) && confirm === pw;

  pwInput.classList.toggle("is-invalid", pwTouched.has(pwInput) && Boolean(pw) && !longEnough);
  pwConfirmInput.classList.toggle("is-invalid", pwTouched.has(pwConfirmInput) && Boolean(confirm) && !matches);

  pwBtn.disabled = pwSending || !hasCurrent || !longEnough || !matches;

  if (pwSending)               pwGateEl.textContent = "";
  else if (!pw && !confirm && !current)
                               pwGateEl.textContent = "Leave blank to keep your current password.";
  else if (!longEnough)        pwGateEl.textContent = passwordTooShortText();
  else if (!matches)           pwGateEl.textContent = "Type the same password in both boxes.";
  else if (!hasCurrent)        pwGateEl.textContent = "Enter your current password to confirm the change.";
  else                         pwGateEl.textContent = "";
}

[pwCurrentInput, pwInput, pwConfirmInput].forEach(el => {
  el.addEventListener("input", refreshPasswordGate);
  el.addEventListener("blur", () => { pwTouched.add(el); refreshPasswordGate(); });
});

refreshPasswordGate();

document.getElementById("eaPasswordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (pwBtn.disabled) return;

  pwSending = true;
  pwBtn.disabled = true;
  try {
    // Prove the current password before setting a new one.
    // updateUser() does not require it — Supabase will change the
    // password of whoever holds the session — so the check has to
    // happen here. Without it, an unattended or hijacked session is
    // a full account takeover that also locks the real owner out.
    //
    // signInWithPassword against the signed-in address is the
    // re-authentication: it returns an error if the password is
    // wrong, and refreshes the same session if it is right.
    //
    // The address is read from Auth here rather than closed over:
    // this handler sits outside the IIFE above that holds `session`,
    // and taking it from the session Auth itself reports keeps the
    // check pinned to whoever is actually signed in.
    const { data: who, error: whoErr } = await supabaseClient.auth.getUser();
    if (whoErr || !who?.user?.email) {
      showStatus("You've been signed out. Sign in again to change your password.", "error");
      return;
    }

    const { error: reauthError } = await supabaseClient.auth.signInWithPassword({
      email: who.user.email,
      password: pwCurrentInput.value,
    });
    if (reauthError) {
      // Said plainly. This is the account holder, already signed in,
      // being told they mistyped their own password — there is
      // nothing to give away by naming it.
      showStatus("That isn't your current password.", "error");
      pwCurrentInput.classList.add("is-invalid");
      pwCurrentInput.focus();
      return;
    }
    pwCurrentInput.classList.remove("is-invalid");

    const { error } = await supabaseClient.auth.updateUser({ password: pwInput.value });
    if (error) throw error;
    pwCurrentInput.value = "";
    pwInput.value = "";
    pwConfirmInput.value = "";
    showStatus("Password updated.", "success");
  } catch (err) {
    console.error("Couldn't update the password:", err);
    showStatus("Couldn't update your password.", "error");
  } finally {
    pwSending = false;
    refreshPasswordGate();
  }
});

// ------------------------------------------------------------
// Data subject access and portability — RA 10173 s.18
//
// export_my_data() takes no email parameter, deliberately: it reads
// the caller's identity from their JWT, so there is no argument to
// tamper with and no way to point it at somebody else. The download is
// assembled in the browser from what the database returns, so nothing
// is written to a server and no file sits anywhere waiting to be found.
//
// The blob URL is revoked immediately after the click. Left alive it
// keeps a copy of the person's data in memory for as long as the tab
// is open.
// ------------------------------------------------------------
const exportBtn  = document.getElementById("eaExportBtn");
const exportNote = document.getElementById("eaExportNote");

if (exportBtn) {
  exportBtn.addEventListener("click", async () => {
    exportBtn.disabled = true;
    exportNote.textContent = "Preparing your file\u2026";

    try {
      const { data, error } = await supabaseClient.rpc("export_my_data");
      if (error) throw error;

      // Local date. This names a data-export receipt issued under
      // RA 10173, where the date it carries is part of what it attests.
      const stamp = todayLocalISO();
      const blob  = new Blob([JSON.stringify(data, null, 2)],
                             { type: "application/json" });
      const url   = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `my-data-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      exportNote.textContent = "Downloaded. The file contains your personal data — keep it somewhere safe.";
    } catch (err) {
      console.error("Data export failed:", err);
      exportNote.textContent = "Couldn't prepare the file. Try again, or contact the Cash Office.";
    } finally {
      exportBtn.disabled = false;
    }
  });
}
