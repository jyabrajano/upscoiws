
// ------------------------------------------------------------
// Administrators only. The redirect below is for tidiness — every
// function this page calls (admin_search_users, admin_update_user,
// admin_delete_user, admin_user_actions) re-checks is_admin() or
// is_main_admin() in the database, so someone who forces their way
// onto this URL gets an empty page and a string of exceptions,
// not access.
// ------------------------------------------------------------

(async () => {
  const session = await requireSession();
  if (!session) return;

  const user = session.user;
  const gateNote = document.getElementById("gateNote");

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

  // ---- the panel ----

  try {
    injectApprovalStyles();
    await mountUserDirectory(document.getElementById("userDirectory"));
  } catch (err) {
    console.error("Couldn't set up the user search:", err);
    document.getElementById("userDirectory").innerHTML =
      '<p class="empty">This page needs the latest database functions. ' +
      'Run deploy-schema.sql ' +
      'in the Supabase SQL Editor.</p>';
  }
})();

// See the note in page-dashboard.js: onclick="logout()" kept the page
// dependent on 'unsafe-inline' regardless of where the rest of the
// script lived.
document.getElementById("logoutBtn").addEventListener("click", () => logout());
