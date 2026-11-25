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
    'passkey-signup',
    'handoff'
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
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (53, '3c2122e100bfa0c935a37edf50a4720a4f53245e7d9f1c6d0b814d14e5ca543c', 1795481712641);

--
-- Data for Name: app_user; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.app_user (username, created_at, key_id, key_slots, source) VALUES ('fixture-owner', '2026-11-01 09:00:00+00', 'eae929da8c6480da', '[{"m": 65536, "p": 1, "t": 3, "kdf": "argon2id", "kind": "passphrase", "salt": "-m-KN7E7qNeyt_QCXGdGjw", "wrapped": "abw1.oKyX-uPhydx-m-uiMH0C5PQI4CqADBOOYOULk4jfzyOkXsH7Y24KnLY6KCoJPloMZW-r_WnJ8FKakk2C"}, {"kind": "recovery", "wrapped": "abw1.3k0PGOmUiYu0DhtEOuqwVnkQEsXzEHSy_QY2p15Zb8H9SNLBDxAX-y7iXsW_rjUaBvMtK8zMCSAU4IFx"}]', 'passkey');

--
-- Data for Name: auth_flow; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: link_rules; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.link_rules (owner, version, document, updated_at) VALUES ('fixture-owner', 2, 'abe1.QpZDTAz0-gSWzoI-3H4sAPhAwQrwO0OOLiHNQg_5jTFc5i57-mv2gw6l7_9CWRiESYRTtQb9EappzYxpp1Fj8P_YTkKN2jQaJu9IgxLPRSPH8WNI-4HFwvXmzgKX7U9zT2noH9bEZALYsYBEABfzIrjuwgK0Qzr2BX4LCAvTTfa3zg9JctXxgcg', '2026-11-01 09:07:00+00');

--
-- Data for Name: machine; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.machine (name, token_hash, created_at, last_seen_at, revoked_at, owner, client_version, client_api, dirs, dirs_index, dirs_updated_at, catalog, catalog_index, catalog_updated_at, usage, usage_index, usage_updated_at, feeds, feeds_index, feeds_updated_at, feed_requests) VALUES ('fixture-laptop', '3fc885efedad236456d8c385e35fcf70a36580f2ad41c98775dd78a3fdffafff', '2026-11-01 09:01:00+00', '2026-11-01 11:00:00+00', NULL, 'fixture-owner', '0.0.0-fixture', 3, 'abe1._szQLlnelFAP2d7q2dUP7UljgRKKcACS8Y03uwAYOGRmfFmpZ-36rmYAqFPmWV6rLeS3vMx8kIqXkgYHSC0p45Y-7b7Uigchy4nEm7Zteckmr_HWX2Ngv4FE2_EstcHubDrohKA7evZqisb-Ka3I4WAV-81UodaY4z7HSh0tWyUvUsQYqIpaSLT9nw6F8L12jFfuYRUkwoteIMBzZpHj2vfsVFr_xaoY81oL1zMWjzsXSdga', 'abh1.Fb1GahFM3W3b_SBzZJXLnb9a7g3as9mbG0wO1nXP5mU', '2026-11-01 09:10:00+00', 'abe1.5KvpyAnnCL9J5zkV0b8GeNw1W_SL8DyHvZTgvrMIywAApuZP-5lpS_LN3kez5p2V_8gc70VSQsuzZDeTh8LyZ34a0VT6nMuqm9ANCReJkyjI9Jl3NXk1EdXWzTSgu1FMN6192uzSbL3PNpsV2sk0P9RpYbqq8vr9Zfjdh182NItmIARNC1c', 'abh1.g7l9baUQBPjcwln-ThrMKvVxvCLVV6Ng-famqY122Eg', '2026-11-01 09:11:00+00', 'abe1.2RbaXVH49J2MlJrLiD_u_7WK4lmrorKzf43_2J54LY9YwO8brymx_dWpmh-Ci618clRunCJWmrI5fv-QVv_-aHsBdOJ7Kpqwo8T-PNyBKDt5ONcv82SFVzGlAzMksE6HPArnJwn-5iBNOIypaNfr49kofdfEZl3pmx5LLFZeb5VVxsqrd2Rc8C3tQtqJ8LMX0SeplnYF7qbzLWNzHiD8TCcvMNtybWUFZlHQ56oT', 'abh1.aQMtElDZ9oOiNxLcVPSWqjwK0mSk-WCz3C6yoUQ0L8I', '2026-11-01 09:12:00+00', 'abe1.lBFD_Xl0qkS7li2HoXmKRaaZoICPQ0jWx8WXirBvOX-B9FBmUs9Mag22txfSOtqa6buYYQspVA5iOt4-w8KTcEcBGRSMjw3BpuendTrL_cGofgAVu3hfIWtCDWKqLnjVRsAa', 'abh1.zyTB_t7o-DGxA5S6jZmzHrTdVpZwTIYMzAm2zonzMoc', '2026-11-01 09:13:00+00', '{pause:fixture-feed}');
INSERT INTO public.machine (name, token_hash, created_at, last_seen_at, revoked_at, owner, client_version, client_api, dirs, dirs_index, dirs_updated_at, catalog, catalog_index, catalog_updated_at, usage, usage_index, usage_updated_at, feeds, feeds_index, feeds_updated_at, feed_requests) VALUES ('fixture-server', '7832bcaa9c8132c0291b6a6c49231d75c84ac1958bde70ac41e8914f3a01781c', '2026-11-01 09:02:00+00', '2026-11-01 11:01:00+00', NULL, 'fixture-owner', '0.0.0-fixture', 3, 'abe1.fBF3IW3d8zCLtPYzrQTc9IdH5bwHZbUlPWxaZFOMnx92paboskDxYKJa-hx-a2vIvBC3D3oDXsoUPFiMzhI7w0fIws2Bb1LkRpQOj-ooCwFQSKHL', 'abh1.IFLJbPuXwX07Baqk07rHF-rF_jDMsMNHK2Q1wm6HJ-U', '2026-11-01 09:11:00+00', 'abe1.TcBijrwqp9Pk3UK8DvCQsdEiFJZBoqE5Z3GwpcXLr2ATziH_7TmE8_pZjxJGdo6sFvZ-zFkC9QPG9kZMRJAEeVxn_sA9eMTkc3EnG4mD', 'abh1.78R0PRnLNzaMf0XWfECTnGqylsZmnqwKtsTo4TDMJqY', '2026-11-01 09:12:00+00', 'abe1.mUgH-hkkewZQFiFYzCkmtkTjyziXgGDNcNwKFm7HmZr4zCKf4MUZxosNsVkXmbFketIFxhxe24Jb7PegEsZpNkh6XIL8sacLI1ppAb4BxX9uIsokX46UISNuYCi5HOI_bkMRl_OHCjCUVDRmqm2zI3uzcbzVfbFUPSSV_xLLNHbUPQZDHz-wBe-zSsjKGa57F9SLm7eDgKah8F4ldk6dIYYyRvTyOL0yzhUfktzf', 'abh1.aQMtElDZ9oOiNxLcVPSWqjwK0mSk-WCz3C6yoUQ0L8I', '2026-11-01 09:13:00+00', 'abe1.gL8a5QaPIvjsaZZMWO1NRa_Mk0UpdzHOj93DVe4XTLbfXD4rxnQdiLZxcVsIqc1SvJSfQodRhx4O39OflF3dq9GeRAYua1JzFAQhiL2UzSv-iJ9MF7quyeT6UHvNr1-VH5nV', 'abh1.zyTB_t7o-DGxA5S6jZmzHrTdVpZwTIYMzAm2zonzMoc', '2026-11-01 09:14:00+00', '{}');

