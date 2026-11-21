-- ============================================================
-- 062: Support WhatsApp Web (QR Code) connectivity alongside
--      Official Meta WhatsApp Cloud API.
--
-- Stores the active connection mode (`official_api` or `qr_code`)
-- and encrypted gateway credentials (Evolution API v2, WAHA, or
-- custom Baileys/webhook bridge) on the per-account whatsapp_config
-- row. Existing official API rows default to `official_api`.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connection_mode TEXT NOT NULL DEFAULT 'official_api',
  ADD COLUMN IF NOT EXISTS qr_provider TEXT,
  ADD COLUMN IF NOT EXISTS qr_api_url TEXT,
  ADD COLUMN IF NOT EXISTS qr_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS qr_api_key TEXT,
  ADD COLUMN IF NOT EXISTS qr_webhook_secret TEXT,
  ADD COLUMN IF NOT EXISTS qr_status TEXT NOT NULL DEFAULT 'disconnected',
  ADD COLUMN IF NOT EXISTS qr_phone_number TEXT,
  ADD COLUMN IF NOT EXISTS qr_connected_at TIMESTAMPTZ;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_connection_mode_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_connection_mode_check
  CHECK (connection_mode IN ('official_api', 'qr_code'));

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_qr_provider_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_qr_provider_check
  CHECK (qr_provider IS NULL OR qr_provider IN ('evolution', 'waha', 'custom_webhook'));

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_qr_status_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_qr_status_check
  CHECK (qr_status IN ('disconnected', 'qr_ready', 'connected'));
