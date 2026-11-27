mod common;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::repo_json;
use p256::ecdsa::{Signature, SigningKey, VerifyingKey, signature::Verifier};
use p256::pkcs8::{DecodePublicKey, EncodePrivateKey};
use rumo_client_core::BUNDLE_ID;
use rumo_client_core::address::check_address;
use rumo_client_core::handover::{first_acceptable, normalise, parse, server_name};
use rumo_client_core::signing::{
    RequestSigner, SigningError, canonical_string, content_digest, key_id,
};
use serde_json::Value;

fn b64(text: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(text).unwrap()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}

fn vector_key<'a>(vectors: &'a Value, name: &str) -> &'a Value {
    vectors["keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|key| key["name"] == name)
        .unwrap()
}

fn verifier_of(key: &Value) -> VerifyingKey {
    VerifyingKey::from_public_key_der(&b64(text(key, "publicKey"))).unwrap()
}

#[test]
fn client_app_002_address_rule_matches_the_contract_cases() {
    let cases = repo_json("packages/contract/dist/cases/address.json");
    let mut checked = 0;
    for case in cases.as_array().unwrap() {
        if case.get("pinnedFingerprint").is_some() {
            continue;
        }
        let input = text(case, "input");
        let expect = &case["expect"];
        let got = check_address(input);
        if expect["ok"].as_bool().unwrap() {
            assert_eq!(got.as_deref(), Ok(text(expect, "url")), "{input}");
        } else {
            assert_eq!(
                got.map_err(|problem| problem.code()),
                Err(text(expect, "problem")),
                "{input}"
            );
        }
        checked += 1;
    }
    assert!(checked >= 25, "only {checked} cases were checked");
}

#[test]
fn client_app_002_bundle_id_matches_the_contract() {
    let contract = repo_json("packages/contract/dist/cases/bundle-id.json");
    assert_eq!(BUNDLE_ID, text(&contract, "bundleId"));

    let conf = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tauri.conf.json");
    let contents = std::fs::read_to_string(conf).unwrap();
    let conf: Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(text(&conf, "identifier"), BUNDLE_ID);
}

#[test]
fn client_app_014_handover_parser_matches_the_contract_cases() {
    let cases = repo_json("packages/contract/dist/cases/handover.json");
    let (mut parsed, mut built) = (0, 0);
    for case in cases.as_array().unwrap() {
        let link = text(case, "link");
        let got = parse(link);
        if let Some(expect) = case.get("expect") {
            if expect["ok"].as_bool().unwrap() {
                assert_eq!(got.as_deref(), Ok(text(expect, "url")), "{link}");
            } else {
                assert_eq!(
                    got.map_err(|problem| problem.code()),
                    Err(text(expect, "problem")),
                    "{link}"
                );
            }
            parsed += 1;
        } else {
            assert_eq!(got.as_deref(), Ok(text(case, "url")), "{link}");
            built += 1;
        }
    }
    assert!(parsed >= 10 && built >= 1);
}

#[test]
fn client_app_014_first_acceptable_url_of_a_batch_wins() {
    let links = [
        "rumo://open?v=1&url=http%3A%2F%2F192.168.1.10%3A4000%2F",
        "rumo://open?v=2&url=http%3A%2F%2Flocalhost%3A1%2F",
        "rumo://open?v=1&url=http%3A%2F%2Fuser%3Asecret%40localhost%3A2%2F",
        "rumo://open?v=1&url=http%3A%2F%2Flocalhost%3A3%2F",
        "rumo://open?v=1&url=http%3A%2F%2Flocalhost%3A4%2F",
    ];
    assert_eq!(
        first_acceptable(links),
        Some("http://localhost:3/".to_owned())
    );
    assert_eq!(first_acceptable(links[..3].iter().copied()), None);
    assert_eq!(first_acceptable([]), None);
}

#[test]
fn client_app_013_handover_names_are_host_and_port_and_distinct() {
    let mut taken: Vec<String> = Vec::new();
    for (url, expected) in [
        ("http://localhost:4000/", "localhost:4000"),
        ("http://localhost:4001/", "localhost:4001"),
        ("http://[::1]:4000/", "[::1]:4000"),
        ("https://127.0.0.1:4000/", "127.0.0.1:4000"),
        ("https://127.0.0.1:4000/", "127.0.0.1:4000 (2)"),
        ("https://127.0.0.1:4000/", "127.0.0.1:4000 (3)"),
    ] {
        let name = server_name(url, &taken);
        assert_eq!(name, expected);
        taken.push(name);
    }
    assert_eq!(
        normalise("  HTTP://LOCALHOST:4000 "),
        Some("http://localhost:4000/".to_owned())
    );
    assert_eq!(normalise("http://board.example.com"), None);
}

