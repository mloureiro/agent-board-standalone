import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TESTS = join(import.meta.dirname, '..', 'src-tauri', 'core', 'tests');
const rust = (file: string): string => readFileSync(join(TESTS, file), 'utf8');

const ROWS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['mobile-001', 'bridge.rs', ['the_server_list_survives_a_restart']],
  [
    'mobile-002',
    'vectors.rs',
    ['address_rule_matches_the_contract_cases', 'the_declared_contract_level_is_the_contracts'],
  ],
  [
    'mobile-002',
    'bridge.rs',
    [
      'adding_a_server_needs_confirmation_and_a_valid_address',
      'two_entries_for_one_address_get_separate_ids',
    ],
  ],
  [
    'mobile-003',
    'bridge.rs',
    ['handoff_finish_stores_the_token_and_sends_the_key_only_when_signatures_are_required'],
  ],
  [
    'mobile-004',
    'paths.rs',
    [
      'links_open_externally_only_for_safe_schemes',
      'navigation_stays_in_the_app_opens_other_origins_outside_and_drops_the_rest',
    ],
  ],
  [
    'mobile-005',
    'attention.rs',
    [
      'the_first_poll_of_a_server_only_remembers_what_is_already_waiting',
      'a_task_that_newly_needs_me_is_reported_once',
      'a_task_that_left_and_came_back_is_reported_again',
      'the_attention_answer_is_read_and_the_text_never_carries_a_title',
    ],
  ],
  [
    'mobile-008',
    'paths.rs',
    [
      'refuses_traversal_in_any_spelling',
      'refuses_paths_outside_the_api',
      'refuses_credential_routes_whatever_the_case_or_query',
    ],
  ],
  [
    'mobile-008',
    'bridge.rs',
    [
      'fetch_adds_the_credential_and_drops_the_pages_own',
      'fetch_refuses_bad_paths_credential_routes_and_unknown_servers',
      'removing_a_server_needs_confirmation_and_deletes_its_credentials',
    ],
  ],
  ['mobile-008', 'vectors.rs', ['signing_primitives_match_the_sealing_vectors']],
  [
    'mobile-010',
    'bridge.rs',
    [
      'pairing_binds_the_key_and_later_requests_are_signed',
      'client_routes_are_signed_before_pairing_so_the_server_can_ask_for_it',
    ],
  ],
];

describe('Rust tests behind the mobile rows', () => {
  it.each(ROWS)('[%s] %s holds %j', (_row, file, names) => {
    const source = rust(file);
    for (const name of names) expect(source).toContain(`fn ${name}(`);
  });
});
