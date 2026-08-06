(async () => {
  const session = await requireSession();
  if (!session) return;
  const user = session.user;

  const isAdmin = await checkIsAdmin();

  const { data: profile, error: profileErr } = await supabaseClient
    .from("profiles")
    .select("id, full_name, account_number")
    .eq("email", user.email)
    .single();
  if (profileErr) console.error("Failed to load profile:", profileErr);

  let adminQueues = null;
  let adminManager = null;
  if (isAdmin) {
    injectApprovalStyles();
    const adminSection = document.getElementById("adminSection");
    adminSection.style.display = "";

    // The user search lives on users.html now — the nav link
    // appears for administrators only. Set before the panels
    // mount, so a panel that fails doesn't take the link with it.
    document.getElementById("usersLink").style.display = "";

    try {
      adminQueues = await mountAdminQueues({
        registrationsEl: document.getElementById("regQueue"),
        changesEl: document.getElementById("changeQueue"),
        onApplied: () => refreshOwnProfile(),
      });
      adminManager = await mountAdminManager(
        document.getElementById("adminManager")
      );

    } catch (err) {
      console.error("Couldn't set up the administrator panels:", err);
      adminSection.innerHTML =
        '<div class="card admin-card"><h2 class="section-title">Administrator tools</h2>' +
        "<p class=\"empty\">These panels need the latest database functions. " +
        "Run deploy-schema.sql in the Supabase " +
        "SQL Editor.</p></div>";
    }
  }

  async function refreshOwnProfile() {
    const { data: fresh } = await supabaseClient
      .from("profiles")
      .select("id, full_name, account_number")
      .eq("email", user.email)
      .maybeSingle();
    if (!fresh) return;
    profile.full_name = fresh.full_name;
    profile.account_number = fresh.account_number;
    document.getElementById("identityName").textContent =
      fresh.full_name || "Name unavailable";
    setProfileDisplay(fresh.full_name);
  }

  document.getElementById("identityName").textContent =
    (profile && profile.full_name) ? profile.full_name : "Name unavailable";
  document.getElementById("acctSub").textContent = user.email;

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

  const availableCard = document.getElementById("availableCard");
  const availableBody = document.getElementById("availableBody");

  if (isAdmin) {
    // Admins have their own account too and can have checks waiting
    // on them same as anyone else. This used to just hide the panel
    // for admins outright; now it's pulled to the top of the admin
    // section instead — same element, moved rather than hidden, so
    // it isn't buried under the approval queues below.
    const adminSlot = document.getElementById("adminAvailableSlot");
    if (adminSlot) adminSlot.appendChild(availableCard);
  }

  try {
    // available_transactions.user_email holds a comma-separated list
    // on some rows — one payment, several contact addresses at the
    // same supplier. A whole-cell .eq() therefore missed people who
    // are genuinely named on the row, which is the same bug the
    // RLS policy on this table was fixed for. Match the way soa.html
    // does: fetch loose (contains, case-insensitive), then decide
    // exact membership client-side. RLS is what actually gates
    // access, so the wider filter reads nothing new.
    const wantedEmail = String(user.email || "").trim().toLowerCase();

    const { data: availableRaw, error: availableErr } = await supabaseClient
      .from("available_transactions")
      .select("status, txn_date, ada_rada_check, name, amount, description_unit, span, user_email")
      .ilike("user_email", `%${wantedEmail}%`)
      .order("txn_date", { ascending: false })
      .limit(1000);

    if (availableErr) throw availableErr;

    const available = (availableRaw || []).filter(r =>
      String(r.user_email == null ? "" : r.user_email)
        .split(/[,;\n]+/)
        .map(e => e.trim().toLowerCase())
        .filter(Boolean)
        .includes(wantedEmail)
    );

    availableBody.innerHTML = (available && available.length)
      ? available.map(t => `
          <tr>
            <td class="status-center"><span class="status-badge">${escapeHtml(t.status || "—")}</span></td>
            <td>${t.txn_date ? formatDate(t.txn_date) : "—"}</td>
            <td>${escapeHtml(t.ada_rada_check || "—")}</td>
            <td>${escapeHtml(t.name || "—")}</td>
            <td class="amt-right">${t.amount != null ? "₱" + Number(t.amount).toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—"}</td>
            <td>${escapeHtml(t.description_unit || "—")}</td>
            <td>${escapeHtml(t.span || "—")}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="7" class="empty">No transactions found for your account yet.</td></tr>';
  } catch (e) {
    console.error("Failed to load available_transactions:", e);
    availableBody.innerHTML = '<tr><td colspan="7" class="empty">Couldn\'t load transactions right now.</td></tr>';
  }

  const newsList = document.getElementById("newsList");
  try {
    const news = await fetchNews(5);
    newsList.innerHTML = news.length
      ? news.map(n => `
          <div class="news-item">
            <h3>${escapeHtml(n.title)}</h3>
            <p>${escapeHtml(n.content)}</p>
          </div>
        `).join("")
      : '<p class="empty">No news to show right now.</p>';
  } catch (e) {
    console.error("Failed to load news:", e);
    newsList.innerHTML = '<p class="empty">Couldn\'t load news right now.</p>';
  }

  // --- INTERACTIVE CALENDAR ENGINE ---
  let currentDisplayDate = new Date();
  let allEvents = [];

  // The calendar used to fetch every event ever recorded and filter
  // it down to one month in the browser. It loads a window instead
  // now: six months either side of whatever is on screen, reloaded
  // when you navigate past the edge of it. Paging back through years
  // still works, a window at a time.
  const CAL_WINDOW_MONTHS = 6;
  let loadedFrom = null;   // "YYYY-MM-DD"
  let loadedTo = null;

  function isoDay(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // The window around a given date, as inclusive ISO bounds.
  function windowFor(date) {
    const from = new Date(date.getFullYear(), date.getMonth() - CAL_WINDOW_MONTHS, 1);
    const to = new Date(date.getFullYear(), date.getMonth() + CAL_WINDOW_MONTHS + 1, 0);
    return {
      from: isoDay(from.getFullYear(), from.getMonth(), 1),
      to: isoDay(to.getFullYear(), to.getMonth(), to.getDate()),
    };
  }

  // True when the month on screen still sits inside what's loaded,
  // with a month of slack so the edges aren't a refetch every click.
  function monthIsLoaded(date) {
    if (!loadedFrom || !loadedTo) return false;
    const first = isoDay(date.getFullYear(), date.getMonth(), 1);
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return first >= loadedFrom && isoDay(last.getFullYear(), last.getMonth(), last.getDate()) <= loadedTo;
  }

  async function loadCalendarWindow(date) {
    const { from, to } = windowFor(date);
    allEvents = await fetchCalendarEvents(from, to);
    loadedFrom = from;
    loadedTo = to;
  }

  // Reloads first if the month being shown has moved outside the
  // loaded window. A failed reload leaves the previous window in
  // place and still redraws, so navigation never dead-ends on a
  // blank grid.
  async function showMonth() {
    if (!monthIsLoaded(currentDisplayDate)) {
      try {
        await loadCalendarWindow(currentDisplayDate);
      } catch (e) {
        console.error("Failed to load calendar events:", e);
      }
    }
    renderCalendar();
  }

  const calGrid = document.getElementById("calGrid");
  const currentMonthYearEl = document.getElementById("currentMonthYear");
  const calDetails = document.getElementById("calDetails");

  function renderCalendar() {
    const year = currentDisplayDate.getFullYear();
    const month = currentDisplayDate.getMonth();

    currentMonthYearEl.textContent = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      year: 'numeric'
    }).format(currentDisplayDate);

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    calGrid.innerHTML = dayNames
      .map(d => `<div class="cal-day-name">${d}</div>`)
      .join('');

    const firstDayIndex = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDayIndex; i++) {
      calGrid.innerHTML += `<div class="cal-cell" style="opacity: 0.2;"></div>`;
    }

    // todayLocalISO(), not toISOString(): dateStr just below is built
    // from local year/month/day, so a UTC "today" put the highlight on
    // yesterday's cell every morning until 8am Manila time.
    const todayStr = todayLocalISO();

    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dayEvents = allEvents.filter(e => e.date === dateStr);
      const isToday = dateStr === todayStr ? 'today' : '';
      const hasEvent = dayEvents.length > 0 ? 'has-event' : '';
      const adminAddable = (isAdmin && dayEvents.length === 0) ? 'admin-addable' : '';

      const cell = document.createElement("div");
      cell.className = `cal-cell ${isToday} ${hasEvent} ${adminAddable}`.trim();
      cell.innerHTML = `
        <span>${day}</span>
        ${dayEvents.length > 0 ? '<div class="event-dot"></div>' : ''}
      `;

      if (dayEvents.length > 0 || isAdmin) {
        cell.addEventListener("click", () => openDayPanel(dateStr));
      }

      calGrid.appendChild(cell);
    }
  }

  function openDayPanel(dateStr) {
    const events = allEvents.filter(e => e.date === dateStr);
    const formattedDate = formatDate(dateStr);

    let html = `
      <strong style="color: var(--maroon); font-family: 'JetBrains Mono', monospace;">
        ${formattedDate}
      </strong>
    `;

    if (events.length) {
      html += `
        <ul class="event-list">
          ${events.map(e => `
            <li class="event-list-item">
              <span class="event-list-title">${escapeHtml(e.title)}</span>
              ${isAdmin ? `<button type="button" class="event-del-btn" data-id="${escapeHtml(e.id)}">Delete</button>` : ''}
            </li>
          `).join('')}
        </ul>
      `;
    } else {
      html += `<div class="empty" style="margin-top:8px;">No events scheduled.</div>`;
    }

    if (isAdmin) {
      html += `
        <form class="add-event-form" id="addEventForm">
          <input type="text" id="newEventTitle" placeholder="Add event title…" maxlength="200" required>
          <button type="submit">Add</button>
        </form>
      `;
    }

    calDetails.innerHTML = html;

    if (isAdmin) {
      const addForm = document.getElementById("addEventForm");
      addForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const titleInput = document.getElementById("newEventTitle");
        const title = titleInput.value.trim();
        if (!title) return;
        const submitBtn = addForm.querySelector("button[type=submit]");
        submitBtn.disabled = true;
        try {
          const created = await addCalendarEvent(dateStr, title);
          allEvents.push(created);
          renderCalendar();
          openDayPanel(dateStr);
        } catch (err) {
          console.error("Failed to add event:", err);
          alert("Couldn't add the event. You may not have admin permission, or the request failed — please try again.");
          submitBtn.disabled = false;
        }
      });

      calDetails.querySelectorAll(".event-del-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-id");
          if (!confirm("Delete this event?")) return;
          btn.disabled = true;
          try {
            await deleteCalendarEvent(id);
            allEvents = allEvents.filter(ev => String(ev.id) !== String(id));
            renderCalendar();
            openDayPanel(dateStr);
          } catch (err) {
            console.error("Failed to delete event:", err);
            alert("Couldn't delete the event. Please try again.");
            btn.disabled = false;
          }
        });
      });
    }
  }

  if (isAdmin) {
    calDetails.innerHTML = '<span class="empty">Click any date to view or add events.</span>';
  }

  try {
    await loadCalendarWindow(currentDisplayDate);
    renderCalendar();
  } catch (e) {
    console.error("Failed to load calendar events:", e);
    calGrid.innerHTML = '<p class="empty" style="grid-column: 1 / -1;">Couldn\'t load calendar right now.</p>';
  }

  document.getElementById("prevMonth").addEventListener("click", () => {
    currentDisplayDate.setMonth(currentDisplayDate.getMonth() - 1);
    showMonth();
  });

  document.getElementById("nextMonth").addEventListener("click", () => {
    currentDisplayDate.setMonth(currentDisplayDate.getMonth() + 1);
    showMonth();
  });
})();

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

const aiLauncher = document.getElementById("aiLauncher");
const aiWidget = document.getElementById("aiWidget");
const aiClose = document.getElementById("aiClose");
const aiBody = document.getElementById("aiBody");
const aiInput = document.getElementById("aiInput");
const aiSend = document.getElementById("aiSend");

let aiHistory = [];
let aiBusy = false;

aiLauncher.addEventListener("click", () => {
  aiWidget.classList.add("open");
  aiLauncher.style.display = "none";
  aiInput.focus();
});
aiClose.addEventListener("click", () => {
  aiWidget.classList.remove("open");
  aiLauncher.style.display = "flex";
});

function appendMsg(role, text) {
  const div = document.createElement("div");
  div.className = `ai-msg ${role}`;
  div.textContent = text;
  aiBody.appendChild(div);
  aiBody.scrollTop = aiBody.scrollHeight;
  return div;
}

async function sendAiMessage() {
  const text = aiInput.value.trim();
  if (!text || aiBusy) return;
  aiBusy = true;
  aiSend.disabled = true;
  aiInput.value = "";

  appendMsg("user", text);
  const typingEl = document.createElement("div");
  typingEl.className = "ai-msg typing";
  typingEl.textContent = "Thinking…";
  aiBody.appendChild(typingEl);
  aiBody.scrollTop = aiBody.scrollHeight;

  try {
    const { data, error } = await supabaseClient.functions.invoke("ai-assistant", {
      body: { message: text, history: aiHistory },
    });

    typingEl.remove();

    if (error || !data || data.error) {
      appendMsg("assistant", "Sorry, I couldn't reach the assistant right now. Please try again shortly.");
    } else {
      appendMsg("assistant", data.reply);
      aiHistory.push({ role: "user", content: text });
      aiHistory.push({ role: "assistant", content: data.reply });
    }
  } catch (e) {
    typingEl.remove();
    appendMsg("assistant", "Sorry, something went wrong reaching the assistant.");
  } finally {
    aiBusy = false;
    aiSend.disabled = false;
  }
}

aiSend.addEventListener("click", sendAiMessage);
aiInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendAiMessage();
});

// ------------------------------------------------------------
// Wiring that used to live in onclick attributes
//
// An inline handler is script inside an attribute, and CSP treats it
// exactly like an inline <script> block: 'unsafe-inline' covers both
// or neither. Moving the code out of <script> tags and leaving
// onclick="logout()" in the markup would have meant the page still
// needed 'unsafe-inline' to work, for one button.
//
// Nonces and hashes do not help here either — neither applies to
// event-handler attributes. A listener is the only way.
// ------------------------------------------------------------
document.getElementById("logoutBtn").addEventListener("click", () => logout());
