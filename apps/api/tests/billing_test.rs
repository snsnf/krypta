mod common;

use hmac::{Hmac, Mac};
use reqwest::Client;
use serde_json::json;
use sha2::Sha256;

const PASSWORD: &str = "correct horse battery staple";

/// Reproduces the `Stripe-Signature` header Stripe itself computes, the same
/// way `apps/api/src/billing/stripe.rs`'s own unit tests do, so this suite
/// needs no real Stripe account: only the `STRIPE_WEBHOOK_SECRET` the server
/// was started with.
fn sign_webhook_payload(payload: &str, secret: &str, timestamp: i64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(format!("{timestamp}.").as_bytes());
    mac.update(payload.as_bytes());
    format!(
        "t={timestamp},v1={}",
        hex::encode(mac.finalize().into_bytes())
    )
}

/// A free account past its allowance must stop collecting, and the respondent
/// must learn nothing about why: the same closed-form shape any other limit
/// produces.
#[tokio::test]
async fn a_free_account_past_its_allowance_stops_collecting_without_saying_why() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("billing-cap-{}@example.com", uuid::Uuid::now_v7());
    let account = common::register_test_account(&base, &client, &email, PASSWORD).await;

    dotenvy::dotenv().ok();
    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();

    // Park the account at its limit directly rather than submitting 250 times.
    sqlx::query(
        "INSERT INTO response_usage (user_id, period_start, response_count)
         VALUES ($1, date_trunc('month', now()), 250)
         ON CONFLICT (user_id, period_start) DO UPDATE SET response_count = 250",
    )
    .bind(account.user_id)
    .execute(&db)
    .await
    .unwrap();

    let form: serde_json::Value = client
        .post(format!("{base}/api/v1/forms"))
        .json(&json!({
            "title_ciphertext": "t",
            "schema_ciphertext": "s",
            "form_public_key": "k",
            "wrapped_form_data_key": "d",
            "wrapped_form_private_key": "p"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let form_id = form["data"]["id"].as_str().unwrap().to_string();

    let public: serde_json::Value = reqwest::Client::new()
        .get(format!("{base}/api/v1/forms/{form_id}/public"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        public["data"]["accepting_responses"], false,
        "a form on an account past its allowance must present as closed"
    );

    let submitted = reqwest::Client::new()
        .post(format!("{base}/api/v1/forms/{form_id}/responses"))
        .json(&json!({ "ciphertext": "a" }))
        .send()
        .await
        .unwrap();
    let status = submitted.status();
    let body: serde_json::Value = submitted.json().await.unwrap();
    assert_eq!(status, 409);
    assert_eq!(
        body["error"]["code"], "form_closed",
        "the respondent must see the ordinary closed-form error, not a billing one"
    );
}

/// Webhooks are authenticated by signature alone, so an unsigned request must
/// change nothing.
#[tokio::test]
async fn an_unsigned_webhook_is_refused() {
    let base = common::base_url();
    let res = Client::new()
        .post(format!("{base}/api/v1/billing/webhook"))
        .header("content-type", "application/json")
        .body(r#"{"id":"evt_forged","type":"customer.subscription.updated"}"#)
        .send()
        .await
        .unwrap();
    assert!(
        res.status().is_client_error(),
        "an unsigned webhook must be refused"
    );
}

/// Subscription state is readable by its owner and by nobody else.
#[tokio::test]
async fn the_subscription_endpoint_requires_a_session() {
    let base = common::base_url();
    let res = Client::new()
        .get(format!("{base}/api/v1/billing/subscription"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

/// A free account reports the free plan and its real usage, so the UI can show
/// a meter without a second round trip.
#[tokio::test]
async fn a_new_account_reports_the_free_plan_and_zero_usage() {
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("billing-plan-{}@example.com", uuid::Uuid::now_v7());
    common::register_test_account(&base, &client, &email, PASSWORD).await;

    let body: serde_json::Value = client
        .get(format!("{base}/api/v1/billing/subscription"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(body["data"]["plan_id"], "free");
    assert_eq!(body["data"]["responses_used"], 0);
    assert_eq!(body["data"]["max_responses_per_period"], 250);
}

/// A paid plan's form and response numbers exist to bound abuse, not to be
/// reached, and the pricing page calls them unlimited. The endpoint says so
/// with `responses_metered` / `forms_metered` rather than leaving the panel
/// to infer it from the plan name, because an `account_quotas` override that
/// genuinely lowers an allowance must still be shown as a meter: this test
/// covers both halves of that, since only the second one can make the word
/// "unlimited" a lie.
#[tokio::test]
async fn a_paid_plan_reports_its_fair_use_ceilings_as_unmetered() {
    dotenvy::dotenv().ok();
    let base = common::base_url();
    let client = Client::builder().cookie_store(true).build().unwrap();
    let email = format!("billing-ceiling-{}@example.com", uuid::Uuid::now_v7());
    common::register_test_account(&base, &client, &email, PASSWORD).await;

    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let user_id: uuid::Uuid = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(&email)
        .fetch_one(&db)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO subscriptions (user_id, plan_id, stripe_customer_id, status)
         VALUES ($1, 'pro', $2, 'active')",
    )
    .bind(user_id)
    .bind(format!("cus_ceiling_{user_id}"))
    .execute(&db)
    .await
    .unwrap();

    let body: serde_json::Value = client
        .get(format!("{base}/api/v1/billing/subscription"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(body["data"]["plan_id"], "pro");
    assert_eq!(body["data"]["responses_metered"], false);
    assert_eq!(body["data"]["forms_metered"], false);
    // The numbers themselves stay on the wire and stay true. Only the
    // presentation changes, so nothing here pretends the ceiling is absent.
    assert_eq!(body["data"]["max_responses_per_period"], 100000);
    assert_eq!(body["data"]["max_open_forms"], 1000);

    // An admin override below the plan's ceiling is a real restriction the
    // account will actually meet, so it goes back to being metered.
    sqlx::query("INSERT INTO account_quotas (user_id, max_responses) VALUES ($1, 50)")
        .bind(user_id)
        .execute(&db)
        .await
        .unwrap();

    let body: serde_json::Value = client
        .get(format!("{base}/api/v1/billing/subscription"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(body["data"]["responses_metered"], true);
    assert_eq!(body["data"]["max_responses_per_period"], 50);
    assert_eq!(
        body["data"]["forms_metered"], false,
        "an override on one allowance must not re-meter the other"
    );
}

/// A replayed webhook event must be processed at most once. This is the test
/// the atomic marker-plus-handler transaction and the out-of-order-delivery
/// retry exist for: the second delivery must genuinely change nothing, not
/// merely return 200.
#[tokio::test]
async fn a_replayed_webhook_event_is_processed_at_most_once() {
    dotenvy::dotenv().ok();
    let secret = std::env::var("STRIPE_WEBHOOK_SECRET")
        .expect("STRIPE_WEBHOOK_SECRET must be set for this test, same as the running server");
    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();

    let user_id = uuid::Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'webhook-replay-test')",
    )
    .bind(user_id)
    .bind(format!("webhook-replay-{user_id}@example.com"))
    .execute(&db)
    .await
    .unwrap();

    let event_id = format!("evt_replay_{}", uuid::Uuid::now_v7());
    let customer_id = format!("cus_replay_{}", uuid::Uuid::now_v7());
    let subscription_id = format!("sub_replay_{}", uuid::Uuid::now_v7());

    // Structurally complete `checkout.session.completed` payload: the fixed
    // fields below (automatic_tax, custom_fields, custom_text, expires_at,
    // mode, payment_method_types, payment_status, shipping_options) are the
    // ones `CheckoutSession` requires beyond identifiers; every other field
    // on it is `Option<T>`, which the parser treats as absent when missing.
    // See the identical comment on `payload()` in `src/billing/stripe.rs`.
    let payload = json!({
        "id": event_id,
        "object": "event",
        "type": "checkout.session.completed",
        "api_version": "2020-08-27",
        "created": 1,
        "livemode": false,
        "pending_webhooks": 0,
        "request": null,
        "data": {
            "object": {
                "id": "cs_replay_test",
                "object": "checkout.session",
                "automatic_tax": { "enabled": false },
                "created": 1,
                "custom_fields": [],
                "custom_text": {},
                "expires_at": 1,
                "livemode": false,
                "mode": "payment",
                "payment_method_types": [],
                "payment_status": "paid",
                "shipping_options": [],
                "client_reference_id": user_id.to_string(),
                "customer": customer_id,
                "subscription": subscription_id,
                "metadata": { "plan_id": "pro" }
            }
        }
    })
    .to_string();

    let timestamp = time::OffsetDateTime::now_utc().unix_timestamp();
    let signature = sign_webhook_payload(&payload, &secret, timestamp);

    let base = common::base_url();
    let client = Client::new();

    let first = client
        .post(format!("{base}/api/v1/billing/webhook"))
        .header("content-type", "application/json")
        .header("stripe-signature", &signature)
        .body(payload.clone())
        .send()
        .await
        .unwrap();
    assert!(
        first.status().is_success(),
        "a correctly signed event must be accepted"
    );

    let row = sqlx::query!(
        "SELECT plan_id, stripe_customer_id, status, updated_at FROM subscriptions WHERE user_id = $1",
        user_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(row.plan_id, "pro");
    assert_eq!(row.stripe_customer_id, customer_id);
    assert_eq!(row.status, "active");

    // `updated_at` is the discriminating assertion below, not the values
    // above: `handle_checkout_completed`'s upsert is idempotent and would
    // write the exact same `plan_id`/`stripe_customer_id`/`status` on a
    // second, genuine run, so checking only those would pass whether or not
    // the event was actually reprocessed. A second run does, however, set
    // `updated_at = now()` again, which a real wall clock always advances
    // between two separate HTTP round trips. Capturing it here and asserting
    // it is unchanged after the replay is what actually proves the handler
    // did not run twice, and `processed_stripe_events` holding exactly one
    // row (checked below) is the same guarantee from the marker's own side.
    let updated_at_after_first = row.updated_at;

    // Stripe retries on any non-2xx, so the replay must still be
    // acknowledged, but it must not reprocess: this is the exact scenario
    // finding 1 (transaction atomicity) and finding 2 (out-of-order
    // handling) both bear on.
    let second = client
        .post(format!("{base}/api/v1/billing/webhook"))
        .header("content-type", "application/json")
        .header("stripe-signature", &signature)
        .body(payload)
        .send()
        .await
        .unwrap();
    assert!(
        second.status().is_success(),
        "a replayed event must still be acknowledged, not treated as a forgery"
    );

    let processed_count = sqlx::query_scalar!(
        "SELECT count(*) AS \"count!\" FROM processed_stripe_events WHERE id = $1",
        event_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        processed_count, 1,
        "a replayed event must be recorded exactly once in the marker table"
    );

    let row_after_replay = sqlx::query!(
        "SELECT plan_id, stripe_customer_id, status, updated_at FROM subscriptions WHERE user_id = $1",
        user_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(row_after_replay.plan_id, "pro");
    assert_eq!(row_after_replay.stripe_customer_id, customer_id);
    assert_eq!(row_after_replay.status, "active");
    assert_eq!(
        row_after_replay.updated_at, updated_at_after_first,
        "a replayed event must not touch the row a second time: if the \
         idempotency short-circuit were missing, the handler would run again \
         and stamp a new updated_at"
    );

    sqlx::query("DELETE FROM subscriptions WHERE user_id = $1")
        .bind(user_id)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&db)
        .await
        .unwrap();
}

/// Builds a signed `customer.subscription.*` event body.
///
/// The fixed fields are the ones `stripe_shared::Subscription` requires
/// beyond identifiers; every other field on it is `Option<T>`, which the
/// parser treats as absent when missing. The same reasoning as the
/// `CheckoutSession` fixture above.
fn subscription_event(
    event_id: &str,
    event_type: &str,
    customer_id: &str,
    subscription_id: &str,
    status: &str,
) -> String {
    // Built in pieces rather than one literal: `json!` hits serde_json's
    // macro recursion limit on a structure this deep.
    let price = json!({
        "id": "price_unknown_to_this_instance",
        "object": "price",
        "active": true,
        "billing_scheme": "per_unit",
        "created": 1,
        "currency": "usd",
        "livemode": false,
        "metadata": {},
        "product": "prod_test",
        "type": "recurring"
    });
    let plan = json!({
        "id": "plan_test",
        "object": "plan",
        "active": true,
        "amount": 1200,
        "billing_scheme": "per_unit",
        "created": 1,
        "currency": "usd",
        "interval": "month",
        "interval_count": 1,
        "livemode": false,
        "metadata": {},
        "product": "prod_test",
        "usage_type": "licensed"
    });
    let item = json!({
        "id": "si_test",
        "object": "subscription_item",
        "created": 1,
        "current_period_start": 1,
        "current_period_end": 2,
        "metadata": {},
        "quantity": 1,
        "subscription": subscription_id,
        "discounts": [],
        "plan": plan,
        "price": price
    });
    let items = json!({
        "object": "list",
        "has_more": false,
        "url": "/v1/subscription_items",
        "data": [item]
    });
    let subscription = json!({
        "id": subscription_id,
        "object": "subscription",
        "customer": customer_id,
        "status": status,
        "created": 1,
        "currency": "usd",
        "cancel_at_period_end": false,
        "collection_method": "charge_automatically",
        "livemode": false,
        "metadata": {},
        "start_date": 1,
        "billing_cycle_anchor": 1,
        "billing_mode": { "type": "classic" },
        "billing_schedules": [],
        "discounts": [],
        "automatic_tax": { "enabled": false },
        "payment_settings": {},
        "invoice_settings": { "issuer": { "type": "self" } },
        "items": items
    });
    json!({
        "id": event_id,
        "object": "event",
        "type": event_type,
        "api_version": "2020-08-27",
        "created": 1,
        "livemode": false,
        "pending_webhooks": 0,
        "request": null,
        "data": { "object": subscription }
    })
    .to_string()
}

/// The stale-subscription regression.
///
/// One Stripe customer can hold several subscriptions over time. Matched by
/// `stripe_customer_id` alone, an old subscription's terminal
/// `customer.subscription.deleted`, which fires at the end of its paid period
/// long after the account resubscribed, would set `plan_id = 'free'` on
/// someone who is currently paying, and nothing would ever correct it.
///
/// The first half of this test is not decoration: an unparseable event is
/// deliberately acknowledged with a 2xx and changes nothing, which is exactly
/// what a correctly ignored stale event looks like. Proving the same payload
/// shape DOES apply when the subscription id matches is what stops the second
/// half from passing for the wrong reason.
#[tokio::test]
async fn an_event_for_a_replaced_subscription_does_not_downgrade_the_current_one() {
    dotenvy::dotenv().ok();
    let secret = std::env::var("STRIPE_WEBHOOK_SECRET")
        .expect("STRIPE_WEBHOOK_SECRET must be set for this test, same as the running server");
    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();

    let user_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'stale-sub-test')")
        .bind(user_id)
        .bind(format!("stale-sub-{user_id}@example.com"))
        .execute(&db)
        .await
        .unwrap();

    let customer_id = format!("cus_stale_{}", uuid::Uuid::now_v7());
    let current_subscription = format!("sub_current_{}", uuid::Uuid::now_v7());
    let replaced_subscription = format!("sub_replaced_{}", uuid::Uuid::now_v7());

    sqlx::query(
        "INSERT INTO subscriptions (
             user_id, plan_id, stripe_customer_id, stripe_subscription_id, status
         ) VALUES ($1, 'pro', $2, $3, 'active')",
    )
    .bind(user_id)
    .bind(&customer_id)
    .bind(&current_subscription)
    .execute(&db)
    .await
    .unwrap();

    let base = common::base_url();
    let client = Client::new();
    let send = |payload: String| {
        let client = client.clone();
        let base = base.clone();
        let secret = secret.clone();
        async move {
            let timestamp = time::OffsetDateTime::now_utc().unix_timestamp();
            let signature = sign_webhook_payload(&payload, &secret, timestamp);
            client
                .post(format!("{base}/api/v1/billing/webhook"))
                .header("content-type", "application/json")
                .header("stripe-signature", &signature)
                .body(payload)
                .send()
                .await
                .unwrap()
        }
    };

    // The control: an event for the CURRENT subscription must apply, which is
    // what proves this fixture parses at all.
    let applied = send(subscription_event(
        &format!("evt_current_{}", uuid::Uuid::now_v7()),
        "customer.subscription.updated",
        &customer_id,
        &current_subscription,
        "past_due",
    ))
    .await;
    assert!(applied.status().is_success());
    let status = sqlx::query_scalar!(
        "SELECT status FROM subscriptions WHERE user_id = $1",
        user_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        status, "past_due",
        "an event for the current subscription must apply: if this fails the \
         fixture no longer parses and the rest of this test proves nothing"
    );

    // The regression: the replaced subscription's terminal event must not
    // touch the row, and must still be acknowledged so Stripe stops retrying.
    let ignored = send(subscription_event(
        &format!("evt_stale_{}", uuid::Uuid::now_v7()),
        "customer.subscription.deleted",
        &customer_id,
        &replaced_subscription,
        "canceled",
    ))
    .await;
    assert!(
        ignored.status().is_success(),
        "an event for a subscription this account no longer holds must be \
         acknowledged, not retried forever"
    );

    let row = sqlx::query!(
        "SELECT plan_id, stripe_subscription_id FROM subscriptions WHERE user_id = $1",
        user_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        row.plan_id, "pro",
        "a replaced subscription's deletion must not downgrade the current one"
    );
    assert_eq!(
        row.stripe_subscription_id.as_deref(),
        Some(current_subscription.as_str())
    );

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&db)
        .await
        .unwrap();
}

/// A subscription paid for at checkout is active from birth, so Stripe sends
/// `customer.subscription.created` for it and never an `.updated`. The row
/// `checkout.session.completed` wrote holds a placeholder status and no period
/// end, and `.created` is the only event that ever fills them in.
#[tokio::test]
async fn a_created_event_fills_in_what_checkout_could_not() {
    dotenvy::dotenv().ok();
    let secret = std::env::var("STRIPE_WEBHOOK_SECRET")
        .expect("STRIPE_WEBHOOK_SECRET must be set for this test, same as the running server");
    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();

    let user_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'created-sub-test')")
        .bind(user_id)
        .bind(format!("created-sub-{user_id}@example.com"))
        .execute(&db)
        .await
        .unwrap();

    let customer_id = format!("cus_created_{}", uuid::Uuid::now_v7());
    let subscription_id = format!("sub_created_{}", uuid::Uuid::now_v7());

    // Exactly what checkout leaves behind: the plan and ids, a placeholder
    // status, and no period end.
    sqlx::query(
        "INSERT INTO subscriptions (
             user_id, plan_id, stripe_customer_id, stripe_subscription_id, status
         ) VALUES ($1, 'pro', $2, $3, 'active')",
    )
    .bind(user_id)
    .bind(&customer_id)
    .bind(&subscription_id)
    .execute(&db)
    .await
    .unwrap();

    let payload = subscription_event(
        &format!("evt_created_{}", uuid::Uuid::now_v7()),
        "customer.subscription.created",
        &customer_id,
        &subscription_id,
        "active",
    );
    let timestamp = time::OffsetDateTime::now_utc().unix_timestamp();
    let response = Client::new()
        .post(format!("{}/api/v1/billing/webhook", common::base_url()))
        .header("content-type", "application/json")
        .header(
            "stripe-signature",
            sign_webhook_payload(&payload, &secret, timestamp),
        )
        .body(payload)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());

    let period_end = sqlx::query_scalar!(
        "SELECT current_period_end FROM subscriptions WHERE user_id = $1",
        user_id,
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        period_end,
        Some(time::OffsetDateTime::from_unix_timestamp(2).unwrap()),
        "customer.subscription.created must record the period end from the \
         subscription item, or a card-paid subscription never gets one"
    );

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&db)
        .await
        .unwrap();
}

/// The returning-subscriber regression.
///
/// Checkout reuses a returning subscriber's stored customer, so until the new
/// subscription's `checkout.session.completed` lands, the row still names the
/// old, finished subscription. An event for the new subscription that arrives
/// first matches no row while a row for the customer exists. It must fail so
/// Stripe retries it once checkout has recorded the new id, not be
/// acknowledged: a `customer.subscription.deleted` dropped here would let the
/// later checkout grant a paid plan with no live subscription behind it.
#[tokio::test]
async fn an_event_that_outruns_a_returning_subscribers_checkout_is_retried() {
    dotenvy::dotenv().ok();
    let secret = std::env::var("STRIPE_WEBHOOK_SECRET")
        .expect("STRIPE_WEBHOOK_SECRET must be set for this test, same as the running server");
    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();

    let user_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'returning-test')")
        .bind(user_id)
        .bind(format!("returning-sub-{user_id}@example.com"))
        .execute(&db)
        .await
        .unwrap();
    let customer_id = format!("cus_returning_{}", uuid::Uuid::now_v7());
    let finished_subscription = format!("sub_finished_{}", uuid::Uuid::now_v7());
    let new_subscription = format!("sub_new_{}", uuid::Uuid::now_v7());
    sqlx::query(
        "INSERT INTO subscriptions (
             user_id, plan_id, stripe_customer_id, stripe_subscription_id, status
         ) VALUES ($1, 'free', $2, $3, 'canceled')",
    )
    .bind(user_id)
    .bind(&customer_id)
    .bind(&finished_subscription)
    .execute(&db)
    .await
    .unwrap();

    let event_id = format!("evt_early_{}", uuid::Uuid::now_v7());
    let payload = subscription_event(
        &event_id,
        "customer.subscription.deleted",
        &customer_id,
        &new_subscription,
        "canceled",
    );
    let timestamp = time::OffsetDateTime::now_utc().unix_timestamp();
    let response = Client::new()
        .post(format!("{}/api/v1/billing/webhook", common::base_url()))
        .header("content-type", "application/json")
        .header(
            "stripe-signature",
            sign_webhook_payload(&payload, &secret, timestamp),
        )
        .body(payload)
        .send()
        .await
        .unwrap();
    assert!(
        !response.status().is_success(),
        "an event for a subscription checkout has not recorded yet must be retried"
    );
    let marked = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM processed_stripe_events WHERE id = $1)",
    )
    .bind(&event_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(
        !marked,
        "the idempotency marker must roll back with the failure"
    );

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&db)
        .await
        .unwrap();
}

