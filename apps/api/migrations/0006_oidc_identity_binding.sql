ALTER TABLE "app_user" ADD COLUMN "identity_issuer" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "identity_subject" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_identity_together" CHECK (("app_user"."identity_issuer" is null) = ("app_user"."identity_subject" is null));--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_identity_length" CHECK (char_length("app_user"."identity_issuer") between 1 and 2048 and char_length("app_user"."identity_subject") between 1 and 2048 or "app_user"."identity_issuer" is null);