--
-- Data for Name: note; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-question-open', 'fixture-needs-me', 'agent', 'question', 'abe1.-eNzTuM5-GKFteN-Bf8ksTTB_3bMjPpAbYn-DM6xwPvr5DKqQblJdV-3fSPLNqGR9Qc-pSGewx-dbZdOu7dPHXmTa3aEy5gbBeA', 'abe1.vnjbDM2g9TfowlpU-u3MHgASs9oZs8e_aXsz-Ls3ak3yEvKOA8fsh2n3-NzwBsv0hsPdd4jtNU4LQ5Bx7phN7xCki1PBX0mMVel7UKzBk6IYgIhqYFFXsbHsjZfRU4afJLuHBYuBWcFBtC-yLSM9kaVXBQSQleNPAZ-U3NxTqsZF25bcQd3lkcUWq_ONqPVRT7_Bmf7eWhSAfjRwKpxT2dX0PMRF3UzrMR0w4aNMzOYC_E1Z_5Ao2NaXkVe2IkyRrO-VIC3PZylEjKUGbw4_3VQOb1j8rXZ1yIjNLxJDq5G1IoH5ZuirOk3DpX_ghvxwy6fvhDkuW3MUwzkuYqS5-Nf-CDcL8ze45aKjmF5MZyK3-djNMLo03TxvXGuKiidqgHuuOmJKiinw', NULL, NULL, 'fixture-laptop', '2026-11-01 11:00:00+00', 'fixture-owner', 'abe1.Dg3Koid5gbiAAoBbFKsY2apsgL6TOuS_0Lxb3iTLo5TKYqxX6uahTkr2cz5BHd8_iJOunOcPj1ocD-Ai6ZDwiGo4iLU', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-question-done', 'fixture-done', 'agent', 'question', 'abe1.TSWg9dY3AbnbopCQSp7gAsSeoM0ZvPFJ9JqOSBZfYFI0dx3B4C84UKdV7tmfP3sQrWhm027TxuCG6YXPWLim', 'abe1.vH4-UA3sjYdD5-fWruUENmbcI7BxQM37nKubEt7cJKK0H6bEQ3nvase7Tml7Gj8GLrQd3svDwfAGjy5fAYbGfWAJaLb2ZOaTNWXJQ20ZH1_ZuhL31ewmpLvV_nkVux-OANEnFI9sGzBm18_0cVrVksr5Q0ml8xcX6tGmK-HT71sDWcH3EcVASG1bfl50Uaqu7CVo7c0lWCd6DVdFeDisu9ZPQkth7VOw7ysJIUpIfACBQenyeER6ndSKdyO2-cwyojD2ke4mEVXheAVbeHy8Bue2xZCQcuC8UR6zUF9fqXEC4c69X4ThfniNbMazBKxfcW7DNhZKs79l3Fl8kc7IYqx5hUtI72TPkpIA_uGNp1pIVszN4u9c1jqr-mYwWgUmdwdPQHvXdsgQ', NULL, NULL, 'fixture-laptop', '2026-11-01 11:10:00+00', 'fixture-owner', 'abe1.l9c_MsRowbg8VON30PDeSl529eZKW09bwYxBOW5bBmwlBY5O_NSIxlJhej7AB7pJVoUkqKoL3F92mCRe-JFt', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-answer', 'fixture-done', 'user', 'answer', 'abe1.kBS2PuWRu25B9pwfPefahC0Jpg_B8xSMlTc9PG_DqxDfYSr6pXrcRnClp3jVfRI', NULL, 'abe1.SZkutaI_gc-IhPHyV_glHt2cWqXcCXVnSPI9EHgrRqc4keiCHEjdrflkR-j1hRF7oGLOWKOQMqzu', 'fixture-note-question-done', 'fixture-owner', '2026-11-01 11:15:00+00', 'fixture-owner', 'abe1.pEGdZgz0pD15yx5PvYXgmeWUzJhPM7J9OD6AFPLn8S-ZyzyOhfwEoviukQ2uHto', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-user', 'fixture-todo', 'user', 'comment', 'abe1.YxfD4vUbLHaOB9XTJcSRlPEdPhR954c14vq4I6Hj4dgeLLwyPGh-7i_38plAX3GB3BZEBcVF2NCeCAjXPaj_iENWZgrP', NULL, NULL, NULL, 'fixture-owner', '2026-11-01 11:20:00+00', 'fixture-owner', 'abe1.AKSsz6pLj5cAclzRz0UwNLOQImIN4DCz7CTRZIKH0pQUJ9uC1R1TNM8f_RxfQev1Jw8neVFn27bMtshmJ1MFm2r4La8', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-pending', 'fixture-running', 'user', 'comment', 'abe1.UxllG2DD3r7seLzlJpLKuKxCAugKmDvFG3OEs9mZZCq9tOPrF4Zd0Ow31Fy2Ejmx2IVtwmpcAFc7SGNP-Bc', NULL, NULL, NULL, 'fixture-owner', '2026-11-01 11:30:00+00', 'fixture-owner', 'abe1.71kmzfBQHUaTVCRFgJnD-0FY3_oERU7BOOfZBD1gAqVL_tmj7Q14b8qBSznyh-qtuL6DDR83HMz4VOrZ3Z8', NULL, true, true, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-delivered', 'fixture-running', 'user', 'comment', 'abe1.XlhWny-tcgssDWRz_3IN4fEi8xqROkHXcH1rFMre40KkVQxI6YxUWjygV-eN727A3zrmZf8BWA', NULL, NULL, NULL, 'fixture-owner', '2026-11-01 11:35:00+00', 'fixture-owner', 'abe1.QGF57kbPRVIygF66djOTZo8PIrGRJa9jmbQuVMkuPVGoC2WHxZsKprIqBzRPFkvrO9_xMvqOow', NULL, false, true, '2026-11-01 11:36:00+00');
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-agent', 'fixture-running', 'agent', 'comment', 'abe1.8hAcTrxglhCJj0qAhhHCOO3WKnRDlwDNZ_LJwX3DHBP2yLHWryshm2-YKMEcvQdg4XPMmPm60VITOuXYCZYHHKYWZJiGQlQhQpJNAg', NULL, NULL, NULL, 'fixture-laptop', '2026-11-01 11:40:00+00', 'fixture-owner', 'abe1.SZdUyXeoInPpSy5xfP4lACWYaYtnpJZtboewVsS3wgb09CUbAaMuJqc_d1CetWGXhn0n7sjtNrerUeDTHZO2pITbX5Q', 'abe1.a4iW3DUJPZ-XhL9EZy15EfNjGHRDn4x3lIA1Yrr7UHHrDu_scFo8I0Cm4E4ntRyYcG9_l4MRP8vLCw', false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-polish', 'fixture-done', 'agent', 'polish', 'abe1.6FiDrdVo9_Yq0rhadJEXQHOWjWl2f3xvkNbiIr2M_1yf_oEFPOF0Bl0UUx0_aIFBw_aCO0-PZn2ouaaRxFAhsNK_', NULL, NULL, NULL, 'fixture-laptop', '2026-11-01 11:45:00+00', 'fixture-owner', 'abe1.xmQsT4nOHf272lcVKTM8qYgB1wBID1ahxpWVk_pu5mO62_SeyT450z0-RPG1YgKigrmvZePrR9QDPem_h_p8iUeP', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-event-system', 'fixture-running', 'system', 'event', 'abe1.RtUGJqoHDPTk5X9ckfPKGKYrruB_EkoWntvot5h3eAW67Px3X0J-n8bs523KEdK7HJGEv28qp7iWzQ', NULL, NULL, NULL, 'fixture-laptop', '2026-11-01 11:50:00+00', 'fixture-owner', 'abe1.5y1kHSeDkPiKLZSvGSML07GHeMl9QhR5Af_NL9VaQA17Z1g5gChmhwNCnGF6xLXAavmOKB-E8pJjOg', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-event-server', 'fixture-running', 'server', 'event', 'Moved from Todo to Running.', NULL, NULL, NULL, NULL, '2026-11-01 11:51:00+00', 'fixture-owner', NULL, NULL, false, false, NULL);

