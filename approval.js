async function checkIsAdmin() {
  const {data: data, error: error} = await supabaseClient.rpc("is_admin");
  if (error) {
    console.error("is_admin check failed:", error);
    return null;
  }
  return data === true;
}

async function getMyPendingChange() {
  const {data: {user: user}} = await supabaseClient.auth.getUser();
  if (!user) return null;
  const {data: data, error: error} = await supabaseClient.from("profile_change_requests").select("id, requested_full_name, requested_account_number, requested_at").ilike("user_email", user.email).eq("status", "pending").order("requested_at", {
    ascending: false
  }).limit(1);
  if (error) {
    console.error("Couldn't load your pending request:", error);
    return null;
  }
  return data && data[0] || null;
}

async function submitProfileChangeRequest(fullName, accountNumber) {
  const {data: data, error: error} = await supabaseClient.rpc("request_profile_change", {
    p_full_name: fullName,
    p_account_number: accountNumber
  });
  if (error) throw error;
  return data;
}

async function cancelMyProfileChange() {
  const {error: error} = await supabaseClient.rpc("cancel_my_profile_change");
  if (error) throw error;
}

async function loadAdminQueue() {
  const {data: data, error: error} = await supabaseClient.rpc("admin_pending_queue");
  if (error) throw error;
  return {
    registrations: data && data.registrations || [],
    profileChanges: data && data.profile_changes || []
  };
}

async function approveRegistration(email) {
  const {data: data, error: error} = await supabaseClient.rpc("approve_registration", {
    p_email: email
  });
  if (error) throw error;
  return data;
}

async function rejectRegistration(email, reason) {
  const {data: data, error: error} = await supabaseClient.rpc("reject_registration", {
    p_email: email,
    p_reason: reason || null
  });
  if (error) throw error;
  return data;
}

async function approveProfileChange(requestId) {
  const {data: data, error: error} = await supabaseClient.rpc("approve_profile_change", {
    p_request_id: requestId
  });
  if (error) throw error;
  return data;
}

async function rejectProfileChange(requestId, note) {
  const {data: data, error: error} = await supabaseClient.rpc("reject_profile_change", {
    p_request_id: requestId,
    p_note: note || null
  });
  if (error) throw error;
  return data;
}

async function notifyDecision(kind, payload) {
  try {
    const {data: data, error: error} = await supabaseClient.functions.invoke("notify-approval", {
      body: {
        kind: kind,
        ...payload
      }
    });
    if (error || data && data.error) {
      throw new Error(data && data.error || error.message || "Edge function error");
    }
    if (payload.email && kind === "registration") {
      await supabaseClient.rpc("mark_notified", {
        p_email: payload.email
      });
    }
    return true;
  } catch (err) {
    console.warn("notify-approval didn't send:", err);
    return false;
  }
}

function formatApprovalStamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function renderApprovalDiffRow(label, was, now) {
  const wasTrim = (was || "").trim();
  const nowTrim = (now || "").trim();
  if (wasTrim === nowTrim) {
    return `\n      <div>\n        <span class="k">${escapeHtml(label)}</span>\n        <span class="v"><span class="no-mod">No modification.</span></span>\n      </div>`;
  }
  return `\n    <div>\n      <span class="k">${escapeHtml(label)}</span>\n      <span class="v">\n        <span class="was">${escapeHtml(was || "—")}</span>\n        <span class="arrow">→</span>\n        <span class="now">${escapeHtml(now || "—")}</span>\n      </span>\n    </div>`;
}

