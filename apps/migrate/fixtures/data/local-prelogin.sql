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
    CONSTRAINT app_user_key_all_or_nothing CHECK (((key_id IS NULL) = (key_slots IS NULL))),
    CONSTRAINT app_user_username_not_empty CHECK ((username <> ''::text))
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
    CONSTRAINT machine_catalog_index_blind CHECK ((catalog_index ~ '^abh1[.][A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT machine_catalog_sealed CHECK ((catalog ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT machine_dirs_index_blind CHECK ((dirs_index ~ '^abh1[.][A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT machine_dirs_sealed CHECK ((dirs ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
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
    CONSTRAINT schedule_after_delay CHECK (((after_schedule_id IS NULL) = (after_delay_ms IS NULL))),
    CONSTRAINT schedule_agent_sealed CHECK ((agent ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT schedule_input_sealed CHECK ((input ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT schedule_one_rule CHECK ((((((every_ms IS NOT NULL))::integer + ((cron IS NOT NULL))::integer) + ((after_schedule_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT schedule_title_sealed CHECK ((title ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT schedule_workdir_sealed CHECK ((workdir ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text))
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
    CONSTRAINT task_agent_sealed CHECK ((agent ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT task_dedupe_key_blind CHECK ((dedupe_key ~ '^abh1[.][A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT task_head_blind CHECK ((head ~ '^abh1[.][A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT task_home_workdir_sealed CHECK ((home_workdir ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
    CONSTRAINT task_input_sealed CHECK ((input ~ '^abe1[.][A-Za-z0-9_-]{38,}$'::text)),
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

--
-- Data for Name: app_user; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.app_user (username, created_at, key_id, key_slots) VALUES ('fixture-owner', '2026-11-01 09:00:00+00', '83f4eac71e93fcf1', '[{"m": 65536, "p": 1, "t": 3, "kdf": "argon2id", "kind": "passphrase", "salt": "Nau-RfXXtQ0CaZk5iUS7VQ", "wrapped": "abw1.45zSSLtLBI_Z-9f_-Ll-w8kyPW3FEWvfltx07xfGy4rbuN2-2PzKispT7QwOg37B3fxyMr3qEsKCWnDd"}, {"kind": "recovery", "wrapped": "abw1.vvA_yO1Txcf6L30gyBCRJWcvJ5KnaCoQgYcWh9RsdUVZH4OCUWvy7DnOzoxv9LsPysBiYgPMMwOjcyAs"}]');

--
-- Data for Name: machine; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.machine (name, token_hash, created_at, last_seen_at, revoked_at, owner, client_version, client_api, dirs, dirs_index, dirs_updated_at, catalog, catalog_index, catalog_updated_at, usage, usage_index, usage_updated_at) VALUES ('fixture-laptop', 'a0059e83dbdc168b1f42e872148a193cd39f9d7bdbbf012dd6a56d9b3d1de9f5', '2026-11-01 09:01:00+00', '2026-11-01 11:00:00+00', NULL, 'fixture-owner', '0.0.0-fixture', 3, 'abe1.i2vBTiftlBGrud4hxvs7b3NWKGPnKxazRfyq4xGF87kvZc9B1KKnra61ufRDfm3PTrDSK7wOBV4B8aseWDX0RsLvfmYDvrXAQ_0YgYXZtyU0MjNeD4kYQ36A5LxVhiDz_iF60z7StgP8_3Kmay6H9qEx-x5Sx8ojw8xChsJKpEEZXTrxV6A20W0SZ_eqKCl63AwqEVgQlHX_sZdAB7OjrvYcpg9kywRNf-hnZ4cD8mNTSkjx', 'abh1.vfdYa8Eb0YW9Kx0GZjL9SmKTlb9l_qFXD_4scEv5RSM', '2026-11-01 09:10:00+00', 'abe1.mdLYhRjPlxUlwHx9vv3rWoHqYk3gb1Uifaebg5u4tZ0KUkee7yerTR8wCmtvQo5DDDV_nm8DgzsCqk7O6JLdvSRYH1msUw9pEt-rQsL8gs9nCpcGflMGAeesUtRJ6dGyjd3b3Vw9qoukBvl_D0qtD0QpHqkLxOjxmiivBbFP0QE4WAf_GHI', 'abh1.w1w_bl__cFUtG3OGepQbGAZTNsKN2dxtsnXr2mRHtuY', '2026-11-01 09:11:00+00', 'abe1.soP4sxqpXOnuudJV_AU62W3IJKhNi668Kql0uYiXOBHoFUdaO3UXZj1T18v46QTzdhUhH1jj5W7g9AR6XeoQd6kPiWQ8BfKfvKly46j833FfySXg9oaOQ6JpQTSSK5Ttv8K-OS3I7EBYuI6bN26DUSGMdjV9McQG6LXdcK1_Vv-8DVqMZhwNqh-tQJdYyzsubyEoZQIGIXCVSZmk2zjw7RGXKKTSeBJWSCxbZhEP', 'abh1.hdnKf6WMgHGsTAf8_MNHvg-FFGjR2Fh_h1y-oioHemU', '2026-11-01 09:12:00+00');
INSERT INTO public.machine (name, token_hash, created_at, last_seen_at, revoked_at, owner, client_version, client_api, dirs, dirs_index, dirs_updated_at, catalog, catalog_index, catalog_updated_at, usage, usage_index, usage_updated_at) VALUES ('fixture-server', '5ea1d0f5db549f9ebfec43d4aac95d6ac0a51fc341e77bc054f1d74fcfedceb5', '2026-11-01 09:02:00+00', '2026-11-01 11:01:00+00', NULL, 'fixture-owner', '0.0.0-fixture', 3, 'abe1.641g1Gg33ydlEx8RjaRKUEX4KLlP26KTx-PHKuTpqhNmVT7XwxRNuEJMcJUGzGV1ldMoKvODiuR5gZFpVLR97UlnOPjLklLV7pvUgjgZz7K6WetY', 'abh1.3e04weQfReKnK3I-ZFF7VtgBRYJ2lPuhB5yJ6J6yC3A', '2026-11-01 09:11:00+00', 'abe1.bgBNBuzr03T3rsRYUhmXhozhfEY6Vvl83xLbsqIzrirCjv8z-DHD8q5PxTFghgF10A_VRBlrZYthGq8yAA3p9FFx6xp218ldvWsUEqOO', 'abh1.mSHR2o_3SutAs7aHuq6jeHbOYH9PpUcjEfMYkzbGUv8', '2026-11-01 09:12:00+00', 'abe1.J8gFD5Zwfsy4btqoiRhQhdnVpma6mXJMv52TtyLkOoe6ZKFWc_cqFhQqVVYjWIYDOR-m10UQUXvRANTyUt9N8PsIY92q9BxM5h1uQFl7io9o-5QzNCiL6vxkuAegTGjWJws3RtG_NfjqsYGWnTheOzVKaZwc8bfQQ0uRsQS00vQ_mWM_MXYOTJtjN8Lf6Bq1RkVRiSgHgfiX7SMZ06xk7EJNEz4SFZbvpweJFK_L', 'abh1.hdnKf6WMgHGsTAf8_MNHvg-FFGjR2Fh_h1y-oioHemU', '2026-11-01 09:13:00+00');

--
-- Data for Name: note; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-question-open', 'fixture-needs-me', 'agent', 'question', 'abe1.M7LbwjnTT8pH5fatDnjN5zh3qqvp0V0DozVTG_7qQu2AYcS1BbGle6wmPdgPOaj8g_dL95vZ_GJOaWBGdmsnsUF7d3ofvuxnWVg', 'abe1.e5j97C1-n53PG-lz5Ot2IBSvY8g5BVAA0ATUiPJVAedZ4hrFUqBKy1Pu4A-QzqHNNJI10FUQ7v6wedrzVuqtdP72b4qd3RI2w0wbBl9BaF3IL1DAMa--PUaEmP4632e1wiWTt-sHybfGAioHGLgS-oQnqJ4R2-9K-dj0Euaz3FI_1aPnv9HVyMzuukqR_RKJ-gpY6_SvYny5eoeK9WGUMgMdouhZM4a6lY7IVYf5mhWOmHlEvKSYkEvLOUQJeZGCnkSYRYmQd8WHFpMhg7ASicr_uWRCRekPVPXqvCs6Sioq30MSVTjyDnF5VFwedURT4q2T_fCmLBuAIH63GqeXX7HRgHk2vNRl_Y-29qML3xK31fiA9GzPu8I8R1v2BEe3e5veV61luF70', NULL, NULL, 'fixture-laptop', '2026-11-01 11:00:00+00', 'fixture-owner', 'abe1.FBsMAtk_QfwajU2r822pcj5A9qIDNLzN4lxmQH4ZloZLqDePyxBqten2sJRyZ4e86nMVu3D4ttyWZxM_zd-Kb4RBgG0', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-question-done', 'fixture-done', 'agent', 'question', 'abe1.GUwPDY-vMnMPJxDZ0m5VDMAAw-COiH_tVOPOdKNxGJfo5neoK3FtA9zjL1AVDSHJEZFDENPWQxaFMB3B96vl', 'abe1.ZEl8hJ780Lv-s1t4R07Wm2_eGdedhT-_HRJ_bleKRVNO7qNdfXmVhOO0M34_ARUg_SWTdzD4iwSXGasCuXnr4Jw3_3z9u-4WycHeBRi1D3pcfZI0IM7noxYrpY8p3ficz7awDNIZPn37q1_Dqm7yun8xTrXnzrazzld53Gfooy-vqkloqW1Y_feDxO7oN8nnoqB079Brt8rm5eACXTadfdY8XF28kyPc-sWHRKR92JUZ0n_mIMSPmQpploUuAPSGmUlh7zAAZgOk2mUTXVgAzijpR4p6LHoUq4Zuw1vgqrc7uIXLzt9Vb9yQ8FnPMlZ4qqdocTLiaHgMCe1dNkNPIqnKPiNAp2gSRLCwqqQZjDErgKJXDhO0RhdV3ymOHtv0wHAu7leIEFJd', NULL, NULL, 'fixture-laptop', '2026-11-01 11:10:00+00', 'fixture-owner', 'abe1.sDkY6t8QDPPAb8lojS_6Sepd6A0ROAP7wNOy7UflMtT8ZYT1Gyq7uhJi0JWblyE2SVQRTOdazfeoZv4BGxKR', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-answer', 'fixture-done', 'user', 'answer', 'abe1.OrBH3XOS2XKrIg-pvpWdEOQnyE8YmiHIJdS7wN6wae9kRLhQXH2mX4OiHfeAFB0', NULL, 'abe1.ACm0ljBPpJGvuwPh3A-gNLf2AwEzP9KNol3O3bMnkQ7YVUx3Y4ytWOGSb5hlHKU4J061_T4ECXHG', 'fixture-note-question-done', 'fixture-owner', '2026-11-01 11:15:00+00', 'fixture-owner', 'abe1.IONJdvLf1uVhCVIz19eKlAXkjZVtC9yE5WHNeHL9rM_6nUNu0L3_j6BSO7JrO00', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-user', 'fixture-todo', 'user', 'comment', 'abe1.RXxO4eRnBcapTQ7O7fluAxCpinaIRBClI2PVXolOsuoj3qO0ET5qNnYJ7PbeWO8PiL_aMRLVLInjM_tgpuk8bBTptTz7', NULL, NULL, NULL, 'fixture-owner', '2026-11-01 11:20:00+00', 'fixture-owner', 'abe1.zqFk7DlT8jclm6cDw8Eik_LcfRnKqKEMnospoxgCnl-sj9hM5MiJBubF6oAn0OdG0a-UFE37RqjZ0r5kgogEhiQdTMg', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-pending', 'fixture-running', 'user', 'comment', 'abe1.tI9LDJIbOCifns6WRI0RHr9ZT2Od1DVjPCfPWU9UPoG9SY9EiTeEWQChgU-zJYzlDuPyE1b_GcPuiCEU9-s', NULL, NULL, NULL, 'fixture-owner', '2026-11-01 11:30:00+00', 'fixture-owner', 'abe1.cAApwCGkHNyag63xMkXHLMf6f3YueHHBC12vNnjAevEx54cNGYFGLNkgRa8qrz3KeXK8i7rYBEmuZ2ZlpDY', NULL, true, true, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-delivered', 'fixture-running', 'user', 'comment', 'abe1.IDsQ3XoHuD9B5paOAf21xZ5fUk3uP6ZlH_olBQ1YQZhhgMdrPWbvn43ZS-9DN_CJLVFvZVElWg', NULL, NULL, NULL, 'fixture-owner', '2026-11-01 11:35:00+00', 'fixture-owner', 'abe1.PEtACdHszLDJNRXmgQB1a6xaxWFHTKVljAQWkabsczH-b6iBvOAgNwzmDetu-XjSCch5jEHU1A', NULL, false, true, '2026-11-01 11:36:00+00');
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-comment-agent', 'fixture-running', 'agent', 'comment', 'abe1.dSt9biDsL1yQwlm4bFmXyz19te7HnFRpsFTx-fCj-VUtMnom8lJEY2kRAJDSrBPeHQcxITjpiOCgD5C3kyPq-WCDT5VzHpRn-J5Wbw', NULL, NULL, NULL, 'fixture-laptop', '2026-11-01 11:40:00+00', 'fixture-owner', 'abe1.amUWWi55RVVPjfJdHBo0n6EVm1eVSIJo8375KEF7aDiQ1DXseoeKITRjWGkpXSKuUrjzQSEkar5BgkcZxmjqrE2PIw8', 'abe1.bJcZ_f_6swyuWrvbf3s-8K47Wnp931teFSM-KOEVJAPgB6-oLxFfT_jEsJS35AqQsOJNKacgnjAnmw', false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-polish', 'fixture-done', 'agent', 'polish', 'abe1.-oB8BkKQAbwWpZFdCOl-EhsSOWpoRlPnUmrQCI1u_m3jjqNVlBR1gk5IJA9LJb_N5V-ZNot2S3ltfC0Kby9PHEAA', NULL, NULL, NULL, 'fixture-laptop', '2026-11-01 11:45:00+00', 'fixture-owner', 'abe1.dGTmQ0Ik9PxfWe2d79O7dDS8JdwYyaY1MBKezAZqryenkn23bMN0xCaHnQxe56ANiQMm1tx8wI9gW9xD1c9GCa-V', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-event-system', 'fixture-running', 'system', 'event', 'abe1.NevqiXu0qG6rqj7nzPC750MyBdVvOKqmihj0xfYJ1BzS550r3m3Nr4VTcNZgoxJ5ic78cwaiti_6mQ', NULL, NULL, NULL, 'fixture-laptop', '2026-11-01 11:50:00+00', 'fixture-owner', 'abe1._xxn6FdtGTb8gPQULvVM3ikUvJxfS5lT4J2zOK4wBKEZNC25zQ3zTqs11gKdj_ovEOx4-XciFAbGWA', NULL, false, false, NULL);
INSERT INTO public.note (id, task_id, author, kind, body, questions, answers, question_note_id, by, created_at, owner, preview, suggestion, pending, queued, delivered_at) VALUES ('fixture-note-event-server', 'fixture-running', 'server', 'event', 'Moved from Todo to Running.', NULL, NULL, NULL, NULL, '2026-11-01 11:51:00+00', 'fixture-owner', NULL, NULL, false, false, NULL);

--
-- Data for Name: schedule; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schedule (id, title, input, priority, machine, workdir, every_ms, cron, timezone, anchor_at, last_occurrence_at, remaining, until, paused_at, ended_at, occurrence_task_id, created_at, owner, model, agent, auto_done, more_crons, after_schedule_id, after_delay_ms, max_concurrent, requested_lane) VALUES ('fixture-schedule-interval', 'abe1.PwRCBvF0sWxqWalq2UtpRC82QwI1YHyerbE7unec_beqCUKnLnHQ1Tz4GPBr', 'abe1.U2iNoKB8idNXCpmvDdpHFGnkvvs0uhSNic1QQXdPyglCSOB2IVPTaA3OaVsUN8vbImQ3cj2JQdh4S2aYUUssqKcuedcU88fdiw', 'normal', 'fixture-laptop', 'abe1.DuAwrlPrHA0cnYc1rczgjWO_dVlVA0Sa9eu4E0QZLp3wmp_XWMUtLi0FKOETQg', 3600000, NULL, NULL, '2026-11-01 09:00:00+00', '2026-11-01 10:00:00+00', NULL, NULL, NULL, NULL, 'fixture-occurrence-next', '2026-11-01 09:02:00+00', 'fixture-owner', NULL, NULL, false, '{}', NULL, NULL, 1, NULL);
INSERT INTO public.schedule (id, title, input, priority, machine, workdir, every_ms, cron, timezone, anchor_at, last_occurrence_at, remaining, until, paused_at, ended_at, occurrence_task_id, created_at, owner, model, agent, auto_done, more_crons, after_schedule_id, after_delay_ms, max_concurrent, requested_lane) VALUES ('fixture-schedule-cron', 'abe1.qGAL9FzD8zr29jueZqKp9hWfiZEj1biS_bJX2J3CskBgxIEH7cu0na5i', 'abe1.NAD4H6B-iS-35IsA0TV7vJ-tfO_YdSQJR0BX2_vXdbkOrMf-58Vxtfpa6CbZjtXOD5QEOfvVJ-1dxvIf604HwbmokzhlZzbKMqEeeQiNIP_g', 'normal', 'fixture-server', 'abe1.W-tr_Ln2kK1eiLbfZM-LZDMpyj4mmHp5mWo1RuqlCCQ14HY-So8IpAiMQkMasw', NULL, '30 8 * * 1-5', 'UTC', '2026-11-01 09:00:00+00', NULL, 10, '2027-01-30 09:00:00+00', '2026-11-01 14:00:00+00', NULL, NULL, '2026-11-01 09:03:00+00', 'fixture-owner', 'sonnet', NULL, false, '{"0 18 * * 5"}', NULL, NULL, NULL, NULL);
INSERT INTO public.schedule (id, title, input, priority, machine, workdir, every_ms, cron, timezone, anchor_at, last_occurrence_at, remaining, until, paused_at, ended_at, occurrence_task_id, created_at, owner, model, agent, auto_done, more_crons, after_schedule_id, after_delay_ms, max_concurrent, requested_lane) VALUES ('fixture-schedule-after', 'abe1.hQtMh1r-zQy9_FD22zU0Mep7SN6KmNQYBCJzs1He90l6C-ln88kYuqwNpEBDYM5JGHWqQDbhGSVTtQ', 'abe1.PcNK2ky4M9EzJHAgd0lKAvSpWMYvvcxh66xIZsYOU3uD9IqgEM3xnCbSyPnjI5Ib_MJ75fvNXjVoouhlG6sgNvfqJ1IM_Kg', 'high', 'fixture-laptop', NULL, NULL, NULL, NULL, '2026-11-01 09:00:00+00', NULL, NULL, NULL, NULL, NULL, NULL, '2026-11-01 09:04:00+00', 'fixture-owner', NULL, 'abe1.Jht0wc8lf8IQ23ROC5k6eGgeYzScYZ4-0lajrEcq0Vg8iU5j', false, '{}', 'fixture-schedule-interval', 120000, NULL, NULL);

--
-- Data for Name: task; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-backlog', 'abe1.f_lbFyC4RyHkmrg2NVoeI3JDqaxN92DeA3iXPw_SbpP9-rEZg6yMI66CUVIo0EV4vxKhPg', 'abe1.e1Q2lV-nPliM8CXCa4VvrIvMdrE1GN0QCSfEKQhAS9uoh4_LCHjb0ijMVt_VfnHQ0zHrdDlUDhW8eKWtOThsdF78DIfIXQCK', 'backlog', 1, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 09:20:00+00', '2026-11-01 09:25:00+00', 'low', NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-proposed', 'abe1.NNH-TXNfZmB3d5vsYbbKmYZjbFYQLIeGh2XdRPAEovCagdpLJggX87OHohxmJogG7ZY4_sY67WtaOVTb', 'abe1.0d5Q8vcuRMs6fP1zX9T9KhFdy3ISeV9juGYdfLEc-urf7UgU33r-RD3ydgblmPtB11rIV99dMJpJsirwagKGPaLyk91fod0rZUzp7W2cfpCeaA', 'backlog', 2, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'agent', true, '2026-11-01 09:22:00+00', '2026-11-01 09:27:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.kPcmjCtibWG8gWFzS-76l5pWmqeC1jP_wH2jYQarjckcgncZTjmeGTmsyk26WQ', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.kPcmjCtibWG8gWFzS-76l5pWmqeC1jP_wH2jYQarjckcgncZTjmeGTmsyk26WQ', NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-todo', 'abe1.sHbJFDFhRKJEWnIrSmx_BzjVGx8ZSuxKfz1FkjE7hKkcUoJTWva2O_ffEkTBjj_hjTWS8E-2Hg', 'abe1.2GMRDVDVUWswdrmCw175WhY4A2Wn2a8ei1aJXO2aJqmfR7WuTDgZxtRh1rl7YoQVedl3ykuk8DlU0PN7pyQBRRRR6WpuFrtePVi4aM-3UW9ZQMre0dOwbw', 'todo', 1, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 09:30:00+00', '2026-11-01 09:35:00+00', 'high', NULL, false, NULL, NULL, 'abe1.6o-U7jZz2LxN5eVhftEmXaQTF7SGGr0xdoSaGqMqqgRSvuH2hlhmjTvXrg1FDQ', NULL, NULL, NULL, '2026-11-02 10:00:00+00', NULL, 'fixture-owner', NULL, false, NULL, 'sonnet', NULL, NULL, false, NULL, 'abe1.6o-U7jZz2LxN5eVhftEmXaQTF7SGGr0xdoSaGqMqqgRSvuH2hlhmjTvXrg1FDQ', NULL, NULL, NULL, '{}', NULL, true, NULL, NULL, 'default');
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-running', 'abe1.MEleRejVEXIXlHiSPO8VcjjQGUP5qX0c1CactiyYlT1HfsTONEUy9Jt7osRk7Br20Oi468Q', 'abe1.0weuTci9kAUAMtE_92BEpTynMmC3_f-UgkgMa1XaJJ7KfiUJzsPTODhuE0-mkzdMzPYXptn9kCm7tK2L629TZ7UIxXlVdoH2a62L2WXSOB8CiWRT5Qk', 'running', 1, false, 'fixture-laptop', 'fixture-session-0001', 'resume', NULL, NULL, NULL, 'user', false, '2026-11-01 09:40:00+00', '2026-11-01 09:45:00+00', 'urgent', 'main', false, '2026-11-01 12:20:00+00', NULL, 'abe1.M5DvhyyPsUcGyzJiOfwMTA0CFwMJf2IMTNo6SQgWE3lFej9ipK78tBzzN0IjCAxX0ygRqGt6R04jR4BPlBI', NULL, '2026-11-01 12:10:00+00', NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, 'opus', NULL, NULL, true, NULL, 'abe1.hMmgj71qxp5FGe1AqA40clXOzhgteX822nwCDXdVuc-Q4M-_Vb7jFqjk5gli', NULL, 'fixture-run-current-0001', 'abe1.9Zyv0OY9jQ2Ik9r2gQeXUZCky6PmWxebGH7ndDA2KmWR1KUZnUk4Gup_wfvnRVTzN4BydTyGSh6Y07Q2aSUs6qUIpz_nkesQzSl45q0DbriTAr5u2tvhgRFliUnVPuBiu3xooKMteQp2EJ5Br3iJD1qWM_6iFMC2a9ZJQnfkkW6g_Dp1Xr0diBW8w46akdJkvGHsrkv3xAK_wcFNMFCXC-Lqec9IM0djFel1p3TIywFnYrnflzV9rsG9_aAaqMdrqf2ZIiace2fd28xgOOk-csJ0t9qLwTMrpDEkkR_lxwSjxCUjNaHiJPEGHUhT4Au6IOgsLE7oIa1dzf5l4ey8lAH865ufcTvQWzmVmrgU9k-aL5BLEuruZEp-T5fIgjdJj3m02rWsKwNqHGQ4gcr5V5AyrJNZGu8yejg', '{fedcba9876543210}', NULL, false, 'machine', NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-waiting', 'abe1.Ij0AV4vq6QDKeExV55-8XT_nCYJecB7HgmCN-UC1_lLjzOdl2YLTbAgOZceo7S3ai2aH83I', 'abe1.hsSRmoCnTfBBMfZoxc3xVljvU-kWf4p7v6q28SilQ5-RH7fda2tl7EkTfq79bs4M3nANg4_fcooQW_qvoVUdDd-1gPng04IjuWtDyaKLK9qu8IfFGnrs0dDdcERGYg', 'waiting', 1, false, 'fixture-server', 'fixture-session-0002', 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 09:50:00+00', '2026-11-01 09:55:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.feuCFqc2oypNBRd0_gwnVZul0ZKo5ooXdFj0ZNDgqbdcfEXHgvLe7ZqpXbQmoQ', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', '2026-11-01 22:20:00+00', true, NULL, NULL, NULL, NULL, false, NULL, 'abe1.feuCFqc2oypNBRd0_gwnVZul0ZKo5ooXdFj0ZNDgqbdcfEXHgvLe7ZqpXbQmoQ', NULL, NULL, 'abe1.IsFC-KsdUE8r5EsLJSLuh3GwkoPLtm_d7Vi2EFVq7z25Oevm9UYx3iopwtn930wrUOMJbDx79YHN6oupOf9WeNyThn7oUcgA4eO816DHkpheboMUGyVHtlZ-DY2rCVAMfLOFV8pi_-u_OmEvAmhwi7BcZIHL3C7a4FIwTe9aHJ8KxTgbivz0hDyOJOZ0xA6L3u5TJ7r_6Vx6WlyP8czMkVCesYd6Lgm6ImzEtMzo4j_24wb-B7WXHKvPgcYlR8nj4EvcG_bBc2wJOpqYUII9JH9aQoXjvaj5gvEYGDYHe07fsxGpwSzo9rcY0WVFhg2eMZY5ECqvF76IXVT0UhnjDHdWopS_qUXQGnPkW7SpKZXv_Sh17Q6iC5Vz8DEEdZCWBWNHWQUoTTG4bEx2Ov3IfZzMQUwudTTfdZo', '{}', NULL, false, 'agent', NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-needs-me', 'abe1.kT7Rgr8M417X77D6dp7VTfDhBgRb_eT6IQtCh3o5FPh3SGuyFZgvlu7X9_blYMbvA8MlCCM', 'abe1.1K2Luk1Pqdw3HjyJQpSANAj1q1YALpBK-252YkRZfZTJYUQWdJemjLM2vjsGP-HyMrEQlqHciFbzHNcIeDmy-ZdjW0VDN6j8jsj_QepFp6d6peCZ_GM', 'needs-me', 1, false, 'fixture-laptop', 'fixture-session-0003', 'fresh', 'fixture-note-question-open', NULL, NULL, 'user', false, '2026-11-01 10:00:00+00', '2026-11-01 10:05:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.GLfH5RTREfadKJGVUNZh9EK80BuoGuRLXA_FZwx-7pmEZtovWdTbIKlJplr8_g', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.GLfH5RTREfadKJGVUNZh9EK80BuoGuRLXA_FZwx-7pmEZtovWdTbIKlJplr8_g', NULL, NULL, NULL, '{}', NULL, false, 'agent', NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-done', 'abe1.OA5eeOgWwLDvEgUFLFZqOPu8srCwky88GL4tr5caFtUw_-0I2_OWjVOx-gQNdpOrctV15KRwYQ', 'abe1.1huzkIZEjSco7vfU0WQM5vFsRgTZ6HAC8yYrKIX8TyuYQOX73Mz_nlH7M93LwHPcCCdxThrNnt_4z5wMKS8ezUewv1cvzfRDQkdU-PwWA_I', 'done', 1, false, 'fixture-laptop', 'fixture-session-0004', 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 10:10:00+00', '2026-11-01 10:15:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.7J4r2gxfQcMeMCxmp04m0v-d7YT0QB7VH8cM0qzCQCdk8bxzXo9LdvWkE3Q4Mw', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, 'merged', NULL, false, NULL, 'abe1.7J4r2gxfQcMeMCxmp04m0v-d7YT0QB7VH8cM0qzCQCdk8bxzXo9LdvWkE3Q4Mw', NULL, NULL, NULL, '{}', NULL, true, 'agent', NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-closed', 'abe1.STheeD1F1-gFysoLe-ihJ1bj_PqkkUDNMiX5RTnOoMwjbSrXiAmK-GryJZGXu_Xu3iZrxTP6dw', 'abe1.dyJC80MQLVNqU2K-nKDQKDDpCjXjMTbHUNmf_vO-oCBBFCiQ8AXBYZE89o5JO16q8rgh7O6gBGQ', 'done', 2, true, NULL, NULL, 'fresh', NULL, NULL, 'fixture-done', 'user', false, '2026-11-01 10:20:00+00', '2026-11-01 10:25:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.51KrRbU5dpJwSxFKpiOs3i8San-f93lui-t66nELTy12aKsh0TUPJfSO-wko', '2026-11-01 15:40:00+00', NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.51KrRbU5dpJwSxFKpiOs3i8San-f93lui-t66nELTy12aKsh0TUPJfSO-wko', NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-fork', 'abe1.8XCvuiEL4hNO9UsE76djQmHVZpHRBgVwGRaZsnLUpL-cSkOyGaZLDIC-MvtFb8XgAA', 'abe1.5wKk81DrZYsgxr97FDyxffky7uvC3UMFAZapdqBtmIp_jje6ClV7Zdalh4_yrwqeBcT5PAyUk0WyggIK1wH4cOAJCBLT2lPOZK_uY4wafhGU5ao', 'todo', 2, false, NULL, NULL, 'fresh', NULL, NULL, 'fixture-done', 'agent', false, '2026-11-01 10:30:00+00', '2026-11-01 10:35:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.NRVC5XHMHf_mlTCg4NcmtdzTD-2AOLx_vQ8741zFpC_qkoBPpcH3z1W7lNtzjg', NULL, NULL, NULL, NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.NRVC5XHMHf_mlTCg4NcmtdzTD-2AOLx_vQ8741zFpC_qkoBPpcH3z1W7lNtzjg', 'abe1.V4WO1qWUN6YO9MXYUsNnw7s5b2FA8HSm2VhXTyxJYLWK-eZP', NULL, NULL, '{}', 'fixture-done', false, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-review', 'abe1.sCZh3FpBo4ka1CuBt7LP-6KI7yARK32RfzO1rV1Hlf1Kcppym6cc3W_minQCzGt84W4eQuFK718', 'abe1.Xt9S_UVWLeKxdPIqm0ib8Fv5AdbOpYYVuB9GNiUvYU4XuHkTbWlz4IRRB_tZ7sBB1RMrSY73TxG7DuoFa1mQNDe4F9Cph4vUL8JhKQZxmzHRJto0qQ', 'todo', 3, false, NULL, NULL, 'fresh', NULL, 'abh1.ybi87q-EkbapS11eHwSkAZpTzcvC1LDDkQMPWkZ4DEw', NULL, 'intake', false, '2026-11-01 10:35:00+00', '2026-11-01 10:40:00+00', 'normal', NULL, false, NULL, NULL, NULL, NULL, NULL, 'abh1.TOZWLvUK607Zi83x7IlURBfpryv7ggmrdnWGFSbyDOc', NULL, NULL, 'fixture-owner', NULL, false, NULL, NULL, 'open', NULL, false, NULL, NULL, NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-occurrence-done', 'abe1.PwRCBvF0sWxqWalq2UtpRC82QwI1YHyerbE7unec_beqCUKnLnHQ1Tz4GPBr', 'abe1.U2iNoKB8idNXCpmvDdpHFGnkvvs0uhSNic1QQXdPyglCSOB2IVPTaA3OaVsUN8vbImQ3cj2JQdh4S2aYUUssqKcuedcU88fdiw', 'done', 3, false, 'fixture-laptop', NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 10:40:00+00', '2026-11-01 10:45:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.H_rwhOK9h9vg2rrUzpt4MTegvIKC3KpI3cdpu8TI0P2WAeTKh-J0zHRFkIxvvw', NULL, NULL, NULL, NULL, 'fixture-schedule-interval', 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.DuAwrlPrHA0cnYc1rczgjWO_dVlVA0Sa9eu4E0QZLp3wmp_XWMUtLi0FKOETQg', NULL, NULL, NULL, '{}', NULL, false, NULL, '2026-11-01 13:20:00+00', NULL);
INSERT INTO public.task (id, title, input, status, "position", closed, machine, session_id, next, open_question_note_id, dedupe_key, parent_id, created_by, proposed, created_at, updated_at, priority, lane, borrowed, last_active_at, paused_at, workdir, closed_at, run_started_at, head, not_before, schedule_id, owner, wake_at, wait_check, woken_at, model, pr_state, stop_requested_at, inbox_read, stop_message_id, home_workdir, agent, run_id, watches, watch_stops, fork_of, auto_done, moved_by, occurrence_finished_at, requested_lane) VALUES ('fixture-occurrence-next', 'abe1.PwRCBvF0sWxqWalq2UtpRC82QwI1YHyerbE7unec_beqCUKnLnHQ1Tz4GPBr', 'abe1.U2iNoKB8idNXCpmvDdpHFGnkvvs0uhSNic1QQXdPyglCSOB2IVPTaA3OaVsUN8vbImQ3cj2JQdh4S2aYUUssqKcuedcU88fdiw', 'todo', 4, false, NULL, NULL, 'fresh', NULL, NULL, NULL, 'user', false, '2026-11-01 10:45:00+00', '2026-11-01 10:50:00+00', 'normal', NULL, false, NULL, NULL, 'abe1.DuAwrlPrHA0cnYc1rczgjWO_dVlVA0Sa9eu4E0QZLp3wmp_XWMUtLi0FKOETQg', NULL, NULL, NULL, '2026-11-02 11:00:00+00', 'fixture-schedule-interval', 'fixture-owner', NULL, false, NULL, NULL, NULL, NULL, false, NULL, 'abe1.DuAwrlPrHA0cnYc1rczgjWO_dVlVA0Sa9eu4E0QZLp3wmp_XWMUtLi0FKOETQg', NULL, NULL, NULL, '{}', NULL, false, NULL, NULL, NULL);

--
-- Data for Name: task_pr; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.task_pr (id, owner, task_id, pr, state, created_at) VALUES ('fixture-pr-merged', 'fixture-owner', 'fixture-done', 'abe1.pi4KSJFurn_cVZr4lIEmm1oqVAcEL686qN2Oh3wcyrI1MEBNhdQIKLECbPZjzdm6KLdEvK8eiwKQvANt9jg8UV_EUiMbrmYdaRD_jN4', 'merged', '2026-11-01 12:11:00+00');
INSERT INTO public.task_pr (id, owner, task_id, pr, state, created_at) VALUES ('fixture-pr-open', 'fixture-owner', 'fixture-running', 'abe1.qlxiaIQIR6CQ5VTF4uvxdq3E3mH-9a7Vtbgo8lcTu-VpxRBbBAFlG1nsHtRMeL7mXIOAX9-N4f25Rj7sz9RiJUvttT8nb1WXX7cWrU4', 'open', '2026-11-01 12:12:00+00');
INSERT INTO public.task_pr (id, owner, task_id, pr, state, created_at) VALUES ('fixture-pr-closed', 'fixture-owner', 'fixture-done', 'abe1.kECe9QTlMZkQZYmr6pLT8BZx3tUyCpXU_Xz5JzaC09TavPCHC2x58V2Ow1gkYsgJv0blp6Bvb9K-3ABSf9_61EDLyftbeipWaNQWeOk', 'closed', '2026-11-01 12:10:00+00');

--
-- Data for Name: transcript_event; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 0, '2026-11-01 12:30:00+00', 'text', NULL, 'abe1.CvVArSw68PF0IaWpwIbtcjcRFjW8jsEB-uhr7BygkEXB-21pCN7akivzmG64Q0iTJSmXdT2CpPgw-CAFQ5MixWFneoMAeFnOG8OE3XT_DV4uAWwaOuWHLevhKGqjI3gXk7wXxavIuX1fQ63N8ZYjsZDzgWm_qNMPpBwu4NO287icYwRUYyaBCk4olA', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 1, '2026-11-01 12:31:00+00', 'tool_use', NULL, 'abe1.y6l4kv2mZgruwkmh-a7MR9YM9_drCkmpHHutdRF5QdqoEJ2qa3vCkOVNWa6RaCLUD1U7WmeVHH8H1w8AbhMhuSbsLotdcQ7yUI8Q-95dtBYr1XLT6mrqUlciAMgo41eXhW1aNldfqtohaW1FRE8XsFBv1L9JIdGfJLn0RufvWP4afO1X50od8LNhyCMyFhkEo5jWX5rW2p5NRyBrKwQlOv2lYkhAYoPi16MakB1JnQ', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 2, '2026-11-01 12:32:00+00', 'tool_result', NULL, 'abe1.xED3adKAw0pyPaKnqzQxqTJi_T_Kl-TRwMDKLEdb5yKQbz93iLzY0SugV3eMTrgu8g9XWIjXL7i-t77toudd1xZggMJnHD74nw5O1_NRfPvcH0lBdDnNMmZ_1t3R7QTA8Mx-JwMiCj8ZpKl8zVWfPXEdaFqq8IRZD8h5-j9LdHhwyN26vLSgLuQ3WY-1', 'abe1.RvsLi0oTKecNwiXSe4v-kNKB_28iToP1sIdYAfJhrjqCf3nxSvXQv5VyjpykcTuGXXZ5ZPHSLjlWkSc0xfLGSTGSfzR5j8Qdjbwd', 47, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000001', 3, '2026-11-01 12:33:00+00', 'result', NULL, 'abe1._Qx1Xxpf_zjBpo90hOeAwgtAaelQR5HztdiiNf-FonOezYNIVgraSgmEHKcF-HYnLUBJQdzI8rR1dE8nsLne3Xy_tFXzSrAi_LRGwVoOPIskl6aGr6vX2q96OYnloTYJ0q60KdyfNuOLJkyoSgc26Zs7nAhydY2PrpWU2Zl-50I6rQwtj8ZZZ1VjTVQb3yEZdfJyMSby8J31KBvYSHAhz5rmL8i2c3S1jFwE8Dk3mvTuQqRURFURPmpOhATwSHxkKXfNSHNev7yV', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000002', 0, '2026-11-01 12:30:00+00', 'text', NULL, 'abe1.epyh-ezSyJ4BQL-vCi84qXoA3u2gnkWTZJqeEdxeuqa9kvyPTjzykr5GTelxT846UyHwFBCJNxPtk21FjIEKTF99pTvaQCa16YRDeykuQDbcmamOtt3Wmm2OLVW4hJwi-kY8C5lDPT9pybaLH0wVKGaqMxh3xeuabYDO4qiMEX_eSW_iPb2Q2vGIpCT7ueWzRiA', NULL, NULL, 'fixture-owner');
INSERT INTO public.transcript_event (run_id, seq, at, kind, parent, data, output, output_size, owner) VALUES ('fixture-run-0000000002', 1, '2026-11-01 12:31:00+00', 'note', NULL, 'abe1.-LHE6d79KbHTIj3mZu6iFEb8zfEPE49ZmtI_OoAKI_zi4r8__-BqISTBgP4qqJavOQZ_fxqgK_EhKzCUF2kJQVUWBftLsG6rPkfeSuvOObeAg5PiJ1ybHvJ2JYCPKaBZlUTcsd4GmrdFB_GVhaDltJYAh1swRfS65q0j', NULL, NULL, 'fixture-owner');

--
-- Data for Name: transcript_run; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.transcript_run (id, task_id, machine, session_id, resumed, started_at, last_event_at, event_count, owner) VALUES ('fixture-run-0000000001', 'fixture-done', 'fixture-laptop', 'fixture-session-0004', false, '2026-11-01 12:30:00+00', '2026-11-01 12:34:00+00', 4, 'fixture-owner');
INSERT INTO public.transcript_run (id, task_id, machine, session_id, resumed, started_at, last_event_at, event_count, owner) VALUES ('fixture-run-0000000002', 'fixture-running', 'fixture-laptop', 'fixture-session-0004', true, '2026-11-01 12:30:00+00', '2026-11-01 12:32:00+00', 2, 'fixture-owner');

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE SET; Schema: drizzle; Owner: -
--

SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 42, true);

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
-- Name: note_task_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX note_task_created_idx ON public.note USING btree (task_id, created_at);

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
-- Name: machine; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.machine ENABLE ROW LEVEL SECURITY;

--
-- Name: note; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.note ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule ENABLE ROW LEVEL SECURITY;

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
-- Name: machine tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.machine TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: note tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.note TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: schedule tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.schedule TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: task tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.task TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: task_pr tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.task_pr TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: transcript_event tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.transcript_event TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

--
-- Name: transcript_run tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant ON public.transcript_run TO board_app USING ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting))) WITH CHECK ((owner = ( SELECT current_setting('app.owner'::text, true) AS current_setting)));

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