--
-- Data for Name: passkey; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.passkey (credential_id, owner, public_key, counter, transports, name, created_at, last_used_at) VALUES ('hDWB7yyN6S54V8F_yhEGgGuHda09HBfq63JGAp2HPB4', 'fixture-owner', 'dkkd3qzyty8EtwrTiokkhv9MCuyFjT-OJ1lT89ipXB5QmLo7AYLBS8g0zivgajvErROLcvJ99LKrcXzCIj99opR3XRXRpq2ldnE4Zis', 4, '["internal", "hybrid"]', 'Fixture laptop key', '2026-11-01 09:05:00+00', '2026-11-01 13:10:00+00');

--
-- Data for Name: schedule; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schedule (id, title, input, priority, machine, workdir, every_ms, cron, timezone, anchor_at, last_occurrence_at, remaining, until, paused_at, ended_at, occurrence_task_id, created_at, owner, model, agent, auto_done, more_crons, after_schedule_id, after_delay_ms, max_concurrent, requested_lane, effort, icon, labels) VALUES ('fixture-schedule-interval', 'abe1.zNklkpYckXO_uUyMePW3DMDtCjxWh6QLkI6Lo0Tr4Q-70oAswxrmiqiNNLhf', 'abe1.6zDE76oAMu3Ff89cuJwKRWPnyasiSMvIcO34_fmIssAezqCkut6Nsm42tlUlbEZs8UUcGXpH-fYo27TCGRlGd-hBHgUXvp8Vog', 'normal', 'fixture-laptop', 'abe1.bj6opazHQsMrfahYoGs-OMB2mGudL7hN4JIjBGoIaZtUVab_tTXETGntdsfYyg', 3600000, NULL, NULL, '2026-11-01 09:00:00+00', '2026-11-01 10:00:00+00', NULL, NULL, NULL, NULL, 'fixture-occurrence-next', '2026-11-01 09:02:00+00', 'fixture-owner', NULL, NULL, false, '{}', NULL, NULL, 1, NULL, NULL, 'abe1.iFRvqpKknUQupLPK-ZVlFkwGfMZvdksSDND-tL8tipya2Q', 'abe1.3BixNc0JHMGXkYm8yH0Fk_FCKwFXgAbXTyZYAbpftsovBsU');
INSERT INTO public.schedule (id, title, input, priority, machine, workdir, every_ms, cron, timezone, anchor_at, last_occurrence_at, remaining, until, paused_at, ended_at, occurrence_task_id, created_at, owner, model, agent, auto_done, more_crons, after_schedule_id, after_delay_ms, max_concurrent, requested_lane, effort, icon, labels) VALUES ('fixture-schedule-cron', 'abe1.kKDkiJhneqobnBmO8Z4_-lvz0TpmdaU9V3gdVwrCeK5atGUc4ZoA-rEm', 'abe1.fNBR2su7ejRnlzAijHsDJ5qzAfV-uKUp_STtEClYYnQI8m5ArvHNFyRXE56_n7Jbvrzo2OP91-wKLKFAx0VSlqspzdQsSQ07yaM53xd8nati', 'normal', 'fixture-server', 'abe1.O7Egl6olBjgbfv_opojyteDlWw5eikskz8dlRKslGxbgny3yrFfDKNeyPrEHYg', NULL, '30 8 * * 1-5', 'UTC', '2026-11-01 09:00:00+00', NULL, 10, '2027-01-30 09:00:00+00', '2026-11-01 14:00:00+00', NULL, NULL, '2026-11-01 09:03:00+00', 'fixture-owner', 'sonnet', NULL, false, '{"0 18 * * 5"}', NULL, NULL, NULL, NULL, 'low', NULL, NULL);
INSERT INTO public.schedule (id, title, input, priority, machine, workdir, every_ms, cron, timezone, anchor_at, last_occurrence_at, remaining, until, paused_at, ended_at, occurrence_task_id, created_at, owner, model, agent, auto_done, more_crons, after_schedule_id, after_delay_ms, max_concurrent, requested_lane, effort, icon, labels) VALUES ('fixture-schedule-after', 'abe1.3NG6l8ye1SFQCJqf7TP7E67JWxRTl-Ocw1KWU31xbFCoOh4n2ll4XsH4M-pM0zu58ahMHgVeTgzVFQ', 'abe1.we4PHZTPNQp6g6u0xkdHbWKmb9O2dVb6f6XjTWaSJEWklAE-PVwEVpZikHWrIDb_RXjovGFO6QkT_r7Nz7txzLeYKzqiF_4', 'high', 'fixture-laptop', NULL, NULL, NULL, NULL, '2026-11-01 09:00:00+00', NULL, NULL, NULL, NULL, NULL, NULL, '2026-11-01 09:04:00+00', 'fixture-owner', NULL, 'abe1.sEptAcDU569-kCooBZwdxFRv_POrpgG6ma_HAp_t2iFrbuXv', false, '{}', 'fixture-schedule-interval', 120000, NULL, NULL, NULL, NULL, NULL);

