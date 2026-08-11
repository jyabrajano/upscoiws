const SUPABASE_URL = "https://xgcdbtahappoqegheitd.supabase.co";

const SUPABASE_ANON_KEY = "sb_publishable_XscnC62J5m1WS0I55kBb8A_fjEyFOpu";

if (SUPABASE_URL.includes("YOUR_SUPABASE") || SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")) {
  console.error("[config.js] Supabase is NOT configured yet. " + "Open config.js and replace SUPABASE_URL and SUPABASE_ANON_KEY with the real values " + "from Supabase → Settings → API. Until then, sign-in, the dashboard, and the " + "statement of account will silently fail to load data.");
  document.addEventListener("DOMContentLoaded", () => {
    const banner = document.createElement("div");
    banner.textContent = "⚠ Supabase is not configured. Edit config.js with your project URL and anon key.";
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#b91c1c;color:#fff;" + "font:600 13px/1.4 sans-serif;text-align:center;padding:10px;";
    document.body.prepend(banner);
  });
}

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function todayLocalISO() {
  const d = new Date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function escapeHtml(str) {
  return (str == null ? "" : String(str)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/`/g, "&#96;");
}

async function getApprovalState(email) {
  try {
    const {data: isAdmin} = await supabaseClient.rpc("is_admin");
    if (isAdmin === true) return {
      status: "approved",
      isAdmin: true,
      reason: null
    };
  } catch (_) {}
  const {data: data, error: error} = await supabaseClient.from("profiles").select("approval_status, rejection_reason, disabled, disabled_reason").eq("email", email).maybeSingle();
  if (error) {
    if (error.code === "42703") {
      console.error("[config.js] The approval columns are missing from `profiles`. " + "Run deploy-schema.sql in Supabase → SQL Editor.");
      return {
        status: "setup",
        isAdmin: false,
        reason: null
      };
    }
    console.error("Couldn't read your approval status:", error);
    return {
      status: "unavailable",
      isAdmin: false,
      reason: null
    };
  }
  if (!data) return {
    status: "missing",
    isAdmin: false,
    reason: null
  };
  if (data.disabled === true) {
    return {
      status: "disabled",
      isAdmin: false,
      reason: data.disabled_reason || null
    };
  }
  return {
    status: data.approval_status || "pending",
    isAdmin: false,
    reason: data.rejection_reason || null
  };
}

async function requireSession() {
  const {data: {session: session}} = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = "index.html";
    return null;
  }
  const state = await getApprovalState(session.user.email);
  if (state.status === "unavailable") {
    showConnectionNotice();
    return null;
  }
  if (state.status !== "approved") {
    await supabaseClient.auth.signOut();
    window.location.href = `index.html?access=${encodeURIComponent(state.status)}`;
    return null;
  }
  startIdleWatch();
  return session;
}

function showConnectionNotice() {
  if (document.getElementById("connNotice")) return;
  const build = () => {
    const box = document.createElement("div");
    box.id = "connNotice";
    box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;inset:0;z-index:9998;display:flex;align-items:center;" + "justify-content:center;background:#f8fafc;padding:24px;" + "font:14px/1.55 system-ui,sans-serif;color:#0f172a;";
    const card = document.createElement("div");
    card.style.cssText = "max-width:380px;text-align:center;background:#fff;border:1px solid #e2e8f0;" + "border-radius:12px;padding:28px 26px;box-shadow:0 8px 28px rgba(15,23,42,0.08);";
    const h = document.createElement("h2");
    h.textContent = "Can't reach the portal";
    h.style.cssText = "margin:0 0 10px;font-size:17px;font-weight:700;";
    const p = document.createElement("p");
    p.textContent = "Your sign-in is still valid — we just couldn't load your account " + "details. This is usually a brief connection problem.";
    p.style.cssText = "margin:0 0 18px;color:#475569;";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Try again";
    retry.style.cssText = "background:#7b1113;color:#fff;border:none;padding:11px 22px;border-radius:8px;" + "font:700 14px/1 inherit;cursor:pointer;";
    retry.addEventListener("click", () => window.location.reload());
    card.append(h, p, retry);
    box.appendChild(card);
    document.body.appendChild(box);
  };
  if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
}

async function logout() {
  await supabaseClient.auth.signOut();
  window.location.href = "index.html";
}

const IDLE_LIMIT_MS = 5 * 60 * 1e3;

const IDLE_WARN_MS = 60 * 1e3;

const IDLE_POLL_MS = 5e3;

const IDLE_WRITE_MS = 2e3;

const IDLE_KEY = "scoiws:last-activity";

let idleLastActivity = Date.now();

let idleLastWrite = 0;

let idleWatching = false;

let idleWarningEl = null;

function idleReadLastActivity() {
  try {
    const raw = localStorage.getItem(IDLE_KEY);
    const shared = raw ? Number(raw) : 0;
    return Math.max(idleLastActivity, Number.isFinite(shared) ? shared : 0);
  } catch (_) {
    return idleLastActivity;
  }
}

function idleMarkActivity(force) {
  const now = Date.now();
  idleLastActivity = now;
  if (!force && now - idleLastWrite < IDLE_WRITE_MS) return;
  idleLastWrite = now;
  try {
    localStorage.setItem(IDLE_KEY, String(now));
  } catch (_) {}
}

function idleDismissWarning() {
  if (!idleWarningEl) return;
  idleWarningEl.remove();
  idleWarningEl = null;
}

function idleShowWarning(secondsLeft) {
  if (idleWarningEl) {
    const count = idleWarningEl.querySelector("[data-idle-count]");
    if (count) count.textContent = String(secondsLeft);
    return;
  }
  const box = document.createElement("div");
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-labelledby", "idleWarnTitle");
  box.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;" + "justify-content:center;background:rgba(15,23,42,0.55);padding:24px;" + "font:14px/1.55 system-ui,sans-serif;color:#0f172a;";
  const card = document.createElement("div");
  card.style.cssText = "max-width:380px;text-align:center;background:#fff;border-radius:12px;" + "padding:28px 26px;box-shadow:0 12px 40px rgba(15,23,42,0.25);";
  const h = document.createElement("h2");
  h.id = "idleWarnTitle";
  h.textContent = "Still there?";
  h.style.cssText = "margin:0 0 10px;font-size:17px;font-weight:700;";
  const p = document.createElement("p");
  p.style.cssText = "margin:0 0 18px;color:#475569;";
  p.append(document.createTextNode("You'll be signed out in "), Object.assign(document.createElement("strong"), {
    textContent: String(secondsLeft)
  }), document.createTextNode(" seconds to protect your account details."));
  p.querySelector("strong").setAttribute("data-idle-count", "");
  const stay = document.createElement("button");
  stay.type = "button";
  stay.textContent = "Stay signed in";
  stay.style.cssText = "background:#7b1113;color:#fff;border:none;padding:11px 22px;border-radius:8px;" + "font:700 14px/1 inherit;cursor:pointer;";
  stay.addEventListener("click", () => {
    idleMarkActivity(true);
    idleDismissWarning();
  });
  card.append(h, p, stay);
  box.appendChild(card);
  document.body.appendChild(box);
  idleWarningEl = box;
  stay.focus();
}

async function idleSignOut() {
  idleWatching = false;
  idleDismissWarning();
  try {
    localStorage.removeItem(IDLE_KEY);
  } catch (_) {}
  try {
    await supabaseClient.auth.signOut();
  } catch (_) {}
  window.location.replace("index.html?timeout=1");
}

function startIdleWatch() {
  if (idleWatching) return;
  idleWatching = true;
  idleMarkActivity(true);
  [ "pointerdown", "pointermove", "keydown", "scroll", "wheel", "focus" ].forEach(evt => window.addEventListener(evt, () => idleMarkActivity(false), {
    passive: true,
    capture: true
  }));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) idleMarkActivity(true);
  });
  setInterval(() => {
    if (!idleWatching) return;
    const idleFor = Date.now() - idleReadLastActivity();
    if (idleFor >= IDLE_LIMIT_MS) {
      idleSignOut();
      return;
    }
    const msLeft = IDLE_LIMIT_MS - idleFor;
    if (msLeft <= IDLE_WARN_MS) idleShowWarning(Math.ceil(msLeft / 1e3)); else idleDismissWarning();
  }, IDLE_POLL_MS);
}

function accountNumberDigits(raw) {
  return String(raw == null ? "" : raw).replace(/\D/g, "").slice(0, 10);
}

function formatAccountNumber(raw) {
  const digits = accountNumberDigits(raw);
  if (digits.length <= 4) return digits;
  if (digits.length <= 8) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`;
}

function validateAccountNumber(value, opts) {
  const required = !!(opts && opts.required);
  const digits = accountNumberDigits(value);
  if (!digits) {
    return required ? {
      ok: false,
      message: "Enter your LBP account number."
    } : {
      ok: true,
      value: ""
    };
  }
  if (digits.length !== 10) {
    return {
      ok: false,
      message: `An LBP account number is 10 digits — that's ${digits.length}.`
    };
  }
  return {
    ok: true,
    value: formatAccountNumber(digits)
  };
}

function setCaretAfterDigits(input, digitCount) {
  if (digitCount <= 0) {
    try {
      input.setSelectionRange(0, 0);
    } catch (_) {}
    return;
  }
  const value = input.value;
  let seen = 0;
  let i = 0;
  for (;i < value.length; i++) {
    if (value[i] >= "0" && value[i] <= "9") seen++;
    if (seen === digitCount) {
      i++;
      break;
    }
  }
  while (i < value.length && value[i] === "-") i++;
  try {
    input.setSelectionRange(i, i);
  } catch (_) {}
}

function countDigits(str) {
  return (String(str).match(/\d/g) || []).length;
}

function attachAccountNumberInput(input) {
  if (!input || input.dataset.acctFormatReady === "1") return;
  input.dataset.acctFormatReady = "1";
  input.setAttribute("inputmode", "numeric");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("maxlength", "12");
  input.addEventListener("keydown", e => {
    if (e.key !== "Backspace") return;
    const pos = input.selectionStart;
    if (pos === null || pos !== input.selectionEnd || pos < 2) return;
    if (input.value[pos - 1] !== "-") return;
    e.preventDefault();
    const kept = input.value.slice(0, pos - 2) + input.value.slice(pos);
    const digitsBefore = countDigits(input.value.slice(0, pos - 2));
    input.value = formatAccountNumber(kept);
    setCaretAfterDigits(input, digitsBefore);
  });
  input.addEventListener("input", () => {
    const caret = input.selectionStart === null ? input.value.length : input.selectionStart;
    const digitsBefore = countDigits(input.value.slice(0, caret));
    input.value = formatAccountNumber(input.value);
    setCaretAfterDigits(input, digitsBefore);
  });
  if (input.value) input.value = formatAccountNumber(input.value);
}

function enableAccountNumberInputs(root) {
  (root || document).querySelectorAll("[data-account-number]").forEach(attachAccountNumberInput);
}

let MAX_ACCOUNT_NUMBERS = 3;

const accountListRefreshers = new Set;

async function syncMaxAccountNumbers() {
  try {
    const {data: data, error: error} = await supabaseClient.rpc("max_account_numbers");
    if (error) throw error;
    const limit = Number(data);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      console.warn("[config.js] max_account_numbers() returned an odd value:", data);
      return MAX_ACCOUNT_NUMBERS;
    }
    if (limit !== MAX_ACCOUNT_NUMBERS) {
      MAX_ACCOUNT_NUMBERS = limit;
      accountListRefreshers.forEach(refresh => {
        try {
          refresh();
        } catch (_) {}
      });
    }
  } catch (err) {
    console.warn("Couldn't read the account-number limit; using", MAX_ACCOUNT_NUMBERS, err);
  }
  return MAX_ACCOUNT_NUMBERS;
}

let UP_MAIL_RESTRICTION_ENABLED = false;

const UP_MAIL_RE = /@up\.edu\.ph$/i;

const UP_MAIL_MSG = "Use your UP Mail address — this portal only accepts accounts ending in @up.edu.ph.";

const upMailRestrictionListeners = new Set;

async function syncUpMailRestriction() {
  try {
    const {data: data, error: error} = await supabaseClient.rpc("up_mail_restriction_enabled");
    if (error) throw error;
    if (typeof data !== "boolean") {
      console.warn("[config.js] up_mail_restriction_enabled() returned a non-boolean:", data);
      return UP_MAIL_RESTRICTION_ENABLED;
    }
    if (data !== UP_MAIL_RESTRICTION_ENABLED) {
      UP_MAIL_RESTRICTION_ENABLED = data;
      upMailRestrictionListeners.forEach(notify => {
        try {
          notify(data);
        } catch (_) {}
      });
    }
  } catch (err) {
    console.warn("Couldn't read the UP Mail restriction; assuming", UP_MAIL_RESTRICTION_ENABLED, err);
  }
  return UP_MAIL_RESTRICTION_ENABLED;
}

function onUpMailRestrictionChange(notify) {
  upMailRestrictionListeners.add(notify);
}

function parseAccountNumbers(value) {
  return String(value == null ? "" : value).split(/[,;\n]+/).map(formatAccountNumber).filter((n, i, all) => n && all.indexOf(n) === i).slice(0, MAX_ACCOUNT_NUMBERS);
}

function joinAccountNumbers(numbers) {
  return (numbers || []).filter(Boolean).join(", ");
}

function attachAccountNumberList(container, opts) {
  const options = opts || {};
  const required = !!options.required;
  const rows = document.createElement("div");
  rows.className = "acct-rows";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "acct-add";
  addBtn.textContent = "+ Add another account number";
  container.appendChild(rows);
  container.appendChild(addBtn);
  function values() {
    return Array.from(rows.querySelectorAll("input")).map(i => i.value.trim()).filter(Boolean);
  }
  function refresh() {
    const count = rows.children.length;
    Array.from(rows.children).forEach((row, i) => {
      const remove = row.querySelector(".acct-remove");
      remove.style.visibility = count > 1 || !required && i > 0 ? "visible" : "hidden";
    });
    addBtn.style.display = count >= MAX_ACCOUNT_NUMBERS ? "none" : "block";
  }
  function addRow(value) {
    if (rows.children.length >= MAX_ACCOUNT_NUMBERS) return null;
    const row = document.createElement("div");
    row.className = "acct-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "####-####-##";
    input.setAttribute("data-account-number", "");
    if (rows.children.length === 0 && options.id) input.id = options.id;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "acct-remove";
    remove.setAttribute("aria-label", "Remove this account number");
    remove.innerHTML = "&times;";
    remove.addEventListener("click", () => {
      row.remove();
      if (rows.children.length === 0) addRow("");
      refresh();
      if (options.onChange) options.onChange();
    });
    row.appendChild(input);
    row.appendChild(remove);
    rows.appendChild(row);
    attachAccountNumberInput(input);
    if (value) input.value = formatAccountNumber(value);
    if (options.onChange) input.addEventListener("change", options.onChange);
    refresh();
    return input;
  }
  addBtn.addEventListener("click", () => {
    const input = addRow("");
    if (input) input.focus();
  });
  function fill(value) {
    rows.innerHTML = "";
    const numbers = parseAccountNumbers(value);
    if (numbers.length === 0) addRow(""); else numbers.forEach(addRow);
    refresh();
  }
  fill(options.initial || "");
  accountListRefreshers.add(refresh);
  return {
    values: values,
    fill: fill,
    value: () => joinAccountNumbers(values()),
    validate() {
      const raw = values();
      if (raw.length === 0) {
        return required ? {
          ok: false,
          message: "Enter at least one account number."
        } : {
          ok: true,
          value: ""
        };
      }
      for (const one of raw) {
        const check = validateAccountNumber(one, {
          required: true
        });
        if (!check.ok) return check;
      }
      const cleaned = parseAccountNumbers(raw.join(","));
      if (cleaned.length !== raw.length) {
        return {
          ok: false,
          message: "That account number is listed twice."
        };
      }
      return {
        ok: true,
        value: joinAccountNumbers(cleaned)
      };
    }
  };
}

const CHECK_CACHE_MS = 3e4;

const CHECK_BURST = 12;

const CHECK_WINDOW_MS = 1e4;

const checkCache = new Map;

const checkCalls = [];

function checkWindowHasRoom() {
  const now = Date.now();
  while (checkCalls.length && now - checkCalls[0] > CHECK_WINDOW_MS) checkCalls.shift();
  if (checkCalls.length >= CHECK_BURST) return false;
  checkCalls.push(now);
  return true;
}

async function cachedCheck(key, fallback, run) {
  const hit = checkCache.get(key);
  if (hit && Date.now() - hit.at < CHECK_CACHE_MS) return hit.value;
  if (!checkWindowHasRoom()) {
    console.warn("Duplicate checks are being made too quickly; skipping this one.");
    return hit ? hit.value : fallback;
  }
  const value = await run();
  checkCache.set(key, {
    at: Date.now(),
    value: value
  });
  if (checkCache.size > 200) {
    const cutoff = Date.now() - CHECK_CACHE_MS;
    checkCache.forEach((entry, k) => {
      if (entry.at < cutoff) checkCache.delete(k);
    });
  }
  return value;
}

async function accountNumbersTaken(value, email) {
  return cachedCheck(`acct:${email || ""}:${value}`, [], async () => {
    try {
      const {data: data, error: error} = await supabaseClient.rpc("account_numbers_taken", {
        p_value: value,
        p_email: email || null
      });
      if (error) throw error;
      return data || [];
    } catch (err) {
      console.warn("Couldn't check account numbers:", err);
      return [];
    }
  });
}

async function fullNameTaken(name, email) {
  return cachedCheck(`name:${email || ""}:${name}`, false, async () => {
    try {
      const {data: data, error: error} = await supabaseClient.rpc("full_name_taken", {
        p_name: name,
        p_email: email || null
      });
      if (error) throw error;
      return data === true;
    } catch (err) {
      console.warn("Couldn't check the name:", err);
      return false;
    }
  });
}

function forgetDuplicateChecks() {
  checkCache.clear();
}

const NAME_SUFFIXES = [ "JR", "JR.", "SR", "SR.", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X" ];

function tidyMiddleInitial(raw) {
  const letters = String(raw == null ? "" : raw).replace(/[^A-Za-z]/g, "").toUpperCase();
  if (!letters) return "";
  return letters.split("").map(letter => `${letter}.`).join("");
}

function countLetters(str) {
  return (String(str).match(/[A-Za-z]/g) || []).length;
}

function setCaretAfterLetters(input, letterCount) {
  const pos = Math.max(0, Math.min(letterCount * 2, input.value.length));
  try {
    input.setSelectionRange(pos, pos);
  } catch (_) {}
}

function attachMiddleInitialInput(input) {
  if (!input || input.dataset.miFormatReady === "1") return;
  input.dataset.miFormatReady = "1";
  input.setAttribute("autocapitalize", "characters");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("spellcheck", "false");
  input.addEventListener("keydown", e => {
    if (e.key !== "Backspace") return;
    const pos = input.selectionStart;
    if (pos === null || pos !== input.selectionEnd || pos === 0) return;
    e.preventDefault();
    const before = countLetters(input.value.slice(0, pos));
    const letters = input.value.replace(/[^A-Za-z]/g, "").toUpperCase().split("");
    if (before > 0) letters.splice(before - 1, 1);
    input.value = tidyMiddleInitial(letters.join(""));
    setCaretAfterLetters(input, before - 1);
    input.dispatchEvent(new Event("input", {
      bubbles: true
    }));
  });
  input.addEventListener("input", () => {
    const caret = input.selectionStart === null ? input.value.length : input.selectionStart;
    const before = countLetters(input.value.slice(0, caret));
    const tidied = tidyMiddleInitial(input.value);
    if (tidied !== input.value) {
      input.value = tidied;
      setCaretAfterLetters(input, before);
    }
  });
  if (input.value) input.value = tidyMiddleInitial(input.value);
}

function buildFullName(parts) {
  const first = String(parts.first || "").trim();
  const mi = String(parts.middleInitial || "").trim().replace(/\.$/, "");
  const last = String(parts.last || "").trim();
  const suffix = String(parts.suffix || "").trim().replace(/^,\s*/, "");
  const middlePart = mi ? ` ${mi}.` : "";
  const firstAndMiddle = `${first}${middlePart}`.trim();
  let name = "";
  if (last && firstAndMiddle) name = `${last}, ${firstAndMiddle}`; else if (last) name = last; else name = firstAndMiddle;
  if (suffix) name = name ? `${name} ${suffix}` : suffix;
  return name.toUpperCase();
}

function splitFullName(fullName) {
  const parts = {
    first: "",
    middleInitial: "",
    last: "",
    suffix: ""
  };
  const value = String(fullName == null ? "" : fullName).trim();
  if (!value) return parts;
  const comma = value.indexOf(",");
  if (comma === -1) {
    parts.last = value;
    return parts;
  }
  parts.last = value.slice(0, comma).trim();
  const tokens = value.slice(comma + 1).trim().split(/\s+/).filter(Boolean);
  if (tokens.length && NAME_SUFFIXES.includes(tokens[tokens.length - 1].toUpperCase())) {
    parts.suffix = tokens.pop();
  }
  const looksLikeInitial = t => /^[A-Za-z](\.[A-Za-z])*\.$/.test(t) || /^[A-Za-z]$/.test(t);
  if (tokens.length > 1 && looksLikeInitial(tokens[tokens.length - 1])) {
    parts.middleInitial = tidyMiddleInitial(tokens.pop());
  }
  parts.first = tokens.join(" ");
  return parts;
}

function attachNameBuilder(fields) {
  const {firstInput: firstInput, miInput: miInput, lastInput: lastInput, suffixInput: suffixInput, fullNameInput: fullNameInput} = fields;
  function read() {
    return {
      first: firstInput ? firstInput.value : "",
      middleInitial: miInput ? miInput.value : "",
      last: lastInput ? lastInput.value : "",
      suffix: suffixInput ? suffixInput.value : ""
    };
  }
  function update() {
    const name = buildFullName(read());
    if (fullNameInput) fullNameInput.value = name;
    return name;
  }
  function tidy() {
    if (miInput) miInput.value = tidyMiddleInitial(miInput.value);
    return update();
  }
  function fill(fullName) {
    const parts = splitFullName(fullName);
    if (firstInput) firstInput.value = parts.first;
    if (miInput) miInput.value = parts.middleInitial;
    if (lastInput) lastInput.value = parts.last;
    if (suffixInput) suffixInput.value = parts.suffix;
    return update();
  }
  function clear() {
    [ firstInput, miInput, lastInput, suffixInput ].forEach(el => {
      if (el) el.value = "";
    });
    return update();
  }
  if (miInput) attachMiddleInitialInput(miInput);
  [ firstInput, miInput, lastInput, suffixInput ].filter(Boolean).forEach(el => el.addEventListener("input", update));
  if (miInput) miInput.addEventListener("blur", tidy);
  update();
  return {
    read: read,
    update: update,
    tidy: tidy,
    fill: fill,
    clear: clear,
    value: () => fullNameInput ? fullNameInput.value.trim() : ""
  };
}

const PRIVACY_NOTICE_VERSION = "2026-08-06";

async function recordPrivacyNoticeAck() {
  try {
    const {error: error} = await supabaseClient.rpc("record_privacy_notice_ack", {
      p_version: PRIVACY_NOTICE_VERSION
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn("Couldn't record the privacy notice acknowledgement:", err);
    return false;
  }
}

const PENDING_ACK_KEY = "scoiws:pending-privacy-ack";

function rememberPendingPrivacyAck(email) {
  try {
    localStorage.setItem(PENDING_ACK_KEY, JSON.stringify({
      email: String(email || "").trim().toLowerCase(),
      version: PRIVACY_NOTICE_VERSION,
      at: (new Date).toISOString()
    }));
  } catch (_) {}
}

function redeemPendingPrivacyAck(email) {
  try {
    const raw = localStorage.getItem(PENDING_ACK_KEY);
    if (!raw) return false;
    const pending = JSON.parse(raw);
    const matches = pending && pending.version === PRIVACY_NOTICE_VERSION && pending.email === String(email || "").trim().toLowerCase();
    if (matches) localStorage.removeItem(PENDING_ACK_KEY);
    return Boolean(matches);
  } catch (_) {
    return false;
  }
}

async function ensurePrivacyNoticeAck(email) {
  try {
    const {data: data, error: error} = await supabaseClient.from("profiles").select("privacy_notice_ack_at, privacy_notice_ack_version").eq("email", email).maybeSingle();
    if (error) throw error;
    if (data && data.privacy_notice_ack_at && data.privacy_notice_ack_version === PRIVACY_NOTICE_VERSION) {
      return true;
    }
    if (redeemPendingPrivacyAck(email)) return recordPrivacyNoticeAck();
    return showPrivacyNoticeGate();
  } catch (err) {
    console.warn("Couldn't check the privacy notice acknowledgement:", err);
    return false;
  }
}

function showPrivacyNoticeGate() {
  return new Promise(resolve => {
    if (document.getElementById("privacyGate")) return resolve(false);
    const build = () => {
      const box = document.createElement("div");
      box.id = "privacyGate";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", "privacyGateTitle");
      box.style.cssText = "position:fixed;inset:0;z-index:9997;display:flex;align-items:center;" + "justify-content:center;background:rgba(15,23,42,0.55);padding:24px;" + "font:14px/1.55 system-ui,sans-serif;color:#0f172a;";
      const card = document.createElement("div");
      card.style.cssText = "max-width:440px;background:#fff;border-radius:12px;padding:28px 26px;" + "box-shadow:0 12px 40px rgba(15,23,42,0.25);";
      const h = document.createElement("h2");
      h.id = "privacyGateTitle";
      h.textContent = "Before you continue";
      h.style.cssText = "margin:0 0 10px;font-size:17px;font-weight:700;";
      const p = document.createElement("p");
      p.style.cssText = "margin:0 0 18px;color:#475569;";
      p.append(document.createTextNode("This portal holds your name and account numbers. Please read the "));
      const privacyLink = document.createElement("a");
      privacyLink.href = "privacy.html";
      privacyLink.target = "_blank";
      privacyLink.rel = "noopener";
      privacyLink.textContent = "Privacy Notice";
      privacyLink.style.cssText = "color:#7b1113;font-weight:600;";
      const termsLink = document.createElement("a");
      termsLink.href = "terms.html";
      termsLink.target = "_blank";
      termsLink.rel = "noopener";
      termsLink.textContent = "Terms of Use";
      termsLink.style.cssText = "color:#7b1113;font-weight:600;";
      p.append(privacyLink, document.createTextNode(" and the "), termsLink, document.createTextNode("."));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "I have read the Privacy Notice";
      btn.style.cssText = "background:#7b1113;color:#fff;border:none;padding:11px 22px;border-radius:8px;" + "font:700 14px/1 inherit;cursor:pointer;";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Saving…";
        const ok = await recordPrivacyNoticeAck();
        box.remove();
        resolve(ok);
      });
      card.append(h, p, btn);
      box.appendChild(card);
      document.body.appendChild(box);
      btn.focus();
    };
    if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
  });
}

const PASSWORD_MIN_LENGTH = 8;

function passwordLongEnough(password) {
  return String(password == null ? "" : password).length >= PASSWORD_MIN_LENGTH;
}

function passwordPolicyText() {
  return `At least ${PASSWORD_MIN_LENGTH} characters.`;
}

function passwordTooShortText() {
  return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
}

function applyPasswordPolicy(root) {
  (root || document).querySelectorAll("[data-password-policy]").forEach(input => {
    input.setAttribute("minlength", String(PASSWORD_MIN_LENGTH));
  });
}

function injectPasswordToggleStyles() {
  if (document.getElementById("pwToggleStyles")) return;
  const style = document.createElement("style");
  style.id = "pwToggleStyles";
  style.textContent = `\n  .pw-wrap { position: relative; display: block; }\n  .pw-wrap > input { padding-right: 44px !important; }\n  .pw-toggle {\n    position: absolute;\n    top: 50%;\n    right: 4px;\n    transform: translateY(-50%);\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    width: 34px;\n    height: 34px;\n    padding: 0;\n    border: none;\n    border-radius: 8px;\n    background: transparent;\n    color: #94a3b8;\n    cursor: pointer;\n    transition: color 0.15s, background-color 0.15s;\n  }\n  .pw-toggle:hover { color: var(--maroon, #7b1113); background: rgba(123, 17, 19, 0.07); }\n  .pw-toggle:focus-visible {\n    outline: 2px solid var(--maroon, #7b1113);\n    outline-offset: 1px;\n  }\n  .pw-toggle svg { width: 18px; height: 18px; pointer-events: none; }\n  .pw-toggle .icon-hide { display: none; }\n  .pw-toggle.is-showing .icon-show { display: none; }\n  .pw-toggle.is-showing .icon-hide { display: block; }\n  .pw-toggle.is-showing { color: var(--maroon, #7b1113); }`;
  document.head.appendChild(style);
}

function attachPasswordToggle(input) {
  if (!input || input.dataset.pwToggleReady === "1") return;
  if (input.hasAttribute("data-no-toggle")) return;
  input.dataset.pwToggleReady = "1";
  const wrap = document.createElement("div");
  wrap.className = "pw-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pw-toggle";
  btn.setAttribute("aria-label", "Show password");
  btn.setAttribute("title", "Show password");
  btn.innerHTML = `\n    <svg class="icon-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"\n         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\n      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>\n      <circle cx="12" cy="12" r="3"></circle>\n    </svg>\n    <svg class="icon-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"\n         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\n      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path>\n      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>\n      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path>\n      <line x1="1" y1="1" x2="23" y2="23"></line>\n    </svg>`;
  btn.addEventListener("click", () => {
    const showing = input.type === "password";
    input.type = showing ? "text" : "password";
    btn.classList.toggle("is-showing", showing);
    btn.setAttribute("aria-label", showing ? "Hide password" : "Show password");
    btn.setAttribute("title", showing ? "Hide password" : "Show password");
    input.focus();
    const end = input.value.length;
    try {
      input.setSelectionRange(end, end);
    } catch (_) {}
  });
  wrap.appendChild(btn);
}

function enablePasswordToggles(root) {
  injectPasswordToggleStyles();
  (root || document).querySelectorAll('input[type="password"]').forEach(attachPasswordToggle);
}

const DATA_REFRESH_POLL_MS = 6e4;

const DATA_REFRESH_DEBOUNCE_MS = 400;

function watchDatasets(datasets, onChange) {
  const wanted = (Array.isArray(datasets) ? datasets : [ datasets ]).filter(Boolean);
  if (!wanted.length || typeof onChange !== "function") return () => {};
  const seen = new Map;
  let timer = null;
  let poller = null;
  let channel = null;
  let stopped = false;
  function moved(dataset, version) {
    if (!wanted.includes(dataset)) return false;
    const had = seen.has(dataset);
    const prev = seen.get(dataset);
    seen.set(dataset, version);
    return had && version !== prev;
  }
  function fire(dataset) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        onChange(dataset);
      } catch (err) {
        console.error("[watchDatasets] refresh handler failed:", err);
      }
    }, DATA_REFRESH_DEBOUNCE_MS);
  }
  async function readVersions(fireOnChange) {
    try {
      const {data: data, error: error} = await supabaseClient.from("data_versions").select("dataset, version").in("dataset", wanted);
      if (error) throw error;
      let changed = null;
      (data || []).forEach(row => {
        if (moved(row.dataset, row.version)) changed = row.dataset;
      });
      if (changed && fireOnChange) fire(changed);
    } catch (err) {
      console.warn("[watchDatasets] couldn't read data_versions:", err);
    }
  }
  function startPolling() {
    if (poller || stopped) return;
    poller = setInterval(() => readVersions(true), DATA_REFRESH_POLL_MS);
  }
  readVersions(false).then(() => {
    if (stopped) return;
    try {
      channel = supabaseClient.channel("data-versions").on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "data_versions"
      }, payload => {
        const row = payload.new || {};
        if (moved(row.dataset, row.version)) fire(row.dataset);
      }).subscribe(status => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") startPolling();
      });
    } catch (err) {
      console.warn("[watchDatasets] Realtime unavailable, polling instead:", err);
      startPolling();
    }
  });
  function onVisible() {
    if (document.visibilityState === "visible") readVersions(true);
  }
  document.addEventListener("visibilitychange", onVisible);
  return function stop() {
    stopped = true;
    clearTimeout(timer);
    if (poller) clearInterval(poller);
    document.removeEventListener("visibilitychange", onVisible);
    if (channel) supabaseClient.removeChannel(channel);
  };
}

