-- pg_cron job: call the Supabase Edge Function every Thursday at 10:00 AM UTC
-- This uses pg_net to make an HTTP request to the edge function
-- Ensure pg_net extension is enabled: CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
    'trigger-on-hold-campaign',
    '0 10 * * 4',  -- Every Thursday at 10:00 AM UTC
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
