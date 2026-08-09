import { createClient } from "npm:@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED = (Deno.env.get("APP_ORIGIN") ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
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
Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsFor(req) });
    }
    try {
        if (!SERVICE_ROLE_KEY) {
            return json(req, { error: "SUPABASE_SERVICE_ROLE_KEY is not available to this function." }, 500);
        }
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
        const actorEmail = whoami.user.email;
        const raw = await req.json().catch(() => ({}));
        const email = String(raw?.email ?? "").trim();
        if (!email || !email.includes("@")) {
            return json(req, { error: "A valid `email` is required." }, 400);
        }
        const { data: result, error: rpcErr } = await caller.rpc("admin_delete_user_data", {
            p_actor_email: actorEmail,
            p_email: email,
        });
        if (rpcErr) {
            return json(req, { error: rpcErr.message }, 400);
        }
        const userId = result?.user_id ?? null;
        if (userId) {
            const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
            const { error: authDeleteErr } = await admin.auth.admin.deleteUser(userId);
            if (authDeleteErr) {
                console.error("admin-delete-user: auth delete failed:", authDeleteErr);
                return json(req, {
                    error: "Account data was removed, but deleting the sign-in login failed: " +
                        authDeleteErr.message,
                    partial: true,
                }, 502);
            }
        }
        return json(req, { deleted: true, email, full_name: result?.full_name ?? null });
    }
    catch (err) {
        console.error("admin-delete-user failed:", err);
        return json(req, { error: (err as Error).message ?? "Unknown error" }, 500);
    }
});
