-- ============================================================
-- 063_n8n_integration_and_steps.sql
--
-- Bidirectional n8n integration Hub (compatible with n8n.akm
-- hosted externally on VPS / Railway / n8n Cloud alongside
-- the serverless CRM on Vercel).
--
-- Note: `automation_steps.step_type` is an unconstrained TEXT
-- column (migration 006), so the new native `http_request` and
-- `ai_agent` automation steps require no ALTER on that table.
-- ============================================================

CREATE TABLE IF NOT EXISTS n8n_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  instance_url TEXT,
  webhook_url TEXT,
  auth_header_name TEXT NOT NULL DEFAULT 'x-n8n-secret',
  auth_header_value_encrypted TEXT,
  subscribed_events TEXT[] NOT NULL DEFAULT ARRAY[
    'message.received',
    'contact.created',
    'deal.created',
    'deal.stage_changed',
    'tag.added',
    'ai.handoff'
  ]::TEXT[],
  inbound_token_hash TEXT,
  inbound_token_prefix TEXT,
  inbound_token_encrypted TEXT,
  last_outbound_at TIMESTAMPTZ,
  last_outbound_status INTEGER,
  last_outbound_error TEXT,
  last_inbound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_n8n_integrations_account
  ON n8n_integrations(account_id);

CREATE INDEX IF NOT EXISTS idx_n8n_integrations_inbound_hash
  ON n8n_integrations(inbound_token_hash)
  WHERE inbound_token_hash IS NOT NULL;

ALTER TABLE n8n_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS n8n_integrations_select ON n8n_integrations;
DROP POLICY IF EXISTS n8n_integrations_insert ON n8n_integrations;
DROP POLICY IF EXISTS n8n_integrations_update ON n8n_integrations;
DROP POLICY IF EXISTS n8n_integrations_delete ON n8n_integrations;

-- Any authenticated member of the account can view non-secret status;
-- admin/owner controls creation, secret rotation, and edits.
CREATE POLICY n8n_integrations_select ON n8n_integrations FOR SELECT
  USING (is_account_member(account_id));

CREATE POLICY n8n_integrations_insert ON n8n_integrations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

CREATE POLICY n8n_integrations_update ON n8n_integrations FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

CREATE POLICY n8n_integrations_delete ON n8n_integrations FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON n8n_integrations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON n8n_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Keep redeem_invitation in sync with all account-scoped domain tables
-- so an account with an n8n_integrations row is never silently dropped.
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM n8n_integrations WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
