-- ============================================================
-- 061: Support Google Gemini as a native AI provider.
--
-- Extends the provider CHECK constraints on ai_configs and
-- ai_usage_log so accounts can configure Google Gemini directly
-- alongside OpenAI, Anthropic, and OpenAI-compatible endpoints.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini', 'openai_compatible'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini', 'openai_compatible'));
