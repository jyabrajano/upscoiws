// ============================================================
// ai-assistant — Supabase Edge Function
//
// dashboard.html has been calling this since the chat panel was
// added. It was never written and never deployed, so every message
// in the panel fell through to "Sorry, I couldn't reach the
// assistant right now."
//
// The contract is set by dashboard.html and is not negotiable here:
//
//   request   { message: string, history: [{ role, content }, ...] }
//   response  { reply: string }              -> shown as the answer
//             { error: string }              -> shown as the fallback
//
// dashboard.html treats any error, any missing body, and any body
// carrying an `error` key identically: it prints the same apologetic
// line. So a misconfigured deployment degrades to exactly the
// behaviour there is today — it does not get worse.
//
// Same two identities as notify-approval and admin-delete-user:
//
//   the caller   their JWT is verified here, and they must be an
//                approved, non-disabled portal user. Without that,
//                the anon key alone would be a public, billable
//                proxy to a paid model API.
//   provider     a model API key held only in this runtime.
//
// ---- WHICH MODEL PROVIDER ----
// Whichever key is set is the one used, checked in this order:
//
//   ANTHROPIC_API_KEY   -> Anthropic  (https://console.anthropic.com)
//   OPENAI_API_KEY      -> OpenAI     (https://platform.openai.com)
//
// If neither is set the function returns 503 and the panel shows its
// existing fallback line. Nothing else in the portal is affected.
//
// Deploy:
//   supabase functions deploy ai-assistant
//
// Secrets:
//   supabase secrets set ANTHROPIC_API_KEY="sk-ant-..."
//   supabase secrets set APP_ORIGIN="https://your-actual-domain"
//   # optional, both have sensible defaults:
//   supabase secrets set AI_MODEL="claude-sonnet-4-6"
//   supabase secrets set AI_SYSTEM_PROMPT="..."
//
// ---- IF YOU'D RATHER NOT HAVE THE PANEL ----
// Deleting this function is not enough on its own — dashboard.html
// would go back to calling something that isn't there. Remove the
// panel markup and sendAiMessage() from dashboard.html instead.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const MODEL = Deno.env.get("AI_MODEL") ?? "";

// How much of the conversation is forwarded. The panel keeps the whole
// thread client-side and sends all of it every time, so without a cap
// a long session grows the request — and the bill — without bound.
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 4000;

// ---- CORS ----
// APP_ORIGIN takes a comma-separated list, so a staging URL and a
// production URL can both be allowed without loosening this to "*".
const ALLOWED = (Deno.env.get("APP_ORIGIN") ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

if (ALLOWED.length === 0) {
  console.warn(
    "ai-assistant: APP_ORIGIN is not set — falling back to '*'. " +
      'Set it with: supabase secrets set APP_ORIGIN="https://your-domain"',
  );
}

function corsFor(req: Request) {
  const origin = (req.headers.get("Origin") ?? "").replace(/\/+$/, "");
  const allow =
    ALLOWED.length === 0 ? "*" : ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
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

// ---- what it's allowed to be ----
//
// Deliberately narrow. This assistant sits on a page showing people
// their own payment records, so the failure mode that matters is not a
// dull answer — it is a confident wrong one about money. It is told to
// route anything factual about a specific transaction back to the
// tables on the page, and back to the Cash Office for anything else.
//
// It is never handed the caller's transactions. It answers questions
// about how the portal works, not about what is in it.

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

// ---- the providers ----

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
    .filter((b: { type?: string }) => b?.type === "text")
    .map((b: { text?: string }) => b.text ?? "")
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
  if (ANTHROPIC_KEY) return await askAnthropic(turns);
  if (OPENAI_KEY) return await askOpenAI(turns);
  return {
    ok: false,
    provider: "none",
    detail:
      "No model provider is configured. Set ANTHROPIC_API_KEY or " +
      "OPENAI_API_KEY with `supabase secrets set`.",
  };
}

// ---- handler ----

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsFor(req) });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json(req, { error: "Not signed in." }, 401);
    }

    // ---- who is asking ----
    // An approved, non-disabled portal user, verified against Auth and
    // the database — not taken from the body. Without this the anon key
    // is a public proxy to a metered API, and the bill is yours.
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: whoami, error: whoamiErr } = await caller.auth.getUser();
    if (whoamiErr || !whoami?.user?.email) {
      return json(req, { error: "Not signed in." }, 401);
    }

    const [{ data: approved }, { data: admin }, { data: disabled }] =
      await Promise.all([
        caller.rpc("is_approved_user"),
        caller.rpc("is_admin"),
        caller.rpc("is_disabled"),
      ]);

    if (disabled === true || (approved !== true && admin !== true)) {
      return json(req, { error: "Not authorized." }, 403);
    }

    // ---- what they're asking ----
    const raw = await req.json().catch(() => ({}));
    const message = String(raw?.message ?? "").trim();

    if (!message) {
      return json(req, { error: "`message` is required." }, 400);
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return json(req, { error: "That message is too long." }, 400);
    }

    // The panel sends its own running history. Rebuild it here rather
    // than trusting its shape: anything that isn't a well-formed user
    // or assistant turn is dropped, and only the last MAX_HISTORY
    // survive. A client is not a source of truth about what it said.
    const history: Turn[] = Array.isArray(raw?.history)
      ? raw.history
          .filter(
            (t: unknown): t is Turn =>
              !!t &&
              typeof t === "object" &&
              ((t as Turn).role === "user" || (t as Turn).role === "assistant") &&
              typeof (t as Turn).content === "string" &&
              (t as Turn).content.trim().length > 0,
          )
          .slice(-MAX_HISTORY)
          .map((t: Turn) => ({
            role: t.role,
            content: t.content.slice(0, MAX_MESSAGE_CHARS),
          }))
      : [];

    // Both provider APIs require the turns to alternate and to start
    // with a user turn. A history that begins mid-thread — which the
    // slice above can easily produce — is rejected outright by
    // Anthropic, so trim from the front until it starts correctly.
    while (history.length && history[0].role !== "user") history.shift();

    const turns: Turn[] = [...history, { role: "user", content: message }];

    // ---- ask ----
    const result = await ask(turns);

    if (!result.ok) {
      console.error("ai-assistant failed:", result.provider, result.detail);
      // 503 rather than 500: nothing is broken in the portal, the
      // assistant just isn't answering. dashboard.html turns any of
      // this into its existing fallback line.
      return json(
        req,
        { error: result.detail ?? "Couldn't reach the assistant.", provider: result.provider },
        503,
      );
    }

    return json(req, { reply: result.reply });
  } catch (err) {
    console.error("ai-assistant crashed:", err);
    return json(req, { error: "Couldn't reach the assistant." }, 500);
  }
});
