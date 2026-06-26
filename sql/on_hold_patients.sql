-- Create the on_hold_patients table
CREATE TABLE on_hold_patients (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id TEXT NOT NULL UNIQUE,
    phone_number TEXT NOT NULL,
    first_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
