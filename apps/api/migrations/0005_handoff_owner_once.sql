CREATE OR REPLACE FUNCTION "auth_flow_update"(p_id text, p_owner text, p_data jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH changed AS (UPDATE "auth_flow" f SET "owner" = p_owner, "data" = p_data WHERE f."id" = p_id AND f."owner" IS NULL AND f."expires_at" > now() RETURNING 1) SELECT EXISTS (SELECT 1 FROM changed)
$$;