function injectApprovalStyles() {
  if (document.getElementById("approvalStyles")) return;
  const css = `\n  .approval-note {\n    font-size: 12.5px;\n    line-height: 1.5;\n    color: var(--muted, #64748b);\n    background: #f8fafc;\n    border: 1px solid #e2e8f0;\n    border-left: 3px solid var(--yellow, #f5b041);\n    border-radius: 8px;\n    padding: 10px 12px;\n    margin-bottom: 16px;\n  }\n  .pending-banner {\n    font-size: 12.5px;\n    line-height: 1.5;\n    background: var(--yellow-soft, #fef9ec);\n    border: 1px solid #fde68a;\n    border-radius: 10px;\n    padding: 11px 13px;\n    margin-bottom: 16px;\n    color: #854d0e;\n  }\n  .pending-banner strong { display: block; margin-bottom: 3px; font-size: 13px; }\n  .pending-banner .withdraw {\n    background: none; border: none; padding: 0; margin-top: 6px;\n    color: #854d0e; font: inherit; font-weight: 700;\n    text-decoration: underline; text-underline-offset: 2px; cursor: pointer;\n  }\n  .admin-panel { margin-top: 4px; }\n  .admin-panel h3 {\n    font-size: 12px;\n    font-family: "JetBrains Mono", monospace;\n    text-transform: uppercase;\n    letter-spacing: 1.1px;\n    color: var(--maroon, #7b1113);\n    margin: 18px 0 10px;\n  }\n  .admin-panel h3:first-child { margin-top: 0; }\n  .admin-panel .queue-count {\n    display: inline-block;\n    min-width: 18px;\n    padding: 1px 6px;\n    margin-left: 6px;\n    border-radius: 999px;\n    background: var(--maroon, #7b1113);\n    color: #fff;\n    font-size: 10.5px;\n    letter-spacing: 0;\n    vertical-align: middle;\n  }\n  .req-card {\n    border: 1px solid rgba(123, 17, 19, 0.14);\n    border-radius: 10px;\n    padding: 12px 13px;\n    margin-bottom: 10px;\n    background: rgba(255,255,255,0.7);\n  }\n  .req-who {\n    font-size: 13.5px; font-weight: 700; color: var(--ink, #1e293b);\n    word-break: break-word;\n  }\n  .req-meta {\n    font-size: 11.5px; color: var(--muted, #64748b);\n    font-family: "JetBrains Mono", monospace; margin-top: 2px;\n  }\n  .req-diff { margin: 9px 0 0; font-size: 12.5px; }\n  .req-diff div { display: flex; gap: 8px; padding: 2px 0; }\n  .req-diff .k {\n    flex: 0 0 96px; color: var(--muted, #64748b); font-size: 11.5px;\n    text-transform: uppercase; letter-spacing: 0.5px; padding-top: 2px;\n  }\n  .req-diff .v { flex: 1; word-break: break-word; }\n  .req-diff .was { color: var(--muted, #64748b); text-decoration: line-through; }\n  .req-diff .now { color: var(--maroon, #7b1113); font-weight: 600; }\n  .req-diff .no-mod { color: var(--muted, #64748b); font-style: italic; }\n  .req-actions { display: flex; gap: 8px; margin-top: 11px; }\n  .req-actions button {\n    flex: 1; padding: 8px 10px; border-radius: 8px;\n    font: 700 12.5px/1 "Inter", sans-serif; cursor: pointer;\n    border: 1.5px solid transparent; transition: opacity .15s, background .15s;\n  }\n  .req-actions button:disabled { opacity: .55; cursor: not-allowed; }\n  .btn-approve { background: var(--maroon, #7b1113); color: #fff; }\n  .btn-approve:hover:not(:disabled) { background: var(--maroon-dark, #5c0d0f); }\n  .btn-reject { background: #fff; color: #b91c1c; border-color: #fecaca !important; }\n  .btn-reject:hover:not(:disabled) { background: #fef2f2; }\n  .queue-empty {\n    font-size: 12.5px; color: var(--muted, #64748b);\n    padding: 12px; text-align: center;\n    border: 1px dashed #e2e8f0; border-radius: 10px;\n  }\n  .queue-result {\n    font-size: 12.5px; padding: 9px 12px; border-radius: 8px;\n    margin-bottom: 12px; line-height: 1.45;\n  }\n  .queue-result.ok   { background: var(--yellow-soft, #fef9ec); color: #854d0e; border: 1px solid #fde68a; }\n  .queue-result.bad  { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }\n\n  \n  \n  .queue-filter {\n    display: flex; align-items: center; gap: 9px;\n    margin-bottom: 14px; flex-wrap: wrap;\n  }\n  .queue-filter[hidden] { display: none; }\n  \n  .queue-filter-field { position: relative; flex: 1 1 240px; min-width: 0; }\n  .queue-filter input {\n    width: 100%; box-sizing: border-box; padding: 10px 12px;\n    border: 1.5px solid #e2e8f0; border-radius: 9px;\n    font: 400 13.5px/1.3 "Inter", sans-serif; background: #fff;\n    color: var(--ink, #1e293b);\n  }\n  .queue-filter input:focus {\n    outline: none; border-color: var(--maroon, #7b1113);\n    box-shadow: 0 0 0 3px rgba(123, 17, 19, 0.08);\n  }\n  .queue-filter button {\n    padding: 9px 16px; border: none; border-radius: 8px;\n    background: var(--maroon, #7b1113); color: #fff;\n    font: 700 12.5px/1 "Inter", sans-serif; cursor: pointer;\n  }\n  .queue-filter button:hover:not(:disabled) { background: var(--maroon-dark, #5c0d0f); }\n  .queue-filter button:disabled { opacity: .55; cursor: not-allowed; }\n  .queue-filter-note {\n    font: 400 12.5px/1.3 "Inter", sans-serif;\n    color: var(--muted, #64748b);\n  }\n\n  \n  .queue-suggest {\n    position: absolute; top: calc(100% + 4px); left: 0; right: 0;\n    z-index: 40; margin: 0; padding: 4px; list-style: none;\n    max-height: 264px; overflow-y: auto;\n    background: #fff; border: 1.5px solid #e2e8f0; border-radius: 10px;\n    box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12);\n  }\n  .queue-suggest[hidden] { display: none; }\n  .queue-suggest li {\n    padding: 8px 10px; border-radius: 7px; cursor: pointer;\n    font: 400 13px/1.35 "Inter", sans-serif; color: var(--ink, #1e293b);\n  }\n  .queue-suggest li:hover,\n  .queue-suggest li[aria-selected="true"] { background: var(--yellow-soft, #fef9ec); }\n  .queue-suggest li[aria-selected="true"] { box-shadow: inset 0 0 0 1.5px var(--maroon, #7b1113); }\n  .queue-suggest .s-name { font-weight: 700; display: block; }\n  .queue-suggest .s-meta {\n    display: block; margin-top: 1px;\n    font-size: 11.5px; color: var(--muted, #64748b);\n  }\n  \n  .queue-suggest mark {\n    background: rgba(123, 17, 19, 0.13); color: inherit;\n    border-radius: 3px; padding: 0 1px;\n  }\n\n  \n  \n  #adminSection { display: contents; }\n  .admin-card { grid-column: 1 / -1; }\n  .admin-card .section-title .queue-count {\n    display: none;\n    margin-left: auto;\n    min-width: 20px;\n    padding: 2px 8px;\n    border-radius: 999px;\n    background: var(--maroon, #7b1113);\n    color: #fff;\n    font-size: 11px;\n    letter-spacing: 0;\n    text-align: center;\n  }\n  .req-diff .arrow {\n    color: var(--muted, #64748b);\n    padding: 0 7px;\n    font-size: 12px;\n  }\n\n  \n  .admin-list { list-style: none; margin: 0 0 16px; padding: 0; }\n  .admin-row {\n    display: flex;\n    align-items: center;\n    gap: 12px;\n    padding: 11px 13px;\n    border: 1px solid rgba(123, 17, 19, 0.12);\n    border-radius: 10px;\n    margin-bottom: 8px;\n    background: rgba(255,255,255,0.7);\n  }\n  .admin-row-main { flex: 1; min-width: 0; }\n  .admin-email {\n    font-size: 13.5px; font-weight: 600; color: var(--ink, #1e293b);\n    word-break: break-all;\n  }\n  .admin-tag {\n    display: inline-block;\n    margin-left: 7px;\n    padding: 2px 7px;\n    border-radius: 999px;\n    background: #f1f5f9;\n    color: var(--muted, #64748b);\n    font-size: 10.5px;\n    font-weight: 700;\n    text-transform: uppercase;\n    letter-spacing: 0.5px;\n    vertical-align: middle;\n  }\n  .admin-tag.you { background: var(--yellow-soft, #fef9ec); color: #854d0e; border: 1px solid #fde68a; }\n  .admin-note-text {\n    font-size: 11.5px; color: var(--muted, #64748b); margin-top: 3px;\n    font-family: "JetBrains Mono", monospace;\n  }\n  .admin-row-locked { color: #cbd5e1; font-size: 13px; padding: 0 10px; }\n  .admin-remove {\n    flex-shrink: 0;\n    padding: 7px 12px;\n    border-radius: 8px;\n    border: 1.5px solid #fecaca;\n    background: #fff;\n    color: #b91c1c;\n    font: 700 12px/1 "Inter", sans-serif;\n    cursor: pointer;\n    transition: background .15s;\n  }\n  .admin-remove:hover:not(:disabled) { background: #fef2f2; }\n  .admin-remove:disabled { opacity: .55; cursor: not-allowed; }\n\n  .admin-cancel-invite {\n    flex-shrink: 0;\n    padding: 7px 12px;\n    border-radius: 8px;\n    border: 1.5px solid #fecaca;\n    background: #fff;\n    color: #b91c1c;\n    font: 700 12px/1 "Inter", sans-serif;\n    cursor: pointer;\n    transition: background .15s;\n  }\n  .admin-cancel-invite:hover:not(:disabled) { background: #fef2f2; }\n  .admin-cancel-invite:disabled { opacity: .55; cursor: not-allowed; }\n\n  .admin-request {\n    flex-shrink: 0;\n    padding: 7px 12px;\n    border-radius: 8px;\n    border: 1.5px solid #fde68a;\n    background: #fff;\n    color: #854d0e;\n    font: 700 12px/1 "Inter", sans-serif;\n    cursor: pointer;\n    transition: background .15s;\n  }\n  .admin-request:hover:not(:disabled) { background: var(--yellow-soft, #fef9ec); }\n  .admin-request:disabled { opacity: .55; cursor: not-allowed; }\n\n  .admin-add-form {\n    border-top: 1px dashed #e2e8f0;\n    padding-top: 15px;\n  }\n  .admin-add-fields { display: flex; gap: 9px; margin-bottom: 10px; flex-wrap: wrap; }\n  .admin-add-fields input {\n    flex: 1 1 190px;\n    min-width: 0;\n    padding: 10px 12px;\n    border: 1.5px solid #e2e8f0;\n    border-radius: 9px;\n    font: 400 13.5px/1.3 "Inter", sans-serif;\n    background: #fff;\n    color: var(--ink, #1e293b);\n  }\n  .admin-add-fields input:focus {\n    outline: none;\n    border-color: var(--maroon, #7b1113);\n    box-shadow: 0 0 0 3px rgba(123, 17, 19, 0.08);\n  }\n  .admin-add-form .btn-approve {\n    padding: 9px 16px;\n    border: none;\n    border-radius: 8px;\n    background: var(--maroon, #7b1113);\n    color: #fff;\n    font: 700 12.5px/1 "Inter", sans-serif;\n    cursor: pointer;\n  }\n  .admin-add-form .btn-approve:hover:not(:disabled) { background: var(--maroon-dark, #5c0d0f); }\n  .admin-add-form .btn-approve:disabled { opacity: .55; cursor: not-allowed; }\n  .admin-hint {\n    font-size: 11.5px; line-height: 1.5; color: var(--muted, #64748b);\n    margin: 13px 0 0;\n  }\n\n  \n  .dir-search { display: flex; gap: 9px; margin-bottom: 14px; flex-wrap: wrap; }\n  .dir-search input {\n    flex: 1 1 220px; min-width: 0; padding: 10px 12px;\n    border: 1.5px solid #e2e8f0; border-radius: 9px;\n    font: 400 13.5px/1.3 "Inter", sans-serif; background: #fff;\n    color: var(--ink, #1e293b);\n  }\n  .dir-search input:focus {\n    outline: none; border-color: var(--maroon, #7b1113);\n    box-shadow: 0 0 0 3px rgba(123, 17, 19, 0.08);\n  }\n  .dir-search button {\n    padding: 9px 16px; border: none; border-radius: 8px;\n    background: var(--maroon, #7b1113); color: #fff;\n    font: 700 12.5px/1 "Inter", sans-serif; cursor: pointer;\n  }\n  .dir-search button:hover:not(:disabled) { background: var(--maroon-dark, #5c0d0f); }\n  .dir-search button:disabled { opacity: .55; cursor: not-allowed; }\n\n  .dir-row {\n    border: 1px solid #e2e8f0; border-radius: 11px;\n    padding: 12px 14px; margin-bottom: 9px; background: #fff;\n  }\n  .dir-row .dir-who { font: 700 13.5px/1.35 "Inter", sans-serif; color: var(--ink, #1e293b); }\n  .dir-row .dir-meta {\n    font: 500 11.5px/1.5 "JetBrains Mono", monospace;\n    color: var(--muted, #64748b); margin-top: 3px; word-break: break-all;\n  }\n  .dir-row .dir-accts {\n    font: 600 12.5px/1.5 "JetBrains Mono", monospace;\n    color: var(--maroon, #7b1113); margin-top: 5px;\n  }\n  .dir-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }\n  .dir-actions button {\n    padding: 7px 13px; border-radius: 8px; border: 1px solid #e2e8f0;\n    background: #fff; font: 700 12px/1 "Inter", sans-serif; cursor: pointer;\n    color: var(--ink, #1e293b);\n  }\n  .dir-actions .dir-edit:hover:not(:disabled) {\n    border-color: var(--maroon, #7b1113); color: var(--maroon, #7b1113);\n  }\n  .dir-actions .dir-delete { color: #b91c1c; border-color: #fecaca; }\n  .dir-actions .dir-delete:hover:not(:disabled) { background: #fef2f2; }\n  .dir-actions button:disabled { opacity: .55; cursor: not-allowed; }\n  .dir-actions .dir-locked {\n    font: 600 12px/1.6 "Inter", sans-serif; color: var(--muted, #64748b);\n  }\n  .dir-actions .dir-disable { color: #854d0e; border-color: #fde68a; }\n  .dir-actions .dir-disable:hover:not(:disabled) { background: var(--yellow-soft, #fef9ec); }\n  .dir-row.is-disabled .dir-who { opacity: .72; }\n  .admin-tag.off { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }\n\n  .removal-queue { margin: 0 0 14px; padding: 0; list-style: none; }\n  .removal-queue li {\n    border: 1px solid #fde68a; background: var(--yellow-soft, #fef9ec);\n    border-radius: 10px; padding: 11px 13px; margin-bottom: 8px;\n  }\n  .removal-queue .rq-who {\n    font: 700 13px/1.4 "Inter", sans-serif; color: var(--ink, #1e293b);\n  }\n  .removal-queue .rq-meta {\n    font: 500 11.5px/1.5 "JetBrains Mono", monospace;\n    color: #854d0e; margin-top: 3px; word-break: break-all;\n  }\n  .removal-queue .rq-actions { display: flex; gap: 8px; margin-top: 9px; flex-wrap: wrap; }\n  .removal-queue .rq-actions button {\n    padding: 6px 12px; border-radius: 8px; border: 1px solid #e2e8f0;\n    background: #fff; font: 700 12px/1 "Inter", sans-serif; cursor: pointer;\n  }\n  .removal-queue .rq-yes { color: #166534; border-color: #bbf7d0; }\n  .removal-queue .rq-no { color: #b91c1c; border-color: #fecaca; }\n  .removal-queue button:disabled { opacity: .55; cursor: not-allowed; }\n\n  .dir-edit-form { margin-top: 11px; padding-top: 11px; border-top: 1px dashed #e2e8f0; }\n  .dir-edit-form label {\n    display: block; font: 700 11px/1 "Inter", sans-serif;\n    text-transform: uppercase; letter-spacing: .7px;\n    color: var(--muted, #64748b); margin: 0 0 5px;\n  }\n  .dir-edit-form input {\n    width: 100%; padding: 9px 11px; margin-bottom: 9px;\n    border: 1.5px solid #e2e8f0; border-radius: 9px;\n    font: 400 13px/1.3 "Inter", sans-serif; background: #fff;\n    color: var(--ink, #1e293b);\n  }\n  .dir-edit-form input:focus {\n    outline: none; border-color: var(--maroon, #7b1113);\n    box-shadow: 0 0 0 3px rgba(123, 17, 19, 0.08);\n  }\n\n  .log-row {\n    display: grid; grid-template-columns: auto 1fr; gap: 3px 12px;\n    border-left: 3px solid var(--yellow, #f5b041);\n    background: #f8fafc; border-radius: 0 9px 9px 0;\n    padding: 9px 12px; margin-bottom: 7px;\n  }\n  .log-when {\n    grid-column: 1 / -1;\n    font: 500 11px/1.4 "JetBrains Mono", monospace;\n    color: var(--muted, #64748b);\n  }\n  .log-what { grid-column: 1 / -1; font: 400 12.5px/1.5 "Inter", sans-serif; color: var(--ink, #1e293b); }\n  .log-what strong { font-weight: 700; }\n  .log-what .log-act { color: var(--maroon, #7b1113); font-weight: 700; }\n  .log-detail {\n    grid-column: 1 / -1;\n    font: 500 11.5px/1.5 "JetBrains Mono", monospace;\n    color: var(--muted, #64748b); margin-top: 2px; word-break: break-word;\n  }\n`;
  const style = document.createElement("style");
  style.id = "approvalStyles";
  style.textContent = css;
  document.head.appendChild(style);
}