--
-- Data for Name: session; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: shared_agents; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.shared_agents (owner, version, document, pushed_at) VALUES ('fixture-owner', 3, 'abe1.GW-_KWy_A76TsL22_BjqThH5Y_1f530h8LW7IaN7mOBuA3N4wnQdDsua9gGrvbfM8uDODB-KM9lF3MRyw6HFtG-dlzwFRUo9lz1nO3aBRvWecdT3BZsNb1jxNQ_sb8WfZjHAPmzUajJwBpp2jclr2uTe0Yyfes40oLE-yyir5gcsHK3ImsQr6ftsy_pRbhmJeBzqSMxAlR8epHuCjtYY_y3NGFvA1Oi4RYLz7zFzJPLjnz1rELzQtwt1ham_s7U', '2026-11-01 09:06:00+00');

--
-- Data for Name: task; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-backlog', 'abe1.qlt17TjgImMgGJ-2tiFTH7rgL9iskh9qJ2iGE3K3kRyHgBJ_I23bk_I_qooCVmyHcg8pug', 'abe1.wvL5GCKth9w7b10Fz36LXGplMQFcfge2I7pM9MOFV0nLrqUunMYjohSrjvYDycvMKH2B8QlZGCQKIis1ECVM5OMFtN1cTm29', 'backlog', 1, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 09:20:00+00', '2026-11-01 09:25:00+00', 'low', NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL, NULL, 'abe1.B4jfReux_Nj4GSvV77in5xYOpMM2UevCynuaW48GlCg', 'abe1.F1jcqunIobnTrUZpaW2s82aAQ6S_1oD71c4OnQCOMKLmDTwV');
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-proposed', 'abe1.AJvV1kqRAR24hNLpKLm7vjRM3QrtruNxj2uMH09ig_VMrvJ5muYgzH20XSSqFvz8ky0-qYaxiufJw4iP', 'abe1.yFpb9PtrDZeZPEZktDH0-g8Ly2j7wM2qSrjXA3O7OdD4EiasiFOaKcSJ7JzrBcpis2dyiwQW2Z1bVHkZ2i2U6YpkyTmbfDY6AaqsKgFVmXQyVw', 'backlog', 2, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'agent', true, '2026-11-01 09:22:00+00', '2026-11-01 09:27:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.FGhkWMUG0SCAstuUfBSynpLDlE1zp4Lzx7yJ4N4SmFiGD1Ie5VQVKJkzTFo9cA', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.FGhkWMUG0SCAstuUfBSynpLDlE1zp4Lzx7yJ4N4SmFiGD1Ie5VQVKJkzTFo9cA', NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-todo', 'abe1.hsCHcQ43WyMN7qCfgfrsFxyby2xvIwEAZ4xfHpd-p75Jc4rOq3bTHBbtMGYNQfzI-udqmSaZng', 'abe1.0c4OfImJAUt-LeKan796Hzp-QK6hWsfY5ddnibCS7ju_yL9RGJTY5WsJMeBCbPMEZowhvD8ubTGC0cXmsgvmss1g7kvkYCxArF4Exe6Nrxev31MYfdTTPQ', 'todo', 1, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 09:30:00+00', '2026-11-01 09:35:00+00', 'high', NULL, false, NULL, NULL, 'abe1.n_YJ1-YpAAP0D_EhUqhLxUGNFwScMDGIr1IVN-ibUpHUX2zDdf0KwoBXf_HVhQ', NULL, NULL, NULL, '2026-11-02 10:00:00+00', NULL, 'fixture-owner', NULL, false, NULL, 'sonnet', NULL, NULL, false, NULL, 'abe1.n_YJ1-YpAAP0D_EhUqhLxUGNFwScMDGIr1IVN-ibUpHUX2zDdf0KwoBXf_HVhQ', NULL, NULL, NULL, '{}', NULL, true, NULL, NULL, 'default', 'high', 'abe1.Z3Lbocytj1rLn_6DF5n06w6qGQDoatcqdgdriLrXlbE', 'abe1.LUZIeLap5T6i_UVnkPmUObzed6OkfAxX-tWD5XxhmKH73PrgsL-fxXvRVTMfk2Dx7w');
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-running', 'abe1.3KJ43Svka0b2e0FaKU_rbs89UW6zD6WjVIHTkdFef0iu1tXCNC5p_hHAMLxqjLnXmFnw5r4', 'abe1.JIBVr24SHvpyAl04pl56nWpomuHhHsHPYKKFiRDT3EMgLxi0hg1dcaTQW_BR78V8-nqCgRQdjD7EczgAkKSsuDq4I8NIxntZeV7NVNzR9XDbjJIuclw', 'running', 1, false, 'fixture-laptop', 'fixture-session-0001', 'resume', NULL, NULL, NULL, 'user', false, '2026-11-01 09:40:00+00', '2026-11-01 09:45:00+00', 'urgent', 'main', false, '2026-11-01 12:20:00+00', NULL, 'abe1._uhzcaUWfiX97MpcwcfWewK5cB9BVQReCLn9yPBd4x6MvafDO0WTxaXPFwsMwRXjL3qCuewGvbHIlEBcmV0', NULL, '2026-11-01 12:10:00+00', NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, 'opus', NULL, NULL, true, NULL, 'abe1.HCfGsM4ieDnWUUjshzThFoAk9bML71XSqB25-mlWprTRXNWu3BtG6ZC0DpcM', NULL, 'fixture-run-current-0001', 'abe1.jGckkpdPuU08hkPyJ9kcsETFtVsLTCtKMPzhMzZTvQTMeioglzutzBM5ymEEgR3orN0ZM84_AxWuGIDXUQh1mwS8hyzle7qbJa4Mlmgub1dRIW9CORgqrNgQ4KrlMYin3SWzaILNOx78SwI-oMztcbifT1JT-OxggRcl7kiCxlBNLR-jLcg2Olz_JnGVn2gmgkU4TexG2SHF5MskEDMN6zi5wjeW8tXB3xnyPeAUeCfVtVAlimeHAT7VIlmLDkHibKl3DjM_78y5MiW2vDZHWL1ytlZ_xhMnO-38wF5dHAzkb3nyjw-8_CCyKBB6VuoFnX6P8tknL2LCdHZAXurZwMhQ-vYW7egupb2cTLTz8Vxm1MYEZBtp9YIvtgwuPEtYrzfZCDz76XAXgXAj2Oi_sJzfYrAB9iDw5Nc', '{fedcba9876543210}', NULL, false, 'machine', NULL, NULL, NULL, 'abe1.dhV78U2prQ2rAtjeAyRdH_YtpKVlkRBoiMv3sjpukMk', 'abe1.NXSF7KSCnyETLzUFdtBFbUpQfDvFb2sI_uyMapSugR94siUqTg');
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-waiting', 'abe1.czmM1TgitU73HTmb6NMJ7yLM-1Vn17PpguYW5arEpxXGPMW5VnLlFO1GwKCMGevJ-nGP8JU', 'abe1.M_sfjsAHLpDEwPAS5RR4SpeTeJ5yNqoj-42X4KgmnrlLm4aUT2Lk0VveiUfFmS6N-TLcUUd24lqCUjUPX3QeI7mCrlXZuZyVHQIGX8CKHzScfACzEiinewppFdNByQ', 'waiting', 1, false, 'fixture-server', 'fixture-session-0002', 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 09:50:00+00', '2026-11-01 09:55:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.C4Z4KsYvIya8i1T8fPDIxEW4GqEBLyb8hIrS5lsXHHsxoSKhOGDGXRK4PstFuA', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', '2026-11-01 22:20:00+00', true, NULL, NULL, NULL, NULL, false, NULL, 'abe1.C4Z4KsYvIya8i1T8fPDIxEW4GqEBLyb8hIrS5lsXHHsxoSKhOGDGXRK4PstFuA', NULL, NULL, 'abe1.XsINWiMbqwHhNqcGXEHL3ZrIYsPHGQA4XaVb00he9PxVFLshK9lm74i7IZq1Q_sRh9-VHiv4Ya2copwWBmVM2hShDKQ2nOuu5K5Ha0j81kmMZTQLMi7oxiVVMD3W79RWsXGtIAAUuWYztdUAyBUgaKAZhpy5Wm0yxMGElgIqjN32rzDAhP2MhKIMtEiCHVEDhlfGHTV_KO63vBwLPYb2aPncE1vE-WCl4O_jpdu6JS7K2UwN3E0FeFgLOH9po4edxRuYMA3tV9hWUeo5zm8yKsFrUq0KnIQ84VXVIM4ss5ljNQrLTg94BzEL8A5NVUjT_j645S43QCMirmW8pnPFlukoJUVEPXiIex6ShaDHS1RCFhRUDiGOj4R7IycXBPkqfDrBag-Zm3FD6j2kjnyJfc6Z6rAUZElTPwY', '{}', NULL, false, 'agent', NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-needs-me', 'abe1.BAIrW5YUhe3R83mvMdbW9GvXTThor3UtONPfR9vOXELj6iQK9tOTPtlM0uF0R53dEDfMGIE', 'abe1.TVnLQyVRLUvkTg7cENeyT1Ll912AAYGnf9msusaDdXWZLal5fBVUfCV8eZmlBjaOF9YbYHMIflM-DpEMiP5hLUDgpgKUzY-C8ELmGlAbihoUflwODFk', 'needs-me', 1, false, 'fixture-laptop', 'fixture-session-0003', 'fresh', 'fixture-note-question-open', NULL, NULL, 'user', false, '2026-11-01 10:00:00+00', '2026-11-01 10:05:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.dR3hvn5VJZ2ZSVLB8IH1DnGoALKnh0UdH8_mxth5V3zeMvslQNHrnij8eSDHsA', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.dR3hvn5VJZ2ZSVLB8IH1DnGoALKnh0UdH8_mxth5V3zeMvslQNHrnij8eSDHsA', NULL, NULL, NULL, '{}', NULL, false, 'agent', NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-done', 'abe1.vfJD4dU0dBvIG5GGxvGuFGp0xdE6LC2yEyogYgmJ1kbdZ80WzwMjqXHb5FctEZmNwzIAMYGwSw', 'abe1.NjP3yWk9CCp8j7HBDTkeK8f3dfpUGjKW8_BKKkpREO5A9dgOiBDezUgIU0Ikkg5Z-Uf0vEtMZx0CLlQ4GLfYmxYSnhsztrVYGMOSlkGiQvo', 'done', 1, false, 'fixture-laptop', 'fixture-session-0004', 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 10:10:00+00', '2026-11-01 10:15:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.k1HJdzebU-pSFrCc9RrhElNlUMwrkFKwx5Fo5_9m7p0xDFO_nC3H7PF5XqRYLg', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, 'merged', NULL, false, NULL, 'abe1.k1HJdzebU-pSFrCc9RrhElNlUMwrkFKwx5Fo5_9m7p0xDFO_nC3H7PF5XqRYLg', NULL, NULL, NULL, '{}', NULL, true, 'agent', NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-closed', 'abe1.HO4n7OxJGKNSbAjcmR6ZgatzDaFYIbCY6v9THCIFARyuMIJhdeEqcbOYSm2P7c2vHc2m9TJ_7w', 'abe1.Soy7Yw_r4q-NWgoCzBUB2-Nb0-pFPRlaO3Kcr9JRIErlsQlc6hq640Bmi7jPi6mp2fAIvEaagS8', 'done', 2, true, NULL, NULL, 'fresh', NULL, NULL, 'fixture-done', 'user', false, '2026-11-01 10:20:00+00', '2026-11-01 10:25:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.s53vE1TNjhGndwebqEdBNSNrtathcxCflzBKur7ehzZx7K7TH6DL7rwd3USK', '2026-11-01 15:40:00+00', NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.s53vE1TNjhGndwebqEdBNSNrtathcxCflzBKur7ehzZx7K7TH6DL7rwd3USK', NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-fork', 'abe1.XUKrRolQsDCPID3flRUTGRutryE-SZgtwFHTLTHWzxuG8Lm1LLfa-Vm2Jq9afGYmPg', 'abe1.IniDq_LyDGdQRIZ2R1tjUD4iAZHO0NlwP4l4zcx-KeAIzvZjXGaxe9SmEedhf9oAWlxUTbZaUg1cfZJM3_B0ucksutMuP8nTb3dhQK139bmjr0c', 'todo', 2, false, NULL, NULL, 'fresh', NULL, NULL, 'fixture-done', 'agent', false, '2026-11-01 10:30:00+00', '2026-11-01 10:35:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.KYeRiJ1CEXQj4uUcmVtbwUz--ubE7uoQ724uBKi6nMa202lKwBbXmodARw9DcA', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.KYeRiJ1CEXQj4uUcmVtbwUz--ubE7uoQ724uBKi6nMa202lKwBbXmodARw9DcA', 'abe1.smzffIcMVDb7Yn7K0iCKL9p4r0jPfcKjHMWUO1_XlnUANNYM', NULL, NULL, '{}', 'fixture-done', false, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-review', 'abe1.lmygGMVZObGnmWp2TKnpe8lPSDqEumCsMfVnJJc_YbRHcz-b687Rv0igZhAWC2IGtiPsEhfHi_4', 'abe1.zizWOi3RraV8UfXJndXg5DYifQpJYPVNAB1_8WyRMNlwskknQAas_bOOFGdzqQecGmqMxpODtrIHutwpuuLqTuUUFiaz3F4MMBEUA_O5XSGlm_AZag', 'todo', 3, false, NULL, NULL, 'fresh', NULL, 'abh1.vkGvUX-GEOKP022VmTQy9ogpUfW5y6vmJilD1TftInE', NULL, 'intake', false, '2026-11-01 10:35:00+00', '2026-11-01 10:40:00+00', 'normal', NULL, false, NULL, NULL, NULL, NULL, NULL, 'abh1.NX1t9jtOixakuwjFlRy9kM8Ddtzwq-x_5rgstKAFBpc', NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, 'open', NULL, false, NULL, NULL, NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-occurrence-done', 'abe1.zNklkpYckXO_uUyMePW3DMDtCjxWh6QLkI6Lo0Tr4Q-70oAswxrmiqiNNLhf', 'abe1.6zDE76oAMu3Ff89cuJwKRWPnyasiSMvIcO34_fmIssAezqCkut6Nsm42tlUlbEZs8UUcGXpH-fYo27TCGRlGd-hBHgUXvp8Vog', 'done', 3, false, 'fixture-laptop', NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 10:40:00+00', '2026-11-01 10:45:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.Bo6pEwoZ0hX_M0LIgyFAOrFOJ-imIRtlXOYzsMnep8pTjFHtTGdp0y1GRqRUZw', NULL, NULL, NULL, NULL, 'fixture-schedule-interval', 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.bj6opazHQsMrfahYoGs-OMB2mGudL7hN4JIjBGoIaZtUVab_tTXETGntdsfYyg', NULL, NULL, NULL, '{}', NULL, false, NULL, '2026-11-01 13:20:00+00', NULL, NULL, 'abe1.iFRvqpKknUQupLPK-ZVlFkwGfMZvdksSDND-tL8tipya2Q', 'abe1.3BixNc0JHMGXkYm8yH0Fk_FCKwFXgAbXTyZYAbpftsovBsU');
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane, effort, icon, labels) VALUES ('fixture-occurrence-next', 'abe1.zNklkpYckXO_uUyMePW3DMDtCjxWh6QLkI6Lo0Tr4Q-70oAswxrmiqiNNLhf', 'abe1.6zDE76oAMu3Ff89cuJwKRWPnyasiSMvIcO34_fmIssAezqCkut6Nsm42tlUlbEZs8UUcGXpH-fYo27TCGRlGd-hBHgUXvp8Vog', 'todo', 4, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 10:45:00+00', '2026-11-01 10:50:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.bj6opazHQsMrfahYoGs-OMB2mGudL7hN4JIjBGoIaZtUVab_tTXETGntdsfYyg', NULL, NULL, NULL, '2026-11-02 11:00:00+00', 'fixture-schedule-interval', 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.bj6opazHQsMrfahYoGs-OMB2mGudL7hN4JIjBGoIaZtUVab_tTXETGntdsfYyg', NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL, NULL, 'abe1.iFRvqpKknUQupLPK-ZVlFkwGfMZvdksSDND-tL8tipya2Q', 'abe1.3BixNc0JHMGXkYm8yH0Fk_FCKwFXgAbXTyZYAbpftsovBsU');

