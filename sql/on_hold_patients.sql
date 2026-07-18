-- Create the on_hold_patients table
CREATE TABLE on_hold_patients (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id TEXT NOT NULL UNIQUE,
    phone_number TEXT NOT NULL,
    first_name TEXT,
    -- Number of campaign texts already sent to this patient. Drives which
    -- template they get: first 3 texts use the standard reminder, the next
    -- uses the final notice.
    sent_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- For an already-deployed table, add the column instead:
-- ALTER TABLE on_hold_patients ADD COLUMN IF NOT EXISTS sent_count INTEGER NOT NULL DEFAULT 0;

-- Index for phone number lookups (STOP webhook deletes by phone)
CREATE INDEX idx_on_hold_patients_phone ON on_hold_patients (phone_number);

-- Index for TTL cleanup
CREATE INDEX idx_on_hold_patients_created_at ON on_hold_patients (created_at);

-- Enable pg_cron extension (if not already enabled)
-- Run this as a superuser / via Supabase dashboard:
-- CREATE EXTENSION IF NOT EXISTS pg_cron;

-- pg_cron job: delete rows older than 1 month, runs daily at midnight UTC
SELECT cron.schedule(
    'cleanup-on-hold-patients',
    '0 0 * * *',
    $$DELETE FROM on_hold_patients WHERE created_at < now() - INTERVAL '1 month'$$
);
