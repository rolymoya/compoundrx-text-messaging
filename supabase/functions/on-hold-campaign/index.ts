import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PODIUM_CLIENT_ID = Deno.env.get("PODIUM_CLIENT_ID")!;
const PODIUM_CLIENT_SECRET = Deno.env.get("PODIUM_CLIENT_SECRET")!;
const PODIUM_REFRESH_TOKEN = Deno.env.get("PODIUM_REFRESH_TOKEN")!;
const PODIUM_LOCATION_UID = Deno.env.get("PODIUM_LOCATION_UID")!;

const PODIUM_BASE_URL = "https://api.podium.com/v4";
const ON_HOLD_REMINDER_FALLBACK =
    "You have 1 or more prescriptions on hold at CompoundRx Pharmacy. Please reply or call to let us know how you'd like to proceed.";

async function getOnHoldTemplate(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from("messaging_groups")
    .select("templates")
    .eq("name", "default")
    .single();

  if (error || !data) {
    console.error("Failed to fetch On_Hold_Campaign template:", error);
    return null;
  }

  return data.templates?.On_Hold_Campaign ?? null;
}

function renderTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? "");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}


async function getPodiumToken(): Promise<string | null> {
  try {
    const res = await fetch("https://accounts.podium.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PODIUM_CLIENT_ID,
        client_secret: PODIUM_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: PODIUM_REFRESH_TOKEN,
      }),
    });
    const data = await res.json();
    return data.access_token ?? null;
  } catch (err) {
    console.error("Error retrieving Podium token:", err);
    return null;
  }
}

async function sendPodiumMessage(token: string, phoneNumber: string, message: string): Promise<boolean> {
  const payload = {
    locationUid: PODIUM_LOCATION_UID,
    body: message,
    //For now, Roly's phone number
    channel: { type: "phone", identifier: "7866129167" },
  };

  const res = await fetch(`${PODIUM_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`Failed to send to ${phoneNumber}:`, err);
    return false;
  }

  console.log(`Sent on-hold reminder to ${phoneNumber}`);
  return true;
}

async function runCampaign(supabase: SupabaseClient): Promise<Response> {
  console.log("Starting on-hold campaign...");

  const { data: patients, error } = await supabase
      .from("on_hold_patients")
      .select("*");

  if (error) {
    console.error("Failed to fetch on-hold patients:", error);
    return json({ error: error.message }, 500);
  }

  if (!patients || patients.length === 0) {
    console.log("No on-hold patients to message.");
    return json({ message: "No patients to message" });
  }

  const token = await getPodiumToken();
  if (!token) {
    return json({ error: "Failed to get Podium token" }, 401);
  }

  const templateMessage = await getOnHoldTemplate(supabase) ?? ON_HOLD_REMINDER_FALLBACK;
  if (templateMessage === ON_HOLD_REMINDER_FALLBACK) {
    console.warn("On_Hold_Campaign template not found in messaging_groups, using fallback message.");
  } else {
    console.log("Using On_Hold_Campaign template from messaging_groups.");
  }

  let sent = 0;
  let failed = 0;

  for (const patient of patients) {
    try {
      const message = renderTemplate(templateMessage, { firstName: patient.first_name ?? "" });
      const ok = await sendPodiumMessage(token, patient.phone_number, message);
      if (ok) sent++;
      else failed++;
    } catch (err) {
      failed++;
      console.error(`Error sending to ${patient.phone_number}:`, err);
    }
  }

  console.log(`On-hold campaign complete: ${sent} sent, ${failed} failed`);
  return json({ sent, failed });
}

async function handleStop(supabase: SupabaseClient, req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  console.log("Podium STOP webhook received:", JSON.stringify(body));
  console.log("phone number", JSON.stringify(body?.conversation?.channel?.identifier))

  const phoneNumber = body?.conversation?.channel?.identifier;
  const message: string= body?.body;

  if (!phoneNumber) {
    console.error("STOP webhook missing phone number");
    return json({ error: "Missing phone number" }, 400);
  }

  if (!message || !message.includes("STOP")) {
    console.log("Message not STOP");
    return json({Success: "All good"}, 200);
  }

  const { data, error } = await supabase
      .from("on_hold_patients")
      .delete()
      .eq("phone_number", phoneNumber)
      .select();

  if (error) {
    console.error("Failed to delete on-hold patient:", error);
    return json({ error: error.message }, 500);
  }

  console.log(`Removed ${data?.length ?? 0} on-hold record(s) for ${phoneNumber}`);
  return json({ removed: phoneNumber, count: data?.length ?? 0 });
}

serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { pathname } = new URL(req.url);

    // Podium STOP webhook → /on-hold-campaign/stop
    if (pathname.endsWith("/stop")) {
      return await handleStop(supabase, req);
    }

    // Default (cron trigger) → /on-hold-campaign
    return await runCampaign(supabase);
  } catch (error) {
    console.error("Edge function error:", error);
    return json({ error: (error as Error).message }, 500);
  }
});
