(async () => {
  const session = await requireSession();
  if (!session) return;
  const user = session.user;

  // RA 10173 s.16(a) — the right to be informed. Shows the notice to
  // anyone whose profile carries no acknowledgement or one for an
  // older version: Google SSO users, accounts the Cash Office set up
  // directly, and everybody at once whenever PRIVACY_NOTICE_VERSION
  // moves. The dashboard is where this belongs because it is the one
  // page every signed-in person lands on.
  //
  // Not awaited. It resolves only when the person clicks, and the rest
  // of the page has no reason to sit blank behind a modal they are
  // reading past.
  ensurePrivacyNoticeAck(user.email);

  const isAdmin = await checkIsAdmin();

  const { data: profile, error: profileErr } = await supabaseClient
    .from("profiles")
    .select("id, full_name, account_number")
    .eq("email", user.email)
    .single();
  if (profileErr) console.error("Failed to load profile:", profileErr);

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
      // The two approval queues moved to users.html. mountAdminQueues()
      // is still exported by approval.js and is called from
      // page-users.js instead; nothing about it is dashboard-specific.
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
    // for admins outright; now it's appended straight into
    // #adminSection, after the Administrators panel.
    //
    // It has to be a direct child of #adminSection and not wrapped in
    // an extra div: #adminSection is `display: contents`, which is
    // what lets its children act as top-level items in the page's
    // grid and pick up .available-card's own grid-column: 1 / -1 (so
    // it spans the full row, same width as the identity card above,
    // instead of being squeezed into a single 2fr/1fr column like the
    // narrower admin-card panels). A wrapper div here would itself
    // become the grid item and swallow that span.
    document.getElementById("adminSection").appendChild(availableCard);
  }

  // Wrapped in a named function so the live-refresh watcher below can
  // re-run exactly what ran on load, rather than duplicating the query.
  async function loadAvailable() {
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
  }

  await loadAvailable();

  // Cheques released while the dashboard is open should appear without
  // the person having to reload. watchDatasets() is in config.js.
  watchDatasets(["available_transactions"], loadAvailable);

  const newsList = document.getElementById("newsList");

  // Pulled out of the inline block below so the admin composer can
  // repaint the public list after posting, editing or deleting --
  // without the person having to reload to see their own change.
  async function renderNews() {
    try {
      const news = await fetchNews(5);

      // Signed in parallel. Each URL is an independent round trip, so
      // awaiting them in sequence would add a request's latency per
      // item with an image.
      const urls = await Promise.all(news.map(n => newsImageUrl(n.image_path)));

      newsList.innerHTML = news.length
        ? news.map((n, i) => `
            <div class="news-item">
              <time class="news-date">${formatTimestamp(n.created_at)}</time>
              <h3>${escapeHtml(n.title)}</h3>
              <p>${escapeHtml(n.content)}</p>
              ${urls[i] ? `<img src="${escapeHtml(urls[i])}" alt="">` : ""}
            </div>
          `).join("")
        : '<p class="empty">No news to show right now.</p>';
    } catch (e) {
      console.error("Failed to load news:", e);
      newsList.innerHTML = '<p class="empty">Couldn\'t load news right now.</p>';
    }
  }

  await renderNews();

  // ------------------------------------------------------------
  // Post News — administrators only.
  //
  // Hiding the card for non-admins is a courtesy, not the control:
  // news_admin_write says is_admin() for both USING and WITH CHECK, so
  // a non-admin who called addNews() from the console gets a policy
  // error. The card is hidden because showing a button that always
  // fails is worse than not showing it.
  // ------------------------------------------------------------
  if (isAdmin) {
    const titleEl   = document.getElementById("newsTitle");
    const contentEl = document.getElementById("newsContent");
    const countEl   = document.getElementById("newsCount");
    const noteEl    = document.getElementById("newsNote");
    const saveBtn   = document.getElementById("newsSave");
    const cancelBtn = document.getElementById("newsCancel");
    const adminList = document.getElementById("newsAdminList");

    const fileEl    = document.getElementById("newsImage");
    const fileName  = document.getElementById("newsImageName");
    const clearBtn  = document.getElementById("newsImageClear");
    const previewEl = document.getElementById("newsImagePreview");

    // null = composing a new item; a uuid = editing that one.
    let editingId = null;
    // The path already stored on the item being edited. Kept so an edit
    // that does not touch the picker leaves the existing image alone.
    let editingImagePath = null;
    // Object URL for a freshly picked file, revoked when replaced --
    // otherwise every pick leaks a blob for the life of the page.
    let previewUrl = null;

    function setPreview(url) {
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
      if (url) {
        previewEl.src = url;
        previewEl.style.display = "";
        clearBtn.style.display = "";
      } else {
        previewEl.removeAttribute("src");
        previewEl.style.display = "none";
        clearBtn.style.display = "none";
      }
    }

    function say(message, kind) {
      noteEl.textContent = message || "";
      noteEl.className = "news-note" + (kind ? " " + kind : "");
    }

    function updateCount() {
      const n = contentEl.value.length;
      countEl.textContent = n + " / 2000";
      countEl.className = "news-count" + (n > 2000 ? " over" : "");
    }

    function resetForm() {
      editingId = null;
      editingImagePath = null;
      titleEl.value = "";
      contentEl.value = "";
      fileEl.value = "";
      fileName.textContent = "No image";
      setPreview(null);
      saveBtn.textContent = "Post";
      cancelBtn.style.display = "none";
      updateCount();
      renderAdminList();
    }

    async function beginEdit(item) {
      editingId = item.id;
      editingImagePath = item.image_path || null;
      titleEl.value = item.title || "";
      contentEl.value = item.content || "";
      fileEl.value = "";

      if (editingImagePath) {
        fileName.textContent = "Current image";
        setPreview(await newsImageUrl(editingImagePath));
      } else {
        fileName.textContent = "No image";
        setPreview(null);
      }

      saveBtn.textContent = "Save changes";
      cancelBtn.style.display = "";
      updateCount();
      say("Editing an existing item.", null);
      renderAdminList();
      titleEl.focus();
    }

    // Rebuilt from scratch each time rather than patched in place: the
    // list is at most NEWS_LIMIT rows, and a full repaint cannot drift
    // out of step with the database the way incremental edits do.
    async function renderAdminList() {
      try {
        const items = await fetchNews(20);
        if (!items.length) {
          adminList.innerHTML = '<p class="empty">Nothing posted yet.</p>';
          return;
        }
        const thumbs = await Promise.all(items.map(n => newsImageUrl(n.image_path)));
        adminList.innerHTML = items.map((n, i) => `
          <div class="news-admin-item${n.id === editingId ? " editing" : ""}">
            ${thumbs[i] ? `<img class="news-admin-thumb" src="${escapeHtml(thumbs[i])}" alt="">` : ""}
            <div class="news-admin-text">
              <strong>${escapeHtml(n.title)}</strong>
              <span>${escapeHtml(n.content)}</span>
            </div>
            <span class="news-admin-date">${formatTimestamp(n.created_at)}</span>
            <div class="news-admin-btns">
              <button type="button" data-news-edit="${escapeHtml(n.id)}">Edit</button>
              <button type="button" data-news-del="${escapeHtml(n.id)}">Delete</button>
            </div>
          </div>
        `).join("");
      } catch (e) {
        console.error("Failed to load news for admin list:", e);
        adminList.innerHTML = '<p class="empty">Couldn\'t load the list.</p>';
      }
    }

    // One delegated listener rather than one per button: the list is
    // re-rendered constantly, and per-button handlers would leak with
    // every repaint.
    adminList.addEventListener("click", async (ev) => {
      const editBtn = ev.target.closest("[data-news-edit]");
      const delBtn  = ev.target.closest("[data-news-del]");

      if (editBtn) {
        const items = await fetchNews(20);
        const item = items.find(n => n.id === editBtn.getAttribute("data-news-edit"));
        if (item) await beginEdit(item);
        return;
      }

      if (delBtn) {
        const id = delBtn.getAttribute("data-news-del");
        if (!window.confirm("Delete this news item? This cannot be undone.")) return;
        delBtn.disabled = true;
        try {
          const items = await fetchNews(20);
          const item = items.find(n => n.id === id);
          await deleteNews(id, item ? item.image_path : null);
          if (editingId === id) resetForm();
          say("Deleted.", "ok");
          await renderAdminList();
          await renderNews();
        } catch (e) {
          console.error("Failed to delete news:", e);
          say("Couldn't delete that item.", "error");
          delBtn.disabled = false;
        }
      }
    });

    fileEl.addEventListener("change", () => {
      const f = fileEl.files && fileEl.files[0];
      if (!f) { fileName.textContent = editingImagePath ? "Current image" : "No image"; return; }
      fileName.textContent = f.name;
      setPreview(URL.createObjectURL(f));
      previewUrl = previewEl.src;
      say("", null);
    });

    // Clears a picked file, and marks an existing image for removal on
    // save by dropping the remembered path.
    clearBtn.addEventListener("click", () => {
      fileEl.value = "";
      editingImagePath = null;
      fileName.textContent = "No image";
      setPreview(null);
    });

    contentEl.addEventListener("input", updateCount);
    cancelBtn.addEventListener("click", () => { resetForm(); say("", null); });

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      say("Saving…", null);
      try {
        const picked = fileEl.files && fileEl.files[0];
        let imagePath = editingImagePath;

        if (picked) {
          say("Uploading image…", null);
          imagePath = await uploadNewsImage(picked);
        }

        if (editingId) {
          await updateNews(editingId, titleEl.value, contentEl.value, imagePath);
          // Only once the row points at the new object. Reversing this
          // would delete the old image and then, on a failed update,
          // leave the item pointing at nothing.
          if (picked && editingImagePath && editingImagePath !== imagePath) {
            await deleteNewsImage(editingImagePath);
          }
          say("Changes saved.", "ok");
        } else {
          await addNews(titleEl.value, contentEl.value, imagePath);
          say("Posted.", "ok");
        }
        resetForm();
        await renderNews();
      } catch (e) {
        console.error("Failed to save news:", e);
        // addNews/updateNews raise plain Error for the validation cases,
        // so their wording is worth showing. A PostgREST error is not.
        say(e && e.message && !e.code ? e.message : "Couldn't save that. Try again.", "error");
      } finally {
        saveBtn.disabled = false;
      }
    });

    updateCount();
    await renderAdminList();
  }

  // eslint-disable-next-line no-constant-condition

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

    // createElement rather than `innerHTML +=`. The += form reparses
    // and rebuilds the entire grid on every iteration, and it is the
    // only place in this file that doesn't build nodes directly — the
    // day cells below already do. Trivial at six blanks; the reason to
    // fix it is that it reads as the house style and isn't.
    for (let i = 0; i < firstDayIndex; i++) {
      const blank = document.createElement("div");
      blank.className = "cal-cell";
      blank.style.opacity = "0.2";
      calGrid.appendChild(blank);
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

// Calendar events only. event_date is a plain YYYY-MM-DD date, and the
// "T00:00:00" is what stops the browser reading it as UTC midnight and
// showing the day before east of Greenwich.
function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// news.created_at is a timestamptz, not a date. Passing it to
// formatDate() above appends a second time component -- producing
// "...+00:00T00:00:00", which is an Invalid Date. It already carries its
// own offset, so it is parsed as-is and rendered in local time.
function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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
