
// ------------------------------------------------------------
// Request Access stays disabled until two things are true: every
// required box is filled, and every check has come back clean.
//
// What the form will not do is say which check failed. Once the
// boxes are all filled, anything still blocking produces the
// same single line. Naming the detail that clashed is how a
// stranger works out who is already registered and under which
// account number.
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

// UP_MAIL_RESTRICTION_ENABLED, UP_MAIL_RE and UP_MAIL_MSG all now
// come from config.js, which reads the toggle from the database
// (up_mail_restriction_enabled()) instead of keeping a second
// copy of it here. This page used to declare its own `false` with
// a comment asking whoever changed the SQL to change this line
// too — see the block in config.js for why that was the wrong
// shape. Nothing to flip here any more; change the SQL.
//
// Note that UP_MAIL_RESTRICTION_ENABLED is a `let` over there and
// its value can change mid-page when the answer arrives, so it
// has to be read at check time rather than captured once. The
// listener below re-runs the gate when it does.
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

// ---- state the button reads ----

let nameClash = false;   // full name already on file
let acctClash = false;   // one of the account numbers already on file
let checking  = false;   // a duplicate check is queued or in flight
let sending   = false;   // signUp is in flight
let refused   = false;   // the last attempt was turned down
let asked     = false;   // Request Access has been pressed at least once

// Nothing on this form is called wrong until Request Access has been
// pressed. Half-typed is not the same as incorrect, and a form that
// starts correcting you at the second character reads as impatient --
// it is scolding someone for not having finished yet.
//
// After the first press the form does judge live, so a correction
// clears its own error as it is made. Making someone press again to
// find out whether they fixed it is the other failure, and the more
// annoying one.

// ---- cooldown after a refused attempt ----
//
// `refused` already holds the button down until something on the
// form changes, which covers an honest mistake. This covers the
// other case: editing one character back and forth to fire the
// duplicate checks and auth.signUp over and over. Each refusal
// in a row waits longer, up to half a minute.
//
// Like the limiter in config.js, this is a courtesy — it lives
// in the browser and can be skipped. Supabase Auth's own rate
// limits are the ones that count.
let attempts  = 0;
let coolUntil = 0;
let coolTimer = null;

function coolingDown() {
  return Date.now() < coolUntil;
}

function startCooldown() {
  attempts += 1;
  coolUntil = Date.now() + Math.min(30000, 2000 * attempts);
  clearInterval(coolTimer);
  // Ticks so the countdown is live, and stops itself once the
  // wait is over — the button comes back without the person
  // having to touch anything.
  coolTimer = setInterval(() => {
    if (!coolingDown()) clearInterval(coolTimer);
    refresh();
  }, 500);
}

// ---- what's blocking, without saying so out loud ----

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
// hold the button down, because the number is only judged when
// Request Access is pressed. The press is what turns a number in
// progress into a wrong one.
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

function refresh() {
  const { bad, short, domainBad } = problems();
  const complete = requiredFilled();
  const blocked  = bad.size > 0 || short.size > 0 || nameClash || acctClash || refused;

  // RA 10173 s.16 -- the notice has to be shown before the data is
  // collected, not after. That still holds: nothing is sent until the
  // box is ticked. It is enforced at the press now rather than by a
  // dead button, which is the same guarantee with a reason attached.
  const acknowledged = !privacyAck || privacyAck.checked;
  const cooling = coolingDown();

  paint(bad, short);

  // The button stays pressable while the form is wrong. A disabled
  // button is the worst way to report a problem: it withholds the
  // action and the reason at the same time, so someone staring at a
  // greyed-out Request Access has nothing to read and nothing to try.
  // Let them press it, then say what is wrong.
  //
  // Only states where pressing genuinely cannot achieve anything
  // disable it: a request already in flight, or a cooldown after
  // repeated failures.
  submitBtn.disabled = sending || cooling;

  if (sending) { gateEl.textContent = ""; return; }

  if (cooling) {
    gateEl.textContent = `Please wait ${Math.ceil((coolUntil - Date.now()) / 1000)}s before trying again.`;
    return;
  }

  // Before the first press the form says nothing about itself beyond
  // a neutral prompt, and shows no red.
  if (!asked) {
    gateEl.textContent = "";
    clearStatus();
    return;
  }

  gateEl.textContent = checking ? "Checking\u2026" : "";

  // Specific complaints outrank the catch-all, so someone is told
  // which rule they missed rather than just that something is wrong.
  if (short.size > 0)         { showStatus(ACCT_LENGTH_MSG, "error"); return; }
  if (domainBad)              { showStatus(UP_MAIL_MSG, "error"); return; }
  if (!acknowledged)          { showStatus("Please read the Privacy Notice and Terms of Use, then tick the box to continue.", "error"); return; }
  if (!complete)              { showStatus("Fill in every required field to continue.", "error"); return; }
  if (checking)               { clearStatus(); return; }

  if (blocked) showStatus(DENIED, "error");
  else clearStatus();
}

// ---- duplicate checks ----
//
// Both go through SECURITY DEFINER functions that answer yes or
// no and never say whose row matched. A check that can't be run
// is treated as "can't tell": the database still refuses on
// submit, so a network hiccup shouldn't lock anyone out here.

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
  refused = false;
  checking = true;
  refresh();
  runChecks();
}