async function adminSearchUsers(query) {
  const {data: data, error: error} = await supabaseClient.rpc("admin_search_users", {
    p_query: query || ""
  });
  if (error) throw error;
  return data || [];
}

async function adminUpdateUser(email, fullName, accountNumber) {
  const {data: data, error: error} = await supabaseClient.rpc("admin_update_user", {
    p_email: email,
    p_full_name: fullName,
    p_account_number: accountNumber || null
  });
  if (error) throw error;
  return data;
}

async function adminDeleteUser(email) {
  const {data: data, error: error} = await supabaseClient.functions.invoke("admin-delete-user", {
    body: {
      email: email
    }
  });
  if (error) throw error;
  if (data && data.error) throw new Error(data.error);
  return data;
}

async function checkIsMainAdmin() {
  try {
    const {data: data, error: error} = await supabaseClient.rpc("is_main_admin");
    if (error) throw error;
    return data === true;
  } catch (err) {
    console.warn("Couldn't check main-administrator rank:", err);
    return false;
  }
}

async function adminUserActions(email) {
  const {data: data, error: error} = await supabaseClient.rpc("admin_user_actions", {
    p_email: email
  });
  if (error) throw error;
  return data || [];
}

async function listAdmins() {
  const {data: data, error: error} = await supabaseClient.rpc("admin_list");
  if (error) throw error;
  return data || [];
}

