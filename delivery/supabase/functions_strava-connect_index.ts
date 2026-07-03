// Supabase Edge Function: strava-connect
// [Maker Ollie delivery 2026-07-03] Place at supabase/functions/strava-connect/index.ts
// The FORM-goggles play: every Cali Coach session auto-posts to Strava as a
// WeightTraining activity with the verified summary — calisthenics is as
// underserved on Strava as swimming was when FORM cracked it.
//
// SETUP (Ollie action): create the API app at strava.com/settings/api →
//   supabase secrets set STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=...
// Migration (add to house migrations):
//   create table public.strava_connections (
//     member_id uuid primary key references public.profiles(id) on delete cascade,
//     athlete_id bigint, access_token text, refresh_token text, expires_at timestamptz,
//     created_at timestamptz default now());
//   alter table public.strava_connections enable row level security;  -- service-role only, no public policies
//
// Routes (?action=):
//   authorize  (GET, authed)  -> redirects to Strava consent (state = member JWT)
//   callback   (GET)          -> exchanges code, stores tokens against the member
//   post       (POST, authed) -> { name, description, elapsed_secs, start? } -> creates the activity

import { createClient } from "jsr:@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get("STRAVA_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("STRAVA_CLIENT_SECRET")!;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function memberFrom(req: Request) {
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await supa.auth.getUser();
  return user;
}

async function freshToken(memberId: string): Promise<string | null> {
  const db = admin();
  const { data: c } = await db.from("strava_connections").select("*").eq("member_id", memberId).single();
  if (!c) return null;
  if (new Date(c.expires_at).getTime() - Date.now() > 60_000) return c.access_token;
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      grant_type: "refresh_token", refresh_token: c.refresh_token }),
  });
  if (!r.ok) return null;
  const t = await r.json();
  await db.from("strava_connections").update({
    access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: new Date(t.expires_at * 1000).toISOString(),
  }).eq("member_id", memberId);
  return t.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const self = `${url.origin}${url.pathname}`;

  if (action === "authorize") {
    const user = await memberFrom(req);
    if (!user) return json({ error: "not authenticated" }, 401);
    const auth = new URL("https://www.strava.com/oauth/authorize");
    auth.searchParams.set("client_id", CLIENT_ID);
    auth.searchParams.set("redirect_uri", `${self}?action=callback`);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", "activity:write");
    auth.searchParams.set("state", req.headers.get("Authorization")?.replace("Bearer ", "") ?? "");
    return json({ url: auth.toString() });          // app opens this in a browser tab
  }

  if (action === "callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? ""; // the member JWT from authorize
    if (!code) return new Response("missing code", { status: 400 });
    const fake = new Request(req.url, { headers: { Authorization: `Bearer ${state}` } });
    const user = await memberFrom(fake);
    if (!user) return new Response("state/JWT invalid or expired — reconnect from the app", { status: 401 });
    const r = await fetch("https://www.strava.com/oauth/token", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: "authorization_code" }),
    });
    if (!r.ok) return new Response("token exchange failed", { status: 502 });
    const t = await r.json();
    await admin().from("strava_connections").upsert({
      member_id: user.id, athlete_id: t.athlete?.id,
      access_token: t.access_token, refresh_token: t.refresh_token,
      expires_at: new Date(t.expires_at * 1000).toISOString(),
    });
    return new Response("<h2 style='font-family:sans-serif'>✓ Strava connected — your Cali sessions will post automatically. Close this tab.</h2>",
      { headers: { "content-type": "text/html" } });
  }

  if (action === "post" && req.method === "POST") {
    const user = await memberFrom(req);
    if (!user) return json({ error: "not authenticated" }, 401);
    const token = await freshToken(user.id);
    if (!token) return json({ error: "strava not connected" }, 409);
    const { name, description, elapsed_secs, start } = await req.json();
    const r = await fetch("https://www.strava.com/api/v3/activities", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: name ?? "Cali Coach session",
        sport_type: "WeightTraining",
        start_date_local: start ?? new Date(Date.now() - (elapsed_secs ?? 600) * 1000).toISOString(),
        elapsed_time: Math.max(60, elapsed_secs ?? 600),
        description: (description ?? "") + "\n✓ Cali Verified — scored live by AI · caliunity.com",
      }),
    });
    const body = await r.json();
    return json({ ok: r.ok, activity_id: body.id ?? null, error: r.ok ? null : body }, r.ok ? 200 : 502);
  }

  return json({ error: "unknown action" }, 400);
});
