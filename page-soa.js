// ---------------------------------------------------------------------
// page-soa.js — Statement of Account
//
// Rewritten 2026-08-11 for server-side paging and issued statements.
//
// What changed and why:
//
//   Rows no longer arrive by the thousand. my_transactions() returns one
//   page plus the exact count and sum over the whole matching set. The
//   totals on screen are now totals OF THE DATA, not of whatever the
//   browser managed to fetch — previously anyone past 5,000 rows was
//   shown a subtotal labelled as a total.
//
//   Print and export now go through issue_statement() first. That call
//   is what produces the reference, the issue timestamp, the row count
//   and the peso total, all computed server-side, and registers them so
//   the Cash Office can resolve the reference later. The client never
//   invents any of those numbers.
//
//   The export still fetches every row in range to fill the sheet, but
//   it does so in pages, and it stops with an honest message rather
//   than a truncated file if the range is larger than EXPORT_MAX_ROWS.
// ---------------------------------------------------------------------

let pageRows = [];
let currentProfile = null;
let currentTableType = "ATM";
let showAcctFilter = false;
let myAccountNumbers = [];

// Server-side paging state.
const PAGE_SIZE = 100;
const EXPORT_MAX_ROWS = 10000;
let pageOffset = 0;
let totalCount = 0;
let totalAmount = 0;
let loading = false;

// The most recent issue_statement() result, shown in the print header
// and written into the exported sheet.
let lastStatement = null;

// True while a statement is being printed or exported.
//
// The table is swapped to the FULL statement for printing, and the print
// dialog can stay open for as long as the person takes. A realtime
// notification arriving in that window — and the daily import fires one
// for every open browser — would call loadPage() and put the 100-row
// page back underneath an open print dialog. The printout would then
// carry a reference header saying "195 transactions" above 100 rows: a
// statement that misrepresents itself, with nothing on screen to show
// it happened.
let statementInProgress = false;

const TABLE_COLUMNS = {
  ATM: [
    { label: "Credit Date", field: "txn_date", type: "date" },
    { label: "DVNO#", field: "dvno" },
    { label: "RADA/SADA#", field: "ada" },
    { label: "Particulars", field: "description" },
    { label: "Amount", field: "amount", type: "amount" }
  ],
  CHECK: [
    { label: "Collection Date", field: "dreleased", type: "date" },
    { label: "Check Date", field: "txn_date", type: "date" },
    { label: "Check Number", field: "ada_rada_check" },
    { label: "Description", field: "description_unit" },
    { label: "Amount", field: "amount", type: "amount" }
  ]
};

function activeColumns() {
  return TABLE_COLUMNS[currentTableType] || TABLE_COLUMNS.ATM;
}

function currentFilters() {
  const acctSel = document.getElementById("acctFilter");
  return {
    from: document.getElementById("dateFrom").value || null,
    to: document.getElementById("dateTo").value || null,
    account: currentTableType === "ATM" && acctSel && acctSel.value ? acctSel.value : null
  };
}

