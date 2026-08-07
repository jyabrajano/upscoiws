let allTxns = [];
let checkTxns = [];
let filteredTxns = [];
let currentProfile = null;
let currentTableType = "ATM";
let showAcctFilter = false;
// The account numbers on the person's profile. Held here so the
// account line and the print header can be rebuilt whenever the
// picker changes, not just once at load.
let myAccountNumbers = [];

// ATM reads off public.transactions. CHECK reads off a different
// table entirely, public.released_transactions, so the two column
// sets map onto different underlying fields. Header text, cell
// order and the Excel column names all come from here — change a
// label once and it changes in all three.
//
// `field` is the column on the table that tab queries (see the
// query section below for which table that is). If the mapping
// below is wrong for checks, this is the only place to fix it.
//
// These are literal column names and must match the database
// spelling exactly, including its typos — the CHECK set really is
// `ada_rada_check` and `description_unit`. Ask PostgREST for a
// column that doesn't exist and it rejects the whole request, so
// one wrong letter empties the tab rather than blanking a cell.
const TABLE_COLUMNS = {
  ATM: [
    { label: "Credit Date", field: "txn_date", type: "date" },
    { label: "DVNO#", field: "dvno" },
    { label: "RADA/SADA#", field: "ada" },
    { label: "Particulars", field: "description" },
    { label: "Amount", field: "amount", type: "amount" },
  ],
  CHECK: [
    { label: "Collection Date", field: "dreleased", type: "date" },
    { label: "Check Date", field: "txn_date", type: "date" },
    { label: "Check Number", field: "ada_rada_check" },
    { label: "Description", field: "description_unit" },
    { label: "Amount", field: "amount", type: "amount" },
  ],
};

// Which column each tab's date-range filter (and print/export
// coverage line) runs against. ATM filters on its Credit Date;
// CHECK filters on Collection Date, since that's the column that
// actually means "when this hit the statement" on released_transactions.
const DATE_FIELD = {
  ATM: "txn_date",
  CHECK: "dreleased",
};

