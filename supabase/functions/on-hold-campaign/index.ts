import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PODIUM_CLIENT_ID = Deno.env.get("PODIUM_CLIENT_ID")!;
const PODIUM_CLIENT_SECRET = Deno.env.get("PODIUM_CLIENT_SECRET")!;
const PODIUM_REFRESH_TOKEN = Deno.env.get("PODIUM_REFRESH_TOKEN")!;
const PODIUM_LOCATION_UID = Deno.env.get("PODIUM_LOCATION_UID")!;

const PODIUM_BASE_URL = "https://api.podium.com/v4";
const ON_HOLD_REMINDER_MESSAGE =
  "You have 1 or more prescriptions on hold at CompoundRx Pharmacy. Please reply or call to let us know how you'd like to proceed.";

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
    const json = await res.json();
    return json.access_token ?? null;
  } catch (err) {
    console.error("Error retrieving Podium token:", err);
    return null;
  }
}

async function sendPodiumMessage(token: string, phoneNumber: string): Promise<boolean> {
  const payload = {
    locationUid: PODIUM_LOCATION_UID,
    body: ON_HOLD_REMINDER_MESSAGE,
    channel: { type: "phone", identifier: phoneNumber },
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

serve(async (_req) => {
  try {
    console.log("Starting on-hold campaign...");

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: patients, error } = await supabase
      .from("on_hold_patients")
      .select("*");

    if (error) {
      console.error("Failed to fetch on-hold patients:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!patients || patients.length === 0) {
      console.log("No on-hold patients to message.");
      return new Response(
        JSON.stringify({ message: "No patients to message" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const token = await getPodiumToken();
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Failed to get Podium token" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    let sent = 0;
    let failed = 0;

    for (const patient of patients) {
      try {
        const ok = await sendPodiumMessage(token, patient.phone_number);
        if (ok) sent++;
        else failed++;
      } catch (err) {
        failed++;
        console.error(`Error sending to ${patient.phone_number}:`, err);
      }
    }

    console.log(`On-hold campaign complete: ${sent} sent, ${failed} failed`);
    return new Response(JSON.stringify({ sent, failed }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Campaign error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