--
-- Data for Name: task_pr; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.task_pr (id, owner, task_id, pr, state, created_at) VALUES ('fixture-pr-merged', 'fixture-owner', 'fixture-done', 'abe1.c3mXaNeCTjIF4QQYfhsKYVGkxbf1ZNG_yOuWd8CFovk7Uo0EdhySy4-J66W25qoWoW5W6QJ3u5H6Fm1GseHa2XIhxjh79g0GQaIfeTY', 'merged', '2026-11-01 12:11:00+00');
INSERT INTO public.task_pr (id, owner, task_id, pr, state, created_at) VALUES ('fixture-pr-open', 'fixture-owner', 'fixture-running', 'abe1.BqqsScTwyrUnAqL3Uo1uUV1wntQoRHuPBRviF-ARqvfDYNJyn-_CSWE8JjxZL3R9q-AE2RIL6xvo0LK0-yZPrFxR1xRCDgvmY-Ts45g', 'open', '2026-11-01 12:12:00+00');
INSERT INTO public.task_pr (id, owner, task_id, pr, state, created_at) VALUES ('fixture-pr-closed', 'fixture-owner', 'fixture-done', 'abe1.FB0zdB0eb5Z3qvAbJ9oLZYbVQ89Axa0hiboT_aHbgnRrSnHGXmDU8EP9WKt6fTMSeahLeTTwqccRJB-qlCHr5j4APTP0nB4XY1U1qrw', 'closed', '2026-11-01 12:10:00+00');

