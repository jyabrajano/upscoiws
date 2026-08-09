// ============================================================
// Approval workflow — shared by dashboard.html and soa.html
//
// Load AFTER config.js:
//   <script src="config.js"></script>
//   <script src="approval.js"></script>
//
// Two things live in here:
//
//   1. The user side of Edit Account. Saving name / account number
//      no longer writes to `profiles` — it calls the
//      request_profile_change RPC, and an administrator has to
//      approve it before it takes effect. Password changes do NOT
//      come through here; they still go straight to Supabase Auth
//      and apply immediately.
//
//   2. The administrator approval panel: mountAdminQueues() paints
//      the two approval queues and mountAdminManager() paints the
//      administrator list, both as their own cards on
//      dashboard.html. They used to render inside the Edit Account
//      modal; see the note near the end of
//      initEditAccountApproval() below for why they moved.
//
// Every check in this file is for the interface's benefit. The
// actual enforcement is in deploy-schema.sql: the RPCs are
// SECURITY DEFINER and re-check is_admin() in the database, and
// users have no UPDATE policy on `profiles` at all.
// ============================================================

// ---------- current user ----------

// true = an administrator, false = not one, null = we couldn't ask.
//
// null rather than false for the error case, and null rather than a
// thrown exception: it is falsy, so the two callers that only want to
// know whether to show the admin tools (page-dashboard.js, and
// mountApprovalUI below) keep working untouched and simply hide them.
// page-users.js is the one that has to tell the difference, because
// there `false` means "go away" — and bouncing an administrator off
// the page they asked for, with no message, is the wrong answer to a
// request that timed out.
async function checkIsAdmin() {
  const { data, error } = await supabaseClient.rpc("is_admin");
  if (error) {
    console.error("is_admin check failed:", error);
    return null;
  }
  return data === true;
}

async function getMyPendingChange() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return null;

  // The email filter matters: an administrator's SELECT policy covers
  // every row in this table, so without it an admin would be shown
  // somebody else's request as their own.
  const { data, error } = await supabaseClient
    .from("profile_change_requests")
    .select("id, requested_full_name, requested_account_number, requested_at")
    .ilike("user_email", user.email)
    .eq("status", "pending")
    .order("requested_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Couldn't load your pending request:", error);
    return null;
  }
  return (data && data[0]) || null;
}

async function submitProfileChangeRequest(fullName, accountNumber) {
  const { data, error } = await supabaseClient.rpc("request_profile_change", {
    p_full_name: fullName,
    p_account_number: accountNumber,
  });
  if (error) throw error;
  // {immediate: true, full_name, account_number} for a main admin's own
  // edit (applied at once), or {immediate: false, id} for everyone else
  // (queued — id is the pending profile_change_requests row).
  return data;
}

async function cancelMyProfileChange() {
  const { error } = await supabaseClient.rpc("cancel_my_profile_change");
  if (error) throw error;
}

// ---------- administrator ----------

async function loadAdminQueue() {
  const { data, error } = await supabaseClient.rpc("admin_pending_queue");
  if (error) throw error;
  return {
    registrations: (data && data.registrations) || [],
    profileChanges: (data && data.profile_changes) || [],
  };
}

async function approveRegistration(email) {
  const { data, error } = await supabaseClient.rpc("approve_registration", { p_email: email });
  if (error) throw error;
  return data;
}

async function rejectRegistration(email, reason) {
  const { data, error } = await supabaseClient.rpc("reject_registration", {
    p_email: email,
    p_reason: reason || null,
  });
  if (error) throw error;
  return data;
}

async function approveProfileChange(requestId) {
  const { data, error } = await supabaseClient.rpc("approve_profile_change", {
    p_request_id: requestId,
  });
  if (error) throw error;
  return data;
}

async function rejectProfileChange(requestId, note) {
  const { data, error } = await supabaseClient.rpc("reject_profile_change", {
    p_request_id: requestId,
    p_note: note || null,
  });
  if (error) throw error;
  return data;
}

// Fires the notification email via the `notify-approval` Edge
// Function. Approval already succeeded by the time this runs, so a
// failure here is reported but never rolled back — the panel says
// "approved, but the email didn't send" rather than pretending
// nothing happened.
async function notifyDecision(kind, payload) {
  try {
    const { data, error } = await supabaseClient.functions.invoke("notify-approval", {
      body: { kind, ...payload },
    });
    if (error || (data && data.error)) {
      throw new Error((data && data.error) || error.message || "Edge function error");
    }
    if (payload.email && kind === "registration") {
      await supabaseClient.rpc("mark_notified", { p_email: payload.email });
    }
    return true;
  } catch (err) {
    console.warn("notify-approval didn't send:", err);
    return false;
  }
}

// ---------- panel UI ----------

// Escapes for BOTH text and attribute contexts.
//
// The previous version set textContent and read innerHTML back. That
// is correct for text nodes and wrong for attributes: the HTML
// serialiser escapes & < > in a text node but deliberately leaves
// quotes alone, because quotes only need escaping when a value is
// serialised into an attribute — which is exactly what this function
// was used for below (value="...", data-email="...").
//
// So a full_name of  " autofocus onfocus="fetch(...)  closed the
// value attribute and ran script in the administrator's browser the
// moment they opened that person's row in the user directory. The
// name is set at signup from auth metadata, so anyone who can reach
// /auth/v1/signup could plant it. script-src carries 'unsafe-inline',
// so the handler was not blocked by the CSP.
//
// Doing it with string replacement rather than the DOM because the
// DOM route cannot express the attribute case at all.

function formatApprovalStamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// One row of a profile-change request's diff: a label plus either
// "No modification." (requested value is the same as what's on file)
// or the was → now treatment when it actually changed.
//
// Compared trimmed, not raw — a request that came back with the same
// value but different whitespace isn't a real change, and showing
// "X → X" would just look like a rendering bug rather than tell the
// administrator anything.
function renderApprovalDiffRow(label, was, now) {
  const wasTrim = (was || "").trim();
  const nowTrim = (now || "").trim();

  if (wasTrim === nowTrim) {
    return `
      <div>
        <span class="k">${escapeHtml(label)}</span>
        <span class="v"><span class="no-mod">No modification.</span></span>
      </div>`;
  }

  return `
    <div>
      <span class="k">${escapeHtml(label)}</span>
      <span class="v">
        <span class="was">${escapeHtml(was || "—")}</span>
        <span class="arrow">→</span>
        <span class="now">${escapeHtml(now || "—")}</span>
      </span>
    </div>`;
}