function pesos(value) {
  return "\u20b1" + Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// ---------------------------------------------------------------------
// Loading a page
// ---------------------------------------------------------------------

async function loadPage() {
  if (loading || statementInProgress) return;
  loading = true;
  const note = document.getElementById("filterNote");
  const { from, to, account } = currentFilters();

  if (from && to && from > to) {
    note.textContent = '"From" date must be before "To" date.';
    loading = false;
    return;
  }

  note.textContent = "Loading\u2026";
  setPagerDisabled(true);

  try {
    const result = await fetchMyTransactions(currentTableType, from, to, account, PAGE_SIZE, pageOffset);
    pageRows = result.rows || [];
    totalCount = result.total_count || 0;
    totalAmount = result.total_amount || 0;

    // A stale offset — from switching tabs, or from data changing under
    // an open page — lands past the end. Walk back rather than showing
    // an empty table over a non-empty statement.
    if (pageRows.length === 0 && pageOffset > 0 && totalCount > 0) {
      pageOffset = Math.max(0, (Math.ceil(totalCount / PAGE_SIZE) - 1) * PAGE_SIZE);
      loading = false;
      return loadPage();
    }

    renderTxns(pageRows);
    renderPager();
    note.textContent = "";
  } catch (err) {
    console.error("Couldn't load your statement:", err);
    const cols = activeColumns();
    document.getElementById("txnBody").innerHTML =
      `<tr><td colspan="${cols.length}" class="empty">Couldn't load your statement. Try again later.</td></tr>`;
    note.textContent = "";
    renderPager();
  } finally {
    loading = false;
    setPagerDisabled(false);
  }
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function formatDateMMDDYYYY(dateStr) {
  if (!dateStr) return "\u2014";
  const [y, m, d] = String(dateStr).split("-");
  if (!y || !m || !d) return dateStr;
  return `${m}/${d}/${y}`;
}

function renderHead() {
  document.getElementById("txnHead").innerHTML = activeColumns()
    .map(c => `<th${c.type === "amount" ? ' class="right"' : ""}>${escapeHtml(c.label)}</th>`)
    .join("");
}

function renderCell(row, col) {
  if (col.type === "amount") {
    const amount = Number(row[col.field] || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
    return `<td class="amt-right">\u20b1${amount}</td>`;
  }
  if (col.type === "date") return `<td>${formatDateMMDDYYYY(row[col.field])}</td>`;
  return `<td>${escapeHtml(row[col.field] || "\u2014")}</td>`;
}

function renderTxns(list) {
  const tbody = document.getElementById("txnBody");
  const cols = activeColumns();
  renderHead();
  if (!list || list.length === 0) {
    const label = currentTableType === "ATM" ? "ATM" : "check";
    const { from, to, account } = currentFilters();
    const filtered = Boolean(from || to || account);
    const message = filtered
      ? "No transactions match those filters."
      : `No ${label} transactions yet.`;
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty">${message}</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(t => `<tr>${cols.map(c => renderCell(t, c)).join("")}</tr>`).join("");
}

function setPagerDisabled(disabled) {
  const prev = document.getElementById("pagePrevBtn");
  const next = document.getElementById("pageNextBtn");
  if (prev) prev.disabled = disabled || pageOffset === 0;
  if (next) next.disabled = disabled || pageOffset + PAGE_SIZE >= totalCount;
}

function renderPager() {
  const summary = document.getElementById("pageSummary");
  const totals = document.getElementById("pageTotals");
  const pager = document.getElementById("pager");
  if (!summary || !pager) return;

  if (totalCount === 0) {
    pager.hidden = true;
    if (totals) totals.textContent = "";
    document.getElementById("exportBtn").disabled = true;
    document.getElementById("printBtn").disabled = true;
    return;
  }

  pager.hidden = false;
  const first = pageOffset + 1;
  const last = Math.min(pageOffset + PAGE_SIZE, totalCount);
  summary.textContent = `Showing ${first.toLocaleString()}\u2013${last.toLocaleString()} of ${totalCount.toLocaleString()}`;

  // The total is over everything matching the filters, not this page.
  // Saying so matters: a person reading "Total ₱4,200" under a page of
  // a hundred rows will reasonably assume it is the page's total.
  if (totals) {
    totals.textContent = `Total across all ${totalCount.toLocaleString()} matching transactions: ${pesos(totalAmount)}`;
  }

  document.getElementById("exportBtn").disabled = false;
  document.getElementById("printBtn").disabled = false;
  setPagerDisabled(false);
}

function updateAcctLine() {
  const acctEl = document.getElementById("acctNum");
  if (!acctEl) return;
  const acctSel = document.getElementById("acctFilter");
  const picked = currentTableType === "ATM" && acctSel ? acctSel.value : "";
  const shown = picked ? [picked] : myAccountNumbers;
  acctEl.textContent = shown.length
    ? (shown.length > 1 ? `Accounts: ${shown.join(" \u00b7 ")}` : `Account: ${shown[0]}`)
    : "";
  acctEl.style.display = currentTableType === "ATM" && acctEl.textContent ? "block" : "none";
}

// ---------------------------------------------------------------------
// Filters and tabs
// ---------------------------------------------------------------------

function resetToFirstPage() {
  pageOffset = 0;
  lastStatement = null;
  paintStatementRef();
  updateAcctLine();
  loadPage();
}

function switchTable(type) {
  currentTableType = type;
  document.getElementById("atmTabBtn").classList.toggle("active", type === "ATM");
  document.getElementById("checkTabBtn").classList.toggle("active", type === "CHECK");
  const acctField = document.getElementById("acctFilterField");
  if (acctField) acctField.style.display = type === "ATM" && showAcctFilter ? "flex" : "none";
  resetToFirstPage();
}

function applyDateFilter() {
  resetToFirstPage();
}

function clearDateFilter() {
  document.getElementById("dateFrom").value = "";
  document.getElementById("dateTo").value = "";
  const acctSel = document.getElementById("acctFilter");
  if (acctSel) acctSel.value = "";
  resetToFirstPage();
}

// ---------------------------------------------------------------------
// Issued statements
// ---------------------------------------------------------------------

function paintStatementRef() {
  const box = document.getElementById("stmtRef");
  const printRef = document.getElementById("printRef");
  if (!box) return;

  if (!lastStatement) {
    box.hidden = true;
    box.textContent = "";
    if (printRef) printRef.textContent = "";
    return;
  }

  const issued = new Date(lastStatement.issued_at);
  box.hidden = false;
  box.innerHTML =
    `<strong>Statement ${escapeHtml(lastStatement.reference)}</strong>` +
    `Issued ${escapeHtml(issued.toLocaleString())} \u00b7 ` +
    `${Number(lastStatement.row_count).toLocaleString()} transactions \u00b7 ` +
    `${escapeHtml(pesos(lastStatement.total_amount))} \u00b7 ` +
    `check ${escapeHtml(lastStatement.digest_short)}. ` +
    `Quote this reference when asking the Cash Office about this statement \u2014 ` +
    `they can confirm it was issued and what it totalled.`;

  if (printRef) {
    printRef.textContent =
      `Reference ${lastStatement.reference}  \u2022  Issued ${issued.toLocaleString()}  \u2022  ` +
      `${Number(lastStatement.row_count).toLocaleString()} transactions  \u2022  ` +
      `Total ${pesos(lastStatement.total_amount)}  \u2022  Check ${lastStatement.digest_short}`;
  }
}

// Registers the statement server-side and returns its details. Every
// number in the result is the server's, including the row count — if it
// disagrees with what the pager showed, the server is right and the
// page is stale.
async function issueCurrentStatement() {
  const { from, to, account } = currentFilters();
  lastStatement = await issueStatement(currentTableType, from, to, account);
  paintStatementRef();
  return lastStatement;
}

function updatePrintSub() {
  const name = currentProfile && currentProfile.full_name ? currentProfile.full_name : "";
  const acctSel = document.getElementById("acctFilter");
  const shown = currentTableType !== "ATM"
    ? ""
    : (acctSel && acctSel.value
        ? acctSel.value
        : joinAccountNumbers(parseAccountNumbers(currentProfile && currentProfile.account_number)));
  const acct = shown ? `Account: ${shown}` : "";
  const { from, to } = currentFilters();
  const coverage = (from || to)
    ? `Coverage: ${from || "start"} to ${to || "present"}`
    : "Coverage: All transactions";
  const tableLabel = currentTableType === "ATM" ? "ATM Transactions" : "CHECK Transactions";
  document.getElementById("printSub").textContent =
    [name, tableLabel, acct, coverage].filter(Boolean).join("  \u2022  ");
}

// Pulls every row in the current range, a page at a time, for print and
// export. Capped: past EXPORT_MAX_ROWS this refuses rather than
// silently handing over a partial statement, which is the failure the
// old 5,000-row limit produced.
async function fetchAllInRange() {
  const { from, to, account } = currentFilters();
  const rows = [];
  let offset = 0;
  for (;;) {
    const result = await fetchMyTransactions(currentTableType, from, to, account, 500, offset);
    rows.push(...(result.rows || []));
    if (!result.has_more) break;
    offset += 500;
    if (rows.length >= EXPORT_MAX_ROWS) {
      const err = new Error("too_many_rows");
      err.tooMany = true;
      err.total = result.total_count;
      throw err;
    }
  }
  return rows;
}

let dataChangedDuringStatement = false;

function statementBusy(busy, label) {
  const printBtn = document.getElementById("printBtn");
  const exportBtn = document.getElementById("exportBtn");
  statementInProgress = busy;
  printBtn.disabled = busy;
  exportBtn.disabled = busy;
  document.getElementById("filterNote").textContent = busy ? label : "";

  // Catch up on anything that arrived while the dialog was open.
  if (!busy && dataChangedDuringStatement) {
    dataChangedDuringStatement = false;
    lastStatement = null;
    paintStatementRef();
    loadPage();
  }
}

function reportStatementError(err) {
  const note = document.getElementById("filterNote");
  if (err && err.tooMany) {
    note.textContent =
      `That range holds ${Number(err.total).toLocaleString()} transactions \u2014 more than ` +
      `${EXPORT_MAX_ROWS.toLocaleString()} can go in one file. Narrow the coverage dates, ` +
      `or ask the Cash Office for a full statement.`;
    return;
  }
  console.error("Couldn't issue the statement:", err);
  note.textContent = "Couldn't prepare the statement. Try again.";
}

async function printStatement() {
  if (totalCount === 0) return;
  statementBusy(true, "Preparing statement\u2026");
  try {
    const rows = await fetchAllInRange();
    await issueCurrentStatement();
    updatePrintSub();
    // Print shows the whole statement, not just the page on screen.
    renderTxns(rows);

    // Restore on afterprint, not on the next line. window.print() blocks
    // in most browsers but not all — where it returns immediately, the
    // old code put the single page back before the dialog had rendered,
    // and the person got 100 rows instead of their whole statement with
    // nothing to suggest anything had gone wrong.
    await new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener("afterprint", finish);
        clearTimeout(guard);
        renderTxns(pageRows);
        resolve();
      };
      window.addEventListener("afterprint", finish);
      // Safety net: afterprint does not fire everywhere. Without this the
      // table would stay stuck on the full statement.
      const guard = setTimeout(finish, 60000);
      window.print();
    });
  } catch (err) {
    reportStatementError(err);
  } finally {
    statementBusy(false);
  }
}

async function exportToExcel() {
  if (totalCount === 0) return;
  statementBusy(true, "Preparing export\u2026");
  try {
    const rows = await fetchAllInRange();
    const stmt = await issueCurrentStatement();
    const cols = activeColumns();

    const body = rows.map(t => {
      const row = {};
      cols.forEach(c => {
        row[c.label] = c.type === "amount" ? Number(t[c.field] || 0) : (t[c.field] || "");
      });
      return row;
    });

    const worksheet = XLSX.utils.json_to_sheet(body, { origin: "A8" });

    // The header block goes above the data, so a sheet that gets
    // forwarded still says what it is, when it was issued and what it
    // totalled. Without it an exported statement is an anonymous grid
    // of numbers with no date on it.
    const issued = new Date(stmt.issued_at);
    XLSX.utils.sheet_add_aoa(worksheet, [
      ["University of the Philippines \u2014 System Cash Office"],
      [`Statement of Account \u2014 ${currentTableType} Transactions`],
      [`Issued to: ${(currentProfile && currentProfile.full_name) || ""}`],
      [`Reference: ${stmt.reference}    Issued: ${issued.toLocaleString()}`],
      [`Coverage: ${stmt.coverage_from || "start"} to ${stmt.coverage_to || "present"}` +
       (stmt.account_filter ? `    Account: ${stmt.account_filter}` : "")],
      [`Transactions: ${stmt.row_count}    Total: ${Number(stmt.total_amount).toFixed(2)}    Check: ${stmt.digest_short}`],
      []
    ], { origin: "A1" });

    const amountColIndex = cols.findIndex(c => c.type === "amount");
    const range = XLSX.utils.decode_range(worksheet["!ref"]);
    if (amountColIndex >= 0) {
      // Data starts at row 8 (1-indexed); the header row is 8, values from 9.
      for (let row = 8; row <= range.e.r; row++) {
        const cellRef = XLSX.utils.encode_cell({ r: row, c: amountColIndex });
        if (worksheet[cellRef]) worksheet[cellRef].z = "#,##0.00";
      }
    }

    worksheet["!cols"] = cols.map(c =>
      (c.field === "description" || c.field === "description_unit") ? { wch: 40 } : { wch: 16 });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet,
      currentTableType === "ATM" ? "ATM Transactions" : "CHECK Transactions");

    // Filename carries the reference, so two exports of the same range
    // on the same day no longer overwrite each other in Downloads.
    XLSX.writeFile(workbook, `${stmt.reference}.xlsx`);
  } catch (err) {
    reportStatementError(err);
  } finally {
    statementBusy(false);
  }
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

(async () => {
  const session = await requireSession();
  if (!session) return;
  const user = session.user;

  const { data: profile, error: profileErr } = await supabaseClient
    .from("profiles").select("id, account_number, full_name").eq("email", user.email).single();
  if (profileErr) console.error("Failed to load profile:", profileErr);
  currentProfile = profile;

  const profileMenu = document.getElementById("profileMenu");
  const profileBtn = document.getElementById("profileBtn");
  const profileAvatar = document.getElementById("profileAvatar");
  const profileNameLabel = document.getElementById("profileNameLabel");
  const ddName = document.getElementById("ddName");
  const ddEmail = document.getElementById("ddEmail");

  const label = (profile && profile.full_name) || user.email;
  profileNameLabel.textContent = label;
  profileAvatar.textContent = label.trim().charAt(0).toUpperCase() || "?";
  ddName.textContent = label;
  ddEmail.textContent = user.email;

  profileBtn.addEventListener("click", e => {
    e.stopPropagation();
    const willOpen = !profileMenu.classList.contains("open");
    profileMenu.classList.toggle("open", willOpen);
    profileBtn.setAttribute("aria-expanded", String(willOpen));
  });
  document.addEventListener("click", e => {
    if (!profileMenu.contains(e.target)) {
      profileMenu.classList.remove("open");
      profileBtn.setAttribute("aria-expanded", "false");
    }
  });

  const userNameEl = document.getElementById("userName");
  if (profile && profile.full_name) {
    userNameEl.textContent = profile.full_name;
    userNameEl.style.display = "block";
  }

  myAccountNumbers = parseAccountNumbers(profile && profile.account_number);
  updateAcctLine();

  if (myAccountNumbers.length) {
    showAcctFilter = true;
    const select = document.getElementById("acctFilter");
    const allLabel = myAccountNumbers.length > 1 ? "All accounts" : "All";
    select.innerHTML = `<option value="">${allLabel}</option>` +
      myAccountNumbers.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
    document.getElementById("acctFilterField").style.display = "flex";
    select.addEventListener("change", resetToFirstPage);
  }

  await loadPage();

  watchDatasets(["transactions", "released_transactions"], () => {
    // Mid-print or mid-export: leave everything alone. The statement
    // being produced was issued against the data as it was, and its
    // digest still describes that data honestly. Refreshing underneath
    // it would corrupt the output; the refresh happens when the dialog
    // closes instead.
    if (statementInProgress) {
      dataChangedDuringStatement = true;
      return;
    }
    // Fresh data invalidates any reference already on screen: it was
    // issued against the previous contents.
    lastStatement = null;
    paintStatementRef();
    loadPage();
  });
})();

document.getElementById("logoutBtn").addEventListener("click", () => logout());
document.getElementById("printBtn").addEventListener("click", () => printStatement());
document.getElementById("exportBtn").addEventListener("click", () => exportToExcel());
document.getElementById("applyFilterBtn").addEventListener("click", () => applyDateFilter());
document.getElementById("clearFilterBtn").addEventListener("click", () => clearDateFilter());

const prevBtn = document.getElementById("pagePrevBtn");
const nextBtn = document.getElementById("pageNextBtn");
if (prevBtn) prevBtn.addEventListener("click", () => {
  if (pageOffset === 0) return;
  pageOffset = Math.max(0, pageOffset - PAGE_SIZE);
  loadPage();
});
if (nextBtn) nextBtn.addEventListener("click", () => {
  if (pageOffset + PAGE_SIZE >= totalCount) return;
  pageOffset += PAGE_SIZE;
  loadPage();
});

document.querySelectorAll("[data-table-tab]").forEach(tab => {
  tab.addEventListener("click", () => switchTable(tab.dataset.tableTab));
});
