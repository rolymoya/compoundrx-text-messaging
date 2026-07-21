import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PODIUM_CLIENT_ID = Deno.env.get("PODIUM_CLIENT_ID")!;
const PODIUM_CLIENT_SECRET = Deno.env.get("PODIUM_CLIENT_SECRET")!;
const PODIUM_REFRESH_TOKEN = Deno.env.get("PODIUM_REFRESH_TOKEN")!;
const PODIUM_LOCATION_UID = Deno.env.get("PODIUM_LOCATION_UID")!;

const PODIUM_BASE_URL = "https://api.podium.com/v4";
// Fallbacks mirror the On_Hold_Campaign / On_Hold_Campaign_Final DB templates
// (bilingual, with opt-out) so a fallback send matches the intended message.
const ON_HOLD_REMINDER_FALLBACK =
  "Hi {firstName}, CompoundRx Pharmacy received your prescription and it's currently on hold. If you'd like us to fill it, simply reply to this message. We're here if you have any questions. Reply NOT INTERESTED to stop these messages.\n\nHola {firstName}, CompoundRx Pharmacy recibió tu receta y por el momento está en espera. Si deseas que la preparemos, simplemente responde a este mensaje. Estamos aquí para ayudarte si tienes alguna pregunta. Responde NO INTERESADO para dejar de recibir estos mensajes.";
const ON_HOLD_FINAL_FALLBACK =
  "Hi {firstName}, CompoundRx Pharmacy received your prescription and it is still on hold. This is our final follow-up in case you'd like us to fill it. Simply reply to this message and we'll take care of the rest. We're here if you have any questions. Reply NOT INTERESTED to stop these messages.\n\nHola {firstName}, CompoundRx Pharmacy recibió tu receta y aún está en espera. Este es nuestro último seguimiento en caso de que desees que la preparemos. Simplemente responde a este mensaje y nos encargaremos del resto. Estamos aquí para ayudarte si tienes alguna pregunta. Responde NO INTERESADO para dejar de recibir estos mensajes.";
const UNSUBSCRIBE_CONFIRMATION =
  "You've been removed from on-hold prescription notifications. Contact us anytime if you need help.\n\nYa no recibirás notificaciones sobre recetas en espera. Contáctanos cuando quieras si necesitas ayuda.";

// Keywords that unsubscribe a patient (matched case-insensitively as a
// substring of the inbound message). Spanish "no interesada" is included so
// female patients who reply naturally also opt out.
const STOP_KEYWORDS = ["not interested", "no interesado", "no interesada"];

// A patient's first REMINDERS_BEFORE_FINAL texts use the standard reminder;
// the next one (their final text before the 1-month TTL removes them) uses the
// final-notice message.
const REMINDERS_BEFORE_FINAL = 3;

async function getOnHoldTemplates(
  supabase: SupabaseClient,
): Promise<{ standard: string | null; final: string | null }> {
  const { data, error } = await supabase
    .from("messaging_groups")
    .select("templates")
    .eq("name", "default")
    .single();

  if (error || !data) {
    console.error("Failed to fetch On_Hold_Campaign templates:", error);
    return { standard: null, final: null };
  }

  return {
    standard: data.templates?.On_Hold_Campaign ?? null,
    final: data.templates?.On_Hold_Campaign_Final ?? null,
  };
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

  const templates = await getOnHoldTemplates(supabase);
  const standardMessage = templates.standard ?? ON_HOLD_REMINDER_FALLBACK;
  const finalMessage = templates.final ?? ON_HOLD_FINAL_FALLBACK;
  if (!templates.standard) {
    console.warn("On_Hold_Campaign template not found in messaging_groups, using fallback message.");
  }
  if (!templates.final) {
    console.warn("On_Hold_Campaign_Final template not found in messaging_groups, using fallback message.");
  }

  let sent = 0;
  let failed = 0;

  for (const patient of patients) {
    try {
      // Their first REMINDERS_BEFORE_FINAL texts get the standard reminder;
      // the next one gets the final notice.
      const sentCount = patient.sent_count ?? 0;
      const isFinal = sentCount >= REMINDERS_BEFORE_FINAL;
      const templateMessage = isFinal ? finalMessage : standardMessage;

      const message = renderTemplate(templateMessage, { firstName: patient.first_name ?? "" });
      const ok = await sendPodiumMessage(token, patient.phone_number, message);
      if (ok) {
        sent++;
        // Only advance the counter on a successful send so a failed message is
        // retried (same message) on the next run rather than being skipped.
        const { error: updateError } = await supabase
          .from("on_hold_patients")
          .update({ sent_count: sentCount + 1 })
          .eq("patient_id", patient.patient_id);
        if (updateError) {
          console.error(`Failed to increment sent_count for ${patient.patient_id}:`, updateError);
        }
      } else {
        failed++;
      }
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
  // console.log("Podium STOP webhook received:", JSON.stringify(body));
  // console.log("phone number", JSON.stringify(body?.conversation?.channel?.identifier))

  // Only act on inbound messages from the consumer. Podium also fires
  // message.sent/message.failed events, which we ignore.
  const eventType = body?.metadata?.eventType;
  if (eventType !== "message.received") {
    console.log(`Ignoring non-inbound event: ${eventType}`);
    return json({ Success: "All good" }, 200);
  }

  const phoneNumber = body?.data?.conversation?.channel?.identifier;
  const message: string = body?.data?.body;

  // console.log(phoneNumber);
  // console.log(message);

  if (!phoneNumber) {
    console.error("STOP webhook missing phone number");
    return json({ error: "Missing phone number" }, 400);
  }

  const lowerMessage = message?.toLowerCase() ?? "";
  const isStop = STOP_KEYWORDS.some((keyword) => lowerMessage.includes(keyword));
  if (!isStop) {
    console.log("Message not STOP");
    return json({ Success: "All good" }, 200);
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

  const token = await getPodiumToken();
  if (token) {
    await sendPodiumMessage(token, phoneNumber, UNSUBSCRIBE_CONFIRMATION);
  } else {
    console.error("Failed to get Podium token for unsubscribe confirmation message");
  }

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
