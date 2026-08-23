(async () => {
  const session = await requireSession();
  if (!session) return;
  const user = session.user;
  ensurePrivacyNoticeAck(user.email);
  // checkIsAdmin() returns null when the check itself failed, which is not
  // the same as "not an admin". Treating null as false hides the admin
  // tools and says nothing, so an administrator hitting a blip concludes
  // their access was pulled. page-users.js already distinguishes the
  // two; this is the same handling.
  const isAdmin = await checkIsAdmin();
  if (isAdmin === null) {
    const gateNote = document.getElementById("adminGateNote");
    if (gateNote) {
      gateNote.textContent = "Couldn't check your access just now — this is usually a brief " + "connection problem. If you're an administrator, reload the page to " + "get the admin tools back.";
      gateNote.hidden = false;
    }
  }
  const {data: profile, error: profileErr} = await supabaseClient.from("profiles").select("id, full_name, account_number").eq("email", user.email).single();
  if (profileErr) console.error("Failed to load profile:", profileErr);
  let adminManager = null;
  if (isAdmin) {
    injectApprovalStyles();
    const adminSection = document.getElementById("adminSection");
    adminSection.style.display = "";
    document.getElementById("usersLink").style.display = "";
    try {
      adminManager = await mountAdminManager(document.getElementById("adminManager"));
    } catch (err) {
      console.error("Couldn't set up the administrator panels:", err);
      adminSection.innerHTML = '<div class="card admin-card"><h2 class="section-title">Administrator tools</h2>' + '<p class="empty">These panels need the latest database functions. ' + "Run deploy-schema.sql in the Supabase " + "SQL Editor.</p></div>";
    }
  }
  async function refreshOwnProfile() {
    const {data: fresh} = await supabaseClient.from("profiles").select("id, full_name, account_number").eq("email", user.email).maybeSingle();
    if (!fresh) return;
    profile.full_name = fresh.full_name;
    profile.account_number = fresh.account_number;
    document.getElementById("identityName").textContent = fresh.full_name || "Name unavailable";
    setProfileDisplay(fresh.full_name);
  }
  document.getElementById("identityName").textContent = profile && profile.full_name ? profile.full_name : "Name unavailable";
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
  const availableCard = document.getElementById("availableCard");
  const availableBody = document.getElementById("availableBody");
  if (isAdmin) {
    document.getElementById("adminSection").appendChild(availableCard);
  }
  async function loadAvailable() {
    try {
      const wantedEmail = String(user.email || "").trim().toLowerCase();
      const {data: availableRaw, error: availableErr} = await supabaseClient.from("available_transactions").select("status, txn_date, ada_rada_check, name, amount, description_unit, span, user_email").ilike("user_email", `%${wantedEmail}%`).order("txn_date", {
        ascending: false
      }).limit(1e3);
      if (availableErr) throw availableErr;
      const available = (availableRaw || []).filter(r => String(r.user_email == null ? "" : r.user_email).split(/[,;\n]+/).map(e => e.trim().toLowerCase()).filter(Boolean).includes(wantedEmail));
      availableBody.innerHTML = available && available.length ? available.map(t => `\n          <tr>\n            <td class="status-center"><span class="status-badge">${escapeHtml(t.status || "—")}</span></td>\n            <td>${t.txn_date ? formatDate(t.txn_date) : "—"}</td>\n            <td>${escapeHtml(t.ada_rada_check || "—")}</td>\n            <td>${escapeHtml(t.name || "—")}</td>\n            <td class="amt-right">${t.amount != null ? "₱" + Number(t.amount).toLocaleString(undefined, {
        minimumFractionDigits: 2
      }) : "—"}</td>\n            <td>${escapeHtml(t.description_unit || "—")}</td>\n            <td>${escapeHtml(t.span || "—")}</td>\n          </tr>\n        `).join("") : '<tr><td colspan="7" class="empty">No transactions found for your account yet.</td></tr>';
    } catch (e) {
      console.error("Failed to load available_transactions:", e);
      availableBody.innerHTML = '<tr><td colspan="7" class="empty">Couldn\'t load transactions right now.</td></tr>';
    }
  }
  await loadAvailable();
  watchDatasets([ "available_transactions" ], loadAvailable);
  const newsList = document.getElementById("newsList");
  async function renderNews() {
    try {
      const news = await fetchNews(5);
      const urlMap = await newsImageUrls(news.map(n => n.image_path));
      const urls = news.map(n => urlMap.get(n.image_path) || null);
      newsList.innerHTML = news.length ? news.map((n, i) => `\n            <div class="news-item">\n              <time class="news-date">${formatTimestamp(n.created_at)}</time>\n              <h3>${escapeHtml(n.title)}</h3>\n              <p>${escapeHtml(n.content)}</p>\n              ${urls[i] ? `<img src="${escapeHtml(urls[i])}" alt="">` : ""}\n            </div>\n          `).join("") : '<p class="empty">No news to show right now.</p>';
    } catch (e) {
      console.error("Failed to load news:", e);
      newsList.innerHTML = '<p class="empty">Couldn\'t load news right now.</p>';
    }
  }
  await renderNews();
  if (isAdmin) {
    const titleEl = document.getElementById("newsTitle");
    const contentEl = document.getElementById("newsContent");
    const countEl = document.getElementById("newsCount");
    const noteEl = document.getElementById("newsNote");
    const saveBtn = document.getElementById("newsSave");
    const cancelBtn = document.getElementById("newsCancel");
    const adminList = document.getElementById("newsAdminList");
    const fileEl = document.getElementById("newsImage");
    const fileName = document.getElementById("newsImageName");
    const clearBtn = document.getElementById("newsImageClear");
    const previewEl = document.getElementById("newsImagePreview");
    let editingId = null;
    let editingImagePath = null;
    let editingThumbData = null;
    let previewUrl = null;
    function setPreview(url) {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = null;
      }
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
      countEl.className = "news-count" + (n > 2e3 ? " over" : "");
    }
    function resetForm() {
      editingId = null;
      editingImagePath = null;
      editingThumbData = null;
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
      editingThumbData = item.thumb_data || null;
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
    async function renderAdminList() {
      try {
        const items = await fetchNews(20);
        if (!items.length) {
          adminList.innerHTML = '<p class="empty">Nothing posted yet.</p>';
          return;
        }
        const needSigning = items.filter(n => n.image_path && !n.thumb_data).map(n => n.image_path);
        const thumbMap = needSigning.length ? await newsImageUrls(needSigning) : new Map;
        const thumbs = items.map(n => n.thumb_data || thumbMap.get(n.image_path) || null);
        adminList.innerHTML = items.map((n, i) => `\n          <div class="news-admin-item${n.id === editingId ? " editing" : ""}">\n            ${thumbs[i] ? `<img class="news-admin-thumb" src="${escapeHtml(thumbs[i])}" alt="" width="44" height="44" loading="lazy" decoding="async">` : ""}\n            <div class="news-admin-text">\n              <strong>${escapeHtml(n.title)}</strong>\n              <span>${escapeHtml(n.content)}</span>\n            </div>\n            <span class="news-admin-date">${formatTimestamp(n.created_at)}</span>\n            <div class="news-admin-btns">\n              <button type="button" data-news-edit="${escapeHtml(n.id)}">Edit</button>\n              <button type="button" data-news-del="${escapeHtml(n.id)}">Delete</button>\n            </div>\n          </div>\n        `).join("");
      } catch (e) {
        console.error("Failed to load news for admin list:", e);
        adminList.innerHTML = '<p class="empty">Couldn\'t load the list.</p>';
      }
    }
    adminList.addEventListener("click", async ev => {
      const editBtn = ev.target.closest("[data-news-edit]");
      const delBtn = ev.target.closest("[data-news-del]");
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
      if (!f) {
        fileName.textContent = editingImagePath ? "Current image" : "No image";
        return;
      }
      fileName.textContent = f.name;
      setPreview(URL.createObjectURL(f));
      previewUrl = previewEl.src;
      say("", null);
    });
    clearBtn.addEventListener("click", () => {
      fileEl.value = "";
      editingImagePath = null;
      editingThumbData = null;
      fileName.textContent = "No image";
      setPreview(null);
    });
    contentEl.addEventListener("input", updateCount);
    cancelBtn.addEventListener("click", () => {
      resetForm();
      say("", null);
    });
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      say("Saving…", null);
      try {
        const picked = fileEl.files && fileEl.files[0];
        let imagePath = editingImagePath;
        let thumbData = editingThumbData;
        if (picked) {
          say("Uploading image…", null);
          thumbData = await makeThumbData(picked);
          imagePath = await uploadNewsImage(picked);
        }
        if (editingId) {
          await updateNews(editingId, titleEl.value, contentEl.value, imagePath, thumbData);
          if (picked && editingImagePath && editingImagePath !== imagePath) {
            await deleteNewsImage(editingImagePath);
          }
          say("Changes saved.", "ok");
        } else {
          await addNews(titleEl.value, contentEl.value, imagePath, thumbData);
          say("Posted.", "ok");
        }
        resetForm();
        await renderNews();
      } catch (e) {
        console.error("Failed to save news:", e);
        say(e && e.message && !e.code ? e.message : "Couldn't save that. Try again.", "error");
      } finally {
        saveBtn.disabled = false;
      }
    });
    updateCount();
    await renderAdminList();
  }
  let currentDisplayDate = new Date;
  let allEvents = [];
  const CAL_WINDOW_MONTHS = 6;
  let loadedFrom = null;
  let loadedTo = null;
  function isoDay(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  function windowFor(date) {
    const from = new Date(date.getFullYear(), date.getMonth() - CAL_WINDOW_MONTHS, 1);
    const to = new Date(date.getFullYear(), date.getMonth() + CAL_WINDOW_MONTHS + 1, 0);
    return {
      from: isoDay(from.getFullYear(), from.getMonth(), 1),
      to: isoDay(to.getFullYear(), to.getMonth(), to.getDate())
    };
  }
  function monthIsLoaded(date) {
    if (!loadedFrom || !loadedTo) return false;
    const first = isoDay(date.getFullYear(), date.getMonth(), 1);
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return first >= loadedFrom && isoDay(last.getFullYear(), last.getMonth(), last.getDate()) <= loadedTo;
  }
  async function loadCalendarWindow(date) {
    const {from: from, to: to} = windowFor(date);
    allEvents = await fetchCalendarEvents(from, to);
    loadedFrom = from;
    loadedTo = to;
  }
  async function showMonth() {
    if (!monthIsLoaded(currentDisplayDate)) {
      try {
        await loadCalendarWindow(currentDisplayDate);
        prewarmEventImages();
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
    currentMonthYearEl.textContent = new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric"
    }).format(currentDisplayDate);
    const dayNames = [ "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" ];
    calGrid.innerHTML = dayNames.map(d => `<div class="cal-day-name">${d}</div>`).join("");
    const firstDayIndex = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < firstDayIndex; i++) {
      const blank = document.createElement("div");
      blank.className = "cal-cell";
      blank.style.opacity = "0.2";
      calGrid.appendChild(blank);
    }
    const todayStr = todayLocalISO();
    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const dayEvents = allEvents.filter(e => e.date === dateStr);
      const isToday = dateStr === todayStr ? "today" : "";
      const hasEvent = dayEvents.length > 0 ? "has-event" : "";
      const adminAddable = isAdmin && dayEvents.length === 0 ? "admin-addable" : "";
      const cell = document.createElement("div");
      cell.className = `cal-cell ${isToday} ${hasEvent} ${adminAddable}`.trim();
      cell.innerHTML = `\n        <span>${day}</span>\n        ${dayEvents.length > 0 ? '<div class="event-dot"></div>' : ""}\n      `;
      if (dayEvents.length > 0 || isAdmin) {
        cell.addEventListener("click", () => openDayPanel(dateStr));
      }
      calGrid.appendChild(cell);
    }
  }
  function openDayPanel(dateStr) {
    const events = allEvents.filter(e => e.date === dateStr);
    const formattedDate = formatDate(dateStr);
    let html = `\n      <strong style="color: var(--maroon); font-family: 'JetBrains Mono', monospace;">\n        ${formattedDate}\n      </strong>\n    `;
    if (events.length) {
      html += `\n        <ul class="event-list">\n          ${events.map(e => `\n            <li class="event-list-item" data-event-id="${escapeHtml(e.id)}">\n              ${e.thumb_data ? `<img class="event-thumb" src="${escapeHtml(e.thumb_data)}" alt="" width="32" height="32" decoding="async">` : e.image_path ? `<img class="event-thumb" data-img-for="${escapeHtml(e.id)}" alt="" width="32" height="32" loading="lazy" decoding="async">` : ""}\n              <span class="event-list-title">${escapeHtml(e.title)}</span>\n              ${isAdmin ? `<button type="button" class="event-del-btn" data-id="${escapeHtml(e.id)}">Delete</button>` : ""}\n            </li>\n          `).join("")}\n        </ul>\n      `;
    } else {
      html += `<div class="empty" style="margin-top:8px;">No events scheduled.</div>`;
    }
    if (isAdmin) {
      html += `\n        <form class="add-event-form" id="addEventForm">\n          <input type="text" id="newEventTitle" placeholder="Add event title…" maxlength="200" required>\n          <button type="submit">Add</button>\n        </form>\n        <div class="event-image-row">\n          <label class="news-image-pick" for="newEventImage">Add preview</label>\n          <input id="newEventImage" type="file"\n                 accept="image/jpeg,image/png,image/webp,image/gif">\n          <span class="news-image-name" id="newEventImageName">No image</span>\n          <button type="button" class="news-image-clear" id="newEventImageClear" style="display:none;">Remove</button>\n        </div>\n      `;
    }
    calDetails.innerHTML = html;
    const withImages = events.filter(e => e.image_path && !e.thumb_data);
    if (withImages.length) {
      newsImageUrls(withImages.map(e => e.image_path)).then(urls => {
        withImages.forEach(e => {
          const url = urls.get(e.image_path);
          const el = calDetails.querySelector(`[data-img-for="${CSS.escape(String(e.id))}"]`);
          if (url && el) el.src = url;
        });
      });
    }
    if (isAdmin) {
      const addForm = document.getElementById("addEventForm");
      const evtFile = document.getElementById("newEventImage");
      const evtName = document.getElementById("newEventImageName");
      const evtClear = document.getElementById("newEventImageClear");
      evtFile.addEventListener("change", () => {
        const f = evtFile.files && evtFile.files[0];
        evtName.textContent = f ? f.name : "No image";
        evtClear.style.display = f ? "" : "none";
      });
      evtClear.addEventListener("click", () => {
        evtFile.value = "";
        evtName.textContent = "No image";
        evtClear.style.display = "none";
      });
      addForm.addEventListener("submit", async e => {
        e.preventDefault();
        const titleInput = document.getElementById("newEventTitle");
        const title = titleInput.value.trim();
        if (!title) return;
        const submitBtn = addForm.querySelector("button[type=submit]");
        submitBtn.disabled = true;
        try {
          const picked = evtFile.files && evtFile.files[0];
          const thumbData = picked ? await makeThumbData(picked) : null;
          const imagePath = picked ? await uploadNewsImage(picked) : null;
          const created = await addCalendarEvent(dateStr, title, imagePath, thumbData);
          allEvents.push(created);
          renderCalendar();
          openDayPanel(dateStr);
        } catch (err) {
          console.error("Failed to add event:", err);
          alert(err && err.message && !err.code ? err.message : "Couldn't add the event. You may not have admin permission, or the request failed — please try again.");
          submitBtn.disabled = false;
        }
      });
      calDetails.querySelectorAll(".event-del-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-id");
          if (!confirm("Delete this event?")) return;
          btn.disabled = true;
          try {
            const ev = allEvents.find(x => String(x.id) === String(id));
            await deleteCalendarEvent(id, ev ? ev.image_path : null);
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
  function prewarmEventImages() {
    const paths = allEvents.filter(e => e.image_path && !e.thumb_data).map(e => e.image_path);
    if (paths.length) newsImageUrls(paths).catch(() => {});
  }
  try {
    await loadCalendarWindow(currentDisplayDate);
    renderCalendar();
    prewarmEventImages();
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
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
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
    const {data: data, error: error} = await supabaseClient.functions.invoke("ai-assistant", {
      body: {
        message: text,
        history: aiHistory
      }
    });
    typingEl.remove();
    if (error || !data || data.error) {
      appendMsg("assistant", "Sorry, I couldn't reach the assistant right now. Please try again shortly.");
    } else {
      appendMsg("assistant", data.reply);
      aiHistory.push({
        role: "user",
        content: text
      });
      aiHistory.push({
        role: "assistant",
        content: data.reply
      });
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

aiInput.addEventListener("keydown", e => {
  if (e.key === "Enter") sendAiMessage();
});

document.getElementById("logoutBtn").addEventListener("click", () => logout());