// The counterpart to parseAccountNumbers() in config.js: one cell,
// possibly several values. Splits on the same separators, trims the
// stray trailing commas the imports leave behind, and lowercases so
// the comparison doesn't turn on how an address was typed.
function parseEmails(value) {
  return String(value == null ? "" : value)
    .split(/[,;\n]+/)
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

function activeColumns() {
  return TABLE_COLUMNS[currentTableType] || TABLE_COLUMNS.ATM;
}

function activeDateField() {
  return DATE_FIELD[currentTableType] || "txn_date";
}

// ============================================================
// Fetching
//
// The cap is far above any realistic single-person history. If a fetch
// comes back sitting exactly on it, the rows are the most recent ones
// (both queries sort descending) and the notice says so rather than
// quietly presenting a partial statement as a whole one.
//
// The date range is applied HERE, in the query, and not only in
// applyFilters(). It used to be browser-side alone: everything was
// fetched once on load and the From/To boxes sliced the array. That
// made the truncation notice's own advice impossible to follow — it
// said "narrow the date range to see earlier ones", but narrowing the
// range never refetched, so no filter could reach a row outside the
// 5,000 already in memory. Anyone who hit the cap and did as they were
// told watched rows disappear and concluded the statement was wrong.
//
// Now a change to either box refetches within the new bounds, so the
// advice is true: a narrower window really does reach further back.
// ============================================================
const TXN_FETCH_LIMIT = 5000;

// Set once the session is known; the loader is called from the filter
// handlers, which sit outside the IIFE that holds `user`.
let myEmail = "";

// What the rows currently in memory were fetched under, so a filter
// change that doesn't move the bounds doesn't hit the network.
let loadedFrom = null;
let loadedTo = null;

async function loadTransactions(fromISO, toISO) {
  const from = fromISO || "";
  const to = toISO || "";

  // ATM transactions: every account the person holds, off
  // public.transactions. CHECK transactions: a different table
  // entirely — public.released_transactions, scoped by the person's
  // email (user_email) rather than an account number. The two are
  // independent queries, so a problem with one doesn't block the other.
  //
  // Each is bounded on its OWN date column: ATM filters on txn_date,
  // CHECK on dreleased. That is the same mapping DATE_FIELD holds for
  // the browser-side filter, and it has to be, or the two would
  // disagree about which rows the window contains.
  let atmQuery = null;

  if (myAccountNumbers.length) {
    atmQuery = supabaseClient
      .from("transactions")
      .select("txn_date, dvno, ada, description, amount, acct_no")
      .in("acct_no", myAccountNumbers);
    if (from) atmQuery = atmQuery.gte(DATE_FIELD.ATM, from);
    if (to) atmQuery = atmQuery.lte(DATE_FIELD.ATM, to);
    atmQuery = atmQuery.order("txn_date", { ascending: false }).limit(TXN_FETCH_LIMIT);
  }

  // released_transactions.user_email holds one address on most rows
  // but a comma-separated list on some — a check made out to a
  // supplier who gave two or three contacts. A whole-value match
  // therefore misses people who are genuinely on the row, the same
  // way a whole-value match on profiles.account_number would miss
  // the second of somebody's two accounts.
  //
  // So the fetch is deliberately loose (contains, case-insensitive)
  // and parseEmails() below makes the real decision on exact
  // membership. Row-level security is what actually gates access,
  // so widening the filter here doesn't widen what can be read.
  let checkQuery = supabaseClient
    .from("released_transactions")
    // No .eq("status", "RELEASED") — every row in this table is
    // RELEASED today, and a filter would silently hide rows if an
    // import ever wrote the value differently. Add one here if
    // that table starts carrying mixed statuses.
    .select("dreleased, txn_date, ada_rada_check, description_unit, amount, user_email")
    .ilike("user_email", `%${myEmail}%`);
  if (from) checkQuery = checkQuery.gte(DATE_FIELD.CHECK, from);
  if (to) checkQuery = checkQuery.lte(DATE_FIELD.CHECK, to);
  checkQuery = checkQuery.order("dreleased", { ascending: false }).limit(TXN_FETCH_LIMIT);

  const [atmResult, checkResult] = await Promise.all([
    atmQuery || Promise.resolve({ data: [], error: null }),
    checkQuery,
  ]);

  if (atmResult.error) console.error("Couldn't load ATM transactions:", atmResult.error);
  if (checkResult.error) console.error("Couldn't load CHECK transactions:", checkResult.error);

  allTxns = atmResult.data || [];
  checkTxns = (checkResult.data || []).filter(
    r => parseEmails(r.user_email).includes(myEmail)
  );

  loadedFrom = from;
  loadedTo = to;

  // Checked against the raw fetch, not the filtered result — the
  // client-side email filter legitimately removes rows, and that is
  // not truncation.
  const notice = document.getElementById("truncNotice");
  if (notice) {
    const truncated =
      (atmResult.data || []).length >= TXN_FETCH_LIMIT ||
      (checkResult.data || []).length >= TXN_FETCH_LIMIT;
    if (truncated) {
      notice.textContent =
        `Showing the most recent ${TXN_FETCH_LIMIT.toLocaleString()} transactions ` +
        "in this date range. Narrow the range to see earlier ones, or ask the " +
        "Cash Office for a full statement.";
      notice.hidden = false;
    } else {
      // Cleared on every load, not just set — a narrower range that
      // comes back under the cap must take the warning away with it,
      // or the person is told their complete statement is partial.
      notice.hidden = true;
      notice.textContent = "";
    }
  }

  return { atmError: atmResult.error, checkError: checkResult.error };
}

(async () => {
  const session = await requireSession();
  if (!session) return;
  const user = session.user;

  const { data: profile, error: profileErr } = await supabaseClient
    .from("profiles")
    .select("id, account_number, full_name")
    .eq("email", user.email)
    .single();

  if (profileErr) console.error("Failed to load profile:", profileErr);
  currentProfile = profile;

  // --- PROFILE MENU (dropdown) ---
  const profileMenu = document.getElementById("profileMenu");
  const profileBtn = document.getElementById("profileBtn");
  const profileAvatar = document.getElementById("profileAvatar");
  const profileNameLabel = document.getElementById("profileNameLabel");
  const ddName = document.getElementById("ddName");
  const ddEmail = document.getElementById("ddEmail");

  function setProfileDisplay(name) {
    const label = name || user.email;
    profileNameLabel.textContent = label;
    profileAvatar.textContent = label.trim().charAt(0).toUpperCase() || "?";
    ddName.textContent = label;
  }
  setProfileDisplay(profile && profile.full_name);
  ddEmail.textContent = user.email;

  profileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !profileMenu.classList.contains("open");
    profileMenu.classList.toggle("open", willOpen);
    profileBtn.setAttribute("aria-expanded", String(willOpen));
  });
  document.addEventListener("click", (e) => {
    if (!profileMenu.contains(e.target)) {
      profileMenu.classList.remove("open");
      profileBtn.setAttribute("aria-expanded", "false");
    }
  });

  // --- PAGE DATA LOADING ---
  const userNameEl = document.getElementById("userName");
  if (profile && profile.full_name) {
    userNameEl.textContent = profile.full_name;
    userNameEl.style.display = "block";
  }

  // The account line under the heading. updateAcctLine() owns both
  // its text and whether it shows, because the text now depends on
  // what's picked in the filter and not only on what's on file.
  const myAccounts = parseAccountNumbers(profile && profile.account_number);
  myAccountNumbers = myAccounts;
  updateAcctLine();

  const tbody = document.getElementById("txnBody");

  myEmail = String(user.email || "").trim().toLowerCase();

  const { atmError, checkError } = await loadTransactions("", "");

  if (atmError && checkError) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="empty">Couldn\'t load your statement. Try again later.</td></tr>';
    return;
  }

  // The account picker is ATM-only — CHECK transactions come off
  // released_transactions and aren't scoped by account number — but
  // it shows for anyone with an account on file, including the
  // one-account case, so the ATM table always carries a visible
  // statement of which account it's showing.
  if (myAccounts.length) {
    showAcctFilter = true;
    const select = document.getElementById("acctFilter");
    // "All accounts" only says something when there's more than one.
    const allLabel = myAccounts.length > 1 ? "All accounts" : "All";
    select.innerHTML = `<option value="">${allLabel}</option>` +
      // escapeHtml is defined below; the account numbers are
      // normalised digits today, but the picker shouldn't be the
      // one place that assumes that.
      myAccounts.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
    document.getElementById("acctFilterField").style.display = "flex";
    select.addEventListener("change", applyFilters);
  }

  applyFilters();
})();

