-- pg_cron job: call the Supabase Edge Function every Tuesday at 10:00 AM ET
-- This uses pg_net to make an HTTP request to the edge function
-- Ensure pg_net extension is enabled: CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
    'trigger-on-hold-campaign',
    '0 14 * * 2',  -- Every Tuesday at 2:00 PM UTC (10:00 AM EDT)
    $$
    SELECT net.http_post(
        url := 'https://<YOUR_SUPABASE_PROJECT_REF>.supabase.co/functions/v1/on-hold-campaign',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer <YOUR_SUPABASE_ANON_KEY>'
        ),
        body := '{}'::jsonb
    );
    $$
);
