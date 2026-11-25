CREATE OR REPLACE FUNCTION "auth_flow_update"(p_id text, p_owner text, p_data jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH changed AS (UPDATE "auth_flow" f SET "owner" = p_owner, "data" = p_data WHERE f."id" = p_id AND f."expires_at" > now() RETURNING 1) SELECT EXISTS (SELECT 1 FROM changed)
$$;--> statement-breakpoint
CREATE FUNCTION "auth_flow_approve"(p_id text, p_owner text, p_data jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH changed AS (UPDATE "auth_flow" f SET "owner" = p_owner, "data" = p_data WHERE f."id" = p_id AND f."owner" IS NULL AND f."expires_at" > now() RETURNING 1) SELECT EXISTS (SELECT 1 FROM changed)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "auth_flow_approve"(text, text, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth_flow_approve"(text, text, jsonb) TO "board_app";