// Switches between the two tabs. They are not two views of one
// table: ATM reads public.transactions and CHECK reads
// public.released_transactions, and both were already fetched on
// load, so this only re-renders. The account filter is ATM-only,
// so it's hidden on the CHECK tab regardless of how many accounts
// the person holds.
function switchTable(type) {
  currentTableType = type;
  document.getElementById("atmTabBtn").classList.toggle("active", type === "ATM");
  document.getElementById("checkTabBtn").classList.toggle("active", type === "CHECK");

  const acctField = document.getElementById("acctFilterField");
  if (acctField) {
    acctField.style.display = (type === "ATM" && showAcctFilter) ? "flex" : "none";
  }

  // The account line under the heading goes with it. Checks aren't
  // credited to an account number, so showing one over a table of
  // them says something that isn't true.
  updateAcctLine();

  applyFilters();
}

// The account line under the person's name, on screen and on the
// printout. When the picker is on a single account, that account is
// the only one named — printing "Accounts: acct1 · acct2" over a
// table filtered to acct1 puts a number on the page that has no
// line under it. "All accounts" goes back to listing everything on
// file. Called on every filter change and tab switch.
function updateAcctLine() {
  const acctEl = document.getElementById("acctNum");
  if (!acctEl) return;
  const acctSel = document.getElementById("acctFilter");
  const picked = (currentTableType === "ATM" && acctSel) ? acctSel.value : "";
  const shown = picked ? [picked] : myAccountNumbers;

  acctEl.textContent = shown.length
    ? (shown.length > 1
        ? `Accounts: ${shown.join(" · ")}`
        : `Account: ${shown[0]}`)
    : "";
  // Empty text means there's no account number on file to show in
  // the first place, so the line stays out of the way either way.
  acctEl.style.display = (currentTableType === "ATM" && acctEl.textContent) ? "block" : "none";
}

function formatDateMMDDYYYY(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-");
  if (!y || !m || !d) return dateStr;
  return `${m}/${d}/${y}`;
}

function renderHead() {
  document.getElementById("txnHead").innerHTML = activeColumns()
    .map(c => `<th${c.type === "amount" ? ' class="right"' : ""}>${escapeHtml(c.label)}</th>`)
    .join("");
}