// Injected here rather than in each page's <style> block so the two
// pages can't drift apart.
function injectApprovalStyles() {
  if (document.getElementById("approvalStyles")) return;
  const css = `
  .approval-note {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--muted, #64748b);
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-left: 3px solid var(--yellow, #f5b041);
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 16px;
  }
  .pending-banner {
    font-size: 12.5px;
    line-height: 1.5;
    background: var(--yellow-soft, #fef9ec);
    border: 1px solid #fde68a;
    border-radius: 10px;
    padding: 11px 13px;
    margin-bottom: 16px;
    color: #854d0e;
  }
  .pending-banner strong { display: block; margin-bottom: 3px; font-size: 13px; }
  .pending-banner .withdraw {
    background: none; border: none; padding: 0; margin-top: 6px;
    color: #854d0e; font: inherit; font-weight: 700;
    text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
  }
  .admin-panel { margin-top: 4px; }
  .admin-panel h3 {
    font-size: 12px;
    font-family: "JetBrains Mono", monospace;
    text-transform: uppercase;
    letter-spacing: 1.1px;
    color: var(--maroon, #7b1113);
    margin: 18px 0 10px;
  }
  .admin-panel h3:first-child { margin-top: 0; }
  .admin-panel .queue-count {
    display: inline-block;
    min-width: 18px;
    padding: 1px 6px;
    margin-left: 6px;
    border-radius: 999px;
    background: var(--maroon, #7b1113);
    color: #fff;
    font-size: 10.5px;
    letter-spacing: 0;
    vertical-align: middle;
  }
  .req-card {
    border: 1px solid rgba(123, 17, 19, 0.14);
    border-radius: 10px;
    padding: 12px 13px;
    margin-bottom: 10px;
    background: rgba(255,255,255,0.7);
  }
  .req-who {
    font-size: 13.5px; font-weight: 700; color: var(--ink, #1e293b);
    word-break: break-word;
  }
  .req-meta {
    font-size: 11.5px; color: var(--muted, #64748b);
    font-family: "JetBrains Mono", monospace; margin-top: 2px;
  }
  .req-diff { margin: 9px 0 0; font-size: 12.5px; }
  .req-diff div { display: flex; gap: 8px; padding: 2px 0; }
  .req-diff .k {
    flex: 0 0 96px; color: var(--muted, #64748b); font-size: 11.5px;
    text-transform: uppercase; letter-spacing: 0.5px; padding-top: 2px;
  }
  .req-diff .v { flex: 1; word-break: break-word; }
  .req-diff .was { color: var(--muted, #64748b); text-decoration: line-through; }
  .req-diff .now { color: var(--maroon, #7b1113); font-weight: 600; }
  .req-diff .no-mod { color: var(--muted, #64748b); font-style: italic; }
  .req-actions { display: flex; gap: 8px; margin-top: 11px; }
  .req-actions button {
    flex: 1; padding: 8px 10px; border-radius: 8px;
    font: 700 12.5px/1 "Inter", sans-serif; cursor: pointer;
    border: 1.5px solid transparent; transition: opacity .15s, background .15s;
  }
  .req-actions button:disabled { opacity: .55; cursor: not-allowed; }
  .btn-approve { background: var(--maroon, #7b1113); color: #fff; }
  .btn-approve:hover:not(:disabled) { background: var(--maroon-dark, #5c0d0f); }
  .btn-reject { background: #fff; color: #b91c1c; border-color: #fecaca !important; }
  .btn-reject:hover:not(:disabled) { background: #fef2f2; }
  .queue-empty {
    font-size: 12.5px; color: var(--muted, #64748b);
    padding: 12px; text-align: center;
    border: 1px dashed #e2e8f0; border-radius: 10px;
  }
  .queue-result {
    font-size: 12.5px; padding: 9px 12px; border-radius: 8px;
    margin-bottom: 12px; line-height: 1.45;
  }
  .queue-result.ok   { background: var(--yellow-soft, #fef9ec); color: #854d0e; border: 1px solid #fde68a; }
  .queue-result.bad  { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }

  /* --- queue filter --- */
  /* Same shape as .dir-search so the two search boxes in the admin
     areas don't look like different features. */
  .queue-filter {
    display: flex; align-items: center; gap: 9px;
    margin-bottom: 14px; flex-wrap: wrap;
  }
  .queue-filter[hidden] { display: none; }
  /* The field wraps the input so the suggestion list can be positioned
     against it rather than against the card, which would put the
     dropdown in the wrong place the moment the row wraps on mobile. */
  .queue-filter-field { position: relative; flex: 1 1 240px; min-width: 0; }
  .queue-filter input {
    width: 100%; box-sizing: border-box; padding: 10px 12px;
    border: 1.5px solid #e2e8f0; border-radius: 9px;
    font: 400 13.5px/1.3 "Inter", sans-serif; background: #fff;
    color: var(--ink, #1e293b);
  }
  .queue-filter input:focus {
    outline: none; border-color: var(--maroon, #7b1113);
    box-shadow: 0 0 0 3px rgba(123, 17, 19, 0.08);
  }
  .queue-filter button {
    padding: 9px 16px; border: none; border-radius: 8px;
    background: var(--maroon, #7b1113); color: #fff;
    font: 700 12.5px/1 "Inter", sans-serif; cursor: pointer;
  }
  .queue-filter button:hover:not(:disabled) { background: var(--maroon-dark, #5c0d0f); }
  .queue-filter button:disabled { opacity: .55; cursor: not-allowed; }
  .queue-filter-note {
    font: 400 12.5px/1.3 "Inter", sans-serif;
    color: var(--muted, #64748b);
  }

  /* --- suggestion dropdown --- */
  .queue-suggest {
    position: absolute; top: calc(100% + 4px); left: 0; right: 0;
    z-index: 40; margin: 0; padding: 4px; list-style: none;
    max-height: 264px; overflow-y: auto;
    background: #fff; border: 1.5px solid #e2e8f0; border-radius: 10px;
    box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12);
  }
  .queue-suggest[hidden] { display: none; }
  .queue-suggest li {
    padding: 8px 10px; border-radius: 7px; cursor: pointer;
    font: 400 13px/1.35 "Inter", sans-serif; color: var(--ink, #1e293b);
  }
  .queue-suggest li:hover,
  .queue-suggest li[aria-selected="true"] { background: var(--yellow-soft, #fef9ec); }
  .queue-suggest li[aria-selected="true"] { box-shadow: inset 0 0 0 1.5px var(--maroon, #7b1113); }
  .queue-suggest .s-name { font-weight: 700; display: block; }
  .queue-suggest .s-meta {
    display: block; margin-top: 1px;
    font-size: 11.5px; color: var(--muted, #64748b);
  }
  /* mark is the browser default yellow otherwise, which fights the
     maroon everywhere else on the page. */
  .queue-suggest mark {
    background: rgba(123, 17, 19, 0.13); color: inherit;
    border-radius: 3px; padding: 0 1px;
  }

  /* --- dashboard admin cards --- */
  /* display:contents lets the three cards sit directly in the
     dashboard's own grid instead of nesting inside a wrapper. */
  #adminSection { display: contents; }
  .admin-card { grid-column: 1 / -1; }
  .admin-card .section-title .queue-count {
    display: none;
    margin-left: auto;
    min-width: 20px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--maroon, #7b1113);
    color: #fff;
    font-size: 11px;
    letter-spacing: 0;
    text-align: center;
  }
  .req-diff .arrow {
    color: var(--muted, #64748b);
    padding: 0 7px;
    font-size: 12px;
  }

  /* --- administrator list --- */
  .admin-list { list-style: none; margin: 0 0 16px; padding: 0; }
  .admin-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 13px;
    border: 1px solid rgba(123, 17, 19, 0.12);
    border-radius: 10px;
    margin-bottom: 8px;
    background: rgba(255,255,255,0.7);
  }
  .admin-row-main { flex: 1; min-width: 0; }
  .admin-email {
    font-size: 13.5px; font-weight: 600; color: var(--ink, #1e293b);
    word-break: break-all;
  }
  .admin-tag {
    display: inline-block;
    margin-left: 7px;
    padding: 2px 7px;
    border-radius: 999px;
    background: #f1f5f9;
    color: var(--muted, #64748b);
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    vertical-align: middle;
  }
  .admin-tag.you { background: var(--yellow-soft, #fef9ec); color: #854d0e; border: 1px solid #fde68a; }
  .admin-note-text {
    font-size: 11.5px; color: var(--muted, #64748b); margin-top: 3px;
    font-family: "JetBrains Mono", monospace;
  }
  .admin-row-locked { color: #cbd5e1; font-size: 13px; padding: 0 10px; }
  .admin-remove {
    flex-shrink: 0;
    padding: 7px 12px;
    border-radius: 8px;
    border: 1.5px solid #fecaca;
    background: #fff;
    color: #b91c1c;
    font: 700 12px/1 "Inter", sans-serif;
    cursor: pointer;
    transition: background .15s;
  }
  .admin-remove:hover:not(:disabled) { background: #fef2f2; }
  .admin-remove:disabled { opacity: .55; cursor: not-allowed; }

  .admin-cancel-invite {
    flex-shrink: 0;
    padding: 7px 12px;
    border-radius: 8px;
    border: 1.5px solid #fecaca;
    background: #fff;
    color: #b91c1c;
    font: 700 12px/1 "Inter", sans-serif;
    cursor: pointer;
    transition: background .15s;
  }
  .admin-cancel-invite:hover:not(:disabled) { background: #fef2f2; }
  .admin-cancel-invite:disabled { opacity: .55; cursor: not-allowed; }

  .admin-request {
    flex-shrink: 0;
    padding: 7px 12px;
    border-radius: 8px;
    border: 1.5px solid #fde68a;
    background: #fff;
    color: #854d0e;
    font: 700 12px/1 "Inter", sans-serif;
    cursor: pointer;
    transition: background .15s;
  }
  .admin-request:hover:not(:disabled) { background: var(--yellow-soft, #fef9ec); }
  .admin-request:disabled { opacity: .55; cursor: not-allowed; }

  .admin-add-form {
    border-top: 1px dashed #e2e8f0;
    padding-top: 15px;
  }
  .admin-add-fields { display: flex; gap: 9px; margin-bottom: 10px; flex-wrap: wrap; }
  .admin-add-fields input {
    flex: 1 1 190px;
    min-width: 0;
    padding: 10px 12px;
    border: 1.5px solid #e2e8f0;
    border-radius: 9px;
    font: 400 13.5px/1.3 "Inter", sans-serif;
    background: #fff;
    color: var(--ink, #1e293b);
  }
  .admin-add-fields input:focus {
    outline: none;
    border-color: var(--maroon, #7b1113);
    box-shadow: 0 0 0 3px rgba(123, 17, 19, 0.08);
  }
  .admin-add-form .btn-approve {
    padding: 9px 16px;
    border: none;
    border-radius: 8px;
    background: var(--maroon, #7b1113);
    color: #fff;
    font: 700 12.5px/1 "Inter", sans-serif;
    cursor: pointer;
  }
  .admin-add-form .btn-approve:hover:not(:disabled) { background: var(--maroon-dark, #5c0d0f); }
  .admin-add-form .btn-approve:disabled { opacity: .55; cursor: not-allowed; }
  .admin-hint {
    font-size: 11.5px; line-height: 1.5; color: var(--muted, #64748b);
    margin: 13px 0 0;
  }

  /* ---- user directory + action log ---- */
  .dir-search { display: flex; gap: 9px; margin-bottom: 14px; flex-wrap: wrap; }
  .dir-search input {
    flex: 1 1 220px; min-width: 0; padding: 10px 12px;
    border: 1.5px solid #e2e8f0; border-radius: 9px;
    font: 400 13.5px/1.3 "Inter", sans-serif; background: #fff;
    color: var(--ink, #1e293b);
  }
  .dir-search input:focus {
    outline: none; border-color: var(--maroon, #7b1113);
    box-shadow: 0 0 0 3px rgba(123, 17, 19, 0.08);
  }
  .dir-search button {
    padding: 9px 16px; border: none; border-radius: 8px;
    background: var(--maroon, #7b1113); color: #fff;
    font: 700 12.5px/1 "Inter", sans-serif; cursor: pointer;
  }
  .dir-search button:hover:not(:disabled) { background: var(--maroon-dark, #5c0d0f); }
  .dir-search button:disabled { opacity: .55; cursor: not-allowed; }

  .dir-row {
    border: 1px solid #e2e8f0; border-radius: 11px;
    padding: 12px 14px; margin-bottom: 9px; background: #fff;
  }
  .dir-row .dir-who { font: 700 13.5px/1.35 "Inter", sans-serif; color: var(--ink, #1e293b); }
  .dir-row .dir-meta {
    font: 500 11.5px/1.5 "JetBrains Mono", monospace;
    color: var(--muted, #64748b); margin-top: 3px; word-break: break-all;
  }
  .dir-row .dir-accts {
    font: 600 12.5px/1.5 "JetBrains Mono", monospace;
    color: var(--maroon, #7b1113); margin-top: 5px;
  }
  .dir-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .dir-actions button {
    padding: 7px 13px; border-radius: 8px; border: 1px solid #e2e8f0;
    background: #fff; font: 700 12px/1 "Inter", sans-serif; cursor: pointer;
    color: var(--ink, #1e293b);
  }
  .dir-actions .dir-edit:hover:not(:disabled) {
    border-color: var(--maroon, #7b1113); color: var(--maroon, #7b1113);
  }
  .dir-actions .dir-delete { color: #b91c1c; border-color: #fecaca; }
  .dir-actions .dir-delete:hover:not(:disabled) { background: #fef2f2; }
  .dir-actions button:disabled { opacity: .55; cursor: not-allowed; }
  .dir-actions .dir-locked {
    font: 600 12px/1.6 "Inter", sans-serif; color: var(--muted, #64748b);
  }
  .dir-actions .dir-disable { color: #854d0e; border-color: #fde68a; }
  .dir-actions .dir-disable:hover:not(:disabled) { background: var(--yellow-soft, #fef9ec); }
  .dir-row.is-disabled .dir-who { opacity: .72; }
  .admin-tag.off { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }

  .removal-queue { margin: 0 0 14px; padding: 0; list-style: none; }
  .removal-queue li {
    border: 1px solid #fde68a; background: var(--yellow-soft, #fef9ec);
    border-radius: 10px; padding: 11px 13px; margin-bottom: 8px;
  }
  .removal-queue .rq-who {
    font: 700 13px/1.4 "Inter", sans-serif; color: var(--ink, #1e293b);
  }
  .removal-queue .rq-meta {
    font: 500 11.5px/1.5 "JetBrains Mono", monospace;
    color: #854d0e; margin-top: 3px; word-break: break-all;
  }
  .removal-queue .rq-actions { display: flex; gap: 8px; margin-top: 9px; flex-wrap: wrap; }
  .removal-queue .rq-actions button {
    padding: 6px 12px; border-radius: 8px; border: 1px solid #e2e8f0;
    background: #fff; font: 700 12px/1 "Inter", sans-serif; cursor: pointer;
  }
  .removal-queue .rq-yes { color: #166534; border-color: #bbf7d0; }
  .removal-queue .rq-no { color: #b91c1c; border-color: #fecaca; }
  .removal-queue button:disabled { opacity: .55; cursor: not-allowed; }

  .dir-edit-form { margin-top: 11px; padding-top: 11px; border-top: 1px dashed #e2e8f0; }
  .dir-edit-form label {
    display: block; font: 700 11px/1 "Inter", sans-serif;
    text-transform: uppercase; letter-spacing: .7px;
    color: var(--muted, #64748b); margin: 0 0 5px;
  }
  .dir-edit-form input {
    width: 100%; padding: 9px 11px; margin-bottom: 9px;
    border: 1.5px solid #e2e8f0; border-radius: 9px;
    font: 400 13px/1.3 "Inter", sans-serif; background: #fff;
    color: var(--ink, #1e293b);
  }
  .dir-edit-form input:focus {
    outline: none; border-color: var(--maroon, #7b1113);
    box-shadow: 0 0 0 3px rgba(123, 17, 19, 0.08);
  }

  .log-row {
    display: grid; grid-template-columns: auto 1fr; gap: 3px 12px;
    border-left: 3px solid var(--yellow, #f5b041);
    background: #f8fafc; border-radius: 0 9px 9px 0;
    padding: 9px 12px; margin-bottom: 7px;
  }
  .log-when {
    grid-column: 1 / -1;
    font: 500 11px/1.4 "JetBrains Mono", monospace;
    color: var(--muted, #64748b);
  }
  .log-what { grid-column: 1 / -1; font: 400 12.5px/1.5 "Inter", sans-serif; color: var(--ink, #1e293b); }
  .log-what strong { font-weight: 700; }
  .log-what .log-act { color: var(--maroon, #7b1113); font-weight: 700; }
  .log-detail {
    grid-column: 1 / -1;
    font: 500 11.5px/1.5 "JetBrains Mono", monospace;
    color: var(--muted, #64748b); margin-top: 2px; word-break: break-word;
  }
  `;
  const style = document.createElement("style");
  style.id = "approvalStyles";
  style.textContent = css;
  document.head.appendChild(style);
}
// ---------- user directory ----------
//
// Search, update, and the actions log go through deploy-schema.sql
// and re-check is_admin()/is_main_admin() server-side. Deletion goes
// through the admin-delete-user Edge Function instead (see
// adminDeleteUser below) — the panels here only decide what to draw,
// never who's allowed.

