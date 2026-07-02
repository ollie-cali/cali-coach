// Supabase Edge Function: coach-summary
// [Maker Ollie delivery] Place at supabase/functions/coach-summary/index.ts
// The production home of the AI coach: client sends the numeric session JSON,
// Claude replies with the coaching paragraph. The Anthropic key lives HERE
// (edge secret), never on a client. Set: supabase secrets set ANTHROPIC_API_KEY=...
import { createClient } from "jsr:@supabase/supabase-js@2";

const SYSTEM = `You are the Cali calisthenics coach: direct, warm, expert. British English. Never use em dashes or en dashes. Given session data (handstand alignment scores out of 100 where deductions come from closed shoulders, banana back, bent knees and lean; push-up scores from depth, body line and lockout), give: 1) a one-line verdict, 2) the single biggest fix with a concrete drill, 3) one thing they did well. Max 90 words.`;

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // auth: must be a logged-in member
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } } },
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: "not authenticated" }), { status: 401, headers: cors });

  const { session } = await req.json();          // the numeric session array only
  if (!Array.isArray(session) || session.length === 0 || JSON.stringify(session).length > 8000)
    return new Response(JSON.stringify({ error: "bad session payload" }), { status: 400, headers: cors });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 350,
      system: SYSTEM,
      messages: [{ role: "user", content: "Session data: " + JSON.stringify(session) }],
    }),
  });
  const j = await r.json();
  const text = j.content?.[0]?.text ?? null;
  return new Response(JSON.stringify({ text, error: text ? null : j.error }), {
    headers: { ...cors, "content-type": "application/json" },
  });
});
