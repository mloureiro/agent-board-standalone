CREATE TYPE "public"."auth_flow_kind" AS ENUM('oidc', 'saml', 'passkey-login', 'passkey-register', 'passkey-signup', 'handoff', 'pair');--> statement-breakpoint
CREATE TYPE "public"."device_kind" AS ENUM('session', 'machine', 'paired');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('agents', 'links', 'titles', 'settings');--> statement-breakpoint
CREATE TYPE "public"."next_run" AS ENUM('fresh', 'resume');--> statement-breakpoint
CREATE TYPE "public"."note_author" AS ENUM('agent', 'user', 'system', 'server');--> statement-breakpoint
CREATE TYPE "public"."note_kind" AS ENUM('comment', 'question', 'answer', 'event', 'polish');--> statement-breakpoint
CREATE TYPE "public"."pr_state" AS ENUM('open', 'merged', 'closed');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('cookie', 'client');--> statement-breakpoint
CREATE TYPE "public"."session_method" AS ENUM('passkey', 'oidc', 'saml');--> statement-breakpoint
CREATE TYPE "public"."task_actor" AS ENUM('user', 'agent', 'machine');--> statement-breakpoint
CREATE TYPE "public"."task_creator" AS ENUM('intake', 'user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."task_effort" AS ENUM('low', 'medium', 'high', 'xhigh', 'max');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('urgent', 'high', 'normal', 'low');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('backlog', 'todo', 'running', 'waiting', 'needs-me', 'done');--> statement-breakpoint
CREATE TABLE "app_user" (
	"username" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key_id" text,
	"key_slots" jsonb,
	"source" "session_method",
	CONSTRAINT "app_user_username_length" CHECK (char_length("app_user"."username") between 1 and 256),
	CONSTRAINT "app_user_key_id_shape" CHECK ("app_user"."key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "app_user_key_together" CHECK (("app_user"."key_id" is null) = ("app_user"."key_slots" is null)),
	CONSTRAINT "app_user_key_slots_shape" CHECK ("app_user"."key_slots" is null or (jsonb_typeof("app_user"."key_slots") = 'array' and jsonb_array_length("app_user"."key_slots") between 1 and 4))
);
--> statement-breakpoint
ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_flow" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "auth_flow_kind" NOT NULL,
	"challenge" text,
	"code_hash" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_key" (
	"key_id" text PRIMARY KEY NOT NULL,
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"public_key" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"kind" "device_kind" NOT NULL,
	"machine_id" text,
	"session_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "client_key_owner_key_id_unique" UNIQUE("owner","key_id"),
	CONSTRAINT "client_key_owner_machine_unique" UNIQUE("owner","machine_id"),
	CONSTRAINT "client_key_owner_session_unique" UNIQUE("owner","session_token_hash"),
	CONSTRAINT "client_key_id_shape" CHECK ("client_key"."key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "client_key_label_length" CHECK (char_length("client_key"."label") <= 256),
	CONSTRAINT "client_key_binding" CHECK (("client_key"."kind" = 'machine') = ("client_key"."machine_id" is not null) and ("client_key"."kind" = 'session') = ("client_key"."session_token_hash" is not null))
);
--> statement-breakpoint
ALTER TABLE "client_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "directory" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"path" text NOT NULL,
	"repo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_owner_id_pk" PRIMARY KEY("owner","id"),
	CONSTRAINT "directory_owner_id_project_unique" UNIQUE("owner","id","project_id"),
	CONSTRAINT "directory_path_sealed" CHECK ("path" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("path") <= 5504),
	CONSTRAINT "directory_repo_sealed" CHECK ("repo" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("repo") <= 1408)
);
--> statement-breakpoint
ALTER TABLE "directory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"kind" "document_kind" NOT NULL,
	"document" text NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_owner_kind_pk" PRIMARY KEY("owner","kind"),
	CONSTRAINT "document_version_positive" CHECK ("document"."version" >= 1),
	CONSTRAINT "document_document_sealed" CHECK ("document"."document" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("document"."document") <= 699093 and char_length("document"."document") <= case "document"."kind" when 'agents' then 349568 when 'links' then 699093 when 'titles' then 699093 else 349568 end)
);
--> statement-breakpoint
ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "legacy_dirs" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"machine_id" text NOT NULL,
	"document" text NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_dirs_owner_machine_id_pk" PRIMARY KEY("owner","machine_id"),
	CONSTRAINT "legacy_dirs_document_sealed" CHECK ("document" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("document") <= 349568)
);
--> statement-breakpoint
ALTER TABLE "legacy_dirs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "machine" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"id" text NOT NULL,
	"token_hash" text NOT NULL,
	"acts_as_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"client_version" text,
	"client_level" integer,
	"catalog" text,
	"catalog_index" text,
	"catalog_updated_at" timestamp with time zone,
	"usage" text,
	"usage_index" text,
	"usage_updated_at" timestamp with time zone,
	"feeds" text,
	"feeds_index" text,
	"feeds_updated_at" timestamp with time zone,
	"feed_requests" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "machine_owner_id_pk" PRIMARY KEY("owner","id"),
	CONSTRAINT "machine_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "machine_id_length" CHECK (char_length("machine"."id") between 1 and 256),
	CONSTRAINT "machine_token_hash_shape" CHECK ("machine"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "machine_client_version_length" CHECK (char_length("machine"."client_version") between 1 and 64),
	CONSTRAINT "machine_catalog_sealed" CHECK ("catalog" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("catalog") <= 349568),
	CONSTRAINT "machine_catalog_index_sealed" CHECK ("catalog_index" ~ '^abh1[.][A-Za-z0-9_-]{43}$'),
	CONSTRAINT "machine_usage_sealed" CHECK ("usage" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("usage") <= 87424),
	CONSTRAINT "machine_usage_index_sealed" CHECK ("usage_index" ~ '^abh1[.][A-Za-z0-9_-]{43}$'),
	CONSTRAINT "machine_feeds_sealed" CHECK ("feeds" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("feeds") <= 436949),
	CONSTRAINT "machine_feeds_index_sealed" CHECK ("feeds_index" ~ '^abh1[.][A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
ALTER TABLE "machine" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "note" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"id" text NOT NULL,
	"task_id" text NOT NULL,
	"author" "note_author" NOT NULL,
	"kind" "note_kind" NOT NULL,
	"body" text NOT NULL,
	"preview" text,
	"suggestion" text,
	"questions" text,
	"answers" text,
	"question_note_id" text,
	"by" text,
	"via_machine_id" text,
	"pending" boolean DEFAULT false NOT NULL,
	"queued" boolean DEFAULT false NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "note_owner_id_pk" PRIMARY KEY("owner","id"),
	CONSTRAINT "note_body_sealed" CHECK (("note"."author" = 'server' and "note"."kind" = 'event' and char_length("note"."body") between 1 and 2000) or ("note"."author" <> 'server' and "note"."body" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("note"."body") <= 533376)),
	CONSTRAINT "note_suggestion_agent_comment" CHECK ("note"."suggestion" is null or ("note"."author" = 'agent' and "note"."kind" = 'comment')),
	CONSTRAINT "note_by_length" CHECK (char_length("note"."by") between 1 and 256),
	CONSTRAINT "note_preview_sealed" CHECK ("preview" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("preview") <= 1643),
	CONSTRAINT "note_suggestion_sealed" CHECK ("suggestion" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("suggestion") <= 10709),
	CONSTRAINT "note_questions_sealed" CHECK ("questions" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("questions") <= 349568),
	CONSTRAINT "note_answers_sealed" CHECK ("answers" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("answers") <= 349568)
);
--> statement-breakpoint
ALTER TABLE "note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "passkey" (
	"credential_id" text PRIMARY KEY NOT NULL,
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "passkey_name_length" CHECK (char_length("passkey"."name") between 1 and 200),
	CONSTRAINT "passkey_counter_range" CHECK ("passkey"."counter" between 0 and 9007199254740991),
	CONSTRAINT "passkey_transports_count" CHECK (cardinality("passkey"."transports") <= 16)
);
--> statement-breakpoint
ALTER TABLE "passkey" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"icon" text,
	"position" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_owner_id_pk" PRIMARY KEY("owner","id"),
	CONSTRAINT "project_position_range" CHECK ("project"."position" between 0 and 1000000),
	CONSTRAINT "project_default_not_archived" CHECK (not "project"."is_default" or "project"."archived_at" is null),
	CONSTRAINT "project_name_sealed" CHECK ("name" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("name") <= 576),
	CONSTRAINT "project_icon_sealed" CHECK ("icon" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("icon") <= 213)
);
--> statement-breakpoint
ALTER TABLE "project" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "request_nonce" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"key_id" text NOT NULL,
	"nonce" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_nonce_key_id_nonce_pk" PRIMARY KEY("key_id","nonce"),
	CONSTRAINT "request_nonce_shape" CHECK ("request_nonce"."nonce" ~ '^[A-Za-z0-9_-]{22,64}$')
);
--> statement-breakpoint
ALTER TABLE "request_nonce" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "schedule" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"id" text NOT NULL,
	"title" text NOT NULL,
	"input" text NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"model" text,
	"effort" "task_effort",
	"requested_lane" text,
	"auto_done" boolean DEFAULT false NOT NULL,
	"machine" text,
	"project_id" uuid NOT NULL,
	"directory_id" uuid,
	"legacy_directory" text,
	"agent" text,
	"icon" text,
	"labels" text,
	"every_ms" bigint,
	"cron" text,
	"more_crons" text[] DEFAULT '{}'::text[] NOT NULL,
	"timezone" text,
	"after_schedule_id" text,
	"after_delay_ms" bigint,
	"max_concurrent" integer,
	"anchor_at" timestamp with time zone NOT NULL,
	"last_occurrence_at" timestamp with time zone,
	"remaining" integer,
	"until" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"occurrence_task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_owner_id_pk" PRIMARY KEY("owner","id"),
	CONSTRAINT "schedule_one_rule" CHECK (("schedule"."every_ms" is not null)::int + ("schedule"."cron" is not null)::int + ("schedule"."after_schedule_id" is not null)::int = 1),
	CONSTRAINT "schedule_after_delay" CHECK (("schedule"."after_schedule_id" is null) = ("schedule"."after_delay_ms" is null)),
	CONSTRAINT "schedule_cron_timezone" CHECK (("schedule"."cron" is null) = ("schedule"."timezone" is null)),
	CONSTRAINT "schedule_more_crons" CHECK (cardinality("schedule"."more_crons") <= 9 and ("schedule"."cron" is not null or cardinality("schedule"."more_crons") = 0)),
	CONSTRAINT "schedule_max_concurrent_range" CHECK ("schedule"."max_concurrent" is null or "schedule"."max_concurrent" between 1 and 100),
	CONSTRAINT "schedule_title_sealed" CHECK ("title" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("title") <= 1643),
	CONSTRAINT "schedule_input_sealed" CHECK ("input" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("input") <= 1066709),
	CONSTRAINT "schedule_legacy_directory_sealed" CHECK ("legacy_directory" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("legacy_directory") <= 5504),
	CONSTRAINT "schedule_agent_sealed" CHECK ("agent" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("agent") <= 384),
	CONSTRAINT "schedule_icon_sealed" CHECK ("icon" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("icon") <= 213),
	CONSTRAINT "schedule_labels_sealed" CHECK ("labels" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("labels") <= 5504)
);
--> statement-breakpoint
ALTER TABLE "schedule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"kind" "session_kind" NOT NULL,
	"method" "session_method" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_owner_token_hash_unique" UNIQUE("owner","token_hash"),
	CONSTRAINT "session_token_hash_shape" CHECK ("session"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"id" text NOT NULL,
	"title" text NOT NULL,
	"input" text NOT NULL,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"model" text,
	"effort" "task_effort",
	"requested_lane" text,
	"auto_done" boolean DEFAULT false NOT NULL,
	"moved_by" "task_actor",
	"position" double precision NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"machine" text,
	"session_id" uuid,
	"project_id" uuid NOT NULL,
	"directory_id" uuid,
	"legacy_directory" text,
	"legacy_home_workdir" text,
	"agent" text,
	"icon" text,
	"labels" text,
	"watches" text,
	"watch_stops" text[] DEFAULT '{}'::text[] NOT NULL,
	"pr_state" "pr_state",
	"next" "next_run" DEFAULT 'fresh' NOT NULL,
	"lane" text,
	"borrowed" boolean DEFAULT false NOT NULL,
	"last_active_at" timestamp with time zone,
	"run_started_at" timestamp with time zone,
	"run_id" text,
	"paused_at" timestamp with time zone,
	"not_before" timestamp with time zone,
	"wake_at" timestamp with time zone,
	"wait_check" boolean DEFAULT false NOT NULL,
	"woken_at" timestamp with time zone,
	"stop_requested_at" timestamp with time zone,
	"inbox_read" boolean DEFAULT false NOT NULL,
	"stop_message_id" text,
	"head" text,
	"open_question_note_id" text,
	"dedupe_key" text,
	"parent_id" text,
	"created_by" "task_creator" DEFAULT 'user' NOT NULL,
	"schedule_id" text,
	"fork_of" text,
	"occurrence_finished_at" timestamp with time zone,
	"proposed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_owner_id_pk" PRIMARY KEY("owner","id"),
	CONSTRAINT "task_owner_dedupe_key_unique" UNIQUE("owner","dedupe_key"),
	CONSTRAINT "task_watch_stops_count" CHECK (cardinality("task"."watch_stops") <= 32),
	CONSTRAINT "task_title_sealed" CHECK ("title" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("title") <= 1643),
	CONSTRAINT "task_input_sealed" CHECK ("input" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("input") <= 1066709),
	CONSTRAINT "task_legacy_directory_sealed" CHECK ("legacy_directory" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("legacy_directory") <= 5504),
	CONSTRAINT "task_legacy_home_workdir_sealed" CHECK ("legacy_home_workdir" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("legacy_home_workdir") <= 5504),
	CONSTRAINT "task_agent_sealed" CHECK ("agent" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("agent") <= 384),
	CONSTRAINT "task_icon_sealed" CHECK ("icon" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("icon") <= 213),
	CONSTRAINT "task_labels_sealed" CHECK ("labels" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("labels") <= 5504),
	CONSTRAINT "task_watches_sealed" CHECK ("watches" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("watches") <= 43733),
	CONSTRAINT "task_dedupe_key_sealed" CHECK ("dedupe_key" ~ '^abh1[.][A-Za-z0-9_-]{43}$'),
	CONSTRAINT "task_head_sealed" CHECK ("head" ~ '^abh1[.][A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
ALTER TABLE "task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task_pr" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"id" text NOT NULL,
	"task_id" text NOT NULL,
	"pr" text NOT NULL,
	"state" "pr_state",
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "task_pr_owner_id_pk" PRIMARY KEY("owner","id"),
	CONSTRAINT "task_pr_pr_sealed" CHECK ("pr" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("pr") <= 1408)
);
--> statement-breakpoint
ALTER TABLE "task_pr" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transcript_event" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"parent" text,
	"data" text NOT NULL,
	"output" text,
	"output_size" integer,
	CONSTRAINT "transcript_event_owner_run_id_seq_pk" PRIMARY KEY("owner","run_id","seq"),
	CONSTRAINT "transcript_event_seq_range" CHECK ("transcript_event"."seq" >= 0),
	CONSTRAINT "transcript_event_kind" CHECK ("transcript_event"."kind" in ('text', 'thinking', 'tool_use', 'result', 'note', 'context', 'tool_result')),
	CONSTRAINT "transcript_event_output_size" CHECK ("transcript_event"."output_size" between 0 and 263168),
	CONSTRAINT "transcript_event_output_with_size" CHECK (("transcript_event"."output" is null) = ("transcript_event"."output_size" is null)),
	CONSTRAINT "transcript_event_data_sealed" CHECK ("data" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("data") <= 1398144),
	CONSTRAINT "transcript_event_output_sealed" CHECK ("output" ~ '^abe1[.][A-Za-z0-9_-]{38,}$' and char_length("output") <= 1403605)
);
--> statement-breakpoint
ALTER TABLE "transcript_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transcript_run" (
	"owner" text DEFAULT current_setting('app.owner', true) NOT NULL,
	"id" text NOT NULL,
	"task_id" text NOT NULL,
	"machine" text NOT NULL,
	"session_id" uuid,
	"resumed" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "transcript_run_owner_id_pk" PRIMARY KEY("owner","id"),
	CONSTRAINT "transcript_run_event_count" CHECK ("transcript_run"."event_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "transcript_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_flow" ADD CONSTRAINT "auth_flow_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_key" ADD CONSTRAINT "client_key_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_key" ADD CONSTRAINT "client_key_machine_fk" FOREIGN KEY ("owner","machine_id") REFERENCES "public"."machine"("owner","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_key" ADD CONSTRAINT "client_key_session_fk" FOREIGN KEY ("owner","session_token_hash") REFERENCES "public"."session"("owner","token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory" ADD CONSTRAINT "directory_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory" ADD CONSTRAINT "directory_machine_fk" FOREIGN KEY ("owner","machine_id") REFERENCES "public"."machine"("owner","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory" ADD CONSTRAINT "directory_project_fk" FOREIGN KEY ("owner","project_id") REFERENCES "public"."project"("owner","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_dirs" ADD CONSTRAINT "legacy_dirs_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_dirs" ADD CONSTRAINT "legacy_dirs_machine_fk" FOREIGN KEY ("owner","machine_id") REFERENCES "public"."machine"("owner","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_task_fk" FOREIGN KEY ("owner","task_id") REFERENCES "public"."task"("owner","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_nonce" ADD CONSTRAINT "request_nonce_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_nonce" ADD CONSTRAINT "request_nonce_key_fk" FOREIGN KEY ("owner","key_id") REFERENCES "public"."client_key"("owner","key_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_project_fk" FOREIGN KEY ("owner","project_id") REFERENCES "public"."project"("owner","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_project_fk" FOREIGN KEY ("owner","project_id") REFERENCES "public"."project"("owner","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_pr" ADD CONSTRAINT "task_pr_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_pr" ADD CONSTRAINT "task_pr_task_fk" FOREIGN KEY ("owner","task_id") REFERENCES "public"."task"("owner","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_event" ADD CONSTRAINT "transcript_event_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_event" ADD CONSTRAINT "transcript_event_run_fk" FOREIGN KEY ("owner","run_id") REFERENCES "public"."transcript_run"("owner","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_run" ADD CONSTRAINT "transcript_run_owner_app_user_username_fk" FOREIGN KEY ("owner") REFERENCES "public"."app_user"("username") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_run" ADD CONSTRAINT "transcript_run_task_fk" FOREIGN KEY ("owner","task_id") REFERENCES "public"."task"("owner","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_flow_code_hash_unique" ON "auth_flow" USING btree ("code_hash") WHERE "auth_flow"."code_hash" is not null;--> statement-breakpoint
CREATE INDEX "auth_flow_expires_idx" ON "auth_flow" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "client_key_owner_idx" ON "client_key" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "directory_machine_idx" ON "directory" USING btree ("owner","machine_id");--> statement-breakpoint
CREATE INDEX "directory_project_idx" ON "directory" USING btree ("owner","project_id");--> statement-breakpoint
CREATE INDEX "note_task_idx" ON "note" USING btree ("owner","task_id","created_at","id");--> statement-breakpoint
CREATE INDEX "passkey_owner_idx" ON "passkey" USING btree ("owner");--> statement-breakpoint
CREATE UNIQUE INDEX "project_one_default_per_owner" ON "project" USING btree ("owner") WHERE "project"."is_default";--> statement-breakpoint
CREATE INDEX "request_nonce_seen_idx" ON "request_nonce" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "schedule_project_idx" ON "schedule" USING btree ("owner","project_id");--> statement-breakpoint
CREATE INDEX "schedule_directory_idx" ON "schedule" USING btree ("owner","directory_id");--> statement-breakpoint
CREATE INDEX "session_owner_idx" ON "session" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "session_expires_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "task_board_idx" ON "task" USING btree ("owner","project_id","status","priority","position");--> statement-breakpoint
CREATE INDEX "task_claim_idx" ON "task" USING btree ("owner","status","not_before");--> statement-breakpoint
CREATE INDEX "task_schedule_idx" ON "task" USING btree ("owner","schedule_id");--> statement-breakpoint
CREATE INDEX "task_directory_idx" ON "task" USING btree ("owner","directory_id");--> statement-breakpoint
CREATE INDEX "task_pr_task_idx" ON "task_pr" USING btree ("owner","task_id","created_at");--> statement-breakpoint
CREATE INDEX "transcript_run_task_idx" ON "transcript_run" USING btree ("owner","task_id","started_at");--> statement-breakpoint
CREATE POLICY "tenant" ON "app_user" AS PERMISSIVE FOR ALL TO "board_app" USING ("username" = (select current_setting('app.owner', true))) WITH CHECK ("username" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "client_key" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "directory" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "document" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "legacy_dirs" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "machine" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "note" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "passkey" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "project" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "request_nonce" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "schedule" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "session" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "task" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "task_pr" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "transcript_event" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));--> statement-breakpoint
CREATE POLICY "tenant" ON "transcript_run" AS PERMISSIVE FOR ALL TO "board_app" USING ("owner" = (select current_setting('app.owner', true))) WITH CHECK ("owner" = (select current_setting('app.owner', true)));