function initSharedBehaviour() {
  enablePasswordToggles();
  enableAccountNumberInputs();
  applyPasswordPolicy();
  syncMaxAccountNumbers();
  syncUpMailRestriction();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSharedBehaviour);
} else {
  initSharedBehaviour();
}

// =====================================================================
// APPEND THIS TO THE END OF config.js
//
// Shared helpers for the 2026-08-11 patch. They live in config.js
// because config.js is already the layer every page loads first, and
// because splitting them into a new file would mean a new <script> tag
// on nine pages, a new SRI hash, and a CSP resync — churn out of all
// proportion to a hundred lines of glue.
// =====================================================================

// ---------------------------------------------------------------------
// Transactions — server-side paging
// ---------------------------------------------------------------------

// Returns { rows, total_count, total_amount, limit, offset, has_more }.
// total_count and total_amount cover the WHOLE matching set, not the
// page — that distinction is the point of the function.
async function fetchMyTransactions(kind, from, to, account, limit, offset) {
  const { data, error } = await supabaseClient.rpc("my_transactions", {
    p_kind: kind,
    p_from: from || null,
    p_to: to || null,
    p_account: account || null,
    p_limit: limit || 100,
    p_offset: offset || 0
  });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------
// Issued statements
// ---------------------------------------------------------------------

// Registers a statement and returns its reference and server-computed
// totals. Call this when a statement leaves the screen — printed,
// exported — not on every page view, or the registry fills with
// references nobody was ever given.
async function issueStatement(kind, from, to, account) {
  const { data, error } = await supabaseClient.rpc("issue_statement", {
    p_kind: kind,
    p_from: from || null,
    p_to: to || null,
    p_account: account || null
  });
  if (error) throw error;
  return data;
}

async function verifyStatement(reference) {
  const { data, error } = await supabaseClient.rpc("verify_statement", {
    p_reference: reference
  });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------
// Account events — the user's own security history
// ---------------------------------------------------------------------

// The server decides what gets written: user_email comes from the JWT,
// the IP and user agent from the request headers. The client only says
// which of three things just happened. Failures are swallowed on
// purpose — a sign-in must not fail because its audit line did.
async function recordAccountEvent(kind, detail) {
  try {
    const { error } = await supabaseClient.rpc("record_account_event", {
      p_kind: kind,
      p_detail: detail || null
    });
    if (error) throw error;
  } catch (err) {
    console.warn("Couldn't record account event:", kind, err);
  }
}

async function myAccountEvents(limit) {
  const { data, error } = await supabaseClient.rpc("my_account_events", {
    p_limit: limit || 25
  });
  if (error) throw error;
  return data || [];
}

const ACCOUNT_EVENT_LABELS = {
  sign_in: "Signed in",
  sign_in_new_device: "Signed in from an unrecognised device",
  password_changed: "Password changed",
  email_changed: "Email address changed",
  profile_change_requested: "Change request submitted",
  profile_change_withdrawn: "Change request withdrawn",
  profile_change_approved: "Change request approved by the Cash Office",
  profile_change_rejected: "Change request declined by the Cash Office",
  account_number_changed: "LBP account number changed",
  data_exported: "Copy of your data downloaded",
  statement_issued: "Statement issued",
  access_disabled: "Access switched off",
  access_restored: "Access restored"
};

// Deliberately coarse. A precise device string is a fingerprint and
// tells the account holder less than "Chrome on Windows" does — the
// question they are answering is "was that me", not "which build".
function deviceLabel(userAgent) {
  const ua = String(userAgent || "");
  if (!ua) return "Unknown device";
  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  let os = "";
  if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";
  return os ? `${browser} on ${os}` : browser;
}

function formatEventStamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit"
  });
}