async function adminSearchUsers(query) {
  const { data, error } = await supabaseClient.rpc("admin_search_users", {
    p_query: query || "",
  });
  if (error) throw error;
  return data || [];
}

async function adminUpdateUser(email, fullName, accountNumber) {
  const { data, error } = await supabaseClient.rpc("admin_update_user", {
    p_email: email,
    p_full_name: fullName,
    p_account_number: accountNumber || null,
  });
  if (error) throw error;
  return data;
}

// Goes through the admin-delete-user Edge Function rather than a
// direct RPC — deleting the Auth login needs the service-role key
// and the Auth Admin API, neither of which belongs in the browser.
// See deploy-schema.sql's admin_delete_user_data() and index.ts.
async function adminDeleteUser(email) {
  const { data, error } = await supabaseClient.functions.invoke("admin-delete-user", {
    body: { email },
  });
  if (error) throw error;
  if (data && data.error) throw new Error(data.error);
  return data;
}

async function checkIsMainAdmin() {
  try {
    const { data, error } = await supabaseClient.rpc("is_main_admin");
    if (error) throw error;
    return data === true;
  } catch (err) {
    // Missing function means deploy-schema.sql hasn't been run.
    console.warn("Couldn't check main-administrator rank:", err);
    return false;
  }
}

// Every logged action for one person, whichever end of it they were
// on: what was done to them, and what they did to others. Main
// administrators only, enforced in admin_user_actions().
async function adminUserActions(email) {
  const { data, error } = await supabaseClient.rpc("admin_user_actions", {
    p_email: email,
  });
  if (error) throw error;
  return data || [];
}

// ---------- administrator list ----------

async function listAdmins() {
  const { data, error } = await supabaseClient.rpc("admin_list");
  if (error) throw error;
  return data || [];
}

async function addAdmin(email, note) {
  const { data, error } = await supabaseClient.rpc("admin_add", {
    p_email: email,
    p_note: note || null,
  });
  if (error) throw error;
  return data;
}

async function removeAdmin(email) {
  const { data, error } = await supabaseClient.rpc("admin_remove", { p_email: email });
  if (error) throw error;
  return data;
}

// Cancels a pending invitation (admin_add() before the person has
// registered). Separate from removeAdmin(): an invite lives in
// admin_invites, not admins, and admin_remove()'s DELETE against
// admins matches nothing for it.
async function cancelAdminInvite(email) {
  const { data, error } = await supabaseClient.rpc("admin_invite_cancel", { p_email: email });
  if (error) throw error;
  return data;
}

// ---------- disable / enable an account ----------
//
// The assigned administrator's alternative to deleting: reversible,
// and it keeps the ledger history that deletion would take with it.
// admin_set_account_disabled() decides who may do it to whom — an
// assigned administrator gets ordinary users only, and nobody at all
// gets a main administrator.

async function setAccountDisabled(email, disabled, reason) {
  const { data, error } = await supabaseClient.rpc("admin_set_account_disabled", {
    p_email: email,
    p_disabled: !!disabled,
    p_reason: reason || null,
  });
  if (error) throw error;
  return data;
}

// ---------- removing administrator access ----------
//
// A main administrator removes access outright (removeAdmin above).
// An assigned administrator can only ask, and a main administrator
// decides. Nothing changes until that decision lands.

async function requestAdminRemoval(email, reason) {
  const { data, error } = await supabaseClient.rpc("admin_request_admin_removal", {
    p_email: email,
    p_reason: reason || null,
  });
  if (error) throw error;
  return data;
}

async function fetchAdminRemovalQueue() {
  const { data, error } = await supabaseClient.rpc("admin_removal_queue");
  if (error) throw error;
  return data || [];
}

async function decideAdminRemoval(requestId, approve, note) {
  const { data, error } = await supabaseClient.rpc("admin_decide_removal", {
    p_request_id: requestId,
    p_approve: !!approve,
    p_note: note || null,
  });
  if (error) throw error;
  return data;
}


