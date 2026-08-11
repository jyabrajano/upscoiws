// ============================================================
// admin-delete-user — Supabase Edge Function
//
// Called by approval.js (adminDeleteUser) when a main administrator
// removes a user entirely. Deleting the Auth login needs the
// service-role key and the Auth Admin API, neither of which belongs
// in the browser — so this is the one step of user deletion that
// can't be a plain RPC.
//
// Two identities, same shape as notify-approval:
//
//   the caller   their JWT is verified here and must belong to a
//                main administrator (checked the same way
//                admin_delete_user_data() checks it, so the two
//                can't disagree).
//   service      the service-role key, held only in this runtime,
//                used only for auth.admin.deleteUser().
//
// Order of operations matters: the database rows are removed first
// (via admin_delete_user_data, which also re-checks authorization
// server-side and returns the user_id), and only once that succeeds
// is the Auth login deleted. A failure partway through leaves a
// profile-less Auth user rather than a login-less profile, which is
// the safer of the two half-finished states — the account simply
// can't sign in and reach anything.
//
// Deploy:
//   supabase functions deploy admin-delete-user
//
// Needs no extra secrets beyond what every project already has:
// SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are
// injected automatically for Edge Functions.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Comma-separated list, same convention as notify-approval's
// APP_ORIGIN, so staging and production can both be allowed without
// loosening this to "*".
const ALLOWED = (Deno.env.get("APP_ORIGIN") ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsFor(req) });
  }

  try {
    if (!SERVICE_ROLE_KEY) {
      return json(
        req,
        { error: "SUPABASE_SERVICE_ROLE_KEY is not available to this function." },
        500,
      );
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json(req, { error: "Not signed in." }, 401);
    }

    // ---- who is asking ----
    // Verified against Auth using the caller's own JWT. Authorization
    // (main-administrator only) is enforced again, server-side, inside
    // admin_delete_user_data() — this call can't skip that check by
    // itself, it just fails the RPC below if it isn't one.
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: whoami, error: whoamiErr } = await caller.auth.getUser();
    if (whoamiErr || !whoami?.user?.email) {
      return json(req, { error: "Not signed in." }, 401);
    }
    const actorEmail = whoami.user.email;

    // ---- what they're asking for ----
    const raw = await req.json().catch(() => ({}));
    const email = String(raw?.email ?? "").trim();
    if (!email || !email.includes("@")) {
      return json(req, { error: "A valid `email` is required." }, 400);
    }

    // ---- remove the database rows first ----
    // Runs as the caller (not service role) so the function's own
    // authorization checks (main-admin, not self, not another main
    // admin) apply exactly as they do when called from SQL directly.
    const { data: result, error: rpcErr } = await caller.rpc("admin_delete_user_data", {
      p_actor_email: actorEmail,
      p_email: email,
    });
    if (rpcErr) {
      return json(req, { error: rpcErr.message }, 400);
    }

    const userId = result?.user_id ?? null;

    // ---- then the Auth login, with the service role ----
    // Only reachable once the RPC above has already succeeded, so a
    // user without a matching `profiles` row (already deleted, never
    // finished signing up, etc.) never reaches this far.
    if (userId) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
      const { error: authDeleteErr } = await admin.auth.admin.deleteUser(userId);
      if (authDeleteErr) {
        console.error("admin-delete-user: auth delete failed:", authDeleteErr);
        // The profile and related rows are already gone at this point.
        // Say so plainly rather than reporting a clean success when the
        // login can still sign in.
        return json(
          req,
          {
            error:
              "Account data was removed, but deleting the sign-in login failed: " +
              authDeleteErr.message,
            partial: true,
          },
          502,
        );
      }
    }

    return json(req, { deleted: true, email, full_name: result?.full_name ?? null });
  } catch (err) {
    console.error("admin-delete-user failed:", err);
    return json(req, { error: (err as Error).message ?? "Unknown error" }, 500);
  }
});