fn checkout_completed_payload(event_id: &str, session_id: &str, user_id: uuid::Uuid) -> String {
    json!({
        "id": event_id,
        "object": "event",
        "type": "checkout.session.completed",
        "api_version": "2020-08-27",
        "created": 1,
        "livemode": false,
        "pending_webhooks": 0,
        "request": null,
        "data": {
            "object": {
                "id": session_id,
                "object": "checkout.session",
                "automatic_tax": { "enabled": false },
                "created": 1,
                "custom_fields": [],
                "custom_text": {},
                "expires_at": 1,
                "livemode": false,
                "mode": "subscription",
                "payment_method_types": [],
                "payment_status": "paid",
                "shipping_options": [],
                "client_reference_id": user_id.to_string(),
                "customer": format!("cus_pending_{}", uuid::Uuid::now_v7()),
                "subscription": format!("sub_pending_{}", uuid::Uuid::now_v7()),
                "metadata": { "plan_id": "pro" }
            }
        }
    })
    .to_string()
}

/// A completed checkout releases the account's claim on an open session, and
/// only when it is the session that claim names: a late completion for a
/// session a newer checkout replaced must leave the newer claim in place.
#[tokio::test]
async fn a_completed_checkout_releases_only_its_own_pending_claim() {
    dotenvy::dotenv().ok();
    let secret = std::env::var("STRIPE_WEBHOOK_SECRET")
        .expect("STRIPE_WEBHOOK_SECRET must be set for this test, same as the running server");
    let db = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let user_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'pending-test')")
        .bind(user_id)
        .bind(format!("pending-checkout-{user_id}@example.com"))
        .execute(&db)
        .await
        .unwrap();
    let current = format!("cs_current_{}", uuid::Uuid::now_v7());
    sqlx::query("INSERT INTO pending_checkouts (user_id, stripe_session_id) VALUES ($1, $2)")
        .bind(user_id)
        .bind(&current)
        .execute(&db)
        .await
        .unwrap();

    let send = |payload: String| {
        let secret = secret.clone();
        async move {
            let timestamp = time::OffsetDateTime::now_utc().unix_timestamp();
            Client::new()
                .post(format!("{}/api/v1/billing/webhook", common::base_url()))
                .header("content-type", "application/json")
                .header(
                    "stripe-signature",
                    sign_webhook_payload(&payload, &secret, timestamp),
                )
                .body(payload)
                .send()
                .await
                .unwrap()
        }
    };
    let claim = || async {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT stripe_session_id FROM pending_checkouts WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_optional(&db)
        .await
        .unwrap()
    };

    let stale = send(checkout_completed_payload(
        &format!("evt_stale_cs_{}", uuid::Uuid::now_v7()),
        &format!("cs_replaced_{}", uuid::Uuid::now_v7()),
        user_id,
    ))
    .await;
    assert!(stale.status().is_success());
    assert_eq!(claim().await, Some(Some(current.clone())));

    let done = send(checkout_completed_payload(
        &format!("evt_current_cs_{}", uuid::Uuid::now_v7()),
        &current,
        user_id,
    ))
    .await;
    assert!(done.status().is_success());
    assert_eq!(claim().await, None);

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&db)
        .await
        .unwrap();
}
