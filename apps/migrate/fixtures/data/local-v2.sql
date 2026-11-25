--
-- PostgreSQL database dump
--

-- Dumped from database version 16.16 (Debian 16.16-1.pgdg13+1)
-- Dumped by pg_dump version 16.16 (Debian 16.16-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;

--
-- Name: auth_flow_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.auth_flow_kind AS ENUM (
    'oidc',
    'saml',
    'passkey-login',
    'passkey-register',
    'passkey-signup'
);

--
-- Name: next_run; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.next_run AS ENUM (
    'fresh',
    'resume'
);

--
-- Name: note_author; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.note_author AS ENUM (
    'agent',
    'user',
    'system',
    'server'
);

--
-- Name: note_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.note_kind AS ENUM (
    'comment',
    'question',
    'answer',
    'event',
    'polish'
);

--
-- Name: pr_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pr_state AS ENUM (
    'open',
    'merged',
    'closed'
);

--
-- Name: session_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.session_method AS ENUM (
    'passkey',
    'oidc',
    'saml'
);

--
-- Name: task_actor; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.task_actor AS ENUM (
    'user',
    'agent',
    'machine'
);

--
-- Name: task_creator; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.task_creator AS ENUM (
    'intake',
    'user',
    'agent'
);

--
-- Name: task_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.task_priority AS ENUM (
    'urgent',
    'high',
    'normal',
    'low'
);

--
-- Name: task_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.task_status AS ENUM (
    'backlog',
    'todo',
    'running',
    'waiting',
    'needs-me',
    'done'
);

--
-- Name: board_owners(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.board_owners() RETURNS TABLE(username text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
	SELECT app_user.username FROM public.app_user ORDER BY app_user.username
$$;

--
-- Name: machine_for_token(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.machine_for_token(hash text) RETURNS TABLE(owner text, name text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
	UPDATE public.machine SET last_seen_at = now()
	WHERE machine.token_hash = "hash" AND machine.revoked_at IS NULL
	RETURNING machine.owner, machine.name
$$;

--
-- Name: passkey_by_credential(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.passkey_by_credential(id text) RETURNS TABLE(owner text, public_key text, counter bigint, transports jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
	SELECT passkey.owner, passkey.public_key, passkey.counter, passkey.transports
	FROM public.passkey WHERE passkey.credential_id = "id"
$$;

--
-- Name: passkey_used(text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.passkey_used(id text, new_counter bigint) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
	WITH updated AS (
		UPDATE public.passkey SET counter = "new_counter", last_used_at = now()
		WHERE passkey.credential_id = "id"
			AND ("new_counter" > passkey.counter OR ("new_counter" = 0 AND passkey.counter = 0))
		RETURNING 1
	)
	SELECT EXISTS (SELECT 1 FROM updated)
$$;

--
-- Name: purge_auth(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_auth() RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
	WITH sessions AS (DELETE FROM public.session WHERE session.expires_at <= now() RETURNING 1),
		flows AS (DELETE FROM public.auth_flow WHERE auth_flow.expires_at <= now() RETURNING 1)
	SELECT (SELECT count(*) FROM sessions)::integer + (SELECT count(*) FROM flows)::integer
$$;

--
-- Name: session_owner(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.session_owner(hash text, ttl_seconds integer) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
	found_owner text;
BEGIN
	SELECT session.owner INTO found_owner FROM public.session
	WHERE session.token_hash = "hash" AND session.expires_at > now();
	IF found_owner IS NULL THEN
		RETURN NULL;
	END IF;
	UPDATE public.session
	SET last_seen_at = now(), expires_at = now() + make_interval(secs => "ttl_seconds")
	WHERE session.token_hash = "hash" AND session.last_seen_at < now() - interval '1 hour';
	RETURN found_owner;
END
$$;

--
-- Name: username_taken(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.username_taken(name text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
	SELECT EXISTS (SELECT 1 FROM public.app_user WHERE app_user.username = "name")
		OR EXISTS (SELECT 1 FROM public.passkey WHERE passkey.owner = "name")
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;

--
-- Name: app_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_user (
    username text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    key_id text,
    key_slots jsonb,
    source public.session_method,
    CONSTRAINT app_user_key_all_or_nothing CHECK (((key_id IS NULL) = (key_slots IS NULL))),
    CONSTRAINT app_user_username_not_empty CHECK ((username <> ''::text))
);

--
-- Name: auth_flow; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_flow (
    id text NOT NULL,
    kind public.auth_flow_kind NOT NULL,
    challenge text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    owner text,
    expires_at timestamp with time zone NOT NULL
);

--
-- Name: link_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.link_rules (
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL,
    version integer NOT NULL,
    document text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT link_rules_document_sealed CHECK ((document ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT link_rules_version_positive CHECK ((version >= 1))
);

--
-- Name: machine; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machine (
    name text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone,
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL,
    client_version text,
    client_api integer,
    dirs text,
    dirs_index text,
    dirs_updated_at timestamp with time zone,
    catalog text,
    catalog_index text,
    catalog_updated_at timestamp with time zone,
    usage text,
    usage_index text,
    usage_updated_at timestamp with time zone,
    feeds text,
    feeds_index text,
    feeds_updated_at timestamp with time zone,
    feed_requests text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT machine_catalog_index_blind CHECK ((catalog_index ~ '^abh1[.][A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT machine_catalog_sealed CHECK ((catalog ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT machine_dirs_index_blind CHECK ((dirs_index ~ '^abh1[.][A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT machine_dirs_sealed CHECK ((dirs ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT machine_feeds_index_blind CHECK ((feeds_index ~ '^abh1[.][A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT machine_feeds_sealed CHECK ((feeds ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT machine_usage_index_blind CHECK ((usage_index ~ '^abh1[.][A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT machine_usage_sealed CHECK ((usage ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text))
);

--
-- Name: note; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.note (
    id text NOT NULL,
    task_id text NOT NULL,
    author public.note_author NOT NULL,
    kind public.note_kind NOT NULL,
    body text NOT NULL,
    questions text,
    answers text,
    question_note_id text,
    by text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL,
    preview text,
    suggestion text,
    pending boolean DEFAULT false NOT NULL,
    queued boolean DEFAULT false NOT NULL,
    delivered_at timestamp with time zone,
    CONSTRAINT note_answers_sealed CHECK ((answers ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT note_body_sealed CHECK (((((author)::text = 'server'::text) AND (kind = 'event'::public.note_kind)) OR (body ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text))),
    CONSTRAINT note_preview_sealed CHECK ((preview ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT note_questions_sealed CHECK ((questions ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT note_suggestion_agent_comment CHECK (((suggestion IS NULL) OR (((author)::text = 'agent'::text) AND (kind = 'comment'::public.note_kind)))),
    CONSTRAINT note_suggestion_sealed CHECK ((suggestion ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text))
);

--
-- Name: passkey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.passkey (
    credential_id text NOT NULL,
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL,
    public_key text NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    transports jsonb DEFAULT '[]'::jsonb NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    CONSTRAINT passkey_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 60)))
);

--
-- Name: schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule (
    id text NOT NULL,
    title text NOT NULL,
    input text NOT NULL,
    priority public.task_priority DEFAULT 'normal'::public.task_priority NOT NULL,
    machine text,
    workdir text,
    every_ms bigint,
    cron text,
    timezone text,
    anchor_at timestamp with time zone NOT NULL,
    last_occurrence_at timestamp with time zone,
    remaining integer,
    until timestamp with time zone,
    paused_at timestamp with time zone,
    ended_at timestamp with time zone,
    occurrence_task_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL,
    model text,
    agent text,
    auto_done boolean DEFAULT false NOT NULL,
    more_crons text[] DEFAULT '{}'::text[] NOT NULL,
    after_schedule_id text,
    after_delay_ms bigint,
    max_concurrent integer,
    requested_lane text,
    effort text,
    icon text,
    labels text,
    CONSTRAINT schedule_after_delay CHECK (((after_schedule_id IS NULL) = (after_delay_ms IS NULL))),
    CONSTRAINT schedule_agent_sealed CHECK ((agent ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT schedule_icon_sealed CHECK ((icon ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT schedule_input_sealed CHECK ((input ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT schedule_labels_sealed CHECK ((labels ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT schedule_one_rule CHECK ((((((every_ms IS NOT NULL))::integer + ((cron IS NOT NULL))::integer) + ((after_schedule_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT schedule_title_sealed CHECK ((title ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT schedule_workdir_sealed CHECK ((workdir ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text))
);

--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    token_hash text NOT NULL,
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL,
    method public.session_method NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

--
-- Name: shared_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_agents (
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL,
    version integer NOT NULL,
    document text NOT NULL,
    pushed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shared_agents_document_sealed CHECK ((document ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT shared_agents_version_positive CHECK ((version >= 1))
);

--
-- Name: task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task (
    id text NOT NULL,
    title text NOT NULL,
    input text NOT NULL,
    status public.task_status DEFAULT 'todo'::public.task_status NOT NULL,
    "position" double precision NOT NULL,
    closed boolean DEFAULT false NOT NULL,
    machine text,
    session_id text,
    next public.next_run DEFAULT 'fresh'::public.next_run NOT NULL,
    open_question_note_id text,
    dedupe_key text,
    parent_id text,
    created_by public.task_creator DEFAULT 'user'::public.task_creator NOT NULL,
    proposed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    priority public.task_priority DEFAULT 'normal'::public.task_priority NOT NULL,
    lane text,
    borrowed boolean DEFAULT false NOT NULL,
    last_active_at timestamp with time zone,
    paused_at timestamp with time zone,
    workdir text,
    closed_at timestamp with time zone,
    run_started_at timestamp with time zone,
    head text,
    not_before timestamp with time zone,
    schedule_id text,
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL,
    wake_at timestamp with time zone,
    wait_check boolean DEFAULT false NOT NULL,
    woken_at timestamp with time zone,
    model text,
    pr_state public.pr_state,
    stop_requested_at timestamp with time zone,
    inbox_read boolean DEFAULT false NOT NULL,
    stop_message_id text,
    home_workdir text,
    agent text,
    run_id text,
    watches text,
    watch_stops text[] DEFAULT '{}'::text[] NOT NULL,
    fork_of text,
    auto_done boolean DEFAULT false NOT NULL,
    moved_by public.task_actor,
    occurrence_finished_at timestamp with time zone,
    requested_lane text,
    effort text,
    icon text,
    labels text,
    CONSTRAINT task_agent_sealed CHECK ((agent ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT task_dedupe_key_blind CHECK ((dedupe_key ~ '^abh1[.][A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT task_head_blind CHECK ((head ~ '^abh1[.][A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT task_home_workdir_sealed CHECK ((home_workdir ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT task_icon_sealed CHECK ((icon ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT task_input_sealed CHECK ((input ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT task_labels_sealed CHECK ((labels ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT task_title_sealed CHECK ((title ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT task_watches_sealed CHECK ((watches ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT task_workdir_sealed CHECK ((workdir ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text))
);

--
-- Name: task_pr; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_pr (
    id text NOT NULL,
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL,
    task_id text NOT NULL,
    pr text NOT NULL,
    state public.pr_state,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT task_pr_pr_sealed CHECK ((pr ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text))
);

--
-- Name: title_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.title_rules (
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL,
    version integer NOT NULL,
    document text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT title_rules_document_sealed CHECK ((document ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT title_rules_version_positive CHECK ((version >= 1))
);

--
-- Name: transcript_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_event (
    run_id text NOT NULL,
    seq integer NOT NULL,
    at timestamp with time zone NOT NULL,
    kind text NOT NULL,
    parent text,
    data text NOT NULL,
    output text,
    output_size integer,
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL,
    CONSTRAINT transcript_event_data_sealed CHECK ((data ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT transcript_event_output_sealed CHECK ((output ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text))
);

--
-- Name: transcript_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_run (
    id text NOT NULL,
    task_id text NOT NULL,
    machine text NOT NULL,
    session_id text,
    resumed boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone NOT NULL,
    last_event_at timestamp with time zone NOT NULL,
    event_count integer DEFAULT 0 NOT NULL,
    owner text DEFAULT current_setting('app.owner'::text, true) NOT NULL
);

--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);

--
-- Data for Name: __drizzle_migrations; Type: TABLE DATA; Schema: drizzle; Owner: -
--

INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (1, '5671555fe333e5c1a808256e739b4ea94f548e32ab31559ccb8fd7e05b201747', 1794568443428);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (2, '8cfc7eab26be8a242942599e23195b7ca8e4ee011d6b1dd922991d6368e8d0d2', 1794578032709);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (3, '96730aa623f2d7d767b2cb74895799997cd1eadffe07b6eb63e7a7b68ae94627', 1794600418368);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (4, 'd1ed6ba842c729541bb9f8c4666c34e61db4be7b282f53f80904cdc0a923e2e1', 1794602356051);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (5, 'f0dd7f03913927b6f661cdb7755e30c29a6483aae828ca902efccfa5211e5e74', 1794607389857);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (6, '2fe8167e613bca8bf64f1e4d096bf464361551402ea0b3337c5ec77194475f37', 1794613132292);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (7, '5c79c9b1d144aa3c3cef39a107d3483c7fa4d0b2e5e2e37889e3852786dcfd7d', 1794613503179);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (8, 'c0131a9cb97b1f43be4ba4856d25a34956dc534427bedc22afae14201e37d4f9', 1794657440929);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (9, 'dd595668c15ae0a2381fa4d9b7530f2fae21770b38bf5e5b516c9f3f47ade657', 1794657717302);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (10, 'f356a59b4231e28d2ebf117ecd96c34915bd541e5071ee9ac9c24b48590ea932', 1794658229792);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (11, 'c1feebb6b961a5b788b61ff69c86d79bf5bde0211ef137614a64f957d05c84b1', 1794661829792);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (12, '64e2902f205618f56b3d804091a60c323396a14cc17de4c3b213c48420f8f8a3', 1794670957817);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (13, '2ef6ef6c423a75a68b40fd47a275c770f38668a6c8dc8fa3d2a3aaab003536b9', 1794671504545);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (14, '4cee96600e52c9de9b4685fa54b2b3a9ab084a51534df299c4608f3bb0fd6ace', 1794675286222);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (15, '949f7b93eb198af4b31959f00e1dba62d0d54c0a623d0c4c363f821b82b36de5', 1794677439656);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (16, '62bf0f904ef3f4c530cd28e6effee433ef9b0d08bd0ccf1843eafab44032d747', 1794698633738);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (17, '0823971379176607933638140b2b2fcf1554acfde066f530aca38fe4de1141e0', 1794736688590);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (18, 'eca333a955fab8dccaaa5428a533b2a6af7548a402a4c12f6e2830ba494b5496', 1794738067027);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (19, '771d34a8c6dd1a2dbd491b3a7439b10f58ba74486202eda87a5cb12d95ad8370', 1794756253388);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (20, '601e4d1088ea7cf03ff400d406539173822bf234cc883a4753b353e6e445fc33', 1794765642666);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (21, '078c57f7db5cfedd0c0c0374f16b9bb6c924a0ec868b415a1da6d5fd6503bab8', 1794769661935);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (22, '2f88156d020af8cba0703d4f7c7bcb25190441101317ca80a9120e57a6057944', 1794777795598);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (23, '7bfa9e55e41803bd75c72a8773d15c6b815e3b0e0e1a24b700077469e44dc037', 1794777911435);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (24, 'ef3b4eec1a6f1fea8efa4ba4c4b257ed4e430010b8adaf65f6d6fda00c6d463b', 1794779001445);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (25, '6e76799e1b49feae39b37c373f638c3dd466a6ea8b0242c84f7d8099010fe2d2', 1794782750199);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (26, '86cdc9bf722befdf1fc68473972caf37589986a1aabd83d4cb20bc0a75347eaf', 1794809800899);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (27, 'd43867ab6c44290a7f6c1dc5aba1dbf0d9c285961b5a914ef81e02f762e72601', 1794817225233);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (28, '022873255c6f9d435db9ebae066d674f1dd43d38c929aa7624e0d8f83be22fee', 1794839675055);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (29, 'ee2566ea9789841e18e83a02f0e06bf3bdc0f8553466f7447ea28b5d802d5a2b', 1794845127743);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (30, '388e41f7ef2fbe456c1e971104ca5f845682031986d3f4e53351fe229400776d', 1794847138914);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (31, 'fff98abec17bc226aae9de0ca77f9a86e812edf2f8e695dce916e9e60f2fe45f', 1794848419631);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (32, '608946579588ae3252133b391fd45848ffdc1a102e521cb257752490019841ab', 1794870440329);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (33, 'f23b0b879e978a8dd1983b6419feeba0282547d00dfa79f6a937cca51ba076a8', 1794900426723);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (34, '6b17cbf012fe1d3524bd04fe72fc342b7e67694ebe4c5b7c5f6f32a64185636d', 1794905985299);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (35, '8cca4daf8523916a82d75721885507ccd6ac2195051212568164a279986da253', 1794908668234);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (36, '48219f9f96a73e427905427a41f9de288302500b8dd2c5e14fdbc1500ed3f2c5', 1794909311117);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (37, '71159049c501e6ff26118c095a084b54e494f76124b9912e6dd55ae9ad3959ec', 1794915784557);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (38, '9e9f3e87dc05f7a58262b370599db3e25edd3eb5c35f4905e89cb59349f530c4', 1794917131296);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (39, 'ce71f860ef7a11c089490e1565c04c7c028772d0a0f898dbb61a50a212f07c56', 1794948956020);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (40, '1ed57f8c76b58c8ab311b6ab72de21a3b2dc44892605ee99d0ba9992a72ffe97', 1794987060293);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (41, '72ab145051e4443b9d18d6d628e61a1afa44edae293e8339fdc7d20acad2e405', 1794990658728);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (42, '84d6a93ed385fea4f06570deeab7a780c6a1ccf258719e09976d7841536caa67', 1795021496337);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (43, 'd0e604126f96b725d0036e2b2dc85bbe99c5b64605bcb1c70419ecab75c08838', 1795025488924);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (44, 'ee168b59afba4b833c648e57fd821f524fd1d12fc7099c8a8d8015064c83119b', 1795028840571);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (45, '74e7e3fb7558934c40b2cb330cb45a89c2922bd21c1ac881463bb69c6e177e88', 1795089715569);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (46, '64cc06bdad5bde26d2248df33af6ceb437da1a6f74b25d25ae0b0592b77f18fc', 1795100989616);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (47, '7bb5ca364b0370ffe31b195d0bf71546687f4b1a4dc2a3156bad0a365a15c4b2', 1795187395462);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (48, '91d581d9458cb379c344a58fd4e117700e0dd8285397db8f3282e8093d965634', 1795285632974);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (49, 'ba45646f6256375eefa3c05c816b20266e073b150bb79a17e5d7cc7ac9d807dd', 1795388016084);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (50, '03316e6675995088a01bbf51ae41cc82755f64d7883c89ff06e289e1436f310c', 1795389484236);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (51, 'a2af908815c63a60671f18dc41637ad85753515812864b08c2aac3f089e33e6a', 1795390257067);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (52, '4db22a671f5c4b0a3e9330a31522da45d67787928308266a51ac36aa3d93bfbf', 1795390260760);

--
-- Data for Name: app_user; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.app_user (username, created_at, key_id, key_slots, source) VALUES ('fixture-owner', '2026-11-01 09:00:00+00', 'bdd7276613c256e4', '[{"m": 65536, "p": 1, "t": 3, "kdf": "argon2id", "kind": "passphrase", "salt": "nyG4cEaAI0iBKPGGfZnkzQ", "wrapped": "abw1.tVZMGxaEiayybPY5Kqa9kXYcojbxkXLffcIuRppOXEtBzB4-tX-eOrFcODJbVMrxdUVxxtrqZ-E7n0MG"}, {"kind": "recovery", "wrapped": "abw1.pfDAy64z1KgfKfey7ezVNHkQMpeH72KlzzCLf6Q_R8zcwzTXOIxg7NNa8spfQdtkLGBkB_yYmQGwcUl-"}]', 'passkey');

--
-- Data for Name: auth_flow; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: link_rules; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.link_rules (owner, version, document, updated_at) VALUES ('fixture-owner', 2, 'abe1.hEHd3ICY2GfHCOHWfm7cYq9lBpllYO5W6B10Aws4IQCQ-7MyQ_7IO3yDhVZKeejul2cwySm20GLhlhEgH7PD_q3SwOE3kTJkFE8jzC5BUtx7B5JQLO7zY4WYfOVQ1FTerxWkHeTl2eKFzAMpgSoXBCtgTLcQR3ptBqk5hTeX5LL9TDxTUwQXRHQ', '2026-11-01 09:07:00+00');

--
-- Data for Name: machine; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.machine (name, token_hash, created_at, last_seen_at, revoked_at, owner, client_version, client_api, dirs, dirs_index, dirs_updated_at, catalog, catalog_index, catalog_updated_at, usage, usage_index, usage_updated_at, feeds, feeds_index, feeds_updated_at, feed_requests) VALUES ('fixture-laptop', 'd4152cf9a65e4494c2fbdea993aa3914a615706e06f63164204d40053e9a0c4e', '2026-11-01 09:01:00+00', '2026-11-01 11:00:00+00', NULL, 'fixture-owner', '0.0.0-fixture', 3, 'abe1.LPMOwgN2H2RuN-59YmEU6I8Nf3Rylgc4kclsgi2gFvu1YWN7-x-vbzEBmV6xWlz5wrmfum9nCWJ85dWGd_5Av-4BlD5EhSL1j13El1g1OsISWksS_bb0siRq9tBLsPlbgVN78om1EcXPb2dO-jw8OQ1d1YREUD47HxrE0qi5bmamWNK5C4Mj_bPOqte8VXgt-VAjDmzqRHpeMTA6gaPD_0FntRl9_NXZsv4JtA56SOpWAddI', 'abh1.D8UIQJs9Ebaa23uGeiUpfpylV1Ow2Jgl3Uivoe5quvQ', '2026-11-01 09:10:00+00', 'abe1.Nykzw8pnC22OjraTYjIaIpUArZ4ZLc6j6XuOAjowTsViFSrczuLflwnLDMG2X_pD_3VkvflZp4N9GLw0ghzQh_e5OvDQ_wfR1EalkVn_0Dt3OlEodJboW_V5mNW4YyN1uAuCA0CZ2tbD14PpVouv5VCBp6lbNJ-COT-Q-pJyL5CqNOAKJbw', 'abh1.KklqWNoBGNXp-JBC65KQvxOSWAyVW-HFiejKHx1ghJo', '2026-11-01 09:11:00+00', 'abe1.Aitq9G4swoY5d8Kjy--aPQaUFL0XP5b_uA2aIdXEM2QtO9k9794-OIGSzsnxYCfIQzgybn-dloxmgekZELT95yzqLibSO7xsbrUnMajJlxd4GL_oa94NdCexG-aV1rAN3E6aIuffKIzfw9ghcY5giR2YhA5h6OiUBYy-As4DzzZutHs7TCt9PwdW3vJtRkHoZ-g-v88huRVyWG4Ln6U8jHU5f8SokSp2z_5PRBN8', 'abh1.j4XAeiVe38IoHVtrTjy-yn1KnKLwZLchUmRvWKboiEg', '2026-11-01 09:12:00+00', 'abe1.7VqRI64vgawoGKekdJ-1nQWm38bxZiFjN58Xq2gjfc0xNHMxJk7mwge2-IsAUZMJ0pUpiR4V1xkcf5NNCo6JcI7f2ASR6vmiUmvgx7tey8KgwTOLTO2M_crY39j9qhfWRzFT', 'abh1.qu5aH70fDwKnlbKlFdBoVXhc-mdInPMiyeVCREjWyss', '2026-11-01 09:13:00+00', '{pause:fixture-feed}');
INSERT INTO public.machine (name, token_hash, created_at, last_seen_at, revoked_at, owner, client_version, client_api, dirs, dirs_index, dirs_updated_at, catalog, catalog_index, catalog_updated_at, usage, usage_index, usage_updated_at, feeds, feeds_index, feeds_updated_at, feed_requests) VALUES ('fixture-server', '10b1eb9d3810a486e3e299eaccb5a7d2640bdd709835fb8fcf7fa45c8e197c4b', '2026-11-01 09:02:00+00', '2026-11-01 11:01:00+00', NULL, 'fixture-owner', '0.0.0-fixture', 3, 'abe1._oLXJSPVEWYh4tJ_WODyfIA0VEbM3YZINva4GEtMWw1FeiGC3kBGLEN39PDro5fNEeS_J4YQcjeqrPBYuo58gadLrSTbkNTrPjpfA76NH_uUaN4O', 'abh1.hUvilfOFZyS7E3dHL4LUIGjbT6FJgzbXNVtQTDqGRoI', '2026-11-01 09:11:00+00', 'abe1.zpPOBRPuH4WBbJxT09mmEmOY7jd1yn1nAIvyADjd6MQu3G2C8o2B1veicAAtjOehGMrm4jj065uYXt_ckHCnHAGGgl4ZUYS9KBpnXSF8', 'abh1.rXaHNEhn9j2rkKoEXx6Uyf0w5VEl_FlWK-qgoR4sfrw', '2026-11-01 09:12:00+00', 'abe1.dcUcCp7e7E7pHXgM_PVveE0u_u1-7BD449icGRQ5VJmhX73fxaVP0ew22Sx6HECmnrMAcdZMdU4nAy_WsMWW2tnAjtJ8bGegeGmQ0bJFvsB1WE7fkeEfKMup1BV3jzMRvvjVQ-2P7Jj7Gs-Rs1iCKey1OF9PKnu9l0DlCukTlRtpIE8BBs2MOn2zLyt7HlLaEh1mZGd7DkuSj5etOW-NLtn10U6_f-vOnWVh8QQM', 'abh1.j4XAeiVe38IoHVtrTjy-yn1KnKLwZLchUmRvWKboiEg', '2026-11-01 09:13:00+00', 'abe1.l8WPeINNgxdW3XZmVbde8wcLAJWxyw-GDpsNQ-Th1aWer09hrWBKUe2zhEsckXW5UxWArlW6UmB1M8mcGbKSNYxZyBTcGjx8VJtNwZVWrFc3tEUOLva_jnzkzePSJloXzGV2', 'abh1.qu5aH70fDwKnlbKlFdBoVXhc-mdInPMiyeVCREjWyss', '2026-11-01 09:14:00+00', '{}');

--
-- Data for Name: note; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-question-open', 'fixture-needs-me', 'agent', 'question', 'abe1.5b1hVAM-E7AoARFSZeKDakFgHV5qoxrdgO_-lBvvvy_ZbeF6f3pOHgJYBfUPrnah4inIMa26EU4i668Nb-t9lAknpkgSEyzpICM', 'abe1.hyeDJtNI3Yxi6A6JSbQc2wss8bttAPqFv7M7nsxT5ROp3vwO8jSVtDz49APgGVKukPGMoDgdF8SvUFJ9nJQxvH5kUWx5cZ6QetJe0-XooGxJxz-xMGyT-NwgEdNdv5fFpBXHUh7McDYCq_zY1K8MeCFWfJ8reMoTIR2rQ9RGQT-J-sTTD0QawRnV1YNh2jz471TrKRnIl0ufeZv5cxcKEnMRePf6gJ_lIBet3Bo-XRpPPF8keb2aXfKfo4qoOF4n0hOmdAhjbbIrg_Upf7rGywVrP05lV8fiAKcBfv0-d7yryJLC2Ei0GrYXlBAFahGH-ZDzc52cHzwUDy0Iv4fyl9DGRZesd0-_N2CLbLvlq4tvYN0e4_bWx9KI2fTx64O1KZu9ktmkkx2W', NULL, NULL, 'fixture-laptop', '2026-11-01 11:00:00+00', 'fixture-owner', 'abe1.N8sREmNnCLIH1FYZU8v2M306rynyQEOraCwWyx0zegIfZi8D_LyKvVQ81czGuLmWJrnV_pEgeSoghXV0zWNd6cBNvYA', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-question-done', 'fixture-done', 'agent', 'question', 'abe1.aYjDgW73qrFAjssoVAo4uLvChfsCJna4cL07fe0RmxMG93jyhi17_-D2DOLAn6TIriJLVmDiaw-3Pg2qJEIq', 'abe1.8neZgx5ovw4Q9os5x9MilChel9kPuH-xqxtRxQy_PoAo3NuvB7H4TO_evPwj-95vzN6mp8vAdSq3bqAvY2OEDJJIhkX9I2AdaUJAT9QcNg-YY-pwUkeanYo2RaWFiyCIvEAr5mF5AzaY12FVai7jM1gH4rmHnLkaB3d1-uXVNfFBNGEJtYfzZHOGsL1dzh7rY0UIsafhcvl5jxNOBodLp9AoAGXSDMTzb_VCAwBh9GbUN3PyTs5TCB60Z0xR4GY5rm8ygVS149s4Zz4OfQIYiHZ2B0XK5ZQfl9z8bRZ04YLE1JeRm3vtaCTpRNx7XyefOFEQ6ZKbslaweBgEudmziyANVY8Muc5uwYBtMTIcwr2dCvylf5-zFXVdibMC8582oYX3eqSJCUrL', NULL, NULL, 'fixture-laptop', '2026-11-01 11:10:00+00', 'fixture-owner', 'abe1.qJGxCBf9SuRK8VNVuzs7eKcWln1_hEI0S0pl7tNVLxxaqn7THz0YOopY0yvymjLPL5D7tBxPDbiwLhpoCC9b', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-answer', 'fixture-done', 'user', 'answer', 'abe1.dYuw50q0UwpDBOHRifm_gjYfQ2KjZsY5j3RfmnnR931maQ76GjMzx1rLU0iWi64', NULL, 'abe1.VceVYRE6OHfOu9VjSwlPmJMnESdEGC9QEu3PNHlBti-mzXO_Nxj3bTnkHltTNvuQQ1WkLERatUdn', 'fixture-note-question-done', 'fixture-owner', '2026-11-01 11:15:00+00', 'fixture-owner', 'abe1.EHWGKrdi2Omwz9_5TjUJNww30nk-icX4rT89gZcruAMp58pBJ2ZNG25cPOYysEI', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-user', 'fixture-todo', 'user', 'comment', 'abe1.sMAE49egmS4G8vDKGc21Rm1HcfrrPQXMVk60RWM616gs2UtxXtKaBNIJpO590GYddI6OkoYlCcFl5MxrtOL8etI1tSyx', NULL, NULL, NULL, 'fixture-owner', '2026-11-01 11:20:00+00', 'fixture-owner', 'abe1.itvtnp0fWlE6L_9rgDTsTcq4NUh9ML8yIf8wQE63jkJ7QVP7EQr-ySN57nWcW9Dft5UbQ2t0vIb8blSzP8Hpz7pMU6I', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-pending', 'fixture-running', 'user', 'comment', 'abe1.fzdolmoI57a3mSvYZzloXSVsxOzXU1FPHX578xhXlgXETQOhAsAe1kYvN-w1CTyW0rWVBn7Mcf1HjlPVnFM', NULL, NULL, NULL, 'fixture-owner', '2026-11-01 11:30:00+00', 'fixture-owner', 'abe1.HCBctTX3ocnHK62fpr3sRLk6mlmoTvAl5L-s03MJ9a9JmEu_wccT5IkbpCHpyBIOg6M_wEKdPdsjyaP2Z1k', NULL, true, true, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-delivered', 'fixture-running', 'user', 'comment', 'abe1.hXBZcH2tYcM0P6Zwo64IpUOBooU2xlmLQgLIOKE4-Dp_-o6O6XtFI2Iht-Ykuu505HtvAdncag', NULL, NULL, NULL, 'fixture-owner', '2026-11-01 11:35:00+00', 'fixture-owner', 'abe1.uRtmdlRpm-1q0YoPthho50o6P3mm1qsJnMO0odhkVUpTEJeeEopl_ALzms3qMz4GY2saL-VxJw', NULL, false, true, '2026-11-01 11:36:00+00');
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-agent', 'fixture-running', 'agent', 'comment', 'abe1.gudzK_EG5vti_gIgXJlXI14s6qNQFGKrisK0Nrfgr0-7ujBwwzoQLQ5heqUnk-6CxD_LLcC8-I7dJyyrXXiFnqiFoxvvi02We1IOWQ', NULL, NULL, NULL, 'fixture-laptop', '2026-11-01 11:40:00+00', 'fixture-owner', 'abe1.gA1fMYyjQZeBfXUrmmNaduOEalsdOtwQwxHsgUekr8Aqn1H--ETum1cDscOTLNDHm20yhnMpw2G350UaT-DfVQhjCFs', 'abe1.Rdcv39SZLB_CQ2-lGSceTFFLyB4NCDRshbu0YPi2kI4vL0dcGs2TmdiQmkX1-8eS3eQmMxAMbGvsdQ', false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-polish', 'fixture-done', 'agent', 'polish', 'abe1.k-WLrOwT-RwliKUKgpn2LVztY7m4HtGNa4QFajjOshTT9Y_zp-CPLnlmXt1uVNZDXfm48h-i_77fXX1FUbAV446O', NULL, NULL, NULL, 'fixture-laptop', '2026-11-01 11:45:00+00', 'fixture-owner', 'abe1.iMawXYsEsVlw3osZndiX4X1f8qIu17ydoXB9eefgSr0ZwVzjWIf6IHa-_S9rzsP2igeeBE8IJgFyiT_ePUGveVn4', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-event-system', 'fixture-running', 'system', 'event', 'abe1.9aBbruoHGqnZMYhDY47X_WhIS4WRbTbC6xlg9yhXx8xxFJu7HpQGmENnQISh9RYU3s0s_F0aQ1vb2g', NULL, NULL, NULL, 'fixture-laptop', '2026-11-01 11:50:00+00', 'fixture-owner', 'abe1.kJHuAKxc2HnIIkdgvwr2z9YGhxX8qgs_9hbHy-4d0F7ALY4dy0JOqqW-EaO93iF9SHYbR7gY9_EmaQ', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-event-server', 'fixture-running', 'server', 'event', 'Moved from Todo to Running.', NULL, NULL, NULL, NULL, '2026-11-01 11:51:00+00', 'fixture-owner', NULL, NULL, false, false, NULL);

--
-- Data for Name: passkey; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.passkey (credential_id, owner, public_key, counter, transports, name, created_at, last_used_at) VALUES ('VBSvhmOeNSr3zu0pmqFN0pgj1hA8MUrPayusd5VBBow', 'fixture-owner', 'bZWUOCxEArR2baWbAkErmhncwRl6ZWArFM-qYBTPiQknQfy8A0ChK9u4suAQPMYCIcFwTIt7-vm9rKRDLOosQpHwhzouFRJMKFMEKxY', 4, '["internal", "hybrid"]', 'Fixture laptop key', '2026-11-01 09:05:00+00', '2026-11-01 13:10:00+00');

--
-- Data for Name: schedule; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schedule (id, title, input, priority, machine, workdir, every_ms, cron, timezone, anchor_at, last_occurrence_at, remaining, until, paused_at, ended_at, occurrence_task_id, created_at, owner, model, agent, auto_done, more_crons, after_schedule_id, after_delay_ms, max_concurrent, requested_lane, effort, icon, labels) VALUES ('fixture-schedule-interval', 'abe1.ctC8WAf7qhVg6bi5XNIMgR_eyYDHP5WiM6elNRotWrazZTF9MRoilEaX9kdm', 'abe1.w2w9A7OAJSaYP63CfoQTg3SmFvbsFg5ikwfNUlKAqow6TkKJhSW-I59ZT9Ue89i_mFBiRiv5JrtalRCtyqKDFPrKgReG2KpQAA', 'normal', 'fixture-laptop', 'abe1.ELRukBieOgRaIKrZoa0MK4e8kkmzBBbaV-ddTNW_nnsAm7aGWeTng02DKMS1IA', 3600000, NULL, NULL, '2026-11-01 09:00:00+00', '2026-11-01 10:00:00+00', NULL, NULL, NULL, NULL, 'fixture-occurrence-next', '2026-11-01 09:02:00+00', 'fixture-owner', NULL, NULL, false, '{}', NULL, NULL, 1, NULL, NULL, 'abe1.6Hl1vMRSx1dOEvARQ72OQrD7HkeIX6Nt4mnR9B7QtI_X1A', 'abe1.pAnlwHObmPgz8ZbqDKFVGZ0kcVSIMXfMhSf8Ctu0-8HF4bI');
INSERT INTO public.schedule (id, title, input, priority, machine, workdir, every_ms, cron, timezone, anchor_at, last_occurrence_at, remaining, until, paused_at, ended_at, occurrence_task_id, created_at, owner, model, agent, auto_done, more_crons, after_schedule_id, after_delay_ms, max_concurrent, requested_lane, effort, icon, labels) VALUES ('fixture-schedule-cron', 'abe1.OHxzL3jgwLzleALoNlfSimkta7Lqx23VHVHqEcvjP8GOq3pnf8VNpfG3', 'abe1.MPYXncQMJ_DLDsT0YzXDv9UZQ1OX0hyEW_maBoWpTeeP7EOH3Zh8-rU5myMNtZ76RSiwHrQHRPpoHx12WcpF0RQ-anpQZiip-qq6kn9LOzCi', 'normal', 'fixture-server', 'abe1.4T-2yNEOgZARAcTr6UQhb1f5VXU_ukkPIAfm8wdiPPxQWh6XABmJ9ZxU4Ozr5g', NULL, '30 8 * * 1-5', 'UTC', '2026-11-01 09:00:00+00', NULL, 10, '2027-01-30 09:00:00+00', '2026-11-01 14:00:00+00', NULL, NULL, '2026-11-01 09:03:00+00', 'fixture-owner', 'sonnet', NULL, false, '{"0 18 * * 5"}', NULL, NULL, NULL, NULL, 'low', NULL, NULL);
INSERT INTO public.schedule (id, title, input, priority, machine, workdir, every_ms, cron, timezone, anchor_at, last_occurrence_at, remaining, until, paused_at, ended_at, occurrence_task_id, created_at, owner, model, agent, auto_done, more_crons, after_schedule_id, after_delay_ms, max_concurrent, requested_lane, effort, icon, labels) VALUES ('fixture-schedule-after', 'abe1.dbiF1B3W95XbRAUz-yMYR58KN9Uvg3KW2mCzD9HdVCR3YxXHihScFYJ8TX3IujMssV9Or3yS6vTJJg', 'abe1.apuenPOyhrEJXUEfPIFI0JfdBZ05oGOjmBdSN39WRe7C5cSAQr11Zxo8lQRbO2GoNZ8d6YIsmRzBScYWs5-BmLtY5a5OTgc', 'high', 'fixture-laptop', NULL, NULL, NULL, NULL, '2026-11-01 09:00:00+00', NULL, NULL, NULL, NULL, NULL, NULL, '2026-11-01 09:04:00+00', 'fixture-owner', NULL, 'abe1.-L0gX482Ka5iB481U48aJdWu8rBXWslMDbHyow0uCiF29AKJ', false, '{}', 'fixture-schedule-interval', 120000, NULL, NULL, NULL, NULL, NULL);

--
-- Data for Name: session; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: shared_agents; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.shared_agents (owner, version, document, pushed_at) VALUES ('fixture-owner', 3, 'abe1.z6cI-BBrtpegpESTiGZoV5OYq7LCsa4qc4J23JZ8ng8dChMRUZnmXFBOMvZYOmSRegnfCBa7MucBlzw3UHJXUve3Kd_SlCZRGHKtVQW7Oo5WCF8LzFISr_qJ34aS2yqPVrZg3XJxJqBIEOa97THm6qn6NPvUGT6UbQhj5dAYlNBJZaamoHyudxbe_moaF5mI8WS76aNafeUyH1mCN_znlpLA_5wthC_X2d3aQ4TDbb8xSQtdMQrII3iEA_eKmXM', '2026-11-01 09:06:00+00');

--
-- Data for Name: task; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-backlog', 'abe1.uO8exdTCoaifuO42k4bwYhk1h4nfghkYGTih4nIG6owodRs7AJkaC77xyLn4b74e0e4oxQ', 'abe1.mgSZkywv7QJzPKr7OfBTl3v1-9vQGd1SWbLLFaP29_sTKfucw4kEVI5DsnG8U1UdM3cRk0BAX60N3IcOOWpS87uPkLoGTnUH', 'backlog', 1, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 09:20:00+00', '2026-11-01 09:25:00+00', 'low', NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL, NULL, 'abe1.q614-6NJene81y2O7gplZv33QgLyEYYnxSL-ccwmNxg', 'abe1.WsRHg05tyHD0x2j7tx6QPqi1wB1ODcQz5NL-OyX1dkY8mCz3');
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-proposed', 'abe1.c2zssOVfMubS2MsmJbPdat4-dL9tfYKQCMhkY1abTE3h09CzkG4aevS4Vwu_ia3KK1EHpdX2euqr65LX', 'abe1.QYmW0-7s-bnKm9gl0413T-BuicY7nWSVPVC0cHXZN3LC-m5ON7uBehIwQ02-UsWin44uqkF6xIMHH3ABMgDdARWoxEaIXk8N3IsWC9y7PwVMHA', 'backlog', 2, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'agent', true, '2026-11-01 09:22:00+00', '2026-11-01 09:27:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.4zpvAOqwv_03rSaiFqtgrR8cpn23zeX4XD6p9Nq_zByWceDaWeCrBPpSeNTffA', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.4zpvAOqwv_03rSaiFqtgrR8cpn23zeX4XD6p9Nq_zByWceDaWeCrBPpSeNTffA', NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-todo', 'abe1.AcP5YkPQGqbJSw1WJObY8j7sYqm_8EuHkDkNgV9v_T7rAlNuRMpB9eEcOHEYaD026U4jJIZEqA', 'abe1.Vu8eteaa830EsP51FrbqYO_IxBo7mHRYrMMHOGLO8unWXKe6ReIluI42fDIjU6irbLDglsOzDxQeJa5hXqyC4qdH77bSQkFGEFTnNXda-sR0xBR0x366nQ', 'todo', 1, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 09:30:00+00', '2026-11-01 09:35:00+00', 'high', NULL, false, NULL, NULL, 'abe1.W1Hblu2_mAlPyquhoS4pjkEnaPk626YkX3cQqcRkXP92RRVRNYhEkR93MfA5dg', NULL, NULL, NULL, '2026-11-02 10:00:00+00', NULL, 'fixture-owner', NULL, false, NULL, 'sonnet', NULL, NULL, false, NULL, 'abe1.W1Hblu2_mAlPyquhoS4pjkEnaPk626YkX3cQqcRkXP92RRVRNYhEkR93MfA5dg', NULL, NULL, NULL, '{}', NULL, true, NULL, NULL, 'default', 'high', 'abe1.DsalM6pHrwtgHSOieMw75ZsNSCnLctsV0IeLaHFx_WE', 'abe1.PwG0RP90E0Br065CzRMmYtqFZCi-kuOoYSHEHB9IA_JovKDWNsaTMo3QynL3_1Ck4w');
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-running', 'abe1.0GLactdWN_OFMOnlmZFU3Sqx41MaT4rCDGElysIXAWKCHJ_vPN0oHhrOSHru6YV9dffsrX4', 'abe1.XpaghhES4zksBhuLnkV9RAnVAYtVeoz0c8unbVT5eVQL6ITM5HM-P7BcSNo8QmeoCFu4Z2ry3CL4kyrzN6Q7px1VDExtK81nNd7tWBXCPtRFJs-kDG8', 'running', 1, false, 'fixture-laptop', 'fixture-session-0001', 'resume', NULL, NULL, NULL, 'user', false, '2026-11-01 09:40:00+00', '2026-11-01 09:45:00+00', 'urgent', 'main', false, '2026-11-01 12:20:00+00', NULL, 'abe1.kx3V88XPN8-fRSLIgwfVhS98wESv3YM1ux6paZePOJZ8132aDuvQu404HpDBLlFBjeJr0r8IHskU96W8a68', NULL, '2026-11-01 12:10:00+00', NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, 'opus', NULL, NULL, true, NULL, 'abe1.7P1gn51BVSNYXPHeLQcqw3iTwzIxMI-hJrzt9EGMygtBGFRMXQCMiAryYKYa', NULL, 'fixture-run-current-0001', 'abe1.mCXVa1P9mBX78mQkhGyAwP4fqYdblt85WXM5_OqH7FaCxdKr1Vw7mwDCsc3VSAFKOPgDIgVoUFj0iNOU_E-3P-rVLjBL-JKbtcyCuVBxIs9U8Suttp-PiQMzUWToPRVRK23N4vR30TQtrOM1Dggpj8zL5pn4njpxU3_sTTmnLqBKsrvlUFgmsrjleJBZWGR41jaBWHu-wu4ArNR0FDLtt7j4vkHZBuH38FYEN-_xC08mKAsr9BY_RtK_bukCLp90lAYb3fgLOgKphLH19dsTUJX7RoYowSzkdXZVmV-OpzCooS-assBhAX68KsY-qnJjFb0CVMdtEzW3xqp-uGijpEz6kNsFGNQvZi_SYF7hr08Akc-KFDU-FwYnM1Ok2YOjDmE2F9drdgr4BABSyX68nbQUmMXYCW-lOQ4', '{fedcba9876543210}', NULL, false, 'machine', NULL, NULL, NULL, 'abe1.o7s__q5J9pCBQcedgVdoyZEoCIFZBpyCZe2MLeSL2EM', 'abe1.5thmAYmN4dO-By9_pC1CxwjcXZnhxR0KX3C_FjWT1DQ0_F__Pg');
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-waiting', 'abe1.NMk7M3Y67x2N6C64-iQxCCH7Udyfn_rNgir9nY9TrXifbjHTQ6LTQ-9mamX5WgQKK1bL0RE', 'abe1.03Kpf8w8pWoK52samFoA5T_Tecroycmal63CE5LryGllDX4ph_s5Q7OVE4TS6pyIaQ1ubORnWTtx0KpWXRZavQ5AHMjhfQYUjX4yFB0aHyoKfaHycWDnFpfGIfpZnA', 'waiting', 1, false, 'fixture-server', 'fixture-session-0002', 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 09:50:00+00', '2026-11-01 09:55:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.0uEoimPcSo2OqRjVqOTm6rB_WZcxzPRf-VjFOEPxAaQIZhWfvuu2k_aNwidWPw', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', '2026-11-01 22:20:00+00', true, NULL, NULL, NULL, NULL, false, NULL, 'abe1.0uEoimPcSo2OqRjVqOTm6rB_WZcxzPRf-VjFOEPxAaQIZhWfvuu2k_aNwidWPw', NULL, NULL, 'abe1.rHxn3EogSTBhzhT-ybMeZS7G0bLu7Jd1eI9jvJUNlAY_o3y6PECbYplR1AkDr0I3JYeOs-JJckJ05CgtJWY5FbT12L2GcUNTaJsA_opSV6Woq0JwaxclmJbSARD4Z_VUL8jdd3cTwK23csqdZeXEeTPZptNl87DCwER3C3VFNCEuUVSuubXpgOjOt94fFjoWSpTLm0OfNDHz3MT_4ZBqYh7XrYtjgApvFFrSSNQkPebNTI0CE14LgiUcwbuY4v7FbmfQN-Zd__vr7H42JhAjqXvD8y4kXGRkb4BVDHWFDOkNe9n6lHKsWaTcbLCWGQ1cDLGOvTi5mvd-64iRwfMabngb-JRhXJRRrW3ls77qyfzbkqV9Pa3yTCInsD1zDZaBTK4sjxt6ugWHX1TDmKkTfeAdtPAP02Xa6UM', '{}', NULL, false, 'agent', NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-needs-me', 'abe1.Z-9Zg2BZM9vhllwlaFaWY5w657oQCDjYfje3tTbrwCTLQjvOZ_4b1nTYuW3oZ8OTpQv5tg8', 'abe1.xs_lIRiIRWE6XDMgRZpTSux8ZlOoQBRQ7yDI43L6fa6o9UhRuQeUsvyiW5kpykrFUruqOHawE15KoV7gRYrYqJ5FBz6AQkpdratxZ6K883oTtmEbCB8', 'needs-me', 1, false, 'fixture-laptop', 'fixture-session-0003', 'fresh', 'fixture-note-question-open', NULL, NULL, 'user', false, '2026-11-01 10:00:00+00', '2026-11-01 10:05:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.VzNCy3aSon5TzjUlWoyIt60FsVQSJsKZLAXd1R3se1u0z0x6aPdT414BLs5iFQ', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.VzNCy3aSon5TzjUlWoyIt60FsVQSJsKZLAXd1R3se1u0z0x6aPdT414BLs5iFQ', NULL, NULL, NULL, '{}', NULL, false, 'agent', NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-done', 'abe1.Wpczu3HadtAKAXzeKVatCEOoy6Xa_RepMtJ11igAOX6hXGXpP7cJhX_l2PHusxrN744Bj3eCTw', 'abe1.n9AOWt7e37yEUnIf8ySTXrRmEY4X1rUJroG3-FS1kiJCRdWF9TxdPLkz_yrivh4BcULoMyA4F6plIOqF5VEhZN-0TrcZviDZMt5mViq1W9Y', 'done', 1, false, 'fixture-laptop', 'fixture-session-0004', 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 10:10:00+00', '2026-11-01 10:15:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.cr_wUtLw3JBeUM-QgJ5DMSpQYLAW301G9INXiq1f7Z4S9KON4mtbCZzEpj5xzA', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, 'merged', NULL, false, NULL, 'abe1.cr_wUtLw3JBeUM-QgJ5DMSpQYLAW301G9INXiq1f7Z4S9KON4mtbCZzEpj5xzA', NULL, NULL, NULL, '{}', NULL, true, 'agent', NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-closed', 'abe1.HyeQWtdxwqgUaXIrC3Th6t1BjVuH_0WObO2MIpvx1xuAjHvPRHzssW2KWcmFxbLBJ1UvY1QRcA', 'abe1.meArozWZwOob_w424ALT_DyXbC7vLL2M4VDSFw6YwErpIk07_Jx5XHUSZgWsZ6QzuxsYDWr5L9o', 'done', 2, true, NULL, NULL, 'fresh', NULL, NULL, 'fixture-done', 'user', false, '2026-11-01 10:20:00+00', '2026-11-01 10:25:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.eW4OmMEwum7i0me3ySGqSHxVPNCBfL8DbRk7dKb3sE7hh-Wvobz-5oP9iRoe', '2026-11-01 15:40:00+00', NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.eW4OmMEwum7i0me3ySGqSHxVPNCBfL8DbRk7dKb3sE7hh-Wvobz-5oP9iRoe', NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-fork', 'abe1.eOnqGbV5cr_3aN6zNi3mUlRoUhWpUkk8BWU806KlPjbfeAh0GHP4SP92M_5HO-EQUw', 'abe1.t2pQnmFAY5S7KeegCCgKW7Nw6s0Q_4xpB9_sRz8zMMv3tQ-7tVmvXjGZvnHESSKHH5Kzuc4cXGyvJFibW2rFPYUot4IPVy4HV_PgqSPCyWzm-fM', 'todo', 2, false, NULL, NULL, 'fresh', NULL, NULL, 'fixture-done', 'agent', false, '2026-11-01 10:30:00+00', '2026-11-01 10:35:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.fiLb8zh5Sw51x1go9alUBTs6599AEM5wUnL81eckkeK7qLwmnF52ngtyn4XdTQ', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.fiLb8zh5Sw51x1go9alUBTs6599AEM5wUnL81eckkeK7qLwmnF52ngtyn4XdTQ', 'abe1.Jj0lSue0WQYskOy3UhlgriOL95PyClfnAp650sjjeo7ce-Xo', NULL, NULL, '{}', 'fixture-done', false, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-review', 'abe1.iWiQW9ua19bJCiPKTai0Rxoc1xGxNiACyWVtdVWviX-PEnIz9eF5coGMR_Z-2JaxX8uVMbe_4Jk', 'abe1.lDsE4M4aO7s4nNLaXlGEwIJOH9qCmLloKafk1zwRqAcW2rEVDdAAacln0KovLlpt-A19uL3pbZeCmxu3W6dLV0d7pHhxjUQmAu_0vpML_JhBnj9jSw', 'todo', 3, false, NULL, NULL, 'fresh', NULL, 'abh1.kgq2ia3dz1XNhPk8PrUqWEqtt8W8mMpfhVC9YSnbcHE', NULL, 'intake', false, '2026-11-01 10:35:00+00', '2026-11-01 10:40:00+00', 'normal', NULL, false, NULL, NULL, NULL, NULL, NULL, 'abh1.iZdE3wNsXxXD8Qbd489v2ajXQadPuXKKk56ENG4iP2E', NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, 'open', NULL, false, NULL, NULL, NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-occurrence-done', 'abe1.ctC8WAf7qhVg6bi5XNIMgR_eyYDHP5WiM6elNRotWrazZTF9MRoilEaX9kdm', 'abe1.w2w9A7OAJSaYP63CfoQTg3SmFvbsFg5ikwfNUlKAqow6TkKJhSW-I59ZT9Ue89i_mFBiRiv5JrtalRCtyqKDFPrKgReG2KpQAA', 'done', 3, false, 'fixture-laptop', NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 10:40:00+00', '2026-11-01 10:45:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.4HYbh1LsspH3oMw1EhwN4WNBqSzwHzpuEy5P2YUNaxfUqGZGe6UJYYbUPdoKzg', NULL, NULL, NULL, NULL, 'fixture-schedule-interval', 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.ELRukBieOgRaIKrZoa0MK4e8kkmzBBbaV-ddTNW_nnsAm7aGWeTng02DKMS1IA', NULL, NULL, NULL, '{}', NULL, false, NULL, '2026-11-01 13:20:00+00', NULL, NULL, 'abe1.6Hl1vMRSx1dOEvARQ72OQrD7HkeIX6Nt4mnR9B7QtI_X1A', 'abe1.pAnlwHObmPgz8ZbqDKFVGZ0kcVSIMXfMhSf8Ctu0-8HF4bI');
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-occurrence-next', 'abe1.ctC8WAf7qhVg6bi5XNIMgR_eyYDHP5WiM6elNRotWrazZTF9MRoilEaX9kdm', 'abe1.w2w9A7OAJSaYP63CfoQTg3SmFvbsFg5ikwfNUlKAqow6TkKJhSW-I59ZT9Ue89i_mFBiRiv5JrtalRCtyqKDFPrKgReG2KpQAA', 'todo', 4, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 10:45:00+00', '2026-11-01 10:50:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.ELRukBieOgRaIKrZoa0MK4e8kkmzBBbaV-ddTNW_nnsAm7aGWeTng02DKMS1IA', NULL, NULL, NULL, '2026-11-02 11:00:00+00', 'fixture-schedule-interval', 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.ELRukBieOgRaIKrZoa0MK4e8kkmzBBbaV-ddTNW_nnsAm7aGWeTng02DKMS1IA', NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL, NULL, 'abe1.6Hl1vMRSx1dOEvARQ72OQrD7HkeIX6Nt4mnR9B7QtI_X1A', 'abe1.pAnlwHObmPgz8ZbqDKFVGZ0kcVSIMXfMhSf8Ctu0-8HF4bI');

--
-- Data for Name: task_pr; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.task_pr (id, owner, task_id, pr, state, created_at) VALUES ('fixture-pr-merged', 'fixture-owner', 'fixture-done', 'abe1.j3SLh2z383TRAdQmCHbazK_aLWUfOGWmFHRv3AMLODeAKjAElBmTI6XRkLNjRzzCIlLPGdqXu_BJf-1yDO5R92dT1419nC2LUoF0hfI', 'merged', '2026-11-01 12:11:00+00');
INSERT INTO public.task_pr (id, owner, task_id, pr, state, created_at) VALUES ('fixture-pr-open', 'fixture-owner', 'fixture-running', 'abe1.XaN5y_HtHMViALevCsuAFGOn_QKtTSdXGw_NbWZ28lfdem-UEKPAZkex-k_SyYxtsBmlYwm92rkceEk7Gt9sqFvnbrfcfrXOKpl1CqA', 'open', '2026-11-01 12:12:00+00');
INSERT INTO public.task_pr (id, owner, task_id, pr, state, created_at) VALUES ('fixture-pr-closed', 'fixture-owner', 'fixture-done', 'abe1.07cRmJ9zwJl7-urbGfPz1TTCUBG_SAICnbIjYLfqzJnBpXOALUWLW_V9tqUc2NlSryRoCmzWdODdKee1NK9DGvZVMxBR3UMUKFe5Q18', 'closed', '2026-11-01 12:10:00+00');

--
-- Data for Name: title_rules; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.title_rules (owner, version, document, updated_at) VALUES ('fixture-owner', 1, 'abe1.kjo9Qy4FX_X07f-62IXaFsV7sTTHsdyvoqNmW_k8OcOEjlzvNHW9aYaGryKHTMdRbnFZy8NM2JKWGzWJZxfLP_fkakiSqfVQqpl0ZbPbsa7okm_dAGWyxihA3lfoKjI30jz_o_2SGdVtX-6zlxWV--Q_jEJhEsRJtMso07fQ-TzqLhREBW_HYJEXdtX6KIVyW6dWDvh9dpvnjmVgsWmIEStiyGwyCw', '2026-11-01 09:08:00+00');

--
-- Data for Name: transcript_event; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 0, '2026-11-01 12:30:00+00', 'text', NULL, 'abe1.SRMfd5BWLk9hcMUjFjfLsI_raFiTmxT7W0njnG8Y7bPdjSYKsgmz07vRPclWpb7iCv8C-zR7Y8txd29pOBIvZUd1VYVl2FSu3WUbdeL8rgmyUgRvfP_2dadjR5p0103zRkfNTSZBAgvbrtqnegKgkR9Yn-Lin9ziIpyfpfio6pZ0T-RuQPkRrE3lNg', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 1, '2026-11-01 12:31:00+00', 'tool_use', NULL, 'abe1.a0yz144ngH3zO3tdKrLzvWJOg5RNO4oZEYeoQq7PHeHUZNUcvFiha-NX2HLXoZytt-zN2BFBuBsJazEUw2sAWr1jTPTIjwaeARoLibX8-BGZzYZMXdT8hkM6m7gz9NRtqQ632Og1nVvHPRjT7JrQdnlWh0SNkneDayFoOgJMn6HwyEpP1eEBl1L_pm-CLcm0VlE3d4RwdfQX3SlaZHgRo0dB624vy08tVEmw5jTCjw', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 2, '2026-11-01 12:32:00+00', 'tool_result', NULL, 'abe1.exnG7eiqpUs2WnyyKLjhy7yWlqXVN7LHKJev4B9yWmB16d-w9aXTxAw6sGnI0dPoOVvlLsp5S0mhfarZdfxU_rzw1gewof1lePUUsXkFLIXCRQKkpE3oTxhgAqzxf_li-rJxtA8ZEQ83VjKXLWGnviVA5ZxjKAWPYpjpwa-M31e9M7OcdZNRd4PFWxqw', 'abe1.bilQM5-2eJ3m0JNAfBufu6-VWQQ2Zfty448FLJqxUyGgFHtINJDnTdoh-PEMvusX03lC-AAVUJ4u6Az3snyfvFOuwBGVjlRKtNRX', 47, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 3, '2026-11-01 12:33:00+00', 'result', NULL, 'abe1.DC37GcDXpSEmlzB_sxvSIhaxo1qf7L448_BNQOJcw2sq0Ha0a5kUJ9ZvJwnwZ11kQh1fF3slUaPK6itBRMrNbyUfiNDsr6Y4tSwYXdGOIE0wvcP-3xRzYJbD0r8wYoojjFtSiMWjYkMOMvKiRN6pIh15N62OiINcQ-64QM6z_Y-eaAIxDn41PrDieqRSPl-PIhQTVCThSX41Q0bBgCPtyZXxqg2NgCCAXMsZWVwmMRxmoF-Z-oHKfE2z5oL9sTn_7sPfilf4WTQ4', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000002', 0, '2026-11-01 12:30:00+00', 'text', NULL, 'abe1.bXEfoebV57CM961bL9qCIMuk3m5nwqAptn_GXfOXMiKhM1SVrpqQtldrvASvlbUdNVP9nYOYwq9zoHNKk1C4gdBGaDqBIKcVG9hUHlIF4or_Q9hT8WGiU7uV3m-Y25eZt6zRevxOmu_pfwObJq0Wn2YcUikCbQX_OnrEC0T2UDrILARH-Rvgx1LS9gQcJZe6uGc', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000002', 1, '2026-11-01 12:31:00+00', 'note', NULL, 'abe1.ORc0zy0gnpUuwKuGa8OgWeIFFcuzAH1ljO_od2LOqrNGTOrZ_VBnzOSa1WhHzlDEp3lzAhRJn4FUuu1gKyZ9CWNDIMJqKUm8SrQOJevaIlY9Kow2UgGTs612HYt7thKuT13053eOnZcpCscF9afZKu2ngkfrBXV6UVD9', NULL, NULL, 'fixture-owner');

--
-- Data for Name: transcript_run; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.transcript_run (id, task_id, machine, session_id, resumed, started_at, last_event_at, event_count, owner) VALUES ('fixture-run-0000000001', 'fixture-done', 'fixture-laptop', 'fixture-session-0004', false, '2026-11-01 12:30:00+00', '2026-11-01 12:34:00+00', 4, 'fixture-owner');
INSERT INTO public.transcript_run (id, task_id, machine, session_id, resumed, started_at, last_event_at, event_count, owner) VALUES ('fixture-run-0000000002', 'fixture-running', 'fixture-laptop', 'fixture-session-0004', true, '2026-11-01 12:30:00+00', '2026-11-01 12:32:00+00', 2, 'fixture-owner');

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE SET; Schema: drizzle; Owner: -
--

SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 52, true);

--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);

--
-- Name: app_user app_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_user
    ADD CONSTRAINT app_user_pkey PRIMARY KEY (username);

--
-- Name: auth_flow auth_flow_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_flow
    ADD CONSTRAINT auth_flow_pkey PRIMARY KEY (id);

--
-- Name: link_rules link_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_rules
    ADD CONSTRAINT link_rules_pkey PRIMARY KEY (owner);

--
-- Name: machine machine_owner_name_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine
    ADD CONSTRAINT machine_owner_name_pk PRIMARY KEY (owner, name);

--
-- Name: machine machine_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine
    ADD CONSTRAINT machine_token_hash_unique UNIQUE (token_hash);

--
-- Name: note note_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note
    ADD CONSTRAINT note_pkey PRIMARY KEY (id);

--
-- Name: passkey passkey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkey
    ADD CONSTRAINT passkey_pkey PRIMARY KEY (credential_id);

--
-- Name: schedule schedule_owner_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule
    ADD CONSTRAINT schedule_owner_id_unique UNIQUE (owner, id);

--
-- Name: schedule schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule
    ADD CONSTRAINT schedule_pkey PRIMARY KEY (id);

--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (token_hash);

--
-- Name: shared_agents shared_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_agents
    ADD CONSTRAINT shared_agents_pkey PRIMARY KEY (owner);

--
-- Name: task task_owner_dedupe_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task
    ADD CONSTRAINT task_owner_dedupe_key_unique UNIQUE (owner, dedupe_key);

--
-- Name: task task_owner_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task
    ADD CONSTRAINT task_owner_id_unique UNIQUE (owner, id);

--
-- Name: task task_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task
    ADD CONSTRAINT task_pkey PRIMARY KEY (id);

--
-- Name: task_pr task_pr_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_pr
    ADD CONSTRAINT task_pr_pkey PRIMARY KEY (id);

--
-- Name: title_rules title_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.title_rules
    ADD CONSTRAINT title_rules_pkey PRIMARY KEY (owner);

--
-- Name: transcript_event transcript_event_owner_run_id_seq_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_event
    ADD CONSTRAINT transcript_event_owner_run_id_seq_pk PRIMARY KEY (owner, run_id, seq);

--
-- Name: transcript_run transcript_run_owner_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_run
    ADD CONSTRAINT transcript_run_owner_id_unique UNIQUE (owner, id);

--
-- Name: transcript_run transcript_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_run
    ADD CONSTRAINT transcript_run_pkey PRIMARY KEY (id);

--
-- Name: auth_flow_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_flow_expires_idx ON public.auth_flow USING btree (expires_at);

--
-- Name: note_task_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX note_task_created_idx ON public.note USING btree (task_id, created_at);

--
-- Name: passkey_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX passkey_owner_idx ON public.passkey USING btree (owner);

--
-- Name: session_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_expires_idx ON public.session USING btree (expires_at);

--
-- Name: session_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_owner_idx ON public.session USING btree (owner);

--
-- Name: task_pr_task_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_pr_task_created_idx ON public.task_pr USING btree (task_id, created_at);

--
-- Name: task_status_priority_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_status_priority_position_idx ON public.task USING btree (owner, status, priority, "position");

--
-- Name: transcript_run_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transcript_run_task_idx ON public.transcript_run USING btree (task_id, started_at);

--
-- Name: auth_flow auth_flow_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_flow
    ADD CONSTRAINT auth_flow_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: link_rules link_rules_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_rules
    ADD CONSTRAINT link_rules_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: machine machine_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machine
    ADD CONSTRAINT machine_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: note note_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note
    ADD CONSTRAINT note_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: note note_task_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note
    ADD CONSTRAINT note_task_fk FOREIGN KEY (owner, task_id) REFERENCES public.task(owner, id) ON DELETE CASCADE;

--
-- Name: passkey passkey_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkey
    ADD CONSTRAINT passkey_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: schedule schedule_after_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule
    ADD CONSTRAINT schedule_after_fk FOREIGN KEY (owner, after_schedule_id) REFERENCES public.schedule(owner, id) ON DELETE RESTRICT;

--
-- Name: schedule schedule_occurrence_task_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule
    ADD CONSTRAINT schedule_occurrence_task_fk FOREIGN KEY (owner, occurrence_task_id) REFERENCES public.task(owner, id) ON DELETE SET NULL (occurrence_task_id);

--
-- Name: schedule schedule_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule
    ADD CONSTRAINT schedule_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: session session_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: shared_agents shared_agents_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_agents
    ADD CONSTRAINT shared_agents_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: task task_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task
    ADD CONSTRAINT task_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: task task_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task
    ADD CONSTRAINT task_parent_fk FOREIGN KEY (owner, parent_id) REFERENCES public.task(owner, id) ON DELETE SET NULL (parent_id);

--
-- Name: task_pr task_pr_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_pr
    ADD CONSTRAINT task_pr_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: task_pr task_pr_task_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_pr
    ADD CONSTRAINT task_pr_task_fk FOREIGN KEY (owner, task_id) REFERENCES public.task(owner, id) ON DELETE CASCADE;

--
-- Name: title_rules title_rules_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.title_rules
    ADD CONSTRAINT title_rules_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: transcript_event transcript_event_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_event
    ADD CONSTRAINT transcript_event_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: transcript_event transcript_event_run_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_event
    ADD CONSTRAINT transcript_event_run_fk FOREIGN KEY (owner, run_id) REFERENCES public.transcript_run(owner, id) ON DELETE CASCADE;

--
-- Name: transcript_run transcript_run_owner_app_user_username_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_run
    ADD CONSTRAINT transcript_run_owner_app_user_username_fk FOREIGN KEY (owner) REFERENCES public.app_user(username) ON DELETE CASCADE;

--
-- Name: transcript_run transcript_run_task_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_run
    ADD CONSTRAINT transcript_run_task_fk FOREIGN KEY (owner, task_id) REFERENCES public.task(owner, id) ON DELETE CASCADE;

--
-- Name: app_user; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_user ENABLE ROW LEVEL SECURITY;

--
-- Name: link_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.link_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: machine; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.machine ENABLE ROW LEVEL SECURITY;

--
-- Name: note; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.note ENABLE ROW LEVEL SECURITY;

--
-- Name: passkey; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.passkey ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule ENABLE ROW LEVEL SECURITY;

--
-- Name: session; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;

--
-- Name: shared_agents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shared_agents ENABLE ROW LEVEL SECURITY;

--
-- Name: task; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.task ENABLE ROW LEVEL SECURITY;

--
-- Name: task_pr; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.task_pr ENABLE ROW LEVEL SECURITY;

--
-- Name: app_user tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.app_user TO board_app USING ((username = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((username = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: link_rules tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.link_rules TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: machine tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.machine TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: note tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.note TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: passkey tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.passkey TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: schedule tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.schedule TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: session tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.session TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: shared_agents tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.shared_agents TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: task tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.task TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: task_pr tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.task_pr TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: title_rules tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.title_rules TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: transcript_event tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.transcript_event TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: transcript_run tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.transcript_run TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: title_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.title_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: transcript_event; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transcript_event ENABLE ROW LEVEL SECURITY;

--
-- Name: transcript_run; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transcript_run ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--