function injectAccountActivityStyles() {
  if (document.getElementById("accountActivityStyles")) return;
  const style = document.createElement("style");
  style.id = "accountActivityStyles";
  style.textContent = `
    .activity-list { list-style:none; margin:12px 0 0; padding:0; }
    .activity-list li {
      display:flex; gap:10px; align-items:flex-start;
      padding:10px 0; border-bottom:1px solid var(--card-border,#e2e8f0);
    }
    .activity-list li:last-child { border-bottom:0; }
    .activity-dot {
      flex:0 0 8px; width:8px; height:8px; border-radius:50%;
      background:#94a3b8; margin-top:6px;
    }
    .activity-dot.flag { background:#b91c1c; }
    .activity-main { flex:1 1 auto; min-width:0; }
    .activity-what { font-weight:600; font-size:13.5px; color:#0f172a; }
    .activity-meta { font-size:12px; color:var(--muted,#64748b); margin-top:2px; }
    .activity-empty { font-size:13px; color:var(--muted,#64748b); margin:12px 0 0; }
    .activity-alarm {
      margin:12px 0 0; padding:10px 12px; border-radius:8px;
      background:#fef2f2; border:1px solid #fecaca; border-left:3px solid #b91c1c;
      font-size:12.5px; line-height:1.55; color:#7f1d1d;
    }
  `;
  document.head.appendChild(style);
}

