CREATE POLICY "system" ON "app_user" AS PERMISSIVE FOR ALL TO current_user USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "system" ON "client_key" AS PERMISSIVE FOR ALL TO current_user USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "system" ON "machine" AS PERMISSIVE FOR ALL TO current_user USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "system" ON "passkey" AS PERMISSIVE FOR ALL TO current_user USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "system" ON "request_nonce" AS PERMISSIVE FOR ALL TO current_user USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "system" ON "session" AS PERMISSIVE FOR ALL TO current_user USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "app_user" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "directory" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legacy_dirs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "passkey" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "request_nonce" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_pr" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transcript_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transcript_run" FORCE ROW LEVEL SECURITY;