async function addAdmin(email, note) {
  const {data: data, error: error} = await supabaseClient.rpc("admin_add", {
    p_email: email,
    p_note: note || null
  });
  if (error) throw error;
  return data;
}

async function removeAdmin(email) {
  const {data: data, error: error} = await supabaseClient.rpc("admin_remove", {
    p_email: email
  });
  if (error) throw error;
  return data;
}

async function cancelAdminInvite(email) {
  const {data: data, error: error} = await supabaseClient.rpc("admin_invite_cancel", {
    p_email: email
  });
  if (error) throw error;
  return data;
}

async function setAccountDisabled(email, disabled, reason) {
  const {data: data, error: error} = await supabaseClient.rpc("admin_set_account_disabled", {
    p_email: email,
    p_disabled: !!disabled,
    p_reason: reason || null
  });
  if (error) throw error;
  return data;
}

async function requestAdminRemoval(email, reason) {
  const {data: data, error: error} = await supabaseClient.rpc("admin_request_admin_removal", {
    p_email: email,
    p_reason: reason || null
  });
  if (error) throw error;
  return data;
}

async function fetchAdminRemovalQueue() {
  const {data: data, error: error} = await supabaseClient.rpc("admin_removal_queue");
  if (error) throw error;
  return data || [];
}

async function decideAdminRemoval(requestId, approve, note) {
  const {data: data, error: error} = await supabaseClient.rpc("admin_decide_removal", {
    p_request_id: requestId,
    p_approve: !!approve,
    p_note: note || null
  });
  if (error) throw error;
  return data;
}