// Renders the account holder's own recent activity into `container`.
// Used on Edit Account; safe to drop anywhere a signed-in user is.
async function mountAccountActivity(container, limit) {
  if (!container) return;
  injectAccountActivityStyles();
  container.innerHTML = '<p class="activity-empty">Loading\u2026</p>';

  let events;
  try {
    events = await myAccountEvents(limit || 15);
  } catch (err) {
    console.error("Couldn't load your account activity:", err);
    container.innerHTML =
      '<p class="activity-empty">Couldn\'t load your recent activity. ' +
      'Reload the page to try again.</p>';
    return;
  }

  if (!events.length) {
    container.innerHTML =
      '<p class="activity-empty">Nothing recorded yet. Activity from here on ' +
      'will be listed, starting with your next sign-in.</p>';
    return;
  }

  // Anything that changes where money goes, or that suggests somebody
  // else got in, is flagged. The flag is visual only — the words carry
  // the meaning, in case the colour does not reach the reader.
  const FLAGGED = new Set(["sign_in_new_device", "account_number_changed", "password_changed", "email_changed"]);
  const anyFlagged = events.some(e => FLAGGED.has(e.kind));

  const rows = events.map(e => {
    const what = ACCOUNT_EVENT_LABELS[e.kind] || e.kind;
    const bits = [formatEventStamp(e.at), deviceLabel(e.user_agent), e.ip || null].filter(Boolean);
    let extra = "";
    if (e.kind === "account_number_changed" && e.detail) {
      extra = ` \u2014 ${escapeHtml(e.detail.from || "none")} \u2192 ${escapeHtml(e.detail.to || "none")}`;
    } else if (e.kind === "statement_issued" && e.detail && e.detail.reference) {
      extra = ` \u2014 ${escapeHtml(e.detail.reference)}`;
    }
    return `
      <li>
        <span class="activity-dot${FLAGGED.has(e.kind) ? " flag" : ""}"></span>
        <span class="activity-main">
          <span class="activity-what">${escapeHtml(what)}${extra}</span>
          <span class="activity-meta">${escapeHtml(bits.join(" \u00b7 "))}</span>
        </span>
      </li>`;
  }).join("");

  container.innerHTML =
    `<ul class="activity-list">${rows}</ul>` +
    (anyFlagged
      ? '<p class="activity-alarm"><strong>Something here you don\'t recognise?</strong> ' +
        'Change your password now, then tell the Cash Office. Do not wait to see ' +
        'whether anything else happens \u2014 an account number changed by somebody ' +
        'else redirects your next payment.</p>'
      : "");
}