// ============================================================
// DASHBOARD PANEL 1 & 2 — the two approval queues.
//
// Both are painted from a single admin_pending_queue() call, so
// opening the dashboard costs one round trip rather than two, and
// the counts on the two cards can never disagree with each other.
//
//   mountAdminQueues({ registrationsEl, changesEl, onApplied })
//
// onApplied() fires after any decision lands, so the host page can
// refresh anything it shows (its own header name, for instance).
// Returns { refresh } for repainting on demand.
// ============================================================
async function mountAdminQueues(opts) {
  injectApprovalStyles();

  const { registrationsEl, changesEl, onApplied, filterEl } = opts;

  // Optional. Pages that don't pass one simply get an unfiltered
  // queue, which is what users.html and anything else mounting these
  // panels does today.
  const filterInput = filterEl ? filterEl.querySelector('[data-role="query"]') : null;
  const filterClear = filterEl ? filterEl.querySelector('[data-act="clear"]') : null;
  const filterNote  = filterEl ? filterEl.querySelector('[data-role="note"]') : null;
  const suggestEl   = filterEl ? filterEl.querySelector('[data-role="suggest"]') : null;

  // Temporary, and safe to delete once the filter is confirmed working.
  // It exists because "the filter doesn't appear" has three completely
  // different causes that look identical from the outside: the markup
  // is missing (old dashboard.html), the option was never passed (old
  // page-dashboard.js), or the wiring ran fine and the queue is simply
  // empty. This says which, in one line, without anyone having to
  // reason about it.
  console.info(
    "[approval.js] registration filter —",
    filterEl ? "container found" : "NO container (old dashboard.html, or filterEl not passed)",
    "| input:", !!filterInput,
    "| suggestions:", !!suggestEl
  );

  if (registrationsEl) registrationsEl.innerHTML = '<div class="queue-empty">Loading…</div>';
  if (changesEl) changesEl.innerHTML = '<div class="queue-empty">Loading…</div>';

  function say(el, message, ok) {
    if (!el) return;
    const note = document.createElement("div");
    note.className = `queue-result ${ok ? "ok" : "bad"}`;
    note.textContent = message;
    el.prepend(note);
    setTimeout(() => note.remove(), 9000);
  }

  function setCount(el, n) {
    const badge = el && el.closest(".card") &&
      el.closest(".card").querySelector(".queue-count");
    if (!badge) return;
    badge.textContent = n;
    badge.style.display = n > 0 ? "inline-block" : "none";
  }

  // The queue as last loaded, unfiltered. The filter narrows this
  // rather than refetching: admin_pending_queue() already returns
  // everything pending in one call, so there is nothing further to ask
  // for and a round trip per keystroke would buy nothing.
  let allRegs = [];

  // Digits-only comparison for account numbers, so a query matches
  // however either side is punctuated: "3072100742", "3072-1007-42"
  // and a half-typed "3072-1007" all find the same row. The same trick
  // admin_action_log() uses in SQL, for the same reason.
  function registrationMatches(r, query) {
    if (!query) return true;

    const text = [r.full_name, r.email].filter(Boolean).join(" ").toLowerCase();
    if (text.includes(query)) return true;

    const queryDigits = query.replace(/\D/g, "");
    if (!queryDigits) return false;

    const acctDigits = String(r.account_number == null ? "" : r.account_number).replace(/\D/g, "");
    return acctDigits.includes(queryDigits);
  }

  function registrationCard(r) {
    return `
      <div class="req-card" data-kind="registration" data-email="${escapeHtml(r.email)}">
        <div class="req-who">${escapeHtml(r.full_name || "(no name given)")}</div>
        <div class="req-meta">${escapeHtml(r.email)} · applied ${escapeHtml(formatApprovalStamp(r.submitted_at))}</div>
        <div class="req-diff">
          <div><span class="k">Account no.</span><span class="v">${escapeHtml(r.account_number || "— not provided —")}</span></div>
        </div>
        <div class="req-actions">
          <button type="button" class="btn-approve" data-act="approve">Approve access</button>
          <button type="button" class="btn-reject" data-act="reject">Reject</button>
        </div>
      </div>`;
  }

  // ---- suggestions ----
  //
  // Drawn from allRegs, the same array the filter narrows, so the
  // dropdown can only ever offer people who are actually waiting. A
  // suggestion list built from anywhere wider would let an
  // administrator pick a name and land on an empty queue.

  const SUGGEST_LIMIT = 8;
  let suggestions = [];
  let activeSuggestion = -1;

  // Escapes first, then wraps the match, so the <mark> is the only
  // markup that survives. Slicing the raw string and escaping each
  // piece separately is what keeps that true — building the string
  // first and escaping after would escape the <mark> too, and
  // escaping first then searching would miss matches inside anything
  // that got entity-encoded.
  function highlight(text, query) {
    const s = String(text == null ? "" : text);
    if (!query) return escapeHtml(s);
    const at = s.toLowerCase().indexOf(query);
    if (at === -1) return escapeHtml(s);
    return escapeHtml(s.slice(0, at)) +
           "<mark>" + escapeHtml(s.slice(at, at + query.length)) + "</mark>" +
           escapeHtml(s.slice(at + query.length));
  }

  // What typing a suggestion puts in the box. full_name is unique in
  // the database (enforce_profile_uniqueness) and so is email, so
  // either narrows to exactly one card.
  function suggestionValue(r) {
    return r.full_name || r.email || "";
  }

  function closeSuggestions() {
    suggestions = [];
    activeSuggestion = -1;
    if (!suggestEl) return;
    suggestEl.hidden = true;
    suggestEl.innerHTML = "";
    if (filterInput) filterInput.setAttribute("aria-expanded", "false");
  }

  function paintSuggestions() {
    if (!suggestEl) return;

    suggestEl.innerHTML = suggestions.map((r, i) => {
      const query = (filterInput.value || "").trim().toLowerCase();
      const meta = [r.email, r.account_number || "no account number"]
        .filter(Boolean).join(" · ");
      return `
        <li role="option" id="regSuggest-${i}" data-i="${i}"
            aria-selected="${i === activeSuggestion}">
          <span class="s-name">${highlight(r.full_name || "(no name given)", query)}</span>
          <span class="s-meta">${highlight(meta, query)}</span>
        </li>`;
    }).join("");

    suggestEl.hidden = suggestions.length === 0;
    filterInput.setAttribute("aria-expanded", String(suggestions.length > 0));
    filterInput.setAttribute(
      "aria-activedescendant",
      activeSuggestion >= 0 ? `regSuggest-${activeSuggestion}` : ""
    );

    suggestEl.querySelectorAll("li").forEach((li) => {
      // mousedown, not click: the input loses focus before a click
      // completes, and the blur handler closes the list out from
      // under the pointer.
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        chooseSuggestion(Number(li.getAttribute("data-i")));
      });
    });
  }

  function openSuggestions() {
    if (!suggestEl || !filterInput) return;

    const query = filterInput.value.trim().toLowerCase();
    // Nothing typed means nothing to suggest. Listing the whole queue
    // on focus would just cover the queue with a copy of itself.
    if (!query) return closeSuggestions();

    const matches = allRegs.filter(r => registrationMatches(r, query));

    // One exact hit is not a suggestion, it is the answer — the list
    // would be a box saying "did you mean the thing you are looking
    // straight at".
    if (matches.length === 1 &&
        suggestionValue(matches[0]).toLowerCase() === query) {
      return closeSuggestions();
    }

    suggestions = matches.slice(0, SUGGEST_LIMIT);
    activeSuggestion = -1;
    paintSuggestions();
  }

  function moveSuggestion(step) {
    if (!suggestions.length) return;
    activeSuggestion = (activeSuggestion + step + suggestions.length) % suggestions.length;
    paintSuggestions();
    const active = suggestEl.querySelector('[aria-selected="true"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }

  function chooseSuggestion(i) {
    const picked = suggestions[i];
    if (!picked) return;
    filterInput.value = suggestionValue(picked);
    closeSuggestions();
    paintRegistrations();
    filterInput.focus();
  }

  // Repaints the registrations list against the current filter text.
  // Called on every keystroke and after every reload.
  function paintRegistrations() {
    if (!registrationsEl) return;

    const query = (filterInput ? filterInput.value : "").trim().toLowerCase();
    const shown = query ? allRegs.filter(r => registrationMatches(r, query)) : allRegs;

    registrationsEl.innerHTML = shown.length
      ? shown.map(registrationCard).join("")
      : `<div class="queue-empty">${
           allRegs.length === 0
             ? "No one is waiting for access."
             : "No registrations match that."
         }</div>`;

    // The badge keeps counting everything pending, not what survived
    // the filter. It answers "how much is waiting", and a filter is not
    // supposed to make work disappear from that answer -- a queue that
    // reads 0 because of a stale search box is how something waits a
    // week. The note beside the box carries the filtered number.
    setCount(registrationsEl, allRegs.length);

    if (filterEl) {
      if (filterNote) {
        filterNote.textContent = query
          ? `Showing ${shown.length} of ${allRegs.length}`
          : "";
      }
      if (filterClear) filterClear.disabled = !query;
    }

    wire(registrationsEl);
  }

  async function render() {
    let queue;
    try {
      queue = await loadAdminQueue();
    } catch (err) {
      console.error("Couldn't load the approval queue:", err);
      const msg = '<div class="queue-empty">Couldn\'t load this queue. Refresh to try again.</div>';
      if (registrationsEl) registrationsEl.innerHTML = msg;
      if (changesEl) changesEl.innerHTML = msg;
      return;
    }

    const regs = queue.registrations;
    const changes = queue.profileChanges;

    if (registrationsEl) {
      allRegs = regs;
      // Deliberately keeps whatever is in the filter box. An approval
      // reloads the queue, and having the box clear itself underneath
      // an administrator part-way through a batch would drop them back
      // into the full list between every decision.
      //
      // The dropdown does close, though: the row it was offering may
      // have just been approved out of existence, and a stale list of
      // people who are no longer waiting is worse than no list.
      closeSuggestions();
      paintRegistrations();
    }

    if (changesEl) {
      changesEl.innerHTML = changes.length
        ? changes.map(c => `
            <div class="req-card" data-kind="change" data-id="${escapeHtml(c.id)}">
              <div class="req-who">${escapeHtml(c.user_email)}</div>
              <div class="req-meta">Requested ${escapeHtml(formatApprovalStamp(c.requested_at))}</div>
              <div class="req-diff">
                ${renderApprovalDiffRow("Full name", c.current_full_name, c.requested_full_name)}
                ${renderApprovalDiffRow("Account no.", c.current_account_number, c.requested_account_number)}
              </div>
              <div class="req-actions">
                <button type="button" class="btn-approve" data-act="approve">Apply change</button>
                <button type="button" class="btn-reject" data-act="reject">Reject</button>
              </div>
            </div>`).join("")
        : '<div class="queue-empty">No account changes waiting.</div>';
      setCount(changesEl, changes.length);
      wire(changesEl);
    }
  }

  function wire(host) {
    host.querySelectorAll(".req-card").forEach(card => {
      const kind = card.getAttribute("data-kind");
      const buttons = card.querySelectorAll("button");

      buttons.forEach(btn => {
        btn.addEventListener("click", async () => {
          const act = btn.getAttribute("data-act");
          let reason = null;

          if (act === "reject") {
            reason = prompt(
              kind === "registration"
                ? "Why is this registration being rejected? The person will see this."
                : "Why is this change being rejected? The person will see this."
            );
            if (reason === null) return; // cancelled
          }

          buttons.forEach(b => (b.disabled = true));

          try {
            let result;
            if (kind === "registration") {
              const email = card.getAttribute("data-email");
              result = act === "approve"
                ? await approveRegistration(email)
                : await rejectRegistration(email, reason);

              const sent = await notifyDecision("registration", {
                email: result.email,
                full_name: result.full_name,
                decision: result.decision,
                reason: result.reason || reason || null,
              });
              say(host,
                (act === "approve"
                  ? `${result.email} can now sign in.`
                  : `${result.email} was rejected.`) +
                (sent ? " They've been emailed." : " Email notice didn't send — tell them another way."),
                true);
            } else {
              const id = card.getAttribute("data-id");
              result = act === "approve"
                ? await approveProfileChange(id)
                : await rejectProfileChange(id, reason);

              const sent = await notifyDecision("profile_change", {
                email: result.email,
                full_name: result.full_name || null,
                account_number: result.account_number || null,
                decision: result.decision,
                reason: result.reason || reason || null,
              });
              say(host,
                (act === "approve"
                  ? `Change applied for ${result.email}.`
                  : `Change rejected for ${result.email}.`) +
                (sent ? " They've been emailed." : " Email notice didn't send."),
                true);
            }

            if (typeof onApplied === "function") onApplied();
            await render();
          } catch (err) {
            console.error("Approval action failed:", err);
            say(host, err.message || "That didn't go through. Try again.", false);
            buttons.forEach(b => (b.disabled = false));
          }
        });
      });
    });
  }

  // Live filtering, not a search button. The rows are already in
  // memory, so there is nothing to wait for and nothing to submit —
  // making someone press Enter to narrow a list they can already see
  // would be latency invented on purpose. The suggestion list rides
  // alongside it: typing always filters, and picking a suggestion is
  // a shortcut to the exact row rather than a required step.
  if (filterInput) {
    filterInput.addEventListener("input", () => {
      paintRegistrations();
      openSuggestions();
    });

    filterInput.addEventListener("keydown", (e) => {
      const open = suggestions.length > 0;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (open) moveSuggestion(1);
        else openSuggestions();
        return;
      }
      if (e.key === "ArrowUp" && open) {
        e.preventDefault();
        moveSuggestion(-1);
        return;
      }
      if (e.key === "Enter") {
        // Only swallow Enter when a suggestion is actually highlighted.
        // Otherwise it should do what it always did — nothing — rather
        // than silently eating a keystroke.
        if (open && activeSuggestion >= 0) {
          e.preventDefault();
          chooseSuggestion(activeSuggestion);
        } else {
          closeSuggestions();
        }
        return;
      }
      if (e.key === "Escape") {
        // First Escape dismisses the dropdown, second clears the box.
        // Collapsing both into one step means an administrator who
        // just wanted the list out of the way loses their filter too.
        if (open) { closeSuggestions(); return; }
        if (filterInput.value) {
          filterInput.value = "";
          paintRegistrations();
        }
        return;
      }
      if (e.key === "Tab") closeSuggestions();
    });

    filterInput.addEventListener("focus", openSuggestions);
    filterInput.addEventListener("blur", closeSuggestions);
  }

  if (filterClear) {
    filterClear.addEventListener("click", () => {
      filterInput.value = "";
      closeSuggestions();
      paintRegistrations();
      filterInput.focus();
    });
  }

  await render();
  return { refresh: render };
}


