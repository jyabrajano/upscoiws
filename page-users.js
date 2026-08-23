(async () => {
  const session = await requireSession();
  if (!session) return;
  const user = session.user;
  const gateNote = document.getElementById("gateNote");
  let isAdmin = null;
  try {
    isAdmin = await checkIsAdmin();
  } catch (err) {
    console.error("Couldn't check administrator status:", err);
    isAdmin = null;
  }
  if (isAdmin === null) {
    gateNote.textContent = "Couldn't check your access just now — this is usually a brief " + "connection problem. Reload the page to try again.";
    return;
  }
  if (!isAdmin) {
    window.location.replace("dashboard.html");
    return;
  }
  document.getElementById("usersLink").style.display = "";
  document.getElementById("pageWrap").style.display = "";
  gateNote.style.display = "none";
  const {data: profile} = await supabaseClient.from("profiles").select("full_name").eq("email", user.email).maybeSingle();
  const profileMenu = document.getElementById("profileMenu");
  const profileBtn = document.getElementById("profileBtn");
  const label = profile && profile.full_name || user.email;
  document.getElementById("profileNameLabel").textContent = label;
  document.getElementById("profileAvatar").textContent = label.trim().charAt(0).toUpperCase() || "?";
  document.getElementById("ddName").textContent = label;
  document.getElementById("ddEmail").textContent = user.email;
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
  injectApprovalStyles();
  try {
    await mountAdminQueues({
      registrationsEl: document.getElementById("regQueue"),
      changesEl: document.getElementById("changeQueue"),
      filterEl: document.getElementById("regFilter")
    });
  } catch (err) {
    console.error("Couldn't set up the approval queues:", err);
    document.getElementById("regQueue").innerHTML = '<p class="empty">These queues need the latest database functions. ' + "Run deploy-schema.sql in the Supabase SQL Editor.</p>";
  }
  try {
    await mountUserDirectory(document.getElementById("userDirectory"));
  } catch (err) {
    console.error("Couldn't set up the user search:", err);
    document.getElementById("userDirectory").innerHTML = '<p class="empty">This page needs the latest database functions. ' + "Run deploy-schema.sql " + "in the Supabase SQL Editor.</p>";
  }
  try {
    const log = await mountActionLog(document.getElementById("actionLog"));
    if (log) document.getElementById("actionLogCard").style.display = "";
  } catch (err) {
    console.error("Couldn't set up the action log:", err);
  }
})();

document.getElementById("logoutBtn").addEventListener("click", () => logout());
