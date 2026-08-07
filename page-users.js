// Version marker for the build stamp in config.js. Bump with the
// BUILD_ID there whenever this file changes, so a stale copy on the
// server announces itself instead of looking like a broken feature.
window.__BUILD = window.__BUILD || {};
window.__BUILD["users"] = "2026-08-07-i";


// ------------------------------------------------------------
// Administrators only. The redirect below is for tidiness — every
// function this page calls (admin_search_users, admin_update_user,
// admin_delete_user, admin_user_actions) re-checks is_admin() or
// is_main_admin() in the database, so someone who forces their way
// onto this URL gets an empty page and a string of exceptions,
// not access.
// ------------------------------------------------------------

(async () => {
  const gateNote = document.getElementById("gateNote");

  // requireSession() returns null for several reasons. Most of them
  // redirect or draw their own notice, but "couldn't reach the server"
  // leaves this page sitting on "Checking your access…" with nothing
  // to read and nothing to do, which is indistinguishable from a page
  // that failed to load. Say so instead.
  const session = await requireSession();
  if (!session) {
    gateNote.textContent =
      "Couldn't confirm your access. If this doesn't clear on a reload, " +
      "sign in again from the home page.";
    return;
  }

  const user = session.user;

  // checkIsAdmin() returns null when the check itself failed, which is
  // not the same as being refused. Redirecting on both meant a
  // momentary network problem looked identical to "you aren't an
  // administrator" — an admin got silently thrown back to the
  // dashboard with nothing to read and nothing to retry.
  let isAdmin = null;
  try {
    isAdmin = await checkIsAdmin();
  } catch (err) {
    console.error("Couldn't check administrator status:", err);
    isAdmin = null;
  }

  if (isAdmin === null) {
    gateNote.textContent =
      "Couldn't check your access just now — this is usually a brief " +
      "connection problem. Reload the page to try again.";
    return;
  }

  if (!isAdmin) {
    window.location.replace("dashboard.html");
    return;
  }

  document.getElementById("usersLink").style.display = "";
  document.getElementById("pageWrap").style.display = "";
  gateNote.style.display = "none";

  // ---- profile menu (same as the dashboard's) ----

  const { data: profile } = await supabaseClient
    .from("profiles")
    .select("full_name")
    .eq("email", user.email)
    .maybeSingle();

  const profileMenu = document.getElementById("profileMenu");
  const profileBtn = document.getElementById("profileBtn");
  const label = (profile && profile.full_name) || user.email;

  document.getElementById("profileNameLabel").textContent = label;
  document.getElementById("profileAvatar").textContent =
    label.trim().charAt(0).toUpperCase() || "?";
  document.getElementById("ddName").textContent = label;
  document.getElementById("ddEmail").textContent = user.email;

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

  // ---- the panels ----

  injectApprovalStyles();

  // The two approval queues, moved here from the dashboard. Mounted
  // first because they sit above Manage Users on the page, and a queue
  // that arrives after the search box has already painted makes the
  // page jump under whoever is reading it.
  //
  // onApplied is not passed. On the dashboard it refreshed the
  // administrator's own identity card, because approving a name change
  // could be their own. There is no identity card on this page, and
  // mountAdminQueues() reloads its own queues regardless.
  try {
    await mountAdminQueues({
      registrationsEl: document.getElementById("regQueue"),
      changesEl: document.getElementById("changeQueue"),
      filterEl: document.getElementById("regFilter"),
    });
  } catch (err) {
    console.error("Couldn't set up the approval queues:", err);
    document.getElementById("regQueue").innerHTML =
      '<p class="empty">These queues need the latest database functions. ' +
      'Run deploy-schema.sql in the Supabase SQL Editor.</p>';
  }

  try {
    await mountUserDirectory(document.getElementById("userDirectory"));
  } catch (err) {
    console.error("Couldn't set up the user search:", err);
    document.getElementById("userDirectory").innerHTML =
      '<p class="empty">This page needs the latest database functions. ' +
      'Run deploy-schema.sql ' +
      'in the Supabase SQL Editor.</p>';
  }

  // Separately, and after: the log is a main-administrator panel that
  // hides itself for everyone else, and a failure to mount it should
  // not take the user directory down with it. mountActionLog() shows
  // the card only if it has something to put in it.
  try {
    // Returns null when the signed-in administrator isn't a main one,
    // which is also the answer to whether the card should exist.
    const log = await mountActionLog(document.getElementById("actionLog"));
    if (log) document.getElementById("actionLogCard").style.display = "";
  } catch (err) {
    console.error("Couldn't set up the action log:", err);
  }
})();

// See the note in page-dashboard.js: onclick="logout()" kept the page
// dependent on 'unsafe-inline' regardless of where the rest of the
// script lived.
document.getElementById("logoutBtn").addEventListener("click", () => logout());
