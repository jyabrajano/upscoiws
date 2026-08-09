let allTxns = [];

let checkTxns = [];

let filteredTxns = [];

let currentProfile = null;

let currentTableType = "ATM";

let showAcctFilter = false;

let myAccountNumbers = [];

const TABLE_COLUMNS = {
  ATM: [ {
    label: "Credit Date",
    field: "txn_date",
    type: "date"
  }, {
    label: "DVNO#",
    field: "dvno"
  }, {
    label: "RADA/SADA#",
    field: "ada"
  }, {
    label: "Particulars",
    field: "description"
  }, {
    label: "Amount",
    field: "amount",
    type: "amount"
  } ],
  CHECK: [ {
    label: "Collection Date",
    field: "dreleased",
    type: "date"
  }, {
    label: "Check Date",
    field: "txn_date",
    type: "date"
  }, {
    label: "Check Number",
    field: "ada_rada_check"
  }, {
    label: "Description",
    field: "description_unit"
  }, {
    label: "Amount",
    field: "amount",
    type: "amount"
  } ]
};

const DATE_FIELD = {
  ATM: "txn_date",
  CHECK: "dreleased"
};

function parseEmails(value) {
  return String(value == null ? "" : value).split(/[,;\n]+/).map(e => e.trim().toLowerCase()).filter(Boolean);
}

function activeColumns() {
  return TABLE_COLUMNS[currentTableType] || TABLE_COLUMNS.ATM;
}

function activeDateField() {
  return DATE_FIELD[currentTableType] || "txn_date";
}

const TXN_FETCH_LIMIT = 5e3;

let myEmail = "";

let loadedFrom = null;

let loadedTo = null;

async function loadTransactions(fromISO, toISO) {
  const from = fromISO || "";
  const to = toISO || "";
  let atmQuery = null;
  if (myAccountNumbers.length) {
    atmQuery = supabaseClient.from("transactions").select("txn_date, dvno, ada, description, amount, acct_no, email").in("acct_no", myAccountNumbers).ilike("email", `%${myEmail}%`);
    if (from) atmQuery = atmQuery.gte(DATE_FIELD.ATM, from);
    if (to) atmQuery = atmQuery.lte(DATE_FIELD.ATM, to);
    atmQuery = atmQuery.order("txn_date", {
      ascending: false
    }).limit(TXN_FETCH_LIMIT);
  }
  let checkQuery = supabaseClient.from("released_transactions").select("dreleased, txn_date, ada_rada_check, description_unit, amount, user_email").ilike("user_email", `%${myEmail}%`);
  if (from) checkQuery = checkQuery.gte(DATE_FIELD.CHECK, from);
  if (to) checkQuery = checkQuery.lte(DATE_FIELD.CHECK, to);
  checkQuery = checkQuery.order("dreleased", {
    ascending: false
  }).limit(TXN_FETCH_LIMIT);
  const [atmResult, checkResult] = await Promise.all([ atmQuery || Promise.resolve({
    data: [],
    error: null
  }), checkQuery ]);
  if (atmResult.error) console.error("Couldn't load ATM transactions:", atmResult.error);
  if (checkResult.error) console.error("Couldn't load CHECK transactions:", checkResult.error);
  allTxns = (atmResult.data || []).filter(r => parseEmails(r.email).includes(myEmail));
  checkTxns = (checkResult.data || []).filter(r => parseEmails(r.user_email).includes(myEmail));
  loadedFrom = from;
  loadedTo = to;
  const notice = document.getElementById("truncNotice");
  if (notice) {
    const truncated = (atmResult.data || []).length >= TXN_FETCH_LIMIT || (checkResult.data || []).length >= TXN_FETCH_LIMIT;
    if (truncated) {
      notice.textContent = `Showing the most recent ${TXN_FETCH_LIMIT.toLocaleString()} transactions ` + "in this date range. Narrow the range to see earlier ones, or ask the " + "Cash Office for a full statement.";
      notice.hidden = false;
    } else {
      notice.hidden = true;
      notice.textContent = "";
    }
  }
  return {
    atmError: atmResult.error,
    checkError: checkResult.error
  };
}

(async () => {
  const session = await requireSession();
  if (!session) return;
  const user = session.user;
  const {data: profile, error: profileErr} = await supabaseClient.from("profiles").select("id, account_number, full_name").eq("email", user.email).single();
  if (profileErr) console.error("Failed to load profile:", profileErr);
  currentProfile = profile;
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
  const myAccounts = parseAccountNumbers(profile && profile.account_number);
  myAccountNumbers = myAccounts;
  updateAcctLine();
  const tbody = document.getElementById("txnBody");
  myEmail = String(user.email || "").trim().toLowerCase();
  const {atmError: atmError, checkError: checkError} = await loadTransactions("", "");
  if (atmError && checkError) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Couldn\'t load your statement. Try again later.</td></tr>';
    return;
  }
  if (myAccounts.length) {
    showAcctFilter = true;
    const select = document.getElementById("acctFilter");
    const allLabel = myAccounts.length > 1 ? "All accounts" : "All";
    select.innerHTML = `<option value="">${allLabel}</option>` + myAccounts.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
    document.getElementById("acctFilterField").style.display = "flex";
    select.addEventListener("change", applyFilters);
  }
  applyFilters();
  watchDatasets([ "transactions", "released_transactions" ], () => {
    loadedFrom = null;
    loadedTo = null;
    applyFilters();
  });
})();