// ============================================================
// DASHBOARD PANEL 3 — administrators.
//
// Adding someone here is all it takes: the signup trigger reads this
// same table, so an admin added before they've registered is approved
// automatically when they do.
// ============================================================
async function mountAdminManager(container, onChanged) {
  injectApprovalStyles();
  container.innerHTML = '<div class="queue-empty">Loading…</div>';

  // Main administrators add and remove access outright, and decide the
  // requests below. Assigned administrators can only ask — and never
  // about a main administrator. admin_add(), admin_remove() and
  // admin_decide_removal() all re-check this in the database.
  const isMainAdmin = await checkIsMainAdmin();

  function say(message, ok) {
    const note = document.createElement("div");
    note.className = `queue-result ${ok ? "ok" : "bad"}`;
    note.textContent = message;
    container.prepend(note);
    setTimeout(() => note.remove(), 9000);
  }

  // ---------- pending removal requests (main administrators only) ----------

  function queueHtml(requests) {
    if (!requests.length) return "";
    const rows = requests.map(r => {
      const who = r.target_name
        ? `${escapeHtml(r.target_name)}`
        : escapeHtml(r.target_email);
      return `
      <li data-id="${escapeHtml(r.id)}">
        <div class="rq-who">Remove administrator access for ${who}</div>
        <div class="rq-meta">
          ${escapeHtml(r.target_email)} ·
          asked by ${escapeHtml(r.requested_by)}${r.reason ? ` · ${escapeHtml(r.reason)}` : ""}
        </div>
        <div class="rq-actions">
          <button type="button" class="rq-yes" data-act="approve">Approve</button>
          <button type="button" class="rq-no" data-act="decline">Decline</button>
        </div>
      </li>`;
    }).join("");
    return `<ul class="removal-queue">${rows}</ul>`;
  }

  // ---------- one row per administrator ----------

  function adminRowHtml(a) {
    // Nobody removes their own access, and a main administrator's rank
    // can't be taken away from inside the application at all.
    // An invite lives in admin_invites, not admins — admin_remove()'s
    // DELETE against admins matches nothing for one, which is why this
    // has to be told apart before any of the rank checks below run.
    let control;
    if (a.is_invite) {
      control = isMainAdmin
        ? `<button type="button" class="admin-cancel-invite" data-email="${escapeHtml(a.email)}">Cancel invite</button>`
        : '<span class="admin-row-locked" title="Only a main administrator can cancel an invitation">—</span>';
    } else if (a.is_you) {
      control = '<span class="admin-row-locked" title="Ask another administrator to remove your access">—</span>';
    } else if (a.is_main) {
      control = '<span class="admin-row-locked" title="A main administrator\'s access can\'t be removed here">—</span>';
    } else if (isMainAdmin) {
      control = `<button type="button" class="admin-remove" data-email="${escapeHtml(a.email)}">Remove</button>`;
    } else if (a.has_pending_removal) {
      control = '<span class="admin-tag">removal requested</span>';
    } else {
      control = `<button type="button" class="admin-request" data-email="${escapeHtml(a.email)}">Request removal</button>`;
    }

    return `
      <li class="admin-row">
        <div class="admin-row-main">
          <span class="admin-email">${escapeHtml(a.email)}</span>
          ${a.is_main ? '<span class="admin-tag you">main</span>' : ""}
          ${a.is_you ? '<span class="admin-tag you">you</span>' : ""}
          ${a.is_invite
            ? `<span class="admin-tag">invited${a.expires_at ? ` · expires ${escapeHtml(formatApprovalStamp(a.expires_at))}` : ""}</span>`
            : (a.has_account ? "" : '<span class="admin-tag">not registered yet</span>')}
          ${a.has_pending_removal && isMainAdmin ? '<span class="admin-tag">removal requested</span>' : ""}
          ${a.note ? `<div class="admin-note-text">${escapeHtml(a.note)}</div>` : ""}
        </div>
        ${control}
      </li>`;
  }

  async function render() {
    let admins;
    try {
      admins = await listAdmins();
    } catch (err) {
      console.error("Couldn't load the administrator list:", err);
      container.innerHTML =
        '<div class="queue-empty">Couldn\'t load the administrator list. Refresh to try again.</div>';
      return;
    }

    // A failure here shouldn't take the list down with it — the queue
    // is an extra, and only main administrators have one.
    let requests = [];
    if (isMainAdmin) {
      try {
        requests = await fetchAdminRemovalQueue();
      } catch (err) {
        console.warn("Couldn't load pending removal requests:", err);
      }
    }

    container.innerHTML = `
      ${queueHtml(requests)}
      <ul class="admin-list">${admins.map(adminRowHtml).join("")}</ul>
      ${isMainAdmin ? `
      <form class="admin-add-form" id="adminAddForm">
        <div class="admin-add-fields">
          <input type="email" id="newAdminEmail" placeholder="name@up.edu.ph" autocomplete="off" required>
          <input type="text" id="newAdminNote" placeholder="Note (optional)" maxlength="120" autocomplete="off">
        </div>
        <button type="submit" class="btn-approve" id="addAdminBtn">Add administrator</button>
      </form>` : ""}
      <p class="admin-hint">
        ${isMainAdmin
          ? `Administrators approve registrations and account changes, and manage
             news and calendar entries. Someone can be added before they've
             registered — their account is approved automatically when they do.`
          : `Only a main administrator can add or remove access. You can ask for
             another administrator's access to be removed; it stays in place
             until a main administrator approves the request.`}
      </p>`;

    // ---------- add (main administrators only) ----------

    const form = document.getElementById("adminAddForm");
    if (form) {
      const emailInput = document.getElementById("newAdminEmail");
      const noteInput = document.getElementById("newAdminNote");
      const addBtn = document.getElementById("addAdminBtn");

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = emailInput.value.trim();
        if (!email) return;
        addBtn.disabled = true;
        try {
          const result = await addAdmin(email, noteInput.value.trim());
          say(
            result.has_account
              ? `${result.email} is now an administrator.`
              : `${result.email} is now an administrator. They'll get access as soon as they register.`,
            true
          );
          if (typeof onChanged === "function") onChanged();
          await render();
        } catch (err) {
          console.error("Couldn't add the administrator:", err);
          say(err.message || "Couldn't add that administrator.", false);
          addBtn.disabled = false;
        }
      });
    }

    // ---------- remove outright (main administrators only) ----------

    container.querySelectorAll(".admin-remove").forEach(btn => {
      btn.addEventListener("click", async () => {
        const email = btn.getAttribute("data-email");
        if (!confirm(`Remove administrator access for ${email}?\n\nTheir account stays active — they just lose the approval panels.`)) return;
        btn.disabled = true;
        try {
          await removeAdmin(email);
          say(`${email} is no longer an administrator.`, true);
          if (typeof onChanged === "function") onChanged();
          await render();
        } catch (err) {
          console.error("Couldn't remove the administrator:", err);
          say(err.message || "Couldn't remove that administrator.", false);
          btn.disabled = false;
        }
      });
    });

    // ---------- cancel a pending invitation (main administrators only) ----------

    container.querySelectorAll(".admin-cancel-invite").forEach(btn => {
      btn.addEventListener("click", async () => {
        const email = btn.getAttribute("data-email");
        if (!confirm(`Cancel the pending invitation for ${email}?`)) return;
        btn.disabled = true;
        try {
          await cancelAdminInvite(email);
          say(`Invitation to ${email} was cancelled.`, true);
          if (typeof onChanged === "function") onChanged();
          await render();
        } catch (err) {
          console.error("Couldn't cancel the invitation:", err);
          say(err.message || "Couldn't cancel that invitation.", false);
          btn.disabled = false;
        }
      });
    });

    // ---------- ask for it (assigned administrators) ----------

    container.querySelectorAll(".admin-request").forEach(btn => {
      btn.addEventListener("click", async () => {
        const email = btn.getAttribute("data-email");
        // Cancel returns null; an empty string is a deliberate "no
        // reason given" and is allowed through.
        const reason = prompt(
          `Ask a main administrator to remove ${email}'s access?\n\n` +
          `Nothing changes until they approve it.\n\nReason (optional):`,
          ""
        );
        if (reason === null) return;
        btn.disabled = true;
        try {
          await requestAdminRemoval(email, reason);
          say("Request sent. A main administrator will decide.", true);
          await render();
        } catch (err) {
          console.error("Couldn't send the request:", err);
          say(err.message || "Couldn't send that request.", false);
          btn.disabled = false;
        }
      });
    });

    // ---------- decide a request (main administrators only) ----------

    container.querySelectorAll(".removal-queue li").forEach(li => {
      const id = li.getAttribute("data-id");
      const buttons = li.querySelectorAll("button");

      async function decide(approve) {
        let note = null;
        if (!approve) {
          note = prompt("Decline this request.\n\nNote (optional):", "");
          if (note === null) return;
        }
        buttons.forEach(b => (b.disabled = true));
        try {
          const result = await decideAdminRemoval(id, approve, note);
          say(
            approve
              ? `${result.email} is no longer an administrator.`
              : "Request declined. Their access is unchanged.",
            true
          );
          if (typeof onChanged === "function") onChanged();
          await render();
        } catch (err) {
          console.error("Couldn't decide that request:", err);
          say(err.message || "Couldn't record that decision.", false);
          buttons.forEach(b => (b.disabled = false));
        }
      }

      const yes = li.querySelector('[data-act="approve"]');
      const no = li.querySelector('[data-act="decline"]');
      if (yes) yes.addEventListener("click", () => decide(true));
      if (no) no.addEventListener("click", () => decide(false));
    });
  }

  await render();
  return { refresh: render };
}