// One cell, formatted by what the column holds rather than by
// where it sits.
function renderCell(row, col) {
  if (col.type === "amount") {
    const amount = Number(row[col.field] || 0)
      .toLocaleString(undefined, { minimumFractionDigits: 2 });
    return `<td class="amt-right">₱${amount}</td>`;
  }
  if (col.type === "date") {
    return `<td>${formatDateMMDDYYYY(row[col.field])}</td>`;
  }
  return `<td>${escapeHtml(row[col.field] || "—")}</td>`;
}

function renderTxns(list, totalForTab) {
  const tbody = document.getElementById("txnBody");
  const cols = activeColumns();
  renderHead();

  if (!list || list.length === 0) {
    // "None in this range" is misleading when the tab is empty to
    // begin with — say which of the two it is.
    const label = currentTableType === "ATM" ? "ATM" : "check";
    const message = totalForTab
      ? "No transactions in the selected date range."
      : `No ${label} transactions yet.`;
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty">${message}</td></tr>`;
    return;
  }

  tbody.innerHTML = list
    .map(t => `<tr>${cols.map(c => renderCell(t, c)).join("")}</tr>`)
    .join("");
}

function updatePrintSub() {
  const name = currentProfile && currentProfile.full_name ? currentProfile.full_name : "";
  const acctSel = document.getElementById("acctFilter");
  // Same reasoning as the on-screen account line: nothing on the
  // CHECK table is scoped by account, so the printout doesn't claim
  // one either.
  const shown = currentTableType !== "ATM"
    ? ""
    : (acctSel && acctSel.value
        ? acctSel.value
        : joinAccountNumbers(parseAccountNumbers(currentProfile && currentProfile.account_number)));
  const acct = shown ? `Account: ${shown}` : "";
  const fromVal = document.getElementById("dateFrom").value;
  const toVal = document.getElementById("dateTo").value;
  let coverage;
  if (fromVal || toVal) {
    coverage = `Coverage: ${fromVal || "start"} to ${toVal || "present"}`;
  } else {
    coverage = "Coverage: All transactions";
  }
  const tableLabel = currentTableType === "ATM" ? "ATM Transactions" : "CHECK Transactions";
  const parts = [name, tableLabel, acct, coverage, `Printed ${new Date().toLocaleDateString()}`].filter(Boolean);
  document.getElementById("printSub").textContent = parts.join("  •  ");
}

// Date range and account are one filter now — changing either
// re-runs both, so they can't contradict each other.
//
// Async because the date range is a query bound, not just an array
// slice: moving it refetches. The account picker is browser-side
// only, so picking an account never costs a round trip.
async function applyFilters() {
  const fromVal = document.getElementById("dateFrom").value;
  const toVal = document.getElementById("dateTo").value;
  const acctSel = document.getElementById("acctFilter");
  // Account filter only applies on the ATM tab — CHECK has no
  // account picker, so it's never scoped by acct_no.
  const acctVal = (currentTableType === "ATM" && acctSel) ? acctSel.value : "";
  const note = document.getElementById("filterNote");

  // Ahead of the date-range check below: the account line follows
  // the picker, not the dates, so it shouldn't be left stale by a
  // From/To pair that stops the rest of this function.
  updateAcctLine();

  if (fromVal && toVal && fromVal > toVal) {
    note.textContent = '"From" date must be before "To" date.';
    return;
  }

  // Only when the bounds actually moved. Switching tabs and picking an
  // account both call through here, and neither changes what the
  // database was asked for.
  if (fromVal !== loadedFrom || toVal !== loadedTo) {
    note.textContent = "Loading…";
    try {
      await loadTransactions(fromVal, toVal);
    } catch (err) {
      console.error("Couldn't reload transactions for that date range:", err);
      note.textContent = "Couldn't load that date range. Try again.";
      return;
    }
  }

  const typeScoped = currentTableType === "ATM" ? allTxns : checkTxns;
  const dateField = activeDateField();

  filteredTxns = typeScoped.filter(t => {
    if (acctVal && t.acct_no !== acctVal) return false;
    if (fromVal && t[dateField] < fromVal) return false;
    if (toVal && t[dateField] > toVal) return false;
    return true;
  });

  note.textContent = filteredTxns.length === typeScoped.length
    ? ""
    : `Showing ${filteredTxns.length} of ${typeScoped.length}`;

  // Print and Export act on what's on screen, so they follow the
  // active tab rather than staying live over an empty table.
  const nothingToAct = filteredTxns.length === 0;
  document.getElementById("exportBtn").disabled = nothingToAct;
  document.getElementById("printBtn").disabled = nothingToAct;

  renderTxns(filteredTxns, typeScoped.length);
  updatePrintSub();
}

