const DENIED = "Access denied: if the given details are valid, Please contact the administrator.";

const ACCT_LENGTH_MSG = "LBP account numbers are default 10 digit, please input the valid account number!";

const EMAIL_TAKEN_MSG = "This email address is already registered. Try signing in instead, or use " + '"Forgot password?" on the sign-in page if you don\'t remember your password.';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const statusEl = document.getElementById("status");

const gateEl = document.getElementById("regGate");

const privacyAck = document.getElementById("privacyAck");

const submitBtn = document.getElementById("regSubmit");

const form = document.getElementById("regForm");

const firstInput = document.getElementById("regFirstName");

const miInput = document.getElementById("regMiddleInitial");

const lastInput = document.getElementById("regLastName");

const suffixInput = document.getElementById("regSuffix");

const emailInput = document.getElementById("regEmail");

const passInput = document.getElementById("regPassword");

const confirmInput = document.getElementById("regConfirmPassword");

const acctListEl = document.getElementById("regAcctList");

submitBtn.disabled = false;

let shown = "";

function showStatus(message, type, scroll) {
  statusEl.textContent = message;
  statusEl.className = `status visible ${type}`;
  if (scroll || shown !== message) {
    statusEl.scrollIntoView({
      block: "nearest",
      behavior: "smooth"
    });
  }
  shown = message;
}

function clearStatus() {
  statusEl.className = "status";
  statusEl.textContent = "";
  shown = "";
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const nameBuilder = attachNameBuilder({
  firstInput: firstInput,
  miInput: miInput,
  lastInput: lastInput,
  suffixInput: suffixInput,
  fullNameInput: document.getElementById("regFullName")
});

const acctList = attachAccountNumberList(acctListEl, {
  id: "regAccountNumber",
  required: false,
  onChange: () => accountsChanged()
});

let nameClash = false;

let acctClash = false;

let checking = false;

let sending = false;

let asked = false;

function acctInputs() {
  return Array.from(acctListEl.querySelectorAll("input"));
}

function requiredFilled() {
  return Boolean(firstInput.value.trim() && lastInput.value.trim() && emailInput.value.trim() && passInput.value && confirmInput.value);
}

function problems() {
  const bad = new Set;
  const short = new Set;
  let domainBad = false;
  [ firstInput, lastInput, emailInput, passInput, confirmInput ].forEach(el => {
    if (!el.value.trim()) bad.add(el);
  });
  const email = emailInput.value.trim();
  if (email && !EMAIL_RE.test(email)) {
    bad.add(emailInput);
  } else if (UP_MAIL_RESTRICTION_ENABLED && email && !UP_MAIL_RE.test(email)) {
    bad.add(emailInput);
    domainBad = true;
  }
  if (passInput.value && !passwordLongEnough(passInput.value)) bad.add(passInput);
  if (confirmInput.value && confirmInput.value !== passInput.value) bad.add(confirmInput);
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
    short: short,
    domainBad: domainBad
  };
}

function paint(bad, short) {
  const all = [ firstInput, lastInput, emailInput, passInput, confirmInput, ...acctInputs() ];
  all.forEach(el => {
    const flagged = asked && (bad.has(el) || short.has(el));
    el.classList.toggle("is-invalid", flagged);
  });
}

function refresh() {
  const {bad: bad, short: short} = problems();
  paint(bad, short);
  if (!asked) {
    gateEl.textContent = "";
    return;
  }
  gateEl.textContent = checking ? "Checking…" : "";
}

let round = 0;

const runChecks = debounce(async () => {
  const mine = ++round;
  const name = nameBuilder.value();
  const accts = acctList.validate();
  try {
    const [takenName, clashes] = await Promise.all([ name ? fullNameTaken(name) : Promise.resolve(false), accts.ok && accts.value ? accountNumbersTaken(accts.value) : Promise.resolve([]) ]);
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

[ firstInput, miInput, lastInput, suffixInput ].forEach(el => el.addEventListener("input", nameChanged));

[ emailInput, passInput, confirmInput ].forEach(el => el.addEventListener("input", detailsChanged));

acctListEl.addEventListener("input", accountsChanged);

refresh();

onUpMailRestrictionChange(refresh);

if (privacyAck) privacyAck.addEventListener("change", refresh);

form.addEventListener("submit", async e => {
  e.preventDefault();
  if (sending) return;
  asked = true;
  nameBuilder.tidy();
  const fullName = nameBuilder.value();
  const email = emailInput.value.trim();
  const password = passInput.value;
  const accts = acctList.validate();
  const {bad: bad, short: short, domainBad: domainBad} = problems();
  const acknowledged = !privacyAck || privacyAck.checked;
  paint(bad, short);
  if (short.size > 0) {
    showStatus(ACCT_LENGTH_MSG, "error", true);
  } else if (domainBad) {
    showStatus(UP_MAIL_MSG, "error", true);
  } else if (!acknowledged) {
    showStatus("Please read the Privacy Notice and Terms of Use, then tick the box to continue.", "error", true);
  } else if (!requiredFilled()) {
    showStatus("Fill in every required field to continue.", "error", true);
  } else if (checking) {
    gateEl.textContent = "Checking…";
    return;
  } else if (!accts.ok || bad.size > 0 || nameClash || acctClash) {
    showStatus(DENIED, "error", true);
  }
  if (bad.size > 0 || short.size > 0 || domainBad || !acknowledged || !requiredFilled() || !accts.ok || nameClash || acctClash) {
    const firstBad = [ firstInput, lastInput, emailInput, passInput, confirmInput, ...acctInputs() ].find(el => bad.has(el) || short.has(el));
    if (firstBad) firstBad.focus({
      preventScroll: true
    });
    return;
  }
  sending = true;
  submitBtn.textContent = "Requesting…";
  clearStatus();
  try {
    forgetDuplicateChecks();
    const [takenName, clashes] = await Promise.all([ fullNameTaken(fullName), accts.value ? accountNumbersTaken(accts.value) : Promise.resolve([]) ]);
    nameClash = takenName === true;
    acctClash = clashes.length > 0;
    if (nameClash || acctClash) throw new Error("blocked");
    const {data: data, error: error} = await supabaseClient.auth.signUp({
      email: email,
      password: password,
      options: {
        emailRedirectTo: new URL("index.html", window.location.href).href,
        data: {
          full_name: fullName,
          account_number: accts.value
        }
      }
    });
    if (error) throw error;
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      const alreadyRegistered = new Error("email_taken");
      alreadyRegistered.emailTaken = true;
      throw alreadyRegistered;
    }
    const needsConfirm = !data.session && data.user && !data.user.email_confirmed_at;
    if (data.session) await recordPrivacyNoticeAck(); else rememberPendingPrivacyAck(email);
    await supabaseClient.auth.signOut();
    window.location.href = "index.html?registered=" + (needsConfirm ? "confirm" : "1");
    return;
  } catch (err) {
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