--
-- Data for Name: title_rules; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.title_rules (owner, version, document, updated_at) VALUES ('fixture-owner', 1, 'abe1.dUZZnFSZaKKqbsmAZNI7fQDvIjZmLEygzljVHwNji0jI8L9L4hkRFKhQd7PpOsmNvl3qeRWrUlL1tlrZJJ6fRlVJ6WJOti4hYx2R_SDzjVPqA4qchufosJMmM9PArgvE2_zVcx2LJbUqNIzDsg3rWkZTPrC2X2cgiOxOA9QM3zJPp7xlunRZ35ZW92H9Avo-MWlDEJGsyKFPW3fOFu2iYX4WIsNn3A', '2026-11-01 09:08:00+00');

--
-- Data for Name: transcript_event; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 0, '2026-11-01 12:30:00+00', 'text', NULL, 'abe1._iD2zg41pg8k_DUtwaSHWSiNYsgAQIC1gYsdD_wcl2s-5miIfU4c9Rpi9D7UU5BblPpuPipHXA8v1941NvlHyPGQTwLcH6hZ1j1UIVPz80xJ6dazDE2sWeOmlk3GvJ8iLT6jC_Y2tmlJeuYz-KWKtRDe5HAqubYNaioMfCPq_pwQpz4QhgpjrPV7pw', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 1, '2026-11-01 12:31:00+00', 'tool_use', NULL, 'abe1.T1vAYlstQL9RuWWtnNKB0m65L4IT382F4iduZ6jcE-6PN1Yg21UJG4N7rsLGWoiaPuUC-WvU-ZTRQ2bYhL2ZZ8hy_nCvWeO68lwLu0P9fJFkrljJlxV8MVZeJzj0b8o4CvcdzrKFDOThwYV8Tp1FbFS6YwS3acZjPbQWhwG5rey6KszN_n1Acxs34zSgV4NEna4NlPfYPTFwpnbIKjwEdRv-k_fZDpR3_WO0Gs11JA', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 2, '2026-11-01 12:32:00+00', 'tool_result', NULL, 'abe1.xorTHR1fQJhqiUOPEGVa3s53qSsSDVsqC5hYCwNckrSqn_gtLVnZ-8FKnMhw5Krh4AC2PlypRtG3-97v41m3U9AwJfT-n3OE-QNdkk-umil-y1ii47WtgYPMuCZveEyLifAiAt2lnh2ADw37M55Z14gGD05IQmREDKnKARyH89e34p6GkX679ifn6i0d', 'abe1.mDir7tMFQxIaGMITIxMS5qoBzS0vVEr5dgjTZspRHOwz7R0Rv35QmD6cwt3u-eWC_rj3UxeaSwMCxlPCT4qXWXiUfVNLO5V6ZG8Y', 47, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 3, '2026-11-01 12:33:00+00', 'result', NULL, 'abe1.10yQ-iTaUfVGMVTJZ8hCF3OtJDNOKQrrqRiDMBYLwen1_GTmcvEby8W-qJcJy48gbyY6bgyKrEuSWtJ0LBtCN47mOChPP6NByenCWEqrNVYuMfvZEnGKshzJ26a6i027KDe3RR4s6RKihdfYrnI3w80GWh13qxGQEVtN5duOg42OQKJ235LFq6tTYtE57qDOJLmL2Iq-sqKzSZs59eAMVQFqNIbocxr96HdMho6VYVtYrPalKw3ru_lTPuVeJcgBy1lBNHcGXBhD', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000002', 0, '2026-11-01 12:30:00+00', 'text', NULL, 'abe1.YbuKiUn6L1TLlnvbNO_Rsix---wN18vIGsfCtF2imRqG_edUHN1iIQ1K_N3hCbuCf24HaeV-J9PEknWtmirbWeOGT1MDT0hZEgOfhL7ysygmSZiOrhDQ9k46osCbo9hv7nVA7lA3FBcqbKlMe69Iw5BBqFe0Ehr9jb7paVKOLwWu7Ya22uwfcAyTtYKezKP0Vqs', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000002', 1, '2026-11-01 12:31:00+00', 'note', NULL, 'abe1.poDQvMbpJVwzbAkr3hwJIWlZkibmS3VH0IzaV1FlscK4UZy1c0X94M78vixklyNK7jQYLdZuJ2KOIEnOm_y6H-_tBaOKTq2R8XEyu8ChvEKd7IrYXtu5WCaubXoTwggcFDeN1CA7y-MnrNpGocMs8s3FdxevbiGXtNVe', NULL, NULL, 'fixture-owner');

--
-- Data for Name: transcript_run; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.transcript_run (id, task_id, machine, session_id, resumed, started_at, last_event_at, event_count, owner) VALUES ('fixture-run-0000000001', 'fixture-done', 'fixture-laptop', 'fixture-session-0004', false, '2026-11-01 12:30:00+00', '2026-11-01 12:34:00+00', 4, 'fixture-owner');
INSERT INTO public.transcript_run (id, task_id, machine, session_id, resumed, started_at, last_event_at, event_count, owner) VALUES ('fixture-run-0000000002', 'fixture-running', 'fixture-laptop', 'fixture-session-0004', true, '2026-11-01 12:30:00+00', '2026-11-01 12:32:00+00', 2, 'fixture-owner');

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE SET; Schema: drizzle; Owner: -
--

SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 53, true);

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
