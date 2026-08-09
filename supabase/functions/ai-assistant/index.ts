import { createClient } from "npm:@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("AI_MODEL") ?? "";
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 4000;
const ALLOWED = (Deno.env.get("APP_ORIGIN") ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
if (ALLOWED.length === 0) {
    console.warn("ai-assistant: APP_ORIGIN is not set — falling back to '*'. " +
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
const DEFAULT_SYSTEM_PROMPT = `
You are the help assistant built into the University of the Philippines
System Cash Office web portal (IntWSys). You help UP staff and suppliers
use the portal itself.

What the portal does:
- The Dashboard shows announcements, a calendar, and available transactions.
- The Statement of Account (SOA) page has two tabs. ATM shows payments
  credited to a registered LBP account number. CHECK shows released
  cheques, matched by the email address on the record.
- Edit Account is where someone changes their name or LBP account
  numbers. Changes are not immediate: they go to the Cash Office as a
  request and take effect once an administrator approves them.
- An account number is a 10-digit LBP number, shown as 9999-9999-99.
  A profile can hold up to three.
- New registrations are reviewed by hand. Confirming an email address
  does not grant access on its own.

How to answer:
- Be brief and plain. Two or three sentences is usually right.
- You cannot see anyone's transactions, balances, account numbers or
  profile. You have no access to the database. If asked about a
  specific payment, amount, date or cheque, say so and point the
  person at the ATM or CHECK tab on the SOA page.
- Never estimate, guess or reconstruct a figure, a date or a payment
  status. If it is not on their screen, the answer is to ask the Cash
  Office.
- You cannot approve registrations, change account numbers, reset
  passwords or alter anything. Those go through the Cash Office.
- For anything outside the portal — tax, payroll, disbursement policy,
  when a payment will be released — say it is a Cash Office question
  and stop there.
- If you are not sure, say you are not sure.
`.trim();
const SYSTEM_PROMPT = Deno.env.get("AI_SYSTEM_PROMPT") ?? DEFAULT_SYSTEM_PROMPT;
interface Turn {
    role: "user" | "assistant";
    content: string;
}
interface Result {
    ok: boolean;
    provider: string;
    reply?: string;
    detail?: string;
}
async function askAnthropic(turns: Turn[]): Promise<Result> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: MODEL || "claude-sonnet-4-6",
            max_tokens: 700,
            system: SYSTEM_PROMPT,
            messages: turns,
        }),
    });
    if (!res.ok) {
        return {
            ok: false,
            provider: "anthropic",
            detail: `${res.status} ${await res.text().catch(() => "")}`.slice(0, 400),
        };
    }
    const data = await res.json();
    const reply = (data?.content ?? [])
        .filter((b: {
        type?: string;
    }) => b?.type === "text")
        .map((b: {
        text?: string;
    }) => b.text ?? "")
        .join("")
        .trim();
    return reply
        ? { ok: true, provider: "anthropic", reply }
        : { ok: false, provider: "anthropic", detail: "Empty reply." };
}
async function askOpenAI(turns: Turn[]): Promise<Result> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify({
            model: MODEL || "gpt-4o-mini",
            max_tokens: 700,
            messages: [{ role: "system", content: SYSTEM_PROMPT }, ...turns],
        }),
    });
    if (!res.ok) {
        return {
            ok: false,
            provider: "openai",
            detail: `${res.status} ${await res.text().catch(() => "")}`.slice(0, 400),
        };
    }
    const data = await res.json();
    const reply = String(data?.choices?.[0]?.message?.content ?? "").trim();
    return reply
        ? { ok: true, provider: "openai", reply }
        : { ok: false, provider: "openai", detail: "Empty reply." };
}
async function ask(turns: Turn[]): Promise<Result> {
    if (ANTHROPIC_KEY)
        return await askAnthropic(turns);
    if (OPENAI_KEY)
        return await askOpenAI(turns);
    return {
        ok: false,
        provider: "none",
        detail: "No model provider is configured. Set ANTHROPIC_API_KEY or " +
            "OPENAI_API_KEY with `supabase secrets set`.",
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
        const [{ data: approved }, { data: admin }, { data: disabled }] = await Promise.all([
            caller.rpc("is_approved_user"),
            caller.rpc("is_admin"),
            caller.rpc("is_disabled"),
        ]);
        if (disabled === true || (approved !== true && admin !== true)) {
            return json(req, { error: "Not authorized." }, 403);
        }
        const raw = await req.json().catch(() => ({}));
        const message = String(raw?.message ?? "").trim();
        if (!message) {
            return json(req, { error: "`message` is required." }, 400);
        }
        if (message.length > MAX_MESSAGE_CHARS) {
            return json(req, { error: "That message is too long." }, 400);
        }
        const history: Turn[] = Array.isArray(raw?.history)
            ? raw.history
                .filter((t: unknown): t is Turn => !!t &&
                typeof t === "object" &&
                ((t as Turn).role === "user" || (t as Turn).role === "assistant") &&
                typeof (t as Turn).content === "string" &&
                (t as Turn).content.trim().length > 0)
                .slice(-MAX_HISTORY)
                .map((t: Turn) => ({
                role: t.role,
                content: t.content.slice(0, MAX_MESSAGE_CHARS),
            }))
            : [];
        while (history.length && history[0].role !== "user")
            history.shift();
        const turns: Turn[] = [...history, { role: "user", content: message }];
        const result = await ask(turns);
        if (!result.ok) {
            console.error("ai-assistant failed:", result.provider, result.detail);
            return json(req, { error: result.detail ?? "Couldn't reach the assistant.", provider: result.provider }, 503);
        }
        return json(req, { reply: result.reply });
    }
    catch (err) {
        console.error("ai-assistant crashed:", err);
        return json(req, { error: "Couldn't reach the assistant." }, 500);
    }
});