#[test]
fn client_app_052_signer_matches_the_sealing_vectors() {
    let vectors = repo_json("packages/sealing/test/vectors/signatures.json");

    for key in vectors["keys"].as_array().unwrap() {
        assert_eq!(key_id(&b64(text(key, "publicKey"))), text(key, "keyId"));
    }
    for digest in vectors["digests"].as_array().unwrap() {
        assert_eq!(
            content_digest(&b64(text(digest, "body"))),
            text(digest, "digest")
        );
    }

    for case in vectors["cases"].as_array().unwrap() {
        let key = vector_key(&vectors, text(case, "key"));
        let canonical = text(case, "canonical");
        let signature = Signature::from_slice(&b64(text(case, "signature"))).unwrap();
        verifier_of(key)
            .verify(canonical.as_bytes(), &signature)
            .unwrap();

        let secret = SigningKey::from_slice(&b64(text(&key["privateKeyJwk"], "d"))).unwrap();
        let signer =
            RequestSigner::from_pkcs8_der(secret.to_pkcs8_der().unwrap().as_bytes()).unwrap();
        assert_eq!(signer.key_id().unwrap(), text(key, "keyId"));
        assert_eq!(signer.public_key().unwrap(), text(key, "publicKey"));
        let fresh = signer.sign(canonical);
        let fresh_bytes = b64(&fresh);
        assert_eq!(fresh_bytes.len(), 64);
        verifier_of(key)
            .verify(
                canonical.as_bytes(),
                &Signature::from_slice(&fresh_bytes).unwrap(),
            )
            .unwrap();
    }

    for refusal in vectors["refusals"].as_array().unwrap() {
        let key = vector_key(&vectors, text(refusal, "key"));
        let verified = Signature::from_slice(&b64(text(refusal, "signature")))
            .map(|signature| {
                verifier_of(key)
                    .verify(text(refusal, "canonical").as_bytes(), &signature)
                    .is_ok()
            })
            .unwrap_or(false);
        assert!(!verified, "{}", text(refusal, "reason"));
    }
}

#[test]
fn client_app_052_generated_keys_round_trip_and_sign() {
    let signer = RequestSigner::generate();
    let restored = RequestSigner::from_pkcs8_der(&signer.to_pkcs8_der().unwrap()).unwrap();
    assert_eq!(restored.key_id().unwrap(), signer.key_id().unwrap());
    assert_eq!(
        signer.key_id().unwrap(),
        key_id(&signer.public_key_der().unwrap())
    );

    let canonical =
        canonical_string("get", "/api/tasks?limit=20", 1767225601, "AQEB", None).unwrap();
    let verifier = VerifyingKey::from_public_key_der(&signer.public_key_der().unwrap()).unwrap();
    let signature = Signature::from_slice(&b64(&restored.sign(&canonical))).unwrap();
    verifier.verify(canonical.as_bytes(), &signature).unwrap();

    assert_eq!(
        RequestSigner::from_pkcs8_der(b"not a key").err(),
        Some(SigningError::InvalidKey)
    );
}

#[test]
fn client_app_052_canonical_string_matches_contract_014() {
    assert_eq!(
        canonical_string(
            "post",
            "/api/tasks",
            1767225600,
            "AAAAAAAAAAAAAAAAAAAAAA",
            None
        )
        .unwrap(),
        "POST\n/api/tasks\n1767225600\nAAAAAAAAAAAAAAAAAAAAAA\n"
    );
    assert_eq!(
        canonical_string("PUT", "/api/x", 1, "n", Some("sha-256=:abc=:")).unwrap(),
        "PUT\n/api/x\n1\nn\nsha-256=:abc=:"
    );
    for (path, nonce, digest) in [
        ("/api/x\n/api/y", "n", None),
        ("/api/x", "n\nn", None),
        ("/api/x", "n", Some("a\nb")),
    ] {
        assert_eq!(
            canonical_string("GET", path, 1, nonce, digest),
            Err(SigningError::NewlineInValue)
        );
    }
    assert_eq!(
        canonical_string("GE\nT", "/api/x", 1, "n", None),
        Err(SigningError::NewlineInValue)
    );
}
