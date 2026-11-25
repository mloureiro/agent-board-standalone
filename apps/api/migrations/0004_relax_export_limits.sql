ALTER TABLE "note" DROP CONSTRAINT "note_body_sealed";--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_watch_stops_count";--> statement-breakpoint
ALTER TABLE "transcript_event" DROP CONSTRAINT "transcript_event_output_with_size";--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_body_sealed" CHECK (("note"."author" = 'server' and "note"."kind" = 'event' and char_length("note"."body") between 1 and 533376) or ("note"."author" <> 'server' and "note"."body" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("note"."body") <= 533376));--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_watch_stops_count" CHECK (cardinality("task"."watch_stops") <= 256);