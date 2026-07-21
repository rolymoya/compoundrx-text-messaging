// Manually re-send the on-hold campaign text to every patient currently in
// on_hold_patients, WITHOUT advancing their sent_count. It triggers the
// on-hold-campaign edge function in replay mode, so the exact same send logic
// (Podium auth, template selection, message rendering) runs.
//
// Usage:
//   SUPABASE_URL=https://<project-ref>.supabase.co \
//   SUPABASE_ANON_KEY=<anon-or-service-role-key> \
//   node scripts/replay-on-hold.js --yes
//
// Without --yes it prints what it would do and exits without sending.
// Requires Node 18+ (global fetch).

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    "Missing config. Set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY).",
  );
  process.exit(1);
}

const endpoint = `${url.replace(/\/+$/, "")}/functions/v1/on-hold-campaign`;

if (!process.argv.includes("--yes")) {
  console.log(
    `This will re-send the on-hold text to ALL patients in on_hold_patients\n` +
      `via ${endpoint}\n` +
      `Message is chosen by each patient's current sent_count, and sent_count is NOT changed.\n\n` +
      `Re-run with --yes to actually send.`,
  );
  process.exit(0);
}

const res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({ replay: true }),
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text);
process.exit(res.ok ? 0 : 1);
