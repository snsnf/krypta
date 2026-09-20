//! Vault recovery: the emailed code, the printed recovery code, TOTP when
//! enrolled, and the containment boundary around the session recovery mints.
//!
//! The property the whole design turns on is that recovery *re-wraps* the
//! account key rather than replacing it, so nothing already encrypted has to
//! move. `an_existing_form_is_untouched_by_recovery` pins the server-visible
//! half of that; the browser half (the wrapper still opens) can only be proved
//! where the crypto runs.

mod common;

use reqwest::Client;
use serde_json::json;
use uuid::Uuid;

const PASSWORD: &str = "correct horse battery staple";
const NEW_PASSWORD: &str = "a different correct horse";

fn base() -> String {
    common::base_url()
}

async fn register(email: &str) -> (Client, common::TestAccount) {
    let client = Client::builder().cookie_store(true).build().unwrap();
    let account = common::register_test_account(&base(), &client, email, PASSWORD).await;
    (client, account)
}

/// Everything the browser produces once it has opened the account key with the
/// printed recovery code: the same key, re-wrapped under a new password and a
/// newly generated recovery code, plus the two verifiers for those.
///
/// All four values are new. Reusing the old recovery verifier here would make
/// "the spent code no longer works" vacuously false, because the code being
/// installed would be the one just spent.
struct Rotation {
    account: common::TestAccount,
    wrapped_password: String,
    recovery_verifier: String,
    wrapped_recovery: String,
}

fn rotation(account: &common::TestAccount, new_password: &str) -> Rotation {
    Rotation {
        account: account.rotated(new_password),
        wrapped_password: common::opaque_wrapped_account_key(),
        recovery_verifier: common::opaque_verifier(),
        wrapped_recovery: common::opaque_wrapped_account_key(),
    }
}

fn completion_body(rotation: &Rotation) -> serde_json::Value {
    json!({
        "new_password_verifier": rotation.account.verifier,
        "wrapped_account_key_password": rotation.wrapped_password,
        "new_recovery_verifier": rotation.recovery_verifier,
        "wrapped_account_key_recovery": rotation.wrapped_recovery,
    })
}

async fn login_status(email: &str, verifier: &str) -> reqwest::StatusCode {
    Client::new()
        .post(format!("{}/api/v1/auth/login", base()))
        .json(&json!({ "email": email, "verifier": verifier }))
        .send()
        .await
        .unwrap()
        .status()
}

/// Presents `token` as the session cookie on a client of its own, so a test
/// never accidentally authenticates with a jar it filled earlier.
fn client_with_session(token: &str) -> (Client, String) {
    (
        Client::builder().build().unwrap(),
        format!("__Host-session={token}"),
    )
}

#[tokio::test]
async fn recovery_rotates_the_password_and_the_code() {
    let email = format!("recover-rotate-{}@example.com", Uuid::now_v7());
    let (_client, account) = register(&email).await;

    let session = common::recovery_session_for(&base(), &account, None).await;

    // A new password and a new recovery code, both wrapping the same account
    // key the browser just opened. The account key itself does not change.
    let next = rotation(&account, NEW_PASSWORD);
    let (client, cookie) = client_with_session(&session);
    let completed = client
        .post(format!("{}/api/v1/auth/recover/complete", base()))
        .header("Cookie", &cookie)
        .json(&completion_body(&next))
        .send()
        .await
        .unwrap();
    assert_eq!(completed.status(), 200);

    assert_eq!(login_status(&email, &next.account.verifier).await, 200);
    assert_eq!(login_status(&email, &account.verifier).await, 401);

    // The recovery session is revoked by the generation bump, so it cannot be
    // replayed to complete a second time.
    let replayed = client
        .post(format!("{}/api/v1/auth/recover/complete", base()))
        .header("Cookie", &cookie)
        .json(&completion_body(&next))
        .send()
        .await
        .unwrap();
    assert_eq!(replayed.status(), 401);

    // And the spent recovery code no longer verifies, even with a fresh
    // emailed code, while the one that replaced it does.
    let (status, pending_token) = common::recover_start(&base(), &email).await;
    assert_eq!(status, 200);
    let code = common::latest_code_for(&email).await;
    let rejected = common::recover_verify(
        &base(),
        &Client::new(),
        &pending_token,
        &code,
        &account.recovery_verifier,
        None,
    )
    .await;
    assert_eq!(rejected.status(), 401);

    let (status, pending_token) = common::recover_start(&base(), &email).await;
    assert_eq!(status, 200);
    let code = common::latest_code_for(&email).await;
    let accepted = common::recover_verify(
        &base(),
        &Client::new(),
        &pending_token,
        &code,
        &next.recovery_verifier,
        None,
    )
    .await;
    assert_eq!(accepted.status(), 200);
    let body: serde_json::Value = accepted.json().await.unwrap();
    assert_eq!(
        body["data"]["wrapped_account_key"].as_str(),
        Some(next.wrapped_recovery.as_str()),
        "recovery must hand back the wrapper the new code opens",
    );
}