// ============================================================
// FIND A USER — the admin search panel (users.html).
//
// One box: part of a name, part of an account number (dashes
// optional), or part of an email. Editing here applies at once
// rather than filing a request — the person who'd approve it is the
// one doing it. Deleting removes the profile, the account numbers,
// any change requests, and the login.
//
// View Actions opens that one person's history in the row itself.
// It replaced a separate log panel: the question is nearly always
// "what about this person", and a search box that only searched a
// log meant knowing the answer before you could ask.
//
// Everything it can do is re-checked in the database. This panel
// decides what to draw, never who's allowed.
// ============================================================
async function mountUserDirectory(container, onChanged) {
  injectApprovalStyles();

  const NO_CHANGES = "No changes applied.";

  // What this panel draws depends on the viewer's rank. Every one of
  // these rules is also enforced in the database — see
  // deploy-schema.sql — so removing a button from the console
  // gets nobody anywhere. Drawing them correctly is a courtesy, not
  // the control.
  const isMainAdmin = await checkIsMainAdmin();

  // Read from the acting end, because that's how each line is worded
  // below: "approved the registration of X" / "X's registration was
  // approved by Y".
  const ACTION_WORDS = {
    registration_approved: ["approved the registration of", "registration approved by"],
    registration_rejected: ["rejected the registration of", "registration rejected by"],
    change_approved: ["applied an account change for", "account change applied by"],
    change_rejected: ["rejected an account change for", "account change rejected by"],
    user_edited: ["edited the account of", "account edited by"],
    user_deleted: ["deleted the account of", "account deleted by"],
    admin_added: ["made an administrator:", "made an administrator by"],
    admin_removed: ["removed administrator access from", "administrator access removed by"],
    admin_promoted: ["made a main administrator:", "made a main administrator by"],
    admin_demoted: ["removed main-administrator rank from", "main-administrator rank removed by"],
  };

  container.innerHTML = `
    <form class="dir-search" id="dirSearchForm">
      <input type="text" id="dirQuery" autocomplete="off"
             placeholder="Name, account number, or email">
      <button type="submit" id="dirSearchBtn">Search</button>
    </form>
    <div id="dirResults"><div class="queue-empty">Loading…</div></div>`;

  const form = container.querySelector("#dirSearchForm");
  const input = container.querySelector("#dirQuery");
  const searchBtn = container.querySelector("#dirSearchBtn");
  const results = container.querySelector("#dirResults");

  function say(message, ok) {
    const note = document.createElement("div");
    note.className = `queue-result ${ok ? "ok" : "bad"}`;
    note.textContent = message;
    results.prepend(note);
    setTimeout(() => note.remove(), 9000);
  }

  function rowHtml(u) {
    const name = u.full_name || "(no name on file)";
    const tags = [
      u.is_main ? "main admin" : (u.is_admin ? "admin" : ""),
      u.approval_status !== "approved" ? u.approval_status : "",
      u.has_pending_change ? "change pending" : "",
    ].filter(Boolean).map(t => `<span class="admin-tag">${escapeHtml(t)}</span>`).join("");

    const offTag = u.disabled ? '<span class="admin-tag off">disabled</span>' : "";

    // Who gets which control:
    //
    //                        main admin        assigned admin
    //   Edit / View Actions  anyone            anyone but a main admin
    //   Disable / Enable     anyone but a      ordinary users only
    //                        main admin
    //   Delete               anyone but a      nobody — they disable
    //                        main admin        instead
    //
    // A main administrator's row is untouchable by an assigned
    // administrator, and can never be disabled or deleted by anyone:
    // disabling switches off is_admin(), so it would be a way to lock
    // the top rank out of its own system.
    const targetIsMain = !!u.is_main;
    const mayTouch = isMainAdmin || !targetIsMain;
    const mayDisable = mayTouch && !targetIsMain && (isMainAdmin || !u.is_admin);
    const mayDelete = isMainAdmin && !targetIsMain;

    const buttons = [
      mayTouch ? '<button type="button" class="dir-edit" data-act="edit">Edit</button>' : "",
      mayTouch ? '<button type="button" data-act="actions">View Actions</button>' : "",
      mayDisable
        ? `<button type="button" class="dir-disable" data-act="disable">${u.disabled ? "Enable" : "Disable"}</button>`
        : "",
      mayDelete ? '<button type="button" class="dir-delete" data-act="delete">Delete</button>' : "",
    ].filter(Boolean).join("\n          ");

    return `
      <div class="dir-row${u.disabled ? " is-disabled" : ""}" data-email="${escapeHtml(u.email)}">
        <div class="dir-who">${escapeHtml(name)} ${tags}${offTag}</div>
        <div class="dir-meta">${escapeHtml(u.email)}</div>
        <div class="dir-accts">${escapeHtml(u.account_number || "— no account number —")}</div>
        <div class="dir-actions">
          ${buttons || '<span class="dir-locked">No actions available</span>'}
        </div>
      </div>`;
  }

  function actionLine(entry, user) {
    const words = ACTION_WORDS[entry.action] || [
      entry.action.replace(/_/g, " "), entry.action.replace(/_/g, " ") + " by",
    ];
    const byThem = entry.side === "by_them";
    const other = byThem
      ? (entry.subject_name
          ? `${entry.subject_name} (${entry.subject_email || "—"})`
          : (entry.subject_email || "—"))
      : entry.actor_email;

    return byThem
      ? `<strong>${escapeHtml(user.full_name || user.email)}</strong>
         <span class="log-act">${escapeHtml(words[0])}</span>
         ${escapeHtml(other)}`
      : `<span class="log-act">${escapeHtml(words[1])}</span>
         <strong>${escapeHtml(other)}</strong>`;
  }

  function actionDetail(entry) {
    const d = entry.detail || {};
    if (d.from && d.to) {
      const was = [d.from.full_name, d.from.account_number].filter(Boolean).join(" · ") || "—";
      const now = [d.to.full_name, d.to.account_number].filter(Boolean).join(" · ") || "—";
      return `${was} → ${now}`;
    }
    if (d.reason) return `Reason: ${d.reason}`;
    if (d.note) return `Note: ${d.note}`;
    if (entry.account_number) return entry.account_number;
    return "";
  }

  // Opens inside the row rather than in a panel of its own, so the
  // history sits next to the person it belongs to.
  async function openActions(row, user, btn) {
    const existing = row.querySelector(".dir-actions-list");
    if (existing) { existing.remove(); btn.textContent = "View Actions"; return; }

    const box = document.createElement("div");
    box.className = "dir-edit-form dir-actions-list";
    box.innerHTML = '<div class="queue-empty">Loading…</div>';
    row.appendChild(box);
    btn.textContent = "Hide Actions";

    try {
      const entries = await adminUserActions(user.email);
      box.innerHTML = entries.length
        ? entries.map(entry => {
            const detail = actionDetail(entry);
            return `
              <div class="log-row">
                <div class="log-when">${escapeHtml(formatApprovalStamp(entry.at))}</div>
                <div class="log-what">${actionLine(entry, user)}</div>
                ${detail ? `<div class="log-detail">${escapeHtml(detail)}</div>` : ""}
              </div>`;
          }).join("")
        : '<div class="queue-empty">Nothing recorded for this account yet.</div>';
    } catch (err) {
      console.error("Couldn't read this account's actions:", err);
      box.innerHTML =
        '<div class="queue-empty">Couldn\'t read the actions. Run deploy-schema.sql in the Supabase SQL Editor.</div>';
    }
  }

  // The edit form is built on demand, one at a time, so the panel
  // isn't carrying a form per row that nobody opened.
  function openEditor(row, user) {
    if (row.querySelector(".dir-edit-form")) return;

    const box = document.createElement("div");
    box.className = "dir-edit-form";
    box.innerHTML = `
      <label>Full name</label>
      <input type="text" class="edit-name" value="${escapeHtml(user.full_name || "")}"
             placeholder="LAST NAME, FIRST NAME M.I." autocomplete="off">
      <label>Account numbers</label>
      <input type="text" class="edit-accts" value="${escapeHtml(user.account_number || "")}"
             placeholder="####-####-##, ####-####-##" autocomplete="off">
      <div class="dir-actions">
        <button type="button" class="dir-edit" data-act="save">Save changes</button>
        <button type="button" data-act="cancel">Cancel</button>
      </div>`;
    row.appendChild(box);

    const nameInput = box.querySelector(".edit-name");
    const acctsInput = box.querySelector(".edit-accts");
    const saveBtn = box.querySelector('[data-act="save"]');

    nameInput.addEventListener("input", () => {
      const caret = nameInput.selectionStart;
      nameInput.value = nameInput.value.toUpperCase();
      try { nameInput.setSelectionRange(caret, caret); } catch (_) {}
    });

    box.querySelector('[data-act="cancel"]').addEventListener("click", () => box.remove());

    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { say("Enter at least a first and last name.", false); return; }

      // Same rule as the account boxes everywhere else: whole numbers
      // or nothing, and the same wording when they're short.
      const numbers = parseAccountNumbers(acctsInput.value);
      const typed = acctsInput.value.split(/[,;\n]+/).map(v => v.trim()).filter(Boolean);
      for (const one of typed) {
        if (!validateAccountNumber(one, { required: true }).ok) {
          say("LBP account numbers are default 10 digit, please input the valid account number!", false);
          return;
        }
      }

      saveBtn.disabled = true;
      try {
        const result = await adminUpdateUser(user.email, name, joinAccountNumbers(numbers));
        if (result && result.changed === false) {
          say(NO_CHANGES, true);
          saveBtn.disabled = false;
          return;
        }
        say(`Updated ${user.email}.`, true);
        if (typeof onChanged === "function") onChanged();
        await render(input.value);
      } catch (err) {
        console.error("Couldn't update the user:", err);
        say(err.message || "Couldn't save that. Try again.", false);
        saveBtn.disabled = false;
      }
    });

    enableAccountNumberInputs(box);
    nameInput.focus();
  }

  function wire(users) {
    results.querySelectorAll(".dir-row").forEach(row => {
      const email = row.getAttribute("data-email");
      const user = users.find(u => u.email === email);
      if (!user) return;

      // Which buttons exist depends on the viewer's rank and the row
      // (see rowHtml), so every lookup below has to tolerate a miss —
      // an unguarded one would throw and abandon the rest of the
      // rows in this loop.
      const editBtn = row.querySelector('[data-act="edit"]');
      if (editBtn) editBtn.addEventListener("click", () => openEditor(row, user));

      const actionsBtn = row.querySelector('[data-act="actions"]');
      if (actionsBtn) {
        actionsBtn.addEventListener("click", () => openActions(row, user, actionsBtn));
      }

      const disableBtn = row.querySelector('[data-act="disable"]');
      if (disableBtn) disableBtn.addEventListener("click", async () => {
        const label = user.full_name ? `${user.full_name} (${user.email})` : user.email;
        let reason = null;

        if (user.disabled) {
          if (!confirm(`Enable ${label}?\n\nThey'll be able to sign in again.`)) return;
        } else {
          // Cancel returns null; an empty string is a deliberate
          // "no reason given" and is allowed through.
          reason = prompt(
            `Disable ${label}?\n\nThey won't be able to sign in, and their ` +
            `statement of account goes dark. Nothing is deleted and this can ` +
            `be undone.\n\nReason (optional):`,
            ""
          );
          if (reason === null) return;
        }

        const buttons = row.querySelectorAll("button");
        buttons.forEach(b => (b.disabled = true));
        try {
          await setAccountDisabled(user.email, !user.disabled, reason);
          say(user.disabled ? `${user.email} was enabled.` : `${user.email} was disabled.`, true);
          if (typeof onChanged === "function") onChanged();
          await render(input.value);
        } catch (err) {
          console.error("Couldn't change that account's status:", err);
          say(err.message || "Couldn't change that account.", false);
          buttons.forEach(b => (b.disabled = false));
        }
      });

      const deleteBtn = row.querySelector('[data-act="delete"]');
      if (deleteBtn) deleteBtn.addEventListener("click", async () => {
        const label = user.full_name ? `${user.full_name} (${user.email})` : user.email;
        if (!confirm(
          `Delete ${label}?\n\nThis removes their profile, account numbers, and login. ` +
          `It can't be undone — they'd have to register again.`
        )) return;

        const buttons = row.querySelectorAll("button");
        buttons.forEach(b => (b.disabled = true));
        try {
          await adminDeleteUser(user.email);
          say(`${user.email} was deleted.`, true);
          if (typeof onChanged === "function") onChanged();
          await render(input.value);
        } catch (err) {
          console.error("Couldn't delete the user:", err);
          say(err.message || "Couldn't delete that account.", false);
          buttons.forEach(b => (b.disabled = false));
        }
      });
    });
  }

  async function render(query) {
    results.innerHTML = '<div class="queue-empty">Searching…</div>';
    let users;
    try {
      users = await adminSearchUsers(query);
    } catch (err) {
      console.error("Couldn't search users:", err);
      results.innerHTML =
        '<div class="queue-empty">Couldn\'t search. Run deploy-schema.sql in the Supabase SQL Editor.</div>';
      return;
    }

    results.innerHTML = users.length
      ? users.map(rowHtml).join("")
      : `<div class="queue-empty">${
          (query || "").trim() ? "Nobody matches that." : "No accounts on file yet."
        }</div>`;
    wire(users);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    searchBtn.disabled = true;
    try { await render(input.value); }
    finally { searchBtn.disabled = false; }
  });

  await render("");
  return { refresh: () => render(input.value) };
}


