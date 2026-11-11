-- Run ONCE on your database computer (MODE=HUB), in the existing iot_db database.
-- This preserves old text_messages rows and sensor data.
CREATE TABLE IF NOT EXISTS public.text_messages (
    id BIGSERIAL PRIMARY KEY,
    sender_id VARCHAR(64) NOT NULL,
    receiver_id VARCHAR(64),
    message TEXT NOT NULL,
    transport VARCHAR(20) NOT NULL DEFAULT 'app_api',
    payload_bytes INTEGER NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.hardware_receipts (
    packet_id UUID PRIMARY KEY,
    message_id BIGINT UNIQUE REFERENCES public.text_messages(id),
    first_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Replace iot_app with your existing application's DB role if different.
GRANT SELECT, INSERT ON public.text_messages TO iot_app;
GRANT USAGE, SELECT ON SEQUENCE public.text_messages_id_seq TO iot_app;
GRANT SELECT, INSERT, UPDATE ON public.hardware_receipts TO iot_app;