function accountsChanged() {
  refused = false;
  checking = true;
  refresh();
  runChecks();
}

function detailsChanged() {
  refused = false;
  refresh();
}

[firstInput, miInput, lastInput, suffixInput]
  .forEach(el => el.addEventListener("input", nameChanged));

[emailInput, passInput, confirmInput]
  .forEach(el => el.addEventListener("input", detailsChanged));

// Delegated, because boxes are added and removed as you go.
acctListEl.addEventListener("input", accountsChanged);

// Leaving a box used to be what earned it a red outline. It no longer
// is -- the press is -- so there is nothing to record on blur, and the
// listener that recorded it has gone with the WeakSet it fed.

refresh();

// config.js asks the database whether the UP Mail restriction is
// on, and the answer lands a moment after this page has already
// painted a gate based on the assumed `false`. Without this, an
// address typed in that first moment keeps whatever verdict it
// got until the next keystroke.
onUpMailRestrictionChange(refresh);

if (privacyAck) privacyAck.addEventListener("change", refresh);

// ---- submit ----

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (submitBtn.disabled) return;

  // The press is what turns "not finished" into "wrong". From here on
  // the form reports what it finds, and keeps reporting live so that
  // fixing something clears its own error.
  asked = true;

  nameBuilder.tidy();
  const fullName = nameBuilder.value();
  const email    = emailInput.value.trim();
  const password = passInput.value;
  const accts    = acctList.validate();

  // Everything the form can judge for itself, judged here, before a
  // single byte leaves the browser. refresh() has already been told
  // to speak up, so it writes the specific reason.
  const { bad, short, domainBad } = problems();
  const acknowledged = !privacyAck || privacyAck.checked;

  if (!accts.ok || bad.size > 0 || short.size > 0 || domainBad ||
      !acknowledged || !requiredFilled() || nameClash || acctClash) {
    refresh();
    // Send focus to the first box at fault. Being told the form is
    // wrong is not much use on a long page if finding the box is the
    // next puzzle.
    const firstBad = [firstInput, lastInput, emailInput, passInput, confirmInput, ...acctInputs()]
      .find(el => bad.has(el) || short.has(el));
    if (firstBad) firstBad.focus({ preventScroll: true });
    statusEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }

  // A duplicate check may still be in flight from the last keystroke.
  // Waiting is better than refusing: the final check below is
  // authoritative anyway, and refusing here would mean a fast typist
  // gets turned away for being fast.
  if (checking) {
    refresh();
    return;
  }

  sending = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "Requesting\u2026";
  clearStatus();

  try {
    // Last look before the account is made — the form can sit
    // open long enough for someone else to take the name. The
    // cache in config.js would answer from up to thirty seconds
    // ago, which is exactly the window that matters here.
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
        // Only these two are read. handle_new_user() takes
        // full_name and account_number off raw_user_meta_data and
        // ignores everything else; profiles.first_name,
        // middle_initial, last_name and suffix are then derived
        // from full_name by normalize_profile_fields_trg, which
        // runs on every insert and update.
        //
        // middle_initial and suffix used to be sent here too, and
        // nothing ever read them. Wiring them up was not an
        // option: the trigger would overwrite both from full_name
        // the moment the row landed, so the copy could only ever
        // be ignored or be wrong. Sending them was also worse
        // than useless — raw_user_meta_data is writable by the
        // account holder through auth.updateUser({ data }) and
        // travels in the JWT, so it was an unvalidated second
        // spelling of someone's name sitting where a later reader
        // could mistake it for the authoritative one.
        //
        // full_name is already built from every name box,
        // middle initial and suffix included (buildFullName() in
        // config.js), so nothing is lost by dropping them.
        data: {
          full_name: fullName,
          account_number: accts.value,
        },
      },
    });
    if (error) throw error;

    // Supabase hands back a user with no identities when the
    // address already has an account, rather than an error —
    // that's its own way of not confirming who's registered.
    // Same treatment here as any other refusal.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new Error("blocked");
    }

    const needsConfirm = !data.session && data.user && !data.user.email_confirmed_at;

    // Written before signOut(), because record_privacy_notice_ack()
    // identifies the person from their JWT and there is no JWT after.
    // Only possible when signUp returned a session -- with email
    // confirmation on it does not.
    //
    // When it does not, the acknowledgement is parked in this browser
    // and redeemed at first sign-in. This page is the only place that
    // actually SHOWS the notice and watches the box get ticked, so it
    // is the only place entitled to say the acknowledgement happened.
    // page-index.js used to assert it on every sign-in regardless,
    // which meant Google SSO users -- who never load this page --
    // collected receipts for a notice they were never shown.
    if (data.session) await recordPrivacyNoticeAck();
    else rememberPendingPrivacyAck(email);

    await supabaseClient.auth.signOut();

    window.location.href = "index.html?registered=" + (needsConfirm ? "confirm" : "1");
    return;
  } catch (err) {
    // The console keeps the real reason for whoever maintains
    // this. The page doesn't.
    console.error("Registration failed:", err);
    refused = true;
    startCooldown();
    showStatus(DENIED, "error", true);
  } finally {
    sending = false;
    submitBtn.textContent = "Request Access";
    refresh();
  }
});
