use serde_json::Value;
use std::path::PathBuf;

fn repo_file(relative: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    std::fs::read_to_string(root.join(relative)).unwrap_or_else(|_| {
        panic!("{relative} is missing: run `pnpm --filter @agent-board/contract run build`")
    })
}

pub fn repo_json(relative: &str) -> Value {
    serde_json::from_str(&repo_file(relative)).unwrap()
}
