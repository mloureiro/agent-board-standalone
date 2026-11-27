use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use p256::pkcs8::DecodePublicKey;
use rumo_bridge_core::address::check_address;
use rumo_bridge_core::sign::{canonical_string, content_digest, key_id_of};
use serde_json::Value;
use std::path::PathBuf;

fn repo_file(relative: &str) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let text = std::fs::read_to_string(root.join(relative)).unwrap_or_else(|_| {
        panic!("{relative} is missing: run `pnpm --filter @rumo/contract build`")
    });
    serde_json::from_str(&text).unwrap()
}

#[test]
fn address_rule_matches_the_contract_cases() {
    let cases = repo_file("packages/contract/dist/cases/address.json");
    let mut checked = 0;
    for case in cases.as_array().unwrap() {
        if case.get("pinnedFingerprint").is_some() {
            continue;
        }
        let input = case["input"].as_str().unwrap();
        let expect = &case["expect"];
        let got = check_address(input);
        if expect["ok"].as_bool().unwrap() {
            assert_eq!(
                got.as_deref(),
                Ok(expect["url"].as_str().unwrap()),
                "{input}"
            );
        } else {
            assert_eq!(
                got.map_err(|p| p.code()),
                Err(expect["problem"].as_str().unwrap()),
                "{input}"
            );
        }
        checked += 1;
    }
    assert!(checked > 20);
}

#[test]
fn signing_primitives_match_the_sealing_vectors() {
    let vectors = repo_file("packages/sealing/test/vectors/signatures.json");
    for key in vectors["keys"].as_array().unwrap() {
        let public = key["publicKey"].as_str().unwrap();
        assert_eq!(key_id_of(public).unwrap(), key["keyId"].as_str().unwrap());
    }
    for digest in vectors["digests"].as_array().unwrap() {
        let body = URL_SAFE_NO_PAD
            .decode(digest["body"].as_str().unwrap())
            .unwrap();
        assert_eq!(content_digest(&body), digest["digest"].as_str().unwrap());
    }
    for case in vectors["cases"].as_array().unwrap() {
        let key = vectors["keys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["name"] == case["key"])
            .unwrap();
        let der = URL_SAFE_NO_PAD
            .decode(key["publicKey"].as_str().unwrap())
            .unwrap();
        let verifier = VerifyingKey::from_public_key_der(&der).unwrap();
        let signature = Signature::from_slice(
            &URL_SAFE_NO_PAD
                .decode(case["signature"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let canonical = case["canonical"].as_str().unwrap();
        verifier.verify(canonical.as_bytes(), &signature).unwrap();
        let parts: Vec<&str> = canonical.split('\n').collect();
        let digest = Some(parts[4]).filter(|d| !d.is_empty());
        assert_eq!(
            canonical_string(
                parts[0],
                parts[1],
                parts[2].parse().unwrap(),
                parts[3],
                digest
            ),
            canonical
        );
    }
}

#[test]
fn the_declared_contract_level_is_the_contracts() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let text = std::fs::read_to_string(root.join("packages/contract/src/version.ts")).unwrap();
    let line = text
        .lines()
        .find(|l| l.starts_with("export const CONTRACT ="))
        .unwrap();
    let level: u32 = line
        .trim_end_matches(';')
        .rsplit(' ')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(rumo_bridge_core::bridge::CONTRACT_LEVEL, level);
}
