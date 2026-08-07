
// ------------------------------------------------------------
// Request Access is a normal, always-clickable button — it is never
// disabled. Pressing it while a request is already in flight is a
// no-op (guarded by `sending`, not by the button's disabled state),
// and pressing it again after a refusal simply tries again.
//
// Nothing is said about the form until the button has actually been
// pressed once. Typing wrong things into an empty form is not an
// error yet; pressing Request Access is what asks the question, and
// only then does the form answer it.
//
// Every refusal shows the same generic line EXCEPT one: an email
// address that's already registered gets its own message, because
// that's useful, actionable information for the person typing their
// own address ("sign in instead"), not a clue about someone else's
// account. Naming a clash on someone else's name or account number
// would be — that stays generic.
//
// The gate is a convenience, not the guard. The real refusals
// live in the database — unique constraints, RLS, and the
// SECURITY DEFINER checks in deploy-schema.sql — and they hold
// whether or not this script runs.
// ------------------------------------------------------------

const DENIED =
  "Access denied: if the given details are valid, Please contact the administrator.";

// The one error that names itself. A wrong length is the person's
// own typing, not a clue about anyone else's record, so saying so
// gives nothing away — and "10 digits" is the only thing that
// actually helps them fix it.
const ACCT_LENGTH_MSG =
  "LBP account numbers are default 10 digit, please input the valid account number!";

// Shown when the address they typed already has an account here.
const EMAIL_TAKEN_MSG =
  "This email address is already registered. Try signing in instead, or use " +
  "\"Forgot password?\" on the sign-in page if you don't remember your password.";

// UP_MAIL_RESTRICTION_ENABLED, UP_MAIL_RE and UP_MAIL_MSG all come
// from config.js, which reads the toggle from the database
// (up_mail_restriction_enabled()) instead of keeping a second copy
// of it here.
//
// Note that UP_MAIL_RESTRICTION_ENABLED is a `let` over there and
// its value can change mid-page when the answer arrives, so it has
// to be read at check time rather than captured once.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const statusEl  = document.getElementById("status");
const gateEl    = document.getElementById("regGate");
const privacyAck = document.getElementById("privacyAck");
const submitBtn = document.getElementById("regSubmit");
const form      = document.getElementById("regForm");

const firstInput   = document.getElementById("regFirstName");
const miInput      = document.getElementById("regMiddleInitial");
const lastInput    = document.getElementById("regLastName");
const suffixInput  = document.getElementById("regSuffix");
const emailInput   = document.getElementById("regEmail");
const passInput    = document.getElementById("regPassword");
const confirmInput = document.getElementById("regConfirmPassword");
const acctListEl   = document.getElementById("regAcctList");

// The button starts disabled in the markup so a form with no JS
// doesn't look submittable. First thing this script does is take
// that back off — from here on the button is never disabled again.
submitBtn.disabled = false;

let shown = "";

