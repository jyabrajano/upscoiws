
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

function refresh() {
  const { bad, short, domainBad } = problems();
  const complete = requiredFilled();
  const blocked  = bad.size > 0 || short.size > 0 || refused;

  // RA 10173 s.16 -- the notice has to be shown before the data is
  // collected, not after. That still holds: nothing is sent until the
  // box is ticked. It is enforced at the press now rather than by a
  // dead button, which is the same guarantee with a reason attached.
  const acknowledged = !privacyAck || privacyAck.checked;

  paint(bad, short);

  // The button stays pressable, full stop. A disabled button is the
  // worst way to report a problem: it withholds the action and the
  // reason at the same time, so someone staring at a greyed-out
  // Request Access has nothing to read and nothing to try. Let them
  // press it, then say what is wrong.
  //
  // The single remaining exception is a request already in flight,
  // which is not a judgement about the form — pressing again would
  // just start a second signUp for the same person. The cooldown that
  // used to hold the button down after repeated refusals is gone with
  // the duplicate checks that drove it; Supabase Auth's own rate
  // limits were always the ones that counted.
  submitBtn.disabled = sending;

  if (sending) { gateEl.textContent = ""; return; }

  // Before the first press the form says nothing about itself beyond
  // a neutral prompt, and shows no red.
  if (!asked) {
    gateEl.textContent = "";
    clearStatus();
    return;
  }

  gateEl.textContent = "";

  // Specific complaints outrank the catch-all, so someone is told
  // which rule they missed rather than just that something is wrong.
  if (short.size > 0)         { showStatus(ACCT_LENGTH_MSG, "error"); return; }
  if (domainBad)              { showStatus(UP_MAIL_MSG, "error"); return; }
  if (!acknowledged)          { showStatus("Please read the Privacy Notice and Terms of Use, then tick the box to continue.", "error"); return; }
  if (!complete)              { showStatus("Fill in every required field to continue.", "error"); return; }

  if (blocked) showStatus(DENIED, "error");
  else clearStatus();
}

function nameChanged() {
  refused = false;
  refresh();
}

function accountsChanged() {
  refused = false;
  refresh();
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
      !acknowledged || !requiredFilled()) {
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

  sending = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "Requesting\u2026";
  clearStatus();

  try {
    // No duplicate check here any more. A name or account number
    // already on file is no longer a reason to refuse a registration:
    // it is sent through, and the administrator decides at approval
    // time with the clash marked on the card in the queue (see
    // dupBadge() in approval.js).
    //
    // That is a deliberate move of the decision, not a removal of it.
    // The old refusal could not explain itself without telling a
    // stranger who was already registered, so it said nothing useful —
    // and it turned away the case it was worst at judging, a real
    // person whose name genuinely matches someone else's.
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
    showStatus(DENIED, "error", true);
  } finally {
    sending = false;
    submitBtn.textContent = "Request Access";
    refresh();
  }
});