// ============================================================
async function initEditAccountApproval(opts) {
  injectApprovalStyles();

  const {
    profile, fullNameInput, acctInput, form, submitBtn,
    statusEl, noticeSlot, onProfileChanged, nameApi, acctApi,
  } = opts;

  const isMainAdmin = await checkIsMainAdmin();

  function status(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status visible ${type}`;
  }

  // ---- notice + pending banner ----

  async function paintNotice() {
    // A main admin's edits apply at once, so there's no queue for them
    // to be waiting on — skip the lookup rather than ask a question
    // whose answer is always "no."
    const pending = isMainAdmin ? null : await getMyPendingChange();

    let html = isMainAdmin
      ? `
      <div class="approval-note">
        As a main administrator, your changes apply immediately —
        nobody else needs to approve them. Password changes take effect
        immediately too.
      </div>`
      : `
      <div class="approval-note">
        Name and account number changes need Cash Office approval.
        Password changes take effect immediately.
      </div>`;

    if (pending) {
      html += `
        <div class="pending-banner">
          <strong>Waiting for review</strong>
          Requested ${escapeHtml(formatApprovalStamp(pending.requested_at))}:
          ${escapeHtml(pending.requested_full_name)} &middot;
          ${escapeHtml(pending.requested_account_number || "no account number")}.
          Your details stay as they are until it's approved.
          <button type="button" class="withdraw" id="withdrawChangeBtn">Withdraw</button>
        </div>`;
    }

    noticeSlot.innerHTML = html;

    const withdrawBtn = document.getElementById("withdrawChangeBtn");
    if (withdrawBtn) {
      withdrawBtn.addEventListener("click", async () => {
        withdrawBtn.disabled = true;
        try {
          await cancelMyProfileChange();
          status("Request withdrawn.", "success");
          await paintNotice();
        } catch (err) {
          status(err.message || "Couldn't withdraw the request.", "error");
          withdrawBtn.disabled = false;
        }
      });
    }
  }

  // ---- the save handler ----
  // The page's own direct-write handler has been removed; this is the
  // only submit listener on the form now.
  if (submitBtn) submitBtn.textContent = isMainAdmin ? "Save changes" : "Submit for approval";

  // Nothing here says which detail clashed. Naming it would let
  // anyone with a login work out who holds which account number.
  const DENIED =
    "Access denied: if the given details are valid, Please contact the administrator.";

  // The one refusal that names itself — a wrong length is the
  // person's own typing, not a clue about anyone else's record.
  const ACCT_LENGTH_MSG =
    "LBP account numbers are default 10 digit, please input the valid account number!";

  // The page can hand over a gate that decides when the button is
  // usable (see editaccount.html). Without one, the button simply
  // comes back on.
  function releaseSubmit() {
    if (typeof opts.refreshGate === "function") opts.refreshGate();
    else if (submitBtn) submitBtn.disabled = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Rebuild from the name boxes first, in case Enter was pressed
    // without the M.I. field ever losing focus.
    if (nameApi) nameApi.tidy();

    const fullName = (fullNameInput.value || "").trim();

    if (!fullName) {
      status("Enter at least a first and last name.", "error");
      return;
    }

    // Up to three numbers, each complete. The boxes format as you
    // type, but a half-finished one would still submit.
    const acct = acctApi
      ? acctApi.validate()
      : validateAccountNumber(acctInput.value, { required: true });
    if (!acct.ok) {
      status(ACCT_LENGTH_MSG, "error");
      releaseSubmit();
      return;
    }
    const accountNumber = acct.value;

    submitBtn.disabled = true;
    try {
      // An account number already registered to someone else can't
      // go through — an administrator would only have to reject it.
      if (accountNumber) {
        const clash = await accountNumbersTaken(accountNumber, (profile && profile.email) || null);
        if (clash.length) {
          if (typeof opts.onClash === "function") opts.onClash();
          status(DENIED, "error");
          releaseSubmit();
          return;
        }
      }

      const result = await submitProfileChangeRequest(fullName, accountNumber);

      if (result && result.immediate) {
        // It's already on file — leave what's in the boxes as-is
        // rather than bouncing them back to the old values, and keep
        // `profile` current so a second edit in the same session
        // compares against what's actually there now.
        if (profile) {
          profile.full_name = result.full_name;
          profile.account_number = result.account_number;
        }
        status("Changes applied.", "success");
        if (typeof onProfileChanged === "function") onProfileChanged(result);
      } else {
        status("Sent for approval. You'll get an email once it's decided.", "success");
        // Put the fields back to what's actually on file, so the form
        // never implies the change already happened.
        const onFile = (profile && profile.full_name) || "";
        if (nameApi) {
          nameApi.fill(onFile);
        } else {
          fullNameInput.value = onFile;
        }
        if (acctApi) acctApi.fill((profile && profile.account_number) || "");
        else acctInput.value = formatAccountNumber((profile && profile.account_number) || "");
      }
      await paintNotice();
    } catch (err) {
      // The console keeps the real reason. The page doesn't.
      console.error("Couldn't submit the change request:", err);
      if (typeof opts.onClash === "function") opts.onClash();
      status(DENIED, "error");
    } finally {
      releaseSubmit();
    }
  });

  await paintNotice();

  // The approval queues used to render here. They now live on the
  // dashboard as their own cards, where there's room for them and an
  // administrator sees them without opening a modal first.
  const isAdmin = await checkIsAdmin();

  return { isAdmin, refreshNotice: paintNotice };
}

// ============================================================
// The action log
//
// Every privileged operation in this app writes a row to
// admin_actions -- approvals, rejections, edits, deletions, admin
// grants and removals. admin_action_log() has existed to read them
// back the whole time and nothing called it. The trail was written
// faithfully and could not be looked at from inside the product: a
// main administrator's only route to it was PostgREST by hand.
//
// An audit trail nobody opens is not doing the job it was built for.
// The per-user history (openActions, above) answers "what happened to
// this person"; this answers "what has been happening", which is the
// question you ask when you don't yet know whose row to open.
//
// Main administrators only, and enforced in the function rather than
// here -- admin_action_log() raises for anyone else, and the
// admin_actions RLS policy is main-admin-select-only besides. The
// gating below is so the panel doesn't sit there inviting a click
// that can only fail.
// ============================================================

async function adminActionLog(query, limit) {
  const { data, error } = await supabaseClient.rpc("admin_action_log", {
    p_query: query || "",
    p_limit: limit || 200,
  });
  if (error) throw error;
  return data || [];
}

// Shared with mountUserDirectory's per-user history. Same vocabulary,
// because the same event described two different ways in two panels
// is how people conclude they are looking at two different events.
const LOG_ACTION_WORDS = {
  registration_approved:   "approved the registration of",
  registration_rejected:   "rejected the registration of",
  change_approved:         "applied an account change for",
  change_rejected:         "rejected an account change for",
  user_edited:             "edited the account of",
  user_deleted:            "deleted the account of",
  admin_added:             "made an administrator:",
  admin_added_from_invite: "made an administrator (from an invitation):",
  admin_invited:           "invited as an administrator:",
  admin_invite_cancelled:  "cancelled the administrator invitation for",
  admin_invite_expired:    "let an administrator invitation expire for",
  admin_removed:           "removed administrator access from",
  admin_promoted:          "made a main administrator:",
  admin_demoted:           "removed main-administrator rank from",
  admin_removal_requested: "requested removal of administrator",
  account_disabled:        "disabled the account of",
  account_enabled:         "re-enabled the account of",
};

function logEntryDetail(entry) {
  const d = entry.detail || {};
  if (d.from && d.to) {
    const was = [d.from.full_name, d.from.account_number].filter(Boolean).join(" · ") || "—";
    const now = [d.to.full_name, d.to.account_number].filter(Boolean).join(" · ") || "—";
    return `${was} → ${now}`;
  }
  if (d.reason) return `Reason: ${d.reason}`;
  if (d.note) return `Note: ${d.note}`;
  if (entry.account_number) return entry.account_number;
  return "";
}

async function mountActionLog(container) {
  if (!container) return null;

  // Ask first. A main administrator gets the panel; an ordinary
  // administrator gets nothing at all rather than a search box that
  // answers every query with "not authorized".
  let isMain = false;
  try {
    isMain = await checkIsMainAdmin();
  } catch (err) {
    console.warn("Couldn't check main-administrator rank:", err);
  }
  if (!isMain) {
    container.style.display = "none";
    return null;
  }
  container.style.display = "";

  container.innerHTML = `
    <form class="dir-search" id="logSearchForm">
      <input type="text" id="logQuery" autocomplete="off"
             placeholder="Name, account number, email, or action">
      <button type="submit" id="logSearchBtn">Search</button>
      <button type="button" id="logClearBtn">Show all</button>
    </form>
    <div id="logResults"></div>`;

  const form = container.querySelector("#logSearchForm");
  const input = container.querySelector("#logQuery");
  const clearBtn = container.querySelector("#logClearBtn");
  const results = container.querySelector("#logResults");

  async function load(query) {
    results.innerHTML = '<div class="queue-empty">Loading…</div>';
    try {
      const entries = await adminActionLog(query, 200);
      results.innerHTML = entries.length
        ? entries.map(entry => {
            const words = LOG_ACTION_WORDS[entry.action] ||
                          String(entry.action || "").replace(/_/g, " ");
            const subject = entry.subject_name
              ? `${entry.subject_name} (${entry.subject_email || "—"})`
              : (entry.subject_email || "—");
            const detail = logEntryDetail(entry);
            return `
              <div class="log-row">
                <div class="log-when">${escapeHtml(formatApprovalStamp(entry.at))}</div>
                <div class="log-what">
                  <strong>${escapeHtml(entry.actor_email || "system")}</strong>
                  <span class="log-act">${escapeHtml(words)}</span>
                  ${escapeHtml(subject)}
                </div>
                ${detail ? `<div class="log-detail">${escapeHtml(detail)}</div>` : ""}
              </div>`;
          }).join("")
        : `<div class="queue-empty">${
             query ? "Nothing recorded matches that." : "Nothing recorded yet."
           }</div>`;
    } catch (err) {
      console.error("Couldn't read the action log:", err);
      results.innerHTML =
        '<div class="queue-empty">Couldn\'t read the action log. ' +
        'Run deploy-schema.sql in the Supabase SQL Editor.</div>';
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    load(input.value.trim());
  });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    load("");
  });

  await load("");
  return { reload: () => load(input.value.trim()) };
}
