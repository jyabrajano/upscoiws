import { createClient } from "npm:@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const SENDGRID_KEY = Deno.env.get("SENDGRID_API_KEY") ?? "";
const MAILGUN_KEY = Deno.env.get("MAILGUN_API_KEY") ?? "";
const MAILGUN_DOMAIN = Deno.env.get("MAILGUN_DOMAIN") ?? "";
const NOTIFY_FROM = Deno.env.get("NOTIFY_FROM") ?? "U.P. System Cash Office <onboarding@resend.dev>";
const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
const ALLOWED = (Deno.env.get("APP_ORIGIN") ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
if (ALLOWED.length === 0) {
    console.warn("notify-approval: APP_ORIGIN is not set — falling back to '*'. " +
        'Set it with: supabase secrets set APP_ORIGIN="https://your-domain"');
}
function corsFor(req: Request) {
    const origin = (req.headers.get("Origin") ?? "").replace(/\/+$/, "");
    const allow = ALLOWED.length === 0 ? "*" : ALLOWED.includes(origin) ? origin : ALLOWED[0];
    return {
        "Access-Control-Allow-Origin": allow,
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        Vary: "Origin",
    };
}
function json(req: Request, body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsFor(req), "Content-Type": "application/json" },
    });
}
function esc(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
type Kind = "registration" | "profile_change";
type Decision = "approved" | "rejected";
interface Payload {
    kind: Kind;
    email: string;
    full_name?: string | null;
    account_number?: string | null;
    decision: Decision;
    reason?: string | null;
}
function subjectFor(p: Payload): string {
    if (p.kind === "registration") {
        return p.decision === "approved"
            ? "Your portal access is approved — U.P. System Cash Office"
            : "About your portal access request — U.P. System Cash Office";
    }
    return p.decision === "approved"
        ? "Your account details were updated — U.P. System Cash Office"
        : "About your requested account change — U.P. System Cash Office";
}
function headlineFor(p: Payload): string {
    if (p.kind === "registration") {
        return p.decision === "approved"
            ? "You can now sign in"
            : "Your access request wasn't approved";
    }
    return p.decision === "approved"
        ? "Your changes have been applied"
        : "Your requested change wasn't approved";
}
function bodyFor(p: Payload): string {
    if (p.kind === "registration") {
        return p.decision === "approved"
            ? "The Cash Office has reviewed your registration and approved your access " +
                "to the U.P. System Cash Office portal. Sign in with the email address " +
                "and password you registered with."
            : "The Cash Office has reviewed your registration and wasn't able to approve " +
                "it. If you think this is a mistake, contact the Cash Office directly — " +
                "replying to this message won't reach anyone.";
    }
    return p.decision === "approved"
        ? "The change you submitted from Edit Account has been reviewed and applied " +
            "to your record. The updated details are below."
        : "The change you submitted from Edit Account was reviewed and not applied. " +
            "Your record is unchanged — nothing was lost, and you can submit a new " +
            "request from Edit Account.";
}
function reasonBlock(p: Payload): string {
    if (!p.reason)
        return "";
    return `
        <tr>
          <td style="padding:20px 32px 0;font-family:Helvetica,Arial,sans-serif;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="background-color:#fef9ec;border:1px solid #fde68a;border-radius:9px;">
              <tr>
                <td style="padding:14px 16px;color:#854d0e;font-size:13px;line-height:1.55;">
                  <strong style="display:block;padding-bottom:4px;font-size:13.5px;">
                    Note from the Cash Office
                  </strong>
                  ${esc(p.reason)}
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
}
function detailBlock(p: Payload): string {
    const rows: string[] = [];
    if (p.full_name) {
        rows.push(`<tr><td style="padding:4px 0;color:#64748b;width:132px;">Name</td>` +
            `<td style="padding:4px 0;color:#1e293b;font-weight:bold;">${esc(p.full_name)}</td></tr>`);
    }
    if (p.account_number) {
        rows.push(`<tr><td style="padding:4px 0;color:#64748b;">Account number</td>` +
            `<td style="padding:4px 0;color:#1e293b;font-weight:bold;font-family:Consolas,'Courier New',monospace;">` +
            `${esc(p.account_number)}</td></tr>`);
    }
    if (rows.length === 0)
        return "";
    return `
        <tr>
          <td style="padding:18px 32px 0;font-family:Helvetica,Arial,sans-serif;font-size:13.5px;line-height:1.6;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${rows.join("")}
            </table>
          </td>
        </tr>`;
}
function buttonBlock(p: Payload): string {
    if (p.decision !== "approved" || !APP_URL)
        return "";
    const label = p.kind === "registration" ? "Sign in to the portal" : "Open the portal";
    return `
        <tr>
          <td align="center" style="padding:22px 32px 4px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#7b1113"
                    style="border-radius:9px;
                           background-image:linear-gradient(135deg,#7b1113 0%,#5c0d0f 100%);
                           box-shadow:0 3px 10px rgba(123,17,19,0.28);">
                  <a href="${esc(APP_URL)}/index.html"
                     style="display:inline-block;padding:14px 30px;font-family:Helvetica,Arial,sans-serif;
                            font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;
                            border-radius:9px;letter-spacing:0.3px;">
                    ${label}
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
}
function renderEmail(p: Payload): string {
    const strapline = p.kind === "registration" ? "Registration Decision" : "Account Change Decision";
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="margin:0;padding:0;background-color:#f7f4ef;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:520px;background-color:#ffffff;border-radius:14px;overflow:hidden;
                    border:1px solid rgba(123,17,19,0.1);
                    box-shadow:0 8px 32px rgba(92,13,15,0.14);">

        <tr>
          <td align="center" bgcolor="#7b1113"
              style="background-color:#7b1113;
                     background-image:linear-gradient(135deg,#4a090a 0%,#5c0d0f 35%,#7b1113 70%,#911518 100%);
                     padding:32px 28px 26px;border-top:3px solid #f5b041;
                     font-family:Helvetica,Arial,sans-serif;">
            <div style="color:#ffffff;font-size:20px;font-weight:bold;line-height:1.3;letter-spacing:0.6px;">
              U.P. System Cash Office - IntWSys
            </div>
            <div style="color:rgba(255,255,255,0.78);font-size:11px;letter-spacing:1.5px;
                        text-transform:uppercase;padding-top:8px;font-family:Consolas,'Courier New',monospace;">
              ${strapline}
            </div>
          </td>
        </tr>
        <tr>
          <td style="height:4px;line-height:4px;font-size:0;background-color:#f5b041;">&nbsp;</td>
        </tr>

        <tr>
          <td style="padding:32px 32px 8px;font-family:Helvetica,Arial,sans-serif;
                     color:#1e293b;font-size:15px;line-height:1.6;">
            <p style="margin:0 0 16px;font-size:17px;font-weight:bold;color:#7b1113;">
              ${headlineFor(p)}
            </p>
            <p style="margin:0;">${bodyFor(p)}</p>
          </td>
        </tr>
        ${detailBlock(p)}
        ${buttonBlock(p)}
        ${reasonBlock(p)}

        <tr>
          <td style="padding:24px 32px 28px;font-family:Helvetica,Arial,sans-serif;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="border-top:1px solid #e2e8f0;padding-top:16px;
                           color:#94a3b8;font-size:11.5px;line-height:1.6;">
                  This is an automated message about the portal account registered to
                  ${esc(p.email)}. Please don't reply to it.
                  <br><br>
                  University of the Philippines System Cash Office &middot; Authorized personnel only
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>`;
}
function renderText(p: Payload): string {
    const lines = [
        "U.P. SYSTEM CASH OFFICE - IntWSys",
        "",
        headlineFor(p),
        "",
        bodyFor(p).replace(/\s+/g, " "),
    ];
    if (p.full_name)
        lines.push("", `Name: ${p.full_name}`);
    if (p.account_number)
        lines.push(`Account number: ${p.account_number}`);
    if (p.reason)
        lines.push("", `Note from the Cash Office: ${p.reason}`);
    if (p.decision === "approved" && APP_URL) {
        lines.push("", `Sign in: ${APP_URL}/index.html`);
    }
    lines.push("", "---", `Automated message about the portal account registered to ${p.email}. Please don't reply.`, "University of the Philippines System Cash Office - Authorized personnel only");
    return lines.join("\n");
}
interface SendResult {
    ok: boolean;
    provider: string;
    detail?: string;
}
async function send(to: string, subject: string, html: string, text: string): Promise<SendResult> {
    if (RESEND_KEY) {
        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${RESEND_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ from: NOTIFY_FROM, to: [to], subject, html, text }),
        });
        if (!res.ok)
            return { ok: false, provider: "resend", detail: await res.text() };
        return { ok: true, provider: "resend" };
    }
    if (SENDGRID_KEY) {
        const match = NOTIFY_FROM.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
        const from = match
            ? { name: match[1], email: match[2] }
            : { email: NOTIFY_FROM.trim() };
        const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${SENDGRID_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                personalizations: [{ to: [{ email: to }] }],
                from,
                subject,
                content: [
                    { type: "text/plain", value: text },
                    { type: "text/html", value: html },
                ],
            }),
        });
        if (!res.ok)
            return { ok: false, provider: "sendgrid", detail: await res.text() };
        return { ok: true, provider: "sendgrid" };
    }
    if (MAILGUN_KEY && MAILGUN_DOMAIN) {
        const form = new FormData();
        form.append("from", NOTIFY_FROM);
        form.append("to", to);
        form.append("subject", subject);
        form.append("html", html);
        form.append("text", text);
        const res = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
            method: "POST",
            headers: { Authorization: "Basic " + btoa(`api:${MAILGUN_KEY}`) },
            body: form,
        });
        if (!res.ok)
            return { ok: false, provider: "mailgun", detail: await res.text() };
        return { ok: true, provider: "mailgun" };
    }
    return {
        ok: false,
        provider: "none",
        detail: "No email provider is configured. Set RESEND_API_KEY, SENDGRID_API_KEY, " +
            "or MAILGUN_API_KEY (+ MAILGUN_DOMAIN) with `supabase secrets set`.",
    };
}
Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsFor(req) });
    }
    try {
        const authHeader = req.headers.get("Authorization") ?? "";
        if (!authHeader.startsWith("Bearer ")) {
            return json(req, { error: "Not signed in." }, 401);
        }
        const caller = createClient(SUPABASE_URL, ANON_KEY, {
            global: { headers: { Authorization: authHeader } },
        });
        const { data: whoami, error: whoamiErr } = await caller.auth.getUser();
        if (whoamiErr || !whoami?.user?.email) {
            return json(req, { error: "Not signed in." }, 401);
        }
        const { data: isAdmin, error: adminErr } = await caller.rpc("is_admin");
        if (adminErr || isAdmin !== true) {
            return json(req, { error: "Not authorized." }, 403);
        }
        const raw = await req.json().catch(() => ({}));
        const kind = String(raw?.kind ?? "");
        const email = String(raw?.email ?? "").trim();
        const decision = String(raw?.decision ?? "");
        if (kind !== "registration" && kind !== "profile_change") {
            return json(req, { error: "`kind` must be registration or profile_change." }, 400);
        }
        if (!email || !email.includes("@")) {
            return json(req, { error: "A valid `email` is required." }, 400);
        }
        if (decision !== "approved" && decision !== "rejected") {
            return json(req, { error: "`decision` must be approved or rejected." }, 400);
        }
        const payload: Payload = {
            kind: kind as Kind,
            email,
            full_name: raw?.full_name ?? null,
            account_number: raw?.account_number ?? null,
            decision: decision as Decision,
            reason: raw?.reason ?? null,
        };
        const result = await send(email, subjectFor(payload), renderEmail(payload), renderText(payload));
        if (!result.ok) {
            console.error("notify-approval send failed:", result.provider, result.detail);
            return json(req, { error: result.detail ?? "Couldn't send the email.", provider: result.provider }, 503);
        }
        return json(req, { sent: true, email, kind, decision, provider: result.provider });
    }
    catch (err) {
        console.error("notify-approval failed:", err);
        return json(req, { error: (err as Error).message ?? "Unknown error" }, 500);
    }
});