function switchTable(type) {
  currentTableType = type;
  document.getElementById("atmTabBtn").classList.toggle("active", type === "ATM");
  document.getElementById("checkTabBtn").classList.toggle("active", type === "CHECK");
  const acctField = document.getElementById("acctFilterField");
  if (acctField) {
    acctField.style.display = type === "ATM" && showAcctFilter ? "flex" : "none";
  }
  updateAcctLine();
  applyFilters();
}

function updateAcctLine() {
  const acctEl = document.getElementById("acctNum");
  if (!acctEl) return;
  const acctSel = document.getElementById("acctFilter");
  const picked = currentTableType === "ATM" && acctSel ? acctSel.value : "";
  const shown = picked ? [ picked ] : myAccountNumbers;
  acctEl.textContent = shown.length ? shown.length > 1 ? `Accounts: ${shown.join(" · ")}` : `Account: ${shown[0]}` : "";
  acctEl.style.display = currentTableType === "ATM" && acctEl.textContent ? "block" : "none";
}

function formatDateMMDDYYYY(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-");
  if (!y || !m || !d) return dateStr;
  return `${m}/${d}/${y}`;
}

function renderHead() {
  document.getElementById("txnHead").innerHTML = activeColumns().map(c => `<th${c.type === "amount" ? ' class="right"' : ""}>${escapeHtml(c.label)}</th>`).join("");
}

function renderCell(row, col) {
  if (col.type === "amount") {
    const amount = Number(row[col.field] || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2
    });
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
    const label = currentTableType === "ATM" ? "ATM" : "check";
    const message = totalForTab ? "No transactions in the selected date range." : `No ${label} transactions yet.`;
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty">${message}</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(t => `<tr>${cols.map(c => renderCell(t, c)).join("")}</tr>`).join("");
}

function updatePrintSub() {
  const name = currentProfile && currentProfile.full_name ? currentProfile.full_name : "";
  const acctSel = document.getElementById("acctFilter");
  const shown = currentTableType !== "ATM" ? "" : acctSel && acctSel.value ? acctSel.value : joinAccountNumbers(parseAccountNumbers(currentProfile && currentProfile.account_number));
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
  const parts = [ name, tableLabel, acct, coverage, `Printed ${(new Date).toLocaleDateString()}` ].filter(Boolean);
  document.getElementById("printSub").textContent = parts.join("  •  ");
}

async function applyFilters() {
  const fromVal = document.getElementById("dateFrom").value;
  const toVal = document.getElementById("dateTo").value;
  const acctSel = document.getElementById("acctFilter");
  const acctVal = currentTableType === "ATM" && acctSel ? acctSel.value : "";
  const note = document.getElementById("filterNote");
  updateAcctLine();
  if (fromVal && toVal && fromVal > toVal) {
    note.textContent = '"From" date must be before "To" date.';
    return;
  }
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
  note.textContent = filteredTxns.length === typeScoped.length ? "" : `Showing ${filteredTxns.length} of ${typeScoped.length}`;
  const nothingToAct = filteredTxns.length === 0;
  document.getElementById("exportBtn").disabled = nothingToAct;
  document.getElementById("printBtn").disabled = nothingToAct;
  renderTxns(filteredTxns, typeScoped.length);
  updatePrintSub();
}

function applyDateFilter() {
  applyFilters();
}

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

function exportToExcel() {
  if (!filteredTxns || filteredTxns.length === 0) return;
  const cols = activeColumns();
  const rows = filteredTxns.map(t => {
    const row = {};
    cols.forEach(c => {
      row[c.label] = c.type === "amount" ? Number(t[c.field] || 0) : t[c.field] || "";
    });
    return row;
  });
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const amountColIndex = cols.findIndex(c => c.type === "amount");
  const range = XLSX.utils.decode_range(worksheet["!ref"]);
  if (amountColIndex >= 0) {
    for (let row = range.s.r + 1; row <= range.e.r; row++) {
      const cellRef = XLSX.utils.encode_cell({
        r: row,
        c: amountColIndex
      });
      if (worksheet[cellRef]) {
        worksheet[cellRef].z = "#,##0.00";
      }
    }
  }
  worksheet["!cols"] = cols.map(c => {
    if (c.field === "description" || c.field === "description_unit") return {
      wch: 40
    };
    if (c.type === "date") return {
      wch: 14
    };
    return {
      wch: 14
    };
  });
  const tableLabel = currentTableType === "ATM" ? "ATM Transactions" : "CHECK Transactions";
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, tableLabel);
  const acctSelExp = document.getElementById("acctFilter");
  const acct = currentTableType === "ATM" && acctSelExp && acctSelExp.value || parseAccountNumbers(currentProfile && currentProfile.account_number)[0] || "account";
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

document.getElementById("logoutBtn").addEventListener("click", () => logout());

document.getElementById("printBtn").addEventListener("click", () => printStatement());

document.getElementById("exportBtn").addEventListener("click", () => exportToExcel());

document.getElementById("applyFilterBtn").addEventListener("click", () => applyDateFilter());

document.getElementById("clearFilterBtn").addEventListener("click", () => clearDateFilter());

document.querySelectorAll("[data-table-tab]").forEach(tab => {
  tab.addEventListener("click", () => switchTable(tab.dataset.tableTab));
});
