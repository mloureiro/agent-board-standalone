REVOKE CREATE ON SCHEMA "public" FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "board_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "app_user", "session", "passkey", "client_key", "request_nonce", "machine", "legacy_dirs", "project", "directory", "task", "task_pr", "note", "schedule", "transcript_run", "transcript_event", "document" TO "board_app";--> statement-breakpoint
REVOKE ALL ON "auth_flow" FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "lookup_session"(p_token_hash text) RETURNS TABLE ("owner" text, "kind" session_kind, "method" session_method, "created_at" timestamptz, "last_seen_at" timestamptz, "expires_at" timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s."owner", s."kind", s."method", s."created_at", s."last_seen_at", s."expires_at" FROM "session" s WHERE s."token_hash" = p_token_hash
$$;--> statement-breakpoint
CREATE FUNCTION "lookup_machine"(p_token_hash text) RETURNS TABLE ("owner" text, "machine_id" text, "revoked_at" timestamptz, "acts_as_owner" boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m."owner", m."id", m."revoked_at", m."acts_as_owner" FROM "machine" m WHERE m."token_hash" = p_token_hash
$$;--> statement-breakpoint
CREATE FUNCTION "lookup_client_key"(p_key_id text) RETURNS TABLE ("owner" text, "public_key" text, "kind" device_kind, "machine_id" text, "session_token_hash" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k."owner", k."public_key", k."kind", k."machine_id", k."session_token_hash" FROM "client_key" k WHERE k."key_id" = p_key_id
$$;--> statement-breakpoint
CREATE FUNCTION "lookup_passkey"(p_credential_id text) RETURNS TABLE ("owner" text, "credential_id" text, "public_key" text, "counter" bigint, "transports" text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p."owner", p."credential_id", p."public_key", p."counter", p."transports" FROM "passkey" p WHERE p."credential_id" = p_credential_id
$$;--> statement-breakpoint
CREATE FUNCTION "list_passkeys_of"(p_username text) RETURNS TABLE ("credential_id" text, "transports" text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p."credential_id", p."transports" FROM "passkey" p WHERE p."owner" = p_username ORDER BY p."created_at", p."credential_id"
$$;--> statement-breakpoint
CREATE FUNCTION "lookup_user"(p_username text) RETURNS TABLE ("username" text, "source" session_method)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u."username", u."source" FROM "app_user" u WHERE u."username" = p_username
$$;--> statement-breakpoint
CREATE FUNCTION "list_owners"() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u."username" FROM "app_user" u ORDER BY u."username"
$$;--> statement-breakpoint
CREATE FUNCTION "auth_flow_create"(p_id text, p_kind auth_flow_kind, p_challenge text, p_code_hash text, p_data jsonb, p_owner text, p_expires_at timestamptz) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO "auth_flow" ("id", "kind", "challenge", "code_hash", "data", "owner", "expires_at") VALUES (p_id, p_kind, p_challenge, p_code_hash, p_data, p_owner, p_expires_at)
$$;--> statement-breakpoint
CREATE FUNCTION "auth_flow_get"(p_id text) RETURNS SETOF "auth_flow"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM "auth_flow" f WHERE f."id" = p_id AND f."expires_at" > now()
$$;--> statement-breakpoint
CREATE FUNCTION "auth_flow_get_by_code"(p_code_hash text) RETURNS SETOF "auth_flow"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM "auth_flow" f WHERE f."code_hash" = p_code_hash AND f."expires_at" > now()
$$;--> statement-breakpoint
CREATE FUNCTION "auth_flow_update"(p_id text, p_owner text, p_data jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH changed AS (UPDATE "auth_flow" f SET "owner" = p_owner, "data" = p_data WHERE f."id" = p_id AND f."expires_at" > now() RETURNING 1) SELECT EXISTS (SELECT 1 FROM changed)
$$;--> statement-breakpoint
CREATE FUNCTION "auth_flow_take"(p_id text) RETURNS SETOF "auth_flow"
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM "auth_flow" f WHERE f."id" = p_id AND f."expires_at" > now() RETURNING f.*
$$;--> statement-breakpoint
CREATE FUNCTION "auth_flow_take_by_code"(p_code_hash text) RETURNS SETOF "auth_flow"
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM "auth_flow" f WHERE f."code_hash" = p_code_hash AND f."expires_at" > now() RETURNING f.*
$$;--> statement-breakpoint
CREATE FUNCTION "purge_expired"(p_now timestamptz) RETURNS TABLE ("sessions" integer, "auth_flows" integer, "nonces" integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  removed_sessions integer;
  removed_flows integer;
  removed_nonces integer;
BEGIN
  DELETE FROM "session" WHERE "expires_at" < p_now;
  GET DIAGNOSTICS removed_sessions = ROW_COUNT;
  DELETE FROM "auth_flow" WHERE "expires_at" < p_now;
  GET DIAGNOSTICS removed_flows = ROW_COUNT;
  DELETE FROM "request_nonce" WHERE "seen_at" < p_now - interval '1 hour';
  GET DIAGNOSTICS removed_nonces = ROW_COUNT;
  RETURN QUERY SELECT removed_sessions, removed_flows, removed_nonces;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "lookup_session"(text), "lookup_machine"(text), "lookup_client_key"(text), "lookup_passkey"(text), "list_passkeys_of"(text), "lookup_user"(text), "list_owners"(), "auth_flow_create"(text, auth_flow_kind, text, text, jsonb, text, timestamptz), "auth_flow_get"(text), "auth_flow_get_by_code"(text), "auth_flow_update"(text, text, jsonb), "auth_flow_take"(text), "auth_flow_take_by_code"(text), "purge_expired"(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "lookup_session"(text), "lookup_machine"(text), "lookup_client_key"(text), "lookup_passkey"(text), "list_passkeys_of"(text), "lookup_user"(text), "list_owners"(), "auth_flow_create"(text, auth_flow_kind, text, text, jsonb, text, timestamptz), "auth_flow_get"(text), "auth_flow_get_by_code"(text), "auth_flow_update"(text, text, jsonb), "auth_flow_take"(text), "auth_flow_take_by_code"(text), "purge_expired"(timestamptz) TO "board_app";
