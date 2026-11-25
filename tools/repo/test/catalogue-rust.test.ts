import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRepository, scanRustSource } from '../src/catalogue/scan.ts';

const PARTS = ['api', 'client-app', 'server-app'];

const SOURCE = `
use something;

#[test]
fn client_app_049_refuses_dot_segments() {}

#[tokio::test]
async fn client_app_014_first_url_wins() {}

#[test]
#[ignore]
fn server_app_007_is_kept_through_other_attributes() {}

#[tokio::test(flavor = "multi_thread")]
async fn api_012_takes_attribute_arguments() {}

// #[test]
// fn client_app_050_is_commented_out() {}

#[test]
fn helper_without_a_row_id() {}

#[test]
fn client_app_1234_has_four_digits() {}

fn client_app_051_is_not_a_test() {}
`;

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

describe('rust catalogue scanner', () => {
  it('[harness] reads row ids from Rust test names', () => {
    const titles = scanRustSource('apps/client-app/src-tauri/core/tests/a.rs', SOURCE, PARTS);
    expect(titles.map((title) => [title.title, title.ids])).toEqual([
      ['client_app_049_refuses_dot_segments', ['client-app-049']],
      ['client_app_014_first_url_wins', ['client-app-014']],
      ['server_app_007_is_kept_through_other_attributes', ['server-app-007']],
      ['api_012_takes_attribute_arguments', ['api-012']],
      ['helper_without_a_row_id', []],
      ['client_app_1234_has_four_digits', []],
    ]);
    expect(titles.every((title) => title.isTest)).toBe(true);
  });

  it('[harness] scans src-tauri Rust files and skips build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'catalogue-rust-'));
    write(root, 'requirements/catalogue/client-app.md', '# client-app\n');
    write(root, 'apps/client-app/src-tauri/core/tests/vectors.rs', SOURCE);
    write(
      root,
      'apps/client-app/src-tauri/target/debug/build/x/out/generated.rs',
      '#[test]\nfn client_app_001_from_build_output() {}\n',
    );
    write(
      root,
      'apps/client-app/src-tauri/gen/generated.rs',
      '#[test]\nfn client_app_002_from_gen() {}\n',
    );
    write(
      root,
      'apps/client-app/src/not_native.rs',
      '#[test]\nfn client_app_003_outside_src_tauri() {}\n',
    );

    const scan = scanRepository(root);
    expect([...scan.ids.keys()].sort()).toEqual(['client-app-014', 'client-app-049']);
    expect(scan.ids.get('client-app-049')).toEqual([
      'apps/client-app/src-tauri/core/tests/vectors.rs',
    ]);
  });
});