// Kept for the buttons in the markup.
function applyDateFilter() { applyFilters(); }

function clearDateFilter() {
  document.getElementById("dateFrom").value = "";
  document.getElementById("dateTo").value = "";
  const acctSel = document.getElementById("acctFilter");
  if (acctSel) acctSel.value = "";
  applyFilters();
}

function printStatement() {
  if (!filteredTxns || filteredTxns.length === 0) return;
  updatePrintSub();
  window.print();
}

// Text AND attribute contexts. The textContent/innerHTML round
// trip that used to be here escapes & < > but not quotes, because
// a text node has no need of it — which makes it unsafe the
// moment the result lands inside value="..." or data-x="...".
// See the same fix in approval.js.
function escapeHtml(str) {
  return (str == null ? "" : String(str))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

function exportToExcel() {
  if (!filteredTxns || filteredTxns.length === 0) return;

  const cols = activeColumns();

  // Same labels as the header on screen, so a check export doesn't
  // come out with the ATM column names on it.
  const rows = filteredTxns.map(t => {
    const row = {};
    cols.forEach(c => {
      row[c.label] = c.type === "amount" ? Number(t[c.field] || 0) : (t[c.field] || "");
    });
    return row;
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);

  const amountColIndex = cols.findIndex(c => c.type === "amount");
  const range = XLSX.utils.decode_range(worksheet["!ref"]);
  if (amountColIndex >= 0) {
    for (let row = range.s.r + 1; row <= range.e.r; row++) {
      const cellRef = XLSX.utils.encode_cell({ r: row, c: amountColIndex });
      if (worksheet[cellRef]) {
        worksheet[cellRef].z = "#,##0.00";
      }
    }
  }
  worksheet["!cols"] = cols.map(c => {
    if (c.field === "description" || c.field === "description_unit") return { wch: 40 };
    if (c.type === "date") return { wch: 14 };
    return { wch: 14 };
  });

  const tableLabel = currentTableType === "ATM" ? "ATM Transactions" : "CHECK Transactions";
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, tableLabel);

  const acctSelExp = document.getElementById("acctFilter");
  const acct = (currentTableType === "ATM" && acctSelExp && acctSelExp.value)
    || parseAccountNumbers(currentProfile && currentProfile.account_number)[0]
    || "account";

  const fromVal = document.getElementById("dateFrom").value;
  const toVal = document.getElementById("dateTo").value;
  let rangeSuffix = "";
  if (fromVal || toVal) {
    rangeSuffix = `_${fromVal || "start"}_to_${toVal || "end"}`;
  } else {
    rangeSuffix = `_${todayLocalISO()}`;
  }

  XLSX.writeFile(workbook, `SOA_${currentTableType}_${acct}${rangeSuffix}.xlsx`);
}

// ------------------------------------------------------------
// Wiring that used to live in onclick attributes
//
// See the note in page-dashboard.js for why these could not stay in
// the markup. Seven of the nine handlers in the portal were on this
// page.
//
// The two table tabs carry data-table-tab rather than an id each, so
// the tab name is read from the element instead of being written
// twice — once in the attribute, once in the listener. Adding a third
// tab is a markup change and nothing else.
// ------------------------------------------------------------
document.getElementById("logoutBtn").addEventListener("click", () => logout());
document.getElementById("printBtn").addEventListener("click", () => printStatement());
document.getElementById("exportBtn").addEventListener("click", () => exportToExcel());
document.getElementById("applyFilterBtn").addEventListener("click", () => applyDateFilter());
document.getElementById("clearFilterBtn").addEventListener("click", () => clearDateFilter());

document.querySelectorAll("[data-table-tab]").forEach((tab) => {
  tab.addEventListener("click", () => switchTable(tab.dataset.tableTab));
});