async function mountAdminQueues(opts) {
  injectApprovalStyles();
  const {registrationsEl: registrationsEl, changesEl: changesEl, onApplied: onApplied, filterEl: filterEl} = opts;
  const filterInput = filterEl ? filterEl.querySelector('[data-role="query"]') : null;
  const filterClear = filterEl ? filterEl.querySelector('[data-act="clear"]') : null;
  const filterNote = filterEl ? filterEl.querySelector('[data-role="note"]') : null;
  const suggestEl = filterEl ? filterEl.querySelector('[data-role="suggest"]') : null;
  console.info("[approval.js] registration filter —", filterEl ? "container found" : "NO container (old dashboard.html, or filterEl not passed)", "| input:", !!filterInput, "| suggestions:", !!suggestEl);
  if (registrationsEl) registrationsEl.innerHTML = '<div class="queue-empty">Loading…</div>';
  if (changesEl) changesEl.innerHTML = '<div class="queue-empty">Loading…</div>';
  function say(el, message, ok) {
    if (!el) return;
    const note = document.createElement("div");
    note.className = `queue-result ${ok ? "ok" : "bad"}`;
    note.textContent = message;
    el.prepend(note);
    setTimeout(() => note.remove(), 9e3);
  }
  function setCount(el, n) {
    const badge = el && el.closest(".card") && el.closest(".card").querySelector(".queue-count");
    if (!badge) return;
    badge.textContent = n;
    badge.style.display = n > 0 ? "inline-block" : "none";
  }
  let allRegs = [];
  function registrationMatches(r, query) {
    if (!query) return true;
    const text = [ r.full_name, r.email ].filter(Boolean).join(" ").toLowerCase();
    if (text.includes(query)) return true;
    const queryDigits = query.replace(/\D/g, "");
    if (!queryDigits) return false;
    const acctDigits = String(r.account_number == null ? "" : r.account_number).replace(/\D/g, "");
    return acctDigits.includes(queryDigits);
  }
  function registrationCard(r) {
    return `\n      <div class="req-card" data-kind="registration" data-email="${escapeHtml(r.email)}">\n        <div class="req-who">${escapeHtml(r.full_name || "(no name given)")}</div>\n        <div class="req-meta">${escapeHtml(r.email)} · applied ${escapeHtml(formatApprovalStamp(r.submitted_at))}</div>\n        <div class="req-diff">\n          <div><span class="k">Account no.</span><span class="v">${escapeHtml(r.account_number || "— not provided —")}</span></div>\n        </div>\n        <div class="req-actions">\n          <button type="button" class="btn-approve" data-act="approve">Approve access</button>\n          <button type="button" class="btn-reject" data-act="reject">Reject</button>\n        </div>\n      </div>`;
  }
  const SUGGEST_LIMIT = 8;
  let suggestions = [];
  let activeSuggestion = -1;
  function highlight(text, query) {
    const s = String(text == null ? "" : text);
    if (!query) return escapeHtml(s);
    const at = s.toLowerCase().indexOf(query);
    if (at === -1) return escapeHtml(s);
    return escapeHtml(s.slice(0, at)) + "<mark>" + escapeHtml(s.slice(at, at + query.length)) + "</mark>" + escapeHtml(s.slice(at + query.length));
  }
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
      const meta = [ r.email, r.account_number || "no account number" ].filter(Boolean).join(" · ");
      return `\n        <li role="option" id="regSuggest-${i}" data-i="${i}"\n            aria-selected="${i === activeSuggestion}">\n          <span class="s-name">${highlight(r.full_name || "(no name given)", query)}</span>\n          <span class="s-meta">${highlight(meta, query)}</span>\n        </li>`;
    }).join("");
    suggestEl.hidden = suggestions.length === 0;
    filterInput.setAttribute("aria-expanded", String(suggestions.length > 0));
    filterInput.setAttribute("aria-activedescendant", activeSuggestion >= 0 ? `regSuggest-${activeSuggestion}` : "");
    suggestEl.querySelectorAll("li").forEach(li => {
      li.addEventListener("mousedown", e => {
        e.preventDefault();
        chooseSuggestion(Number(li.getAttribute("data-i")));
      });
    });
  }
  function openSuggestions() {
    if (!suggestEl || !filterInput) return;
    const query = filterInput.value.trim().toLowerCase();
    if (!query) return closeSuggestions();
    const matches = allRegs.filter(r => registrationMatches(r, query));
    if (matches.length === 1 && suggestionValue(matches[0]).toLowerCase() === query) {
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
    if (active && active.scrollIntoView) active.scrollIntoView({
      block: "nearest"
    });
  }
  function chooseSuggestion(i) {
    const picked = suggestions[i];
    if (!picked) return;
    filterInput.value = suggestionValue(picked);
    closeSuggestions();
    paintRegistrations();
    filterInput.focus();
  }
  function paintRegistrations() {
    if (!registrationsEl) return;
    const query = (filterInput ? filterInput.value : "").trim().toLowerCase();
    const shown = query ? allRegs.filter(r => registrationMatches(r, query)) : allRegs;
    registrationsEl.innerHTML = shown.length ? shown.map(registrationCard).join("") : `<div class="queue-empty">${allRegs.length === 0 ? "No one is waiting for access." : "No registrations match that."}</div>`;
    setCount(registrationsEl, allRegs.length);
    if (filterEl) {
      if (filterNote) {
        filterNote.textContent = query ? `Showing ${shown.length} of ${allRegs.length}` : "";
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
      closeSuggestions();
      paintRegistrations();
    }
    if (changesEl) {
      changesEl.innerHTML = changes.length ? changes.map(c => `\n            <div class="req-card" data-kind="change" data-id="${escapeHtml(c.id)}">\n              <div class="req-who">${escapeHtml(c.user_email)}</div>\n              <div class="req-meta">Requested ${escapeHtml(formatApprovalStamp(c.requested_at))}</div>\n              <div class="req-diff">\n                ${renderApprovalDiffRow("Full name", c.current_full_name, c.requested_full_name)}\n                ${renderApprovalDiffRow("Account no.", c.current_account_number, c.requested_account_number)}\n              </div>\n              <div class="req-actions">\n                <button type="button" class="btn-approve" data-act="approve">Apply change</button>\n                <button type="button" class="btn-reject" data-act="reject">Reject</button>\n              </div>\n            </div>`).join("") : '<div class="queue-empty">No account changes waiting.</div>';
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
            reason = prompt(kind === "registration" ? "Why is this registration being rejected? The person will see this." : "Why is this change being rejected? The person will see this.");
            if (reason === null) return;
          }
          buttons.forEach(b => b.disabled = true);
          try {
            let result;
            if (kind === "registration") {
              const email = card.getAttribute("data-email");
              result = act === "approve" ? await approveRegistration(email) : await rejectRegistration(email, reason);
              const sent = await notifyDecision("registration", {
                email: result.email,
                full_name: result.full_name,
                decision: result.decision,
                reason: result.reason || reason || null
              });
              say(host, (act === "approve" ? `${result.email} can now sign in.` : `${result.email} was rejected.`) + (sent ? " They've been emailed." : " Email notice didn't send — tell them another way."), true);
            } else {
              const id = card.getAttribute("data-id");
              result = act === "approve" ? await approveProfileChange(id) : await rejectProfileChange(id, reason);
              const sent = await notifyDecision("profile_change", {
                email: result.email,
                full_name: result.full_name || null,
                account_number: result.account_number || null,
                decision: result.decision,
                reason: result.reason || reason || null
              });
              say(host, (act === "approve" ? `Change applied for ${result.email}.` : `Change rejected for ${result.email}.`) + (sent ? " They've been emailed." : " Email notice didn't send."), true);
            }
            if (typeof onApplied === "function") onApplied();
            await render();
          } catch (err) {
            console.error("Approval action failed:", err);
            say(host, err.message || "That didn't go through. Try again.", false);
            buttons.forEach(b => b.disabled = false);
          }
        });
      });
    });
  }
  if (filterInput) {
    filterInput.addEventListener("input", () => {
      paintRegistrations();
      openSuggestions();
    });
    filterInput.addEventListener("keydown", e => {
      const open = suggestions.length > 0;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (open) moveSuggestion(1); else openSuggestions();
        return;
      }
      if (e.key === "ArrowUp" && open) {
        e.preventDefault();
        moveSuggestion(-1);
        return;
      }
      if (e.key === "Enter") {
        if (open && activeSuggestion >= 0) {
          e.preventDefault();
          chooseSuggestion(activeSuggestion);
        } else {
          closeSuggestions();
        }
        return;
      }
      if (e.key === "Escape") {
        if (open) {
          closeSuggestions();
          return;
        }
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
  return {
    refresh: render
  };
}

async function mountAdminManager(container, onChanged) {
  injectApprovalStyles();
  container.innerHTML = '<div class="queue-empty">Loading…</div>';
  const isMainAdmin = await checkIsMainAdmin();
  function say(message, ok) {
    const note = document.createElement("div");
    note.className = `queue-result ${ok ? "ok" : "bad"}`;
    note.textContent = message;
    container.prepend(note);
    setTimeout(() => note.remove(), 9e3);
  }
  function queueHtml(requests) {
    if (!requests.length) return "";
    const rows = requests.map(r => {
      const who = r.target_name ? `${escapeHtml(r.target_name)}` : escapeHtml(r.target_email);
      return `\n      <li data-id="${escapeHtml(r.id)}">\n        <div class="rq-who">Remove administrator access for ${who}</div>\n        <div class="rq-meta">\n          ${escapeHtml(r.target_email)} ·\n          asked by ${escapeHtml(r.requested_by)}${r.reason ? ` · ${escapeHtml(r.reason)}` : ""}\n        </div>\n        <div class="rq-actions">\n          <button type="button" class="rq-yes" data-act="approve">Approve</button>\n          <button type="button" class="rq-no" data-act="decline">Decline</button>\n        </div>\n      </li>`;
    }).join("");
    return `<ul class="removal-queue">${rows}</ul>`;
  }
  function adminRowHtml(a) {
    let control;
    if (a.is_invite) {
      control = isMainAdmin ? `<button type="button" class="admin-cancel-invite" data-email="${escapeHtml(a.email)}">Cancel invite</button>` : '<span class="admin-row-locked" title="Only a main administrator can cancel an invitation">—</span>';
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
    return `\n      <li class="admin-row">\n        <div class="admin-row-main">\n          <span class="admin-email">${escapeHtml(a.email)}</span>\n          ${a.is_main ? '<span class="admin-tag you">main</span>' : ""}\n          ${a.is_you ? '<span class="admin-tag you">you</span>' : ""}\n          ${a.is_invite ? `<span class="admin-tag">invited${a.expires_at ? ` · expires ${escapeHtml(formatApprovalStamp(a.expires_at))}` : ""}</span>` : a.has_account ? "" : '<span class="admin-tag">not registered yet</span>'}\n          ${a.has_pending_removal && isMainAdmin ? '<span class="admin-tag">removal requested</span>' : ""}\n          ${a.note ? `<div class="admin-note-text">${escapeHtml(a.note)}</div>` : ""}\n        </div>\n        ${control}\n      </li>`;
  }
  async function render() {
    let admins;
    try {
      admins = await listAdmins();
    } catch (err) {
      console.error("Couldn't load the administrator list:", err);
      container.innerHTML = '<div class="queue-empty">Couldn\'t load the administrator list. Refresh to try again.</div>';
      return;
    }
    let requests = [];
    if (isMainAdmin) {
      try {
        requests = await fetchAdminRemovalQueue();
      } catch (err) {
        console.warn("Couldn't load pending removal requests:", err);
      }
    }
    container.innerHTML = `\n      ${queueHtml(requests)}\n      <ul class="admin-list">${admins.map(adminRowHtml).join("")}</ul>\n      ${isMainAdmin ? `\n      <form class="admin-add-form" id="adminAddForm">\n        <div class="admin-add-fields">\n          <input type="email" id="newAdminEmail" placeholder="name@up.edu.ph" autocomplete="off" required>\n          <input type="text" id="newAdminNote" placeholder="Note (optional)" maxlength="120" autocomplete="off">\n        </div>\n        <button type="submit" class="btn-approve" id="addAdminBtn">Add administrator</button>\n      </form>` : ""}\n      <p class="admin-hint">\n        ${isMainAdmin ? `Administrators approve registrations and account changes, and manage\n             news and calendar entries. Someone can be added before they've\n             registered — their account is approved automatically when they do.` : `Only a main administrator can add or remove access. You can ask for\n             another administrator's access to be removed; it stays in place\n             until a main administrator approves the request.`}\n      </p>`;
    const form = document.getElementById("adminAddForm");
    if (form) {
      const emailInput = document.getElementById("newAdminEmail");
      const noteInput = document.getElementById("newAdminNote");
      const addBtn = document.getElementById("addAdminBtn");
      form.addEventListener("submit", async e => {
        e.preventDefault();
        const email = emailInput.value.trim();
        if (!email) return;
        addBtn.disabled = true;
        try {
          const result = await addAdmin(email, noteInput.value.trim());
          say(result.has_account ? `${result.email} is now an administrator.` : `${result.email} is now an administrator. They'll get access as soon as they register.`, true);
          if (typeof onChanged === "function") onChanged();
          await render();
        } catch (err) {
          console.error("Couldn't add the administrator:", err);
          say(err.message || "Couldn't add that administrator.", false);
          addBtn.disabled = false;
        }
      });
    }
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
    container.querySelectorAll(".admin-request").forEach(btn => {
      btn.addEventListener("click", async () => {
        const email = btn.getAttribute("data-email");
        const reason = prompt(`Ask a main administrator to remove ${email}'s access?\n\n` + `Nothing changes until they approve it.\n\nReason (optional):`, "");
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
    container.querySelectorAll(".removal-queue li").forEach(li => {
      const id = li.getAttribute("data-id");
      const buttons = li.querySelectorAll("button");
      async function decide(approve) {
        let note = null;
        if (!approve) {
          note = prompt("Decline this request.\n\nNote (optional):", "");
          if (note === null) return;
        }
        buttons.forEach(b => b.disabled = true);
        try {
          const result = await decideAdminRemoval(id, approve, note);
          say(approve ? `${result.email} is no longer an administrator.` : "Request declined. Their access is unchanged.", true);
          if (typeof onChanged === "function") onChanged();
          await render();
        } catch (err) {
          console.error("Couldn't decide that request:", err);
          say(err.message || "Couldn't record that decision.", false);
          buttons.forEach(b => b.disabled = false);
        }
      }
      const yes = li.querySelector('[data-act="approve"]');
      const no = li.querySelector('[data-act="decline"]');
      if (yes) yes.addEventListener("click", () => decide(true));
      if (no) no.addEventListener("click", () => decide(false));
    });
  }
  await render();
  return {
    refresh: render
  };
}

async function mountUserDirectory(container, onChanged) {
  injectApprovalStyles();
  const NO_CHANGES = "No changes applied.";
  const isMainAdmin = await checkIsMainAdmin();
  const ACTION_WORDS = {
    registration_approved: [ "approved the registration of", "registration approved by" ],
    registration_rejected: [ "rejected the registration of", "registration rejected by" ],
    change_approved: [ "applied an account change for", "account change applied by" ],
    change_rejected: [ "rejected an account change for", "account change rejected by" ],
    user_edited: [ "edited the account of", "account edited by" ],
    user_deleted: [ "deleted the account of", "account deleted by" ],
    admin_added: [ "made an administrator:", "made an administrator by" ],
    admin_removed: [ "removed administrator access from", "administrator access removed by" ],
    admin_promoted: [ "made a main administrator:", "made a main administrator by" ],
    admin_demoted: [ "removed main-administrator rank from", "main-administrator rank removed by" ]
  };
  container.innerHTML = `\n    <form class="dir-search" id="dirSearchForm">\n      <input type="text" id="dirQuery" autocomplete="off"\n             placeholder="Name, account number, or email">\n      <button type="submit" id="dirSearchBtn">Search</button>\n    </form>\n    <div id="dirResults"><div class="queue-empty">Loading…</div></div>`;
  const form = container.querySelector("#dirSearchForm");
  const input = container.querySelector("#dirQuery");
  const searchBtn = container.querySelector("#dirSearchBtn");
  const results = container.querySelector("#dirResults");
  function say(message, ok) {
    const note = document.createElement("div");
    note.className = `queue-result ${ok ? "ok" : "bad"}`;
    note.textContent = message;
    results.prepend(note);
    setTimeout(() => note.remove(), 9e3);
  }
  function rowHtml(u) {
    const name = u.full_name || "(no name on file)";
    const tags = [ u.is_main ? "main admin" : u.is_admin ? "admin" : "", u.approval_status !== "approved" ? u.approval_status : "", u.has_pending_change ? "change pending" : "" ].filter(Boolean).map(t => `<span class="admin-tag">${escapeHtml(t)}</span>`).join("");
    const offTag = u.disabled ? '<span class="admin-tag off">disabled</span>' : "";
    const targetIsMain = !!u.is_main;
    const mayTouch = isMainAdmin || !targetIsMain;
    const mayDisable = mayTouch && !targetIsMain && (isMainAdmin || !u.is_admin);
    const mayDelete = isMainAdmin && !targetIsMain;
    const buttons = [ mayTouch ? '<button type="button" class="dir-edit" data-act="edit">Edit</button>' : "", mayTouch ? '<button type="button" data-act="actions">View Actions</button>' : "", mayDisable ? `<button type="button" class="dir-disable" data-act="disable">${u.disabled ? "Enable" : "Disable"}</button>` : "", mayDelete ? '<button type="button" class="dir-delete" data-act="delete">Delete</button>' : "" ].filter(Boolean).join("\n          ");
    return `\n      <div class="dir-row${u.disabled ? " is-disabled" : ""}" data-email="${escapeHtml(u.email)}">\n        <div class="dir-who">${escapeHtml(name)} ${tags}${offTag}</div>\n        <div class="dir-meta">${escapeHtml(u.email)}</div>\n        <div class="dir-accts">${escapeHtml(u.account_number || "— no account number —")}</div>\n        <div class="dir-actions">\n          ${buttons || '<span class="dir-locked">No actions available</span>'}\n        </div>\n      </div>`;
  }
  function actionLine(entry, user) {
    const words = ACTION_WORDS[entry.action] || [ entry.action.replace(/_/g, " "), entry.action.replace(/_/g, " ") + " by" ];
    const byThem = entry.side === "by_them";
    const other = byThem ? entry.subject_name ? `${entry.subject_name} (${entry.subject_email || "—"})` : entry.subject_email || "—" : entry.actor_email;
    return byThem ? `<strong>${escapeHtml(user.full_name || user.email)}</strong>\n         <span class="log-act">${escapeHtml(words[0])}</span>\n         ${escapeHtml(other)}` : `<span class="log-act">${escapeHtml(words[1])}</span>\n         <strong>${escapeHtml(other)}</strong>`;
  }
  function actionDetail(entry) {
    const d = entry.detail || {};
    if (d.from && d.to) {
      const was = [ d.from.full_name, d.from.account_number ].filter(Boolean).join(" · ") || "—";
      const now = [ d.to.full_name, d.to.account_number ].filter(Boolean).join(" · ") || "—";
      return `${was} → ${now}`;
    }
    if (d.from_email && d.to_email) return `${d.from_email} → ${d.to_email}`;
    if (d.reason) return `Reason: ${d.reason}`;
    if (d.note) return `Note: ${d.note}`;
    if (entry.account_number) return entry.account_number;
    return "";
  }
  async function openActions(row, user, btn) {
    const existing = row.querySelector(".dir-actions-list");
    if (existing) {
      existing.remove();
      btn.textContent = "View Actions";
      return;
    }
    const box = document.createElement("div");
    box.className = "dir-edit-form dir-actions-list";
    box.innerHTML = '<div class="queue-empty">Loading…</div>';
    row.appendChild(box);
    btn.textContent = "Hide Actions";
    try {
      const entries = await adminUserActions(user.email);
      box.innerHTML = entries.length ? entries.map(entry => {
        const detail = actionDetail(entry);
        return `\n              <div class="log-row">\n                <div class="log-when">${escapeHtml(formatApprovalStamp(entry.at))}</div>\n                <div class="log-what">${actionLine(entry, user)}</div>\n                ${detail ? `<div class="log-detail">${escapeHtml(detail)}</div>` : ""}\n              </div>`;
      }).join("") : '<div class="queue-empty">Nothing recorded for this account yet.</div>';
    } catch (err) {
      console.error("Couldn't read this account's actions:", err);
      box.innerHTML = '<div class="queue-empty">Couldn\'t read the actions. Run deploy-schema.sql in the Supabase SQL Editor.</div>';
    }
  }
  function openEditor(row, user) {
    if (row.querySelector(".dir-edit-form")) return;
    const box = document.createElement("div");
    box.className = "dir-edit-form";
    box.innerHTML = `\n      <label>Full name</label>\n      <input type="text" class="edit-name" value="${escapeHtml(user.full_name || "")}"\n             placeholder="LAST NAME, FIRST NAME M.I." autocomplete="off">\n      <label>Account numbers</label>\n      <input type="text" class="edit-accts" value="${escapeHtml(user.account_number || "")}"\n             placeholder="####-####-##, ####-####-##" autocomplete="off">\n      <div class="dir-actions">\n        <button type="button" class="dir-edit" data-act="save">Save changes</button>\n        <button type="button" data-act="cancel">Cancel</button>\n      </div>`;
    row.appendChild(box);
    const nameInput = box.querySelector(".edit-name");
    const acctsInput = box.querySelector(".edit-accts");
    const saveBtn = box.querySelector('[data-act="save"]');
    nameInput.addEventListener("input", () => {
      const caret = nameInput.selectionStart;
      nameInput.value = nameInput.value.toUpperCase();
      try {
        nameInput.setSelectionRange(caret, caret);
      } catch (_) {}
    });
    box.querySelector('[data-act="cancel"]').addEventListener("click", () => box.remove());
    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        say("Enter at least a first and last name.", false);
        return;
      }
      const numbers = parseAccountNumbers(acctsInput.value);
      const typed = acctsInput.value.split(/[,;\n]+/).map(v => v.trim()).filter(Boolean);
      for (const one of typed) {
        if (!validateAccountNumber(one, {
          required: true
        }).ok) {
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
          reason = prompt(`Disable ${label}?\n\nThey won't be able to sign in, and their ` + `statement of account goes dark. Nothing is deleted and this can ` + `be undone.\n\nReason (optional):`, "");
          if (reason === null) return;
        }
        const buttons = row.querySelectorAll("button");
        buttons.forEach(b => b.disabled = true);
        try {
          await setAccountDisabled(user.email, !user.disabled, reason);
          say(user.disabled ? `${user.email} was enabled.` : `${user.email} was disabled.`, true);
          if (typeof onChanged === "function") onChanged();
          await render(input.value);
        } catch (err) {
          console.error("Couldn't change that account's status:", err);
          say(err.message || "Couldn't change that account.", false);
          buttons.forEach(b => b.disabled = false);
        }
      });
      const deleteBtn = row.querySelector('[data-act="delete"]');
      if (deleteBtn) deleteBtn.addEventListener("click", async () => {
        const label = user.full_name ? `${user.full_name} (${user.email})` : user.email;
        if (!confirm(`Delete ${label}?\n\nThis removes their profile, account numbers, and login. ` + `It can't be undone — they'd have to register again.`)) return;
        const buttons = row.querySelectorAll("button");
        buttons.forEach(b => b.disabled = true);
        try {
          await adminDeleteUser(user.email);
          say(`${user.email} was deleted.`, true);
          if (typeof onChanged === "function") onChanged();
          await render(input.value);
        } catch (err) {
          console.error("Couldn't delete the user:", err);
          say(err.message || "Couldn't delete that account.", false);
          buttons.forEach(b => b.disabled = false);
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
      results.innerHTML = '<div class="queue-empty">Couldn\'t search. Run deploy-schema.sql in the Supabase SQL Editor.</div>';
      return;
    }
    results.innerHTML = users.length ? users.map(rowHtml).join("") : `<div class="queue-empty">${(query || "").trim() ? "Nobody matches that." : "No accounts on file yet."}</div>`;
    wire(users);
  }
  form.addEventListener("submit", async e => {
    e.preventDefault();
    searchBtn.disabled = true;
    try {
      await render(input.value);
    } finally {
      searchBtn.disabled = false;
    }
  });
  await render("");
  return {
    refresh: () => render(input.value)
  };
}

async function initEditAccountApproval(opts) {
  injectApprovalStyles();
  const {profile: profile, fullNameInput: fullNameInput, acctInput: acctInput, form: form, submitBtn: submitBtn, statusEl: statusEl, noticeSlot: noticeSlot, onProfileChanged: onProfileChanged, nameApi: nameApi, acctApi: acctApi} = opts;
  const isMainAdmin = await checkIsMainAdmin();
  function status(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status visible ${type}`;
  }
  async function paintNotice() {
    const pending = isMainAdmin ? null : await getMyPendingChange();
    let html = isMainAdmin ? `\n      <div class="approval-note">\n        As a main administrator, your changes apply immediately —\n        nobody else needs to approve them. Password changes take effect\n        immediately too.\n      </div>` : `\n      <div class="approval-note">\n        Name and account number changes need Cash Office approval.\n        Password changes take effect immediately.\n      </div>`;
    if (pending) {
      html += `\n        <div class="pending-banner">\n          <strong>Waiting for review</strong>\n          Requested ${escapeHtml(formatApprovalStamp(pending.requested_at))}:\n          ${escapeHtml(pending.requested_full_name)} &middot;\n          ${escapeHtml(pending.requested_account_number || "no account number")}.\n          Your details stay as they are until it's approved.\n          <button type="button" class="withdraw" id="withdrawChangeBtn">Withdraw</button>\n        </div>`;
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
  if (submitBtn) submitBtn.textContent = isMainAdmin ? "Save changes" : "Submit for approval";
  const DENIED = "Access denied: if the given details are valid, Please contact the administrator.";
  const ACCT_LENGTH_MSG = "LBP account numbers are default 10 digit, please input the valid account number!";
  function releaseSubmit() {
    if (typeof opts.refreshGate === "function") opts.refreshGate(); else if (submitBtn) submitBtn.disabled = false;
  }
  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (nameApi) nameApi.tidy();
    const fullName = (fullNameInput.value || "").trim();
    if (!fullName) {
      status("Enter at least a first and last name.", "error");
      return;
    }
    const acct = acctApi ? acctApi.validate() : validateAccountNumber(acctInput.value, {
      required: true
    });
    if (!acct.ok) {
      status(ACCT_LENGTH_MSG, "error");
      releaseSubmit();
      return;
    }
    const accountNumber = acct.value;
    submitBtn.disabled = true;
    try {
      if (accountNumber) {
        const clash = await accountNumbersTaken(accountNumber, profile && profile.email || null);
        if (clash.length) {
          if (typeof opts.onClash === "function") opts.onClash();
          status(DENIED, "error");
          releaseSubmit();
          return;
        }
      }
      const result = await submitProfileChangeRequest(fullName, accountNumber);
      if (result && result.immediate) {
        if (profile) {
          profile.full_name = result.full_name;
          profile.account_number = result.account_number;
        }
        status("Changes applied.", "success");
        if (typeof onProfileChanged === "function") onProfileChanged(result);
      } else {
        status("Sent for approval. You'll get an email once it's decided.", "success");
        const onFile = profile && profile.full_name || "";
        if (nameApi) {
          nameApi.fill(onFile);
        } else {
          fullNameInput.value = onFile;
        }
        if (acctApi) acctApi.fill(profile && profile.account_number || ""); else acctInput.value = formatAccountNumber(profile && profile.account_number || "");
      }
      await paintNotice();
    } catch (err) {
      console.error("Couldn't submit the change request:", err);
      if (typeof opts.onClash === "function") opts.onClash();
      status(DENIED, "error");
    } finally {
      releaseSubmit();
    }
  });
  await paintNotice();
  const isAdmin = await checkIsAdmin();
  return {
    isAdmin: isAdmin,
    refreshNotice: paintNotice
  };
}

async function adminActionLog(query, limit) {
  const {data: data, error: error} = await supabaseClient.rpc("admin_action_log", {
    p_query: query || "",
    p_limit: limit || 200
  });
  if (error) throw error;
  return data || [];
}

const LOG_ACTION_WORDS = {
  registration_approved: "approved the registration of",
  registration_rejected: "rejected the registration of",
  change_approved: "applied an account change for",
  change_rejected: "rejected an account change for",
  user_edited: "edited the account of",
  user_deleted: "deleted the account of",
  admin_added: "made an administrator:",
  admin_added_from_invite: "made an administrator (from an invitation):",
  admin_invited: "invited as an administrator:",
  admin_invite_cancelled: "cancelled the administrator invitation for",
  admin_invite_expired: "let an administrator invitation expire for",
  admin_removed: "removed administrator access from",
  admin_promoted: "made a main administrator:",
  admin_demoted: "removed main-administrator rank from",
  admin_removal_requested: "requested removal of administrator",
  account_disabled: "disabled the account of",
  account_enabled: "re-enabled the account of"
};

function logEntryDetail(entry) {
  const d = entry.detail || {};
  if (d.from && d.to) {
    const was = [ d.from.full_name, d.from.account_number ].filter(Boolean).join(" · ") || "—";
    const now = [ d.to.full_name, d.to.account_number ].filter(Boolean).join(" · ") || "—";
    return `${was} → ${now}`;
  }
  if (d.from_email && d.to_email) return `${d.from_email} → ${d.to_email}`;
  if (d.reason) return `Reason: ${d.reason}`;
  if (d.note) return `Note: ${d.note}`;
  if (entry.account_number) return entry.account_number;
  return "";
}

async function mountActionLog(container) {
  if (!container) return null;
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
  container.innerHTML = `\n    <form class="dir-search" id="logSearchForm">\n      <input type="text" id="logQuery" autocomplete="off"\n             placeholder="Name, account number, email, or action">\n      <button type="submit" id="logSearchBtn">Search</button>\n      <button type="button" id="logClearBtn">Show all</button>\n    </form>\n    <div id="logResults"></div>`;
  const form = container.querySelector("#logSearchForm");
  const input = container.querySelector("#logQuery");
  const clearBtn = container.querySelector("#logClearBtn");
  const results = container.querySelector("#logResults");
  async function load(query) {
    results.innerHTML = '<div class="queue-empty">Loading…</div>';
    try {
      const entries = await adminActionLog(query, 200);
      results.innerHTML = entries.length ? entries.map(entry => {
        const words = LOG_ACTION_WORDS[entry.action] || String(entry.action || "").replace(/_/g, " ");
        const subject = entry.subject_name ? `${entry.subject_name} (${entry.subject_email || "—"})` : entry.subject_email || "—";
        const detail = logEntryDetail(entry);
        return `\n              <div class="log-row">\n                <div class="log-when">${escapeHtml(formatApprovalStamp(entry.at))}</div>\n                <div class="log-what">\n                  <strong>${escapeHtml(entry.actor_email || "system")}</strong>\n                  <span class="log-act">${escapeHtml(words)}</span>\n                  ${escapeHtml(subject)}\n                </div>\n                ${detail ? `<div class="log-detail">${escapeHtml(detail)}</div>` : ""}\n              </div>`;
      }).join("") : `<div class="queue-empty">${query ? "Nothing recorded matches that." : "Nothing recorded yet."}</div>`;
    } catch (err) {
      console.error("Couldn't read the action log:", err);
      results.innerHTML = '<div class="queue-empty">Couldn\'t read the action log. ' + "Run deploy-schema.sql in the Supabase SQL Editor.</div>";
    }
  }
  form.addEventListener("submit", e => {
    e.preventDefault();
    load(input.value.trim());
  });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    load("");
  });
  await load("");
  return {
    reload: () => load(input.value.trim())
  };
}