/// The whole point of the account-key indirection: recovery re-wraps a key it
/// never sees, so every row that was encrypted under it is left alone. If any
/// of these bytes moved, the browser's key hierarchy would have been silently
/// invalidated.
#[tokio::test]
async fn an_existing_form_is_untouched_by_recovery() {
    let email = format!("recover-form-{}@example.com", Uuid::now_v7());
    let (client, account) = register(&email).await;

    let created: serde_json::Value = client
        .post(format!("{}/api/v1/forms", base()))
        .json(&json!({
            "title_ciphertext": "title-ciphertext-before-recovery",
            "schema_ciphertext": "schema-ciphertext-before-recovery",
            "form_public_key": "form-public-key",
            "wrapped_form_private_key": "wrapped-form-private-key",
            "wrapped_form_data_key": "wrapped-form-data-key",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let form_id = created["data"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("form creation returned no id: {created}"))
        .to_string();

    let session = common::recovery_session_for(&base(), &account, None).await;
    let next = rotation(&account, NEW_PASSWORD);
    let (recovery_client, cookie) = client_with_session(&session);
    assert_eq!(
        recovery_client
            .post(format!("{}/api/v1/auth/recover/complete", base()))
            .header("Cookie", &cookie)
            .json(&completion_body(&next))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    // Sign in under the new password and read the form back.
    let after = Client::builder().cookie_store(true).build().unwrap();
    let login: serde_json::Value = after
        .post(format!("{}/api/v1/auth/login", base()))
        .json(&json!({ "email": email, "verifier": next.account.verifier }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        login["data"]["wrapped_account_key"].as_str(),
        Some(next.wrapped_password.as_str()),
        "login must hand back the wrapper recovery stored",
    );

    let form: serde_json::Value = after
        .get(format!("{}/api/v1/forms/{form_id}", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        form["data"]["title_ciphertext"].as_str(),
        Some("title-ciphertext-before-recovery"),
    );
    assert_eq!(
        form["data"]["encrypted_form_data_key"].as_str(),
        Some("wrapped-form-data-key"),
        "the form data key must still be wrapped under the same account key",
    );
    assert_eq!(
        form["data"]["encrypted_form_private_key"].as_str(),
        Some("wrapped-form-private-key"),
    );
}

#[tokio::test]
async fn an_unknown_email_is_indistinguishable() {
    let known = format!("recover-known-{}@example.com", Uuid::now_v7());
    register(&known).await;
    let unknown = format!("recover-nobody-{}@example.com", Uuid::now_v7());

    let (known_status, known_token) = common::recover_start(&base(), &known).await;
    let (unknown_status, unknown_token) = common::recover_start(&base(), &unknown).await;

    assert_eq!(known_status, unknown_status);
    assert_eq!(known_status, 200);
    assert!(
        !unknown_token.is_empty(),
        "the decoy must carry a handle too"
    );

    // The decoy handle can never be redeemed, whatever code is presented.
    let response = common::recover_verify(
        &base(),
        &Client::new(),
        &unknown_token,
        "000000",
        &common::opaque_verifier(),
        None,
    )
    .await;
    assert_eq!(response.status(), 401);
    assert_ne!(known_token, unknown_token);
}

#[tokio::test]
async fn a_wrong_email_code_is_capped() {
    let email = format!("recover-cap-{}@example.com", Uuid::now_v7());
    let (_client, account) = register(&email).await;

    let (status, pending_token) = common::recover_start(&base(), &email).await;
    assert_eq!(status, 200);
    let code = common::latest_code_for(&email).await;
    let wrong = if code == "000000" { "111111" } else { "000000" };

    for _ in 0..5 {
        let response = common::recover_verify(
            &base(),
            &Client::new(),
            &pending_token,
            wrong,
            &account.recovery_verifier,
            None,
        )
        .await;
        assert_eq!(response.status(), 401);
    }

    // The handle is destroyed once the cap is reached, so even the real code
    // no longer redeems it.
    let response = common::recover_verify(
        &base(),
        &Client::new(),
        &pending_token,
        &code,
        &account.recovery_verifier,
        None,
    )
    .await;
    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn a_wrong_recovery_verifier_is_rejected() {
    let email = format!("recover-wrong-code-{}@example.com", Uuid::now_v7());
    register(&email).await;

    let (status, pending_token) = common::recover_start(&base(), &email).await;
    assert_eq!(status, 200);
    let code = common::latest_code_for(&email).await;

    let response = common::recover_verify(
        &base(),
        &Client::new(),
        &pending_token,
        &code,
        &common::opaque_verifier(),
        None,
    )
    .await;

    assert_eq!(response.status(), 401);
    assert!(
        common::session_cookie_value(&response).is_none(),
        "a rejected recovery must mint no session"
    );
}

/// A mistyped recovery code must not burn the emailed code: the user is
/// transcribing 32 characters from paper, and a fresh mail round trip per typo
/// is the wrong trade. The 6-digit code is the only low-entropy secret here and
/// it keeps its own attempt cap.
#[tokio::test]
async fn a_mistyped_recovery_code_can_be_retried_on_the_same_handle() {
    let email = format!("recover-retry-{}@example.com", Uuid::now_v7());
    let (_client, account) = register(&email).await;

    let (status, pending_token) = common::recover_start(&base(), &email).await;
    assert_eq!(status, 200);
    let code = common::latest_code_for(&email).await;

    for _ in 0..3 {
        let response = common::recover_verify(
            &base(),
            &Client::new(),
            &pending_token,
            &code,
            &common::opaque_verifier(),
            None,
        )
        .await;
        assert_eq!(response.status(), 401);
    }

    let response = common::recover_verify(
        &base(),
        &Client::new(),
        &pending_token,
        &code,
        &account.recovery_verifier,
        None,
    )
    .await;
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn totp_is_required_when_enrolled() {
    let email = format!("recover-totp-{}@example.com", Uuid::now_v7());
    let (client, account) = register(&email).await;
    let totp = common::enrol_totp(&base(), &client).await;

    let (status, pending_token) = common::recover_start(&base(), &email).await;
    assert_eq!(status, 200);
    let code = common::latest_code_for(&email).await;

    let without = common::recover_verify(
        &base(),
        &Client::new(),
        &pending_token,
        &code,
        &account.recovery_verifier,
        None,
    )
    .await;
    assert_eq!(
        without.status(),
        401,
        "every factor is required when TOTP is enrolled"
    );

    let with = common::recover_verify(
        &base(),
        &Client::new(),
        &pending_token,
        &code,
        &account.recovery_verifier,
        Some(common::code_from_next_step(&totp).await),
    )
    .await;
    assert_eq!(with.status(), 200);
}

/// A recovery-scoped session must not be usable as a general-purpose
/// session: it should be rejected on ordinary authenticated routes exactly
/// like no session at all (a generic 401, not a distinct error naming the
/// scope, which would tell an attacker what kind of handle they hold).
#[tokio::test]
async fn a_recovery_session_cannot_read_anything() {
    let email = format!("recovery-{}@example.com", Uuid::now_v7());
    let (_client, account) = register(&email).await;

    let recovery_token = common::recovery_session_for(&base(), &account, None).await;
    let (probe, cookie) = client_with_session(&recovery_token);

    for path in ["/api/v1/auth/me", "/api/v1/forms"] {
        let response = probe
            .get(format!("{}{path}", base()))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            401,
            "a recovery-scoped session must not reach {path}"
        );
    }
}

/// The mirror image: an ordinary session must not reach
/// `/auth/recover/complete`. The 401 has to come from the extractor rejecting
/// the scope, which is only meaningful now that the route exists: a 404 from
/// a missing route would look identical and prove nothing.
#[tokio::test]
async fn a_full_session_cannot_complete_a_recovery() {
    let email = format!("recovery-full-{}@example.com", Uuid::now_v7());
    let (client, account) = register(&email).await;

    let response = client
        .post(format!("{}/api/v1/auth/recover/complete", base()))
        .json(&completion_body(&rotation(&account, NEW_PASSWORD)))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 401);

    // An unmounted route would have answered 404 above, so that 401 is the
    // extractor rejecting the scope. No session at all is refused the same
    // way, which is what makes the two indistinguishable to a caller.
    let unauthenticated = Client::new()
        .post(format!("{}/api/v1/auth/recover/complete", base()))
        .json(&completion_body(&rotation(&account, NEW_PASSWORD)))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), 401);

    // Nothing was rotated by the refused request.
    assert_eq!(login_status(&email, &account.verifier).await, 200);
}