function showStatus(message, type, scroll) {
  statusEl.textContent = message;
  statusEl.className = `status visible ${type}`;
  if (scroll || shown !== message) {
    statusEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  shown = message;
}

function clearStatus() {
  statusEl.className = "status";
  statusEl.textContent = "";
  shown = "";
}

// Waits for typing to stop before asking the database. Without
// this every keystroke would be a round trip.
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

const nameBuilder = attachNameBuilder({
  firstInput,
  miInput,
  lastInput,
  suffixInput,
  fullNameInput: document.getElementById("regFullName"),
});

const acctList = attachAccountNumberList(
  acctListEl,
  { id: "regAccountNumber", required: false, onChange: () => accountsChanged() }
);

// ---- state ----

let nameClash = false;   // full name already on file
let acctClash = false;   // one of the account numbers already on file
let checking  = false;   // a duplicate check is queued or in flight
let sending   = false;   // signUp is in flight — guards re-entrant submits
let asked     = false;   // Request Access has been pressed at least once

// Nothing on this form is called wrong until Request Access has been
// pressed. From that first press on, a correction clears its own
// error as it's made — but the notification itself only ever
// appears as a result of pressing the button, never while just
// typing into an untouched form.

function acctInputs() {
  return Array.from(acctListEl.querySelectorAll("input"));
}

function requiredFilled() {
  return Boolean(
    firstInput.value.trim() &&
    lastInput.value.trim() &&
    emailInput.value.trim() &&
    passInput.value &&
    confirmInput.value
  );
}

// Every box that is stopping the form, collected in one pass.
//
// Short account numbers are deliberately NOT in `bad`: they don't
// get flagged until Request Access is pressed. The press is what
// turns a number in progress into a wrong one.
function problems() {
  const bad = new Set();
  const short = new Set();
  let domainBad = false;

  [firstInput, lastInput, emailInput, passInput, confirmInput]
    .forEach(el => { if (!el.value.trim()) bad.add(el); });

  const email = emailInput.value.trim();
  if (email && !EMAIL_RE.test(email)) {
    bad.add(emailInput);
  } else if (UP_MAIL_RESTRICTION_ENABLED && email && !UP_MAIL_RE.test(email)) {
    bad.add(emailInput);
    domainBad = true;
  }
  if (passInput.value && !passwordLongEnough(passInput.value)) bad.add(passInput);
  if (confirmInput.value && confirmInput.value !== passInput.value) bad.add(confirmInput);

  const seen = new Set();
  acctInputs().forEach(input => {
    const value = input.value.trim();
    if (!value) return;
    const check = validateAccountNumber(value, { required: true });
    if (!check.ok) { short.add(input); return; }
    if (seen.has(check.value)) { bad.add(input); return; }
    seen.add(check.value);
  });

  return { bad, short, domainBad };
}

function paint(bad, short) {
  const all = [firstInput, lastInput, emailInput, passInput, confirmInput, ...acctInputs()];
  all.forEach(el => {
    const flagged = asked && (bad.has(el) || short.has(el));
    el.classList.toggle("is-invalid", flagged);
  });
}

// Recomputes what's wrong and repaints the invalid-box outlines, but
// never puts anything into the notification box on its own — that
// only happens inside the submit handler, in response to an actual
// press. Called after every keystroke (to keep the outlines and the
// small "Checking…" hint current) and after every duplicate-check
// result, but it does not call showStatus.
function refresh() {
  const { bad, short } = problems();
  paint(bad, short);

  if (!asked) { gateEl.textContent = ""; return; }
  gateEl.textContent = checking ? "Checking\u2026" : "";
}

// ---- duplicate checks ----
//
// Both go through SECURITY DEFINER functions that answer yes or no
// and never say whose row matched. A check that can't be run is
// treated as "can't tell": the database still refuses on submit, so
// a network hiccup shouldn't lock anyone out here.

// A slow answer to an old question must not settle anything for a
// newer one, so each round carries a number and only the latest is
// allowed to update the flags.
let round = 0;

const runChecks = debounce(async () => {
  const mine  = ++round;
  const name  = nameBuilder.value();
  const accts = acctList.validate();

  try {
    const [takenName, clashes] = await Promise.all([
      name ? fullNameTaken(name) : Promise.resolve(false),
      accts.ok && accts.value ? accountNumbersTaken(accts.value) : Promise.resolve([]),
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

function nameChanged() {
  if (asked) clearStatus();
  checking = true;
  refresh();
  runChecks();
}

function accountsChanged() {
  if (asked) clearStatus();
  checking = true;
  refresh();
  runChecks();
}

function detailsChanged() {
  if (asked) clearStatus();
  refresh();
}

[firstInput, miInput, lastInput, suffixInput]
  .forEach(el => el.addEventListener("input", nameChanged));

[emailInput, passInput, confirmInput]
  .forEach(el => el.addEventListener("input", detailsChanged));

// Delegated, because boxes are added and removed as you go.
acctListEl.addEventListener("input", accountsChanged);

refresh();

// config.js asks the database whether the UP Mail restriction is on,
// and the answer lands a moment after this page has already painted
// based on the assumed `false`. Re-run the (silent) recompute when
// it changes so a stale verdict doesn't stick around.
onUpMailRestrictionChange(refresh);

if (privacyAck) privacyAck.addEventListener("change", refresh);

// ---- submit ----
//
// Everything the notification box ever shows originates here. No
// other code path calls showStatus.

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (sending) return;

  asked = true;

  nameBuilder.tidy();
  const fullName = nameBuilder.value();
  const email    = emailInput.value.trim();
  const password = passInput.value;
  const accts    = acctList.validate();

  const { bad, short, domainBad } = problems();
  const acknowledged = !privacyAck || privacyAck.checked;
  paint(bad, short);

  // Specific complaints outrank the catch-all, so someone is told
  // which rule they missed rather than just that something is wrong.
  if (short.size > 0) {
    showStatus(ACCT_LENGTH_MSG, "error", true);
  } else if (domainBad) {
    showStatus(UP_MAIL_MSG, "error", true);
  } else if (!acknowledged) {
    showStatus("Please read the Privacy Notice and Terms of Use, then tick the box to continue.", "error", true);
  } else if (!requiredFilled()) {
    showStatus("Fill in every required field to continue.", "error", true);
  } else if (checking) {
    // A duplicate check may still be in flight from the last
    // keystroke. Wait rather than refuse: the final check below is
    // authoritative anyway, and refusing here would mean a fast
    // typist gets turned away for being fast.
    gateEl.textContent = "Checking\u2026";
    return;
  } else if (!accts.ok || bad.size > 0 || nameClash || acctClash) {
    showStatus(DENIED, "error", true);
  }

  if (bad.size > 0 || short.size > 0 || domainBad || !acknowledged ||
      !requiredFilled() || !accts.ok || nameClash || acctClash) {
    const firstBad = [firstInput, lastInput, emailInput, passInput, confirmInput, ...acctInputs()]
      .find(el => bad.has(el) || short.has(el));
    if (firstBad) firstBad.focus({ preventScroll: true });
    return;
  }

  sending = true;
  submitBtn.textContent = "Requesting\u2026";
  clearStatus();

  try {
    // Last look before the account is made — the form can sit open
    // long enough for someone else to take the name. The cache in
    // config.js would answer from up to thirty seconds ago, which is
    // exactly the window that matters here.
    forgetDuplicateChecks();
    const [takenName, clashes] = await Promise.all([
      fullNameTaken(fullName),
      accts.value ? accountNumbersTaken(accts.value) : Promise.resolve([]),
    ]);
    nameClash = takenName === true;
    acctClash = clashes.length > 0;
    if (nameClash || acctClash) throw new Error("blocked");

    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: new URL("index.html", window.location.href).href,
        data: {
          full_name: fullName,
          account_number: accts.value,
        },
      },
    });
    if (error) throw error;

    // Supabase hands back a user with no identities when the address
    // already has an account, rather than an error. It's the
    // person's own address they just typed, so telling them plainly
    // is useful rather than a leak — flagged distinctly so the catch
    // block can give this one case its own message and leave every
    // other refusal generic.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      const alreadyRegistered = new Error("email_taken");
      alreadyRegistered.emailTaken = true;
      throw alreadyRegistered;
    }

    const needsConfirm = !data.session && data.user && !data.user.email_confirmed_at;

    if (data.session) await recordPrivacyNoticeAck();
    else rememberPendingPrivacyAck(email);

    await supabaseClient.auth.signOut();

    window.location.href = "index.html?registered=" + (needsConfirm ? "confirm" : "1");
    return;
  } catch (err) {
    // The console keeps the real reason for whoever maintains this.
    // The page shows the generic line to everyone EXCEPT the one
    // case that's genuinely the person's own business: their own
    // address already having an account here.
    console.error("Registration failed:", err);
    if (err && err.emailTaken) {
      showStatus(EMAIL_TAKEN_MSG, "error", true);
    } else {
      showStatus(DENIED, "error", true);
    }
  } finally {
    sending = false;
    submitBtn.textContent = "Request Access";
    refresh();
  }
});
