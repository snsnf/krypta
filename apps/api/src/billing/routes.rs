use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::HeaderMap,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use stripe_webhook::EventObject;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    auth::extractor::SessionUser,
    billing::{
        quota,
        stripe::{WebhookVerifyError, verify_webhook},
    },
    error::{ApiError, ApiJson, ApiResponse, ApiResult},
    state::AppState,
};

// Stripe's own hosted pages redirect here afterward. There is no dedicated
// success/cancel page yet, so both land on the settings tab that will host
// the billing panel; `?checkout=` lets that page distinguish the two later
// without another round trip.
const CHECKOUT_SUCCESS_PATH: &str = "/dashboard/settings?checkout=success";
const CHECKOUT_CANCEL_PATH: &str = "/dashboard/settings?checkout=cancel";

/// The four billing routes, built as their own `Router` so `main.rs` can
/// merge them in only when `state.stripe.is_some()`. An instance with no
/// Stripe configuration mounts none of this, so a self-hosted deployment has
/// no billing surface at all rather than one that 500s on every call.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/billing/checkout", post(checkout))
        .route("/api/v1/billing/portal", post(portal))
        .route("/api/v1/billing/subscription", get(subscription))
        .route("/api/v1/billing/webhook", post(webhook))
}

fn stripe_context(state: &AppState) -> Result<&crate::billing::stripe::StripeContext, ApiError> {
    // Reachable only if this handler is called on an instance where the
    // billing router was never merged in the first place, which `main.rs`
    // guards against. Kept as a real error rather than an `unwrap` so a
    // future refactor of that guard fails loudly instead of panicking a
    // request thread.
    state.stripe.as_deref().ok_or_else(|| {
        ApiError::Internal(anyhow::anyhow!(
            "billing route reached with no Stripe context"
        ))
    })
}

#[derive(Deserialize)]
pub struct CheckoutBody {
    pub interval: String,
}

#[derive(Serialize)]
pub struct CheckoutResponse {
    pub url: String,
}

/// Creates a Stripe Checkout Session for the chosen billing interval and
/// returns its URL for the browser to redirect to.
///
/// Reuses the caller's existing `stripe_customer_id` when a `subscriptions`
/// row already exists, so a returning user is not duplicated in Stripe, and
/// stamps `user_id` onto `client_reference_id` so the webhook can attribute
/// the completed payment without any other correlation.
///
/// A caller who already holds a live paid subscription is sent to the billing
/// portal instead; see the comment on that check below.
pub async fn checkout(
    State(state): State<AppState>,
    user: SessionUser,
    ApiJson(body): ApiJson<CheckoutBody>,
) -> ApiResult<CheckoutResponse> {
    let stripe = stripe_context(&state)?;

    // The interval to price mapping and the interval to plan mapping are
    // chosen together, right here, rather than the webhook re-deriving a
    // plan from whatever price the session turns out to have used. Today
    // there is only one paid plan, so both intervals resolve to `"pro"`;
    // adding a second paid tier is adding a second match arm here (plus a
    // `plans` row), not touching the webhook handlers below at all. The
    // chosen plan id travels to the webhook on the Checkout Session's own
    // `metadata`, so `handle_checkout_completed` reads it back rather than
    // hardcoding it a second time.
    let (price_id, plan_id) = match body.interval.as_str() {
        "monthly" => (stripe.price_monthly.clone(), "pro"),
        "yearly" => (stripe.price_yearly.clone(), "pro"),
        _ => return Err(ApiError::BadRequest("Invalid billing interval".to_string())),
    };

    // A caller who is already on a paid plan must not be able to buy a second
    // one. Stripe permits a customer to hold concurrent subscriptions, and
    // `handle_checkout_completed` upserts by `user_id`, so a second checkout
    // would bill twice while the row kept only the newer subscription id: the
    // first subscription would stay live, keep charging, and be invisible to
    // this app forever. The UI hides the button, but the endpoint takes a
    // session and is reachable without it.
    //
    // `status` matters here: a `past_due` or `unpaid` subscription is still a
    // subscription, and what it needs is the portal to fix the card, not a
    // duplicate. Only a
    // subscription Stripe considers finished (`canceled`, or an `incomplete`
    // one that expired without ever being paid) leaves the caller free to
    // check out again, and `handle_subscription_deleted` puts the row back on
    // `free` when that happens.
    let existing = sqlx::query!(
        "SELECT stripe_customer_id, plan_id, status FROM subscriptions WHERE user_id = $1",
        user.user_id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    if let Some(existing) = &existing
        && crate::billing::quota::subscription_is_live(&existing.plan_id, &existing.status)
    {
        let session = stripe_billing::billing_portal_session::CreateBillingPortalSession::new()
            .customer(existing.stripe_customer_id.clone())
            .return_url(stripe.portal_return_url.clone())
            .send(&stripe.client)
            .await
            .map_err(|error| {
                ApiError::Internal(anyhow::anyhow!(
                    "stripe billing portal session creation failed: {error}"
                ))
            })?;
        return Ok(ApiResponse::ok(CheckoutResponse { url: session.url }));
    }

    let existing_customer_id = existing.map(|existing| existing.stripe_customer_id);

    // The check above can only see a subscription the webhook has already
    // recorded, so on its own it lets any number of sessions open before the
    // first payment is confirmed. This row is the claim that closes that
    // window: one session per account, the previous one expired before the
    // next is created. See migration 0030. The transaction holds only this
    // row's lock across the calls to Stripe, and only against another
    // checkout by the same account.
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    sqlx::query!(
        "INSERT INTO pending_checkouts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
        user.user_id,
    )
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let previous_session = sqlx::query_scalar!(
        "SELECT stripe_session_id FROM pending_checkouts WHERE user_id = $1 FOR UPDATE",
        user.user_id,
    )
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if let Some(previous_session) = previous_session {
        close_previous_checkout(&stripe.client, previous_session).await?;
    }

    let mut line_item = stripe_checkout::checkout_session::CreateCheckoutSessionLineItems::new();
    line_item.price = Some(price_id);
    line_item.quantity = Some(1);

    let mut request = stripe_checkout::checkout_session::CreateCheckoutSession::new()
        .mode(stripe_checkout::CheckoutSessionMode::Subscription)
        .client_reference_id(user.user_id.to_string())
        .line_items(vec![line_item])
        .metadata(std::collections::HashMap::from([(
            "plan_id".to_string(),
            plan_id.to_string(),
        )]))
        .success_url(format!(
            "{}{CHECKOUT_SUCCESS_PATH}",
            state.config.web_base_url
        ))
        .cancel_url(format!(
            "{}{CHECKOUT_CANCEL_PATH}",
            state.config.web_base_url
        ));

    if let Some(customer_id) = existing_customer_id {
        request = request.customer(customer_id);
    }

    let session = request.send(&stripe.client).await.map_err(|error| {
        ApiError::Internal(anyhow::anyhow!(
            "stripe checkout session creation failed: {error}"
        ))
    })?;

    let url = session
        .url
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("stripe checkout session had no url")))?;

    sqlx::query!(
        "UPDATE pending_checkouts SET stripe_session_id = $2, updated_at = now() WHERE user_id = $1",
        user.user_id,
        session.id.as_str(),
    )
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(CheckoutResponse { url }))
}

/// What to do about the account's previously recorded Checkout Session
/// before opening a new one, given its status at Stripe.
#[derive(Debug, PartialEq, Eq)]
enum PreviousCheckout {
    /// Still payable: expire it, so it can no longer become a subscription.
    Expire,
    /// Already paid, and the webhook has not recorded it yet. Opening another
    /// session now is exactly the double charge this guard exists to stop.
    Refuse,
    /// Expired already, or a status this crate does not know: nothing that
    /// can still be paid, so a new session may open.
    Proceed,
}

fn previous_checkout_action(
    status: Option<&stripe_shared::CheckoutSessionStatus>,
) -> PreviousCheckout {
    match status {
        Some(stripe_shared::CheckoutSessionStatus::Open) => PreviousCheckout::Expire,
        Some(stripe_shared::CheckoutSessionStatus::Complete) => PreviousCheckout::Refuse,
        _ => PreviousCheckout::Proceed,
    }
}

async fn close_previous_checkout(
    client: &stripe::Client,
    session_id: String,
) -> Result<(), ApiError> {
    let id = stripe_shared::CheckoutSessionId::from(session_id);
    let retrieve = |id: stripe_shared::CheckoutSessionId| async move {
        stripe_checkout::checkout_session::RetrieveCheckoutSession::new(id)
            .send(client)
            .await
            .map_err(|error| {
                ApiError::Internal(anyhow::anyhow!(
                    "stripe checkout session retrieval failed: {error}"
                ))
            })
    };
    let previous = retrieve(id.clone()).await?;
    match previous_checkout_action(previous.status.as_ref()) {
        PreviousCheckout::Proceed => Ok(()),
        PreviousCheckout::Refuse => Err(ApiError::CheckoutInProgress),
        PreviousCheckout::Expire => {
            let expired = stripe_checkout::checkout_session::ExpireCheckoutSession::new(id.clone())
                .send(client)
                .await;
            if expired.is_ok() {
                return Ok(());
            }
            // Expiring fails when the session stopped being open in between,
            // most likely because it was paid a moment ago. Ask again rather
            // than guess: paid means refuse, anything else means the attempt
            // itself failed.
            let now = retrieve(id).await?;
            match previous_checkout_action(now.status.as_ref()) {
                PreviousCheckout::Refuse => Err(ApiError::CheckoutInProgress),
                PreviousCheckout::Proceed => Ok(()),
                PreviousCheckout::Expire => Err(ApiError::Internal(anyhow::anyhow!(
                    "stripe refused to expire an open checkout session"
                ))),
            }
        }
    }
}

#[derive(Serialize)]
pub struct PortalResponse {
    pub url: String,
}

/// Creates a Stripe Billing Portal Session for the caller's
/// `stripe_customer_id` and returns its URL. A caller with no subscription
/// (never checked out) gets `NotFound`: there is no Stripe customer to open a
/// portal session for.
pub async fn portal(State(state): State<AppState>, user: SessionUser) -> ApiResult<PortalResponse> {
    let stripe = stripe_context(&state)?;

    let customer_id = sqlx::query_scalar!(
        "SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1",
        user.user_id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::NotFound)?;

    let session = stripe_billing::billing_portal_session::CreateBillingPortalSession::new()
        .customer(customer_id)
        .return_url(stripe.portal_return_url.clone())
        .send(&stripe.client)
        .await
        .map_err(|error| {
            ApiError::Internal(anyhow::anyhow!(
                "stripe billing portal session creation failed: {error}"
            ))
        })?;

    Ok(ApiResponse::ok(PortalResponse { url: session.url }))
}

#[derive(Serialize)]
pub struct SubscriptionResponse {
    pub plan_id: String,
    pub status: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub current_period_end: Option<OffsetDateTime>,
    pub cancel_at_period_end: bool,
    pub responses_used: i64,
    /// Null means no cap. Unreachable while this route is only mounted when
    /// billing is on (the plan layer always resolves then), but the resolver
    /// can return it and the wire format says so rather than pretending.
    pub max_responses_per_period: Option<i32>,
    /// Whether the response allowance is a real limit worth showing as a
    /// meter. False on a paid plan, where the number is a fair-use ceiling
    /// nobody reaches honestly rather than a product limit, which is what
    /// lets the panel call it unlimited the way the pricing page does.
    pub responses_metered: bool,
    pub max_open_forms: i32,
    /// The same distinction for open forms. See `responses_metered`.
    pub forms_metered: bool,
    pub open_forms_used: i64,
    pub max_attachment_bytes: i64,
    pub attachment_bytes_used: i64,
}

/// Reads the caller's plan, subscription state and current usage in one
/// round trip, so the settings UI can render a meter without a second call.
///
/// A free account has no `subscriptions` row at all: the query resolves that
/// to the `'free'` plan the same way `admin::settings::max_responses_for_user`
/// does, and `status`/`current_period_end` come back `null` rather than a
/// fabricated value.
pub async fn subscription(
    State(state): State<AppState>,
    user: SessionUser,
) -> ApiResult<SubscriptionResponse> {
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    let plan = sqlx::query!(
        r#"SELECT
             plans.id AS plan_id,
             plans.max_open_forms AS plan_max_open_forms,
             plans.max_responses_per_period AS plan_max_responses_per_period,
             subscriptions.status AS "status?",
             subscriptions.current_period_end AS "current_period_end?",
             subscriptions.cancel_at_period_end AS "cancel_at_period_end?"
           FROM plans
           LEFT JOIN subscriptions ON subscriptions.user_id = $1
           WHERE plans.id = entitled_plan_id(subscriptions.status, subscriptions.plan_id)"#,
        user.user_id,
    )
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    // These three go through the same resolvers `reserve_form_slot` and
    // friends enforce with (`account_quotas` overrides, then the plan, then
    // the instance default), rather than reading `plans` directly, so the
    // number shown here always matches what is actually enforced.
    let billing_enabled = state.billing_enabled();
    let max_responses_per_period = crate::admin::settings::max_responses_for_user(
        &mut transaction,
        user.user_id,
        billing_enabled,
    )
    .await?;
    let max_open_forms =
        crate::admin::settings::max_forms_for_user(&mut transaction, user.user_id, billing_enabled)
            .await?;
    let max_attachment_bytes = crate::admin::settings::max_attachment_bytes_for_user(
        &mut transaction,
        user.user_id,
        billing_enabled,
    )
    .await?;

    // A paid plan's form and response numbers exist to bound abuse, not to
    // be reached, so the panel presents them as unlimited rather than as a
    // meter filling up. An `account_quotas` override that lowers either one
    // below the plan's own ceiling is a genuine restriction the account will
    // actually hit, so the comparison against the plan row is what keeps
    // "unlimited" from being a lie in that case: a lowered limit is still
    // metered.
    let paid = plan.plan_id != "free";
    let responses_metered = !(paid
        && max_responses_per_period
            .is_none_or(|resolved| resolved >= plan.plan_max_responses_per_period));
    let forms_metered = !(paid && max_open_forms >= plan.plan_max_open_forms);

    let responses_used = quota::responses_used(&mut transaction, user.user_id).await?;
    let open_forms_used = quota::open_form_count(&mut transaction, user.user_id).await?;

    let attachment_bytes_used = sqlx::query_scalar!(
        "SELECT attachment_bytes_used FROM account_usage WHERE user_id = $1",
        user.user_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .unwrap_or(0);

    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(SubscriptionResponse {
        plan_id: plan.plan_id,
        status: plan.status,
        current_period_end: plan.current_period_end,
        cancel_at_period_end: plan.cancel_at_period_end.unwrap_or(false),
        responses_used,
        max_responses_per_period,
        responses_metered,
        max_open_forms,
        forms_metered,
        open_forms_used,
        max_attachment_bytes,
        attachment_bytes_used,
    }))
}

/// Authenticated by the `Stripe-Signature` header alone: no session, no
/// cookie. `body` must stay `Bytes` rather than a `Json` extractor, because
/// Stripe signs the exact bytes it sent and a `Json` extractor would consume
/// and re-serialize them, breaking the signature before `verify_webhook` ever
/// sees it.
pub async fn webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<serde_json::Value> {
    let stripe = stripe_context(&state)?;

    let signature = headers
        .get("stripe-signature")
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;

    let event = match verify_webhook(&body, signature, &stripe.webhook_secret) {
        Ok(event) => event,
        Err(WebhookVerifyError::InvalidSignature) => return Err(ApiError::Unauthorized),
        // Per the Stripe webhook spec, an event this crate version cannot
        // parse must still be acknowledged, or Stripe retries the same
        // undeliverable event forever. This is not a forgery, only an
        // unrecognized shape, so it gets a 2xx and nothing else.
        Err(WebhookVerifyError::Unparseable) => return Ok(ApiResponse::ok(json!({}))),
    };

    // The marker insert and the handler's state change share one
    // transaction, so a failure partway through rolls both back together.
    // Doing this in two separate autocommit statements (as an earlier
    // version of this handler did) would durably record the event as
    // processed even when the handler below it failed, turning a transient
    // database error into permanent, silent event loss: Stripe's retry would
    // see the marker, short-circuit to 200, and never deliver the event
    // again.
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    // Stripe retries, so the same event can arrive many times. Recording the
    // id first and treating a conflict as success makes processing
    // idempotent.
    let inserted = sqlx::query!(
        "INSERT INTO processed_stripe_events (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
        event.id.to_string(),
    )
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if inserted.rows_affected() == 0 {
        // Nothing was written this call, so there is nothing to commit; the
        // transaction drops here and rolls back on its own.
        return Ok(ApiResponse::ok(json!({})));
    }

    match event.data.object {
        EventObject::CheckoutSessionCompleted(session) => {
            handle_checkout_completed(&mut transaction, *session).await?;
        }
        EventObject::CustomerSubscriptionUpdated(sub) => {
            handle_subscription_updated(&mut transaction, *sub).await?;
        }
        EventObject::CustomerSubscriptionDeleted(sub) => {
            handle_subscription_deleted(&mut transaction, *sub).await?;
        }
        EventObject::InvoicePaymentFailed(invoice) => {
            handle_invoice_payment_failed(&mut transaction, *invoice).await?;
        }
        // Any other event type is acknowledged and ignored, so an unexpected
        // type never wedges Stripe's retry queue.
        _ => {}
    }
    // A handler returning `Err(..)` above exits before this point, so the
    // transaction (and the marker insert with it) is dropped and rolled back
    // rather than committed. That turns a failed handler into a retryable
    // 500: Stripe redelivers the same event, and it is genuinely reprocessed
    // rather than short-circuited, because the marker never made it in.
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(json!({})))
}

/// Upserts the subscription row onto the plan chosen at `checkout` time.
///
/// Only the identifiers are trustworthy at this point: the Checkout Session
/// does not carry the subscription's billing period, so `status` is set to a
/// plain `'active'` placeholder and `current_period_end` is left null. The
/// `customer.subscription.updated` event Stripe sends around the same time
/// fills both in for real.
///
/// The plan comes from `session.metadata["plan_id"]`, which `checkout` set
/// when it created the session, rather than being hardcoded here. `checkout`
/// is the one place that knows which price maps to which plan (today that is
/// the only place that knows it: there is one paid plan, so `checkout`
/// always writes `"pro"`), so this reads that decision back instead of
/// repeating it. A session missing the metadata (one created outside this
/// app's own `checkout` handler, for instance directly in the Stripe
/// dashboard) is logged and ignored rather than guessed at.
async fn handle_checkout_completed(
    transaction: &mut Transaction<'_, Postgres>,
    session: stripe_shared::CheckoutSession,
) -> Result<(), ApiError> {
    let Some(client_reference_id) = session.client_reference_id else {
        tracing::warn!("checkout.session.completed with no client_reference_id, ignoring");
        return Ok(());
    };
    let Ok(user_id) = Uuid::parse_str(&client_reference_id) else {
        tracing::warn!(
            "checkout.session.completed with an unparseable client_reference_id, ignoring"
        );
        return Ok(());
    };
    let Some(customer) = session.customer else {
        tracing::warn!("checkout.session.completed with no customer, ignoring");
        return Ok(());
    };
    let Some(plan_id) = session
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("plan_id"))
    else {
        tracing::warn!(
            "checkout.session.completed with no plan_id metadata, ignoring \
             (this session was not created by this app's checkout handler)"
        );
        return Ok(());
    };
    let customer_id = customer.id().as_str();
    let subscription_id = session
        .subscription
        .map(|subscription| subscription.id().as_str().to_string());
    // A session paid by a method that settles later completes before the
    // money arrives. Recording that as 'active' used to hand over the paid
    // plan for nothing; 'incomplete' keeps the row (later subscription events
    // need it to match) while `entitled_plan_id` resolves it to free, until
    // `customer.subscription.updated` reports the subscription active. An
    // unrecognised value is treated as unpaid: entitlement bugs undershoot.
    let status = match session.payment_status {
        stripe_shared::CheckoutSessionPaymentStatus::Paid
        | stripe_shared::CheckoutSessionPaymentStatus::NoPaymentRequired => "active",
        _ => "incomplete",
    };

    sqlx::query!(
        "INSERT INTO subscriptions (
             user_id, plan_id, stripe_customer_id, stripe_subscription_id, status, cancel_at_period_end
         )
         VALUES ($1, $2, $3, $4, $5, FALSE)
         ON CONFLICT (user_id) DO UPDATE SET
             plan_id = EXCLUDED.plan_id,
             stripe_customer_id = EXCLUDED.stripe_customer_id,
             stripe_subscription_id = EXCLUDED.stripe_subscription_id,
             status = EXCLUDED.status,
             updated_at = now()",
        user_id,
        plan_id,
        customer_id,
        subscription_id,
        status,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    // The session this account was allowed to have open has now completed,
    // so its claim is released. Matched on the id, so a completion arriving
    // late for a session a newer checkout already replaced leaves that newer
    // claim alone.
    sqlx::query!(
        "DELETE FROM pending_checkouts WHERE user_id = $1 AND stripe_session_id = $2",
        user_id,
        session.id.as_str(),
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(())
}

/// Matched by `stripe_customer_id` AND `stripe_subscription_id`. The customer
/// is what ties the event to a krypta account, because
/// `handle_checkout_completed` above is the only place that knows the
/// `user_id` and it always writes the customer id. The subscription id is
/// what ties it to the RIGHT subscription: see `subscription_row_state`
/// below for what one Stripe customer holding several subscriptions over
/// time does to a customer-only match.
///
/// A subscription's price is resolved back to a plan through
/// `plans.stripe_price_id_monthly`/`stripe_price_id_yearly`. Today neither
/// column is populated by any migration, so no price ever matches and
/// `plan_id` is always left unchanged here, which is correct while `'pro'`
/// is the only paid plan (it was set by `handle_checkout_completed` already).
/// Populating those columns is what makes this resolve a real second tier
/// later, with no other code change. An unmatched price must never default
/// to a paid plan: once a second, cheaper tier exists, defaulting an
/// unrecognized price to `'pro'` would silently upgrade that tier's
/// subscribers to the more generous one. Leaving `plan_id` untouched and
/// logging the unrecognized price is the safe direction to fail in; an
/// entitlement bug should undershoot, never overshoot.
///
/// Stripe does not guarantee delivery order: `customer.subscription.updated`
/// (or `.created`) frequently arrives before `checkout.session.completed`
/// for the same subscription. When that happens the `UPDATE` below matches
/// zero rows, because the row does not exist yet. Returning an error rather
/// than silently accepting that is what makes the row eventually correct:
/// the caller's transaction rolls back, the idempotency marker rolls back
/// with it, and Stripe's retry (it retries any non-2xx) redelivers this same
/// event later, after `checkout.session.completed` has had its chance to run
/// and create the row.
async fn handle_subscription_updated(
    transaction: &mut Transaction<'_, Postgres>,
    subscription: stripe_shared::Subscription,
) -> Result<(), ApiError> {
    let customer_id = subscription.customer.id().as_str();
    let subscription_id = subscription.id.as_str();
    let status = subscription.status.as_str();
    let cancel_at_period_end = subscription.cancel_at_period_end;

    let current_period_end = subscription
        .items
        .data
        .first()
        .map(|item| OffsetDateTime::from_unix_timestamp(item.current_period_end))
        .transpose()
        .map_err(|error| ApiError::Internal(error.into()))?;

    let price_id = subscription
        .items
        .data
        .first()
        .map(|item| item.price.id.as_str());
    let resolved_plan_id: Option<String> = match price_id {
        Some(price_id) => {
            let found = sqlx::query_scalar!(
                "SELECT id FROM plans WHERE stripe_price_id_monthly = $1 OR stripe_price_id_yearly = $1",
                price_id,
            )
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|error| ApiError::Internal(error.into()))?;
            if found.is_none() {
                tracing::warn!(
                    price_id = %price_id,
                    "customer.subscription.updated referenced an unrecognized price id, \
                     leaving plan_id unchanged rather than guessing"
                );
            }
            found
        }
        None => None,
    };

    let updated = sqlx::query!(
        "UPDATE subscriptions
         SET plan_id = COALESCE($1, plan_id),
             status = $2,
             current_period_end = $3,
             cancel_at_period_end = $4,
             stripe_subscription_id = $5,
             updated_at = now()
         WHERE stripe_customer_id = $6
           AND (stripe_subscription_id IS NULL OR stripe_subscription_id = $5)",
        resolved_plan_id,
        status,
        current_period_end,
        cancel_at_period_end,
        subscription_id,
        customer_id,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    if updated.rows_affected() == 0 {
        return unmatched_subscription_event(
            transaction,
            "customer.subscription.updated",
            customer_id,
            subscription_id,
        )
        .await;
    }

    Ok(())
}

/// What to do when a subscription event's `UPDATE` matched no row.
///
/// There are two different reasons that happens and they need opposite
/// answers, which is why this cannot simply always fail.
///
/// **No row for the customer at all**: the event arrived before
/// `checkout.session.completed` created the row. Stripe does not guarantee
/// order and this is common. Returning an error rolls the caller's
/// transaction back, and the idempotency marker with it, so Stripe's retry
/// genuinely reprocesses the event once the row exists.
///
/// **A row exists but holds a different `stripe_subscription_id`**: the event
/// belongs to a subscription this account has moved on from. One Stripe
/// customer can hold several subscriptions over time, so this is what a
/// cancel-then-resubscribe looks like: the old subscription's
/// `customer.subscription.deleted` fires at the end of its paid period, long
/// after the new one is live. Matched by customer alone it would set
/// `plan_id = 'free'` on someone who is currently paying, and because
/// `deleted` is terminal nothing would ever correct it. Retrying is no better
/// than applying it: the stale subscription's id never becomes the current
/// one, so the retry would fail for the same reason until Stripe gives up
/// days later. It is acknowledged and ignored instead.
///
/// The cost of ignoring is bounded and self-correcting. What is skipped is a
/// status or period stamp for a subscription that is not the current one, and
/// the current subscription's own events keep arriving. Nothing about
/// entitlement is decided here that a later `customer.subscription.updated`
/// for the live subscription does not decide again.
///
/// **But a row with a different id is only stale when that row is live.** A
/// returning subscriber's new checkout reuses the stored customer, so until
/// `checkout.session.completed` records the new subscription id, the row
/// still names the old, finished one. Every event for the new subscription
/// then matches no row while a row for the customer exists. Acknowledging
/// those was the flaw this check replaced an `EXISTS` to fix: a
/// `customer.subscription.deleted` that outran its own checkout was dropped,
/// and the checkout completing afterwards granted a paid plan with no live
/// subscription behind it, which nothing ever revisited. When the recorded
/// subscription is finished the event is treated like the no-row case and
/// retried. The price is that a genuinely stale event for a subscription
/// older than a finished one is retried until Stripe gives up, which is log
/// noise and never an entitlement change.
async fn unmatched_subscription_event(
    transaction: &mut Transaction<'_, Postgres>,
    event_type: &str,
    customer_id: &str,
    subscription_id: &str,
) -> Result<(), ApiError> {
    let recorded = sqlx::query!(
        "SELECT plan_id, status FROM subscriptions WHERE stripe_customer_id = $1",
        customer_id,
    )
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    if let Some(recorded) = recorded
        && crate::billing::quota::subscription_is_live(&recorded.plan_id, &recorded.status)
    {
        tracing::warn!(
            event_type = %event_type,
            customer_id = %customer_id,
            subscription_id = %subscription_id,
            "subscription event is for a subscription this account no longer holds, \
             acknowledging without applying it"
        );
        return Ok(());
    }

    tracing::warn!(
        event_type = %event_type,
        customer_id = %customer_id,
        "subscription event matched no live subscriptions row, likely arrived before \
         checkout.session.completed; failing so the marker rolls back and Stripe retries"
    );
    Err(ApiError::Internal(anyhow::anyhow!(
        "{event_type} arrived before its subscriptions row existed"
    )))
}

/// Moves the row to the free plan rather than deleting it, so
/// `stripe_customer_id` (and the unique index over it) survives for the next
/// `checkout` call to reuse.
///
/// This is the worse-case version of the ordering problem documented on
/// `handle_subscription_updated` above. `customer.subscription.deleted` is
/// terminal: nothing corrects a missed one later. If it arrives before
/// `checkout.session.completed` (Stripe permits this, and it happens for a
/// subscription created then cancelled quickly) and this silently no-oped on
/// a zero-row match, `checkout.session.completed` would then create the row
/// fresh with an active paid plan, and that phantom entitlement would stand
/// forever: there is no later event that revisits it. Handing a zero-row
/// match to `unmatched_subscription_event`, exactly as
/// `handle_subscription_updated` does, is what rolls the marker back and lets
/// Stripe's retry land after the row exists.
async fn handle_subscription_deleted(
    transaction: &mut Transaction<'_, Postgres>,
    subscription: stripe_shared::Subscription,
) -> Result<(), ApiError> {
    let customer_id = subscription.customer.id().as_str();
    let subscription_id = subscription.id.as_str();
    let status = subscription.status.as_str();

    // The subscription id is in the predicate for the reason spelled out on
    // `unmatched_subscription_event`: this is the handler where matching by
    // customer alone did real damage, downgrading a paying account when a
    // subscription it had already replaced finally ended.
    //
    // A null `stripe_subscription_id` still matches. That is the row
    // `handle_checkout_completed` writes when the Checkout Session carried no
    // subscription yet, and the only subscription such a customer can have is
    // the one being deleted. Accepting it downgrades, which is the safe
    // direction for an entitlement to be wrong in.
    let updated = sqlx::query!(
        "UPDATE subscriptions
         SET plan_id = 'free',
             status = $1,
             cancel_at_period_end = FALSE,
             updated_at = now()
         WHERE stripe_customer_id = $2
           AND (stripe_subscription_id IS NULL OR stripe_subscription_id = $3)",
        status,
        customer_id,
        subscription_id,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    if updated.rows_affected() == 0 {
        return unmatched_subscription_event(
            transaction,
            "customer.subscription.deleted",
            customer_id,
            subscription_id,
        )
        .await;
    }

    Ok(())
}

/// Leaves the plan alone: a card failing on Friday must not silently
/// downgrade someone before their next attempt on Monday. Only `status`
/// moves, to `past_due`.
///
/// Quota resolution goes through the `entitled_plan_id` SQL function
/// (migration 0029), which keeps `plan_id` for every status except the two
/// that mean nothing was ever collected, `incomplete` and
/// `incomplete_expired`. That is what keeps a `past_due` account on its
/// plan's limits instead of being knocked down to free mid-period the moment a
/// card fails, so this handler moving `status` to `past_due` changes no limit.
/// Do not widen that function's list to `past_due` or `unpaid`: those are
/// subscriptions that were paid for and are failing a renewal, and the
/// behaviour this comment protects is exactly theirs.
///
/// Also fails on a zero-row match, for the same ordering reason as
/// `handle_subscription_updated` and `handle_subscription_deleted` above.
/// The consequence here is smaller (a missed `past_due` stamp leaves the
/// status at whatever `checkout.session.completed` set, with no entitlement
/// escalation), but leaving this one handler as the exception to the pattern
/// is how the next person concludes the pattern is optional.
///
/// This is the one handler that still matches on `stripe_customer_id` alone.
/// An `Invoice`'s link back to its subscription moved between Stripe API
/// versions and is not a plain field on this crate's type, and the stale-row
/// damage the other two handlers guard against does not arise here: nothing
/// on this path touches `plan_id`, which is the sole authority for
/// entitlement. The worst a stale invoice can do is stamp `past_due` on a
/// current subscription, which the next `customer.subscription.updated` for
/// that subscription corrects. Give this the same subscription-id predicate
/// as its neighbours the day the crate exposes the link plainly.
async fn handle_invoice_payment_failed(
    transaction: &mut Transaction<'_, Postgres>,
    invoice: stripe_shared::Invoice,
) -> Result<(), ApiError> {
    let Some(customer) = invoice.customer else {
        tracing::warn!("invoice.payment_failed with no customer, ignoring");
        return Ok(());
    };
    let customer_id = customer.id().as_str();

    let updated = sqlx::query!(
        "UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE stripe_customer_id = $1",
        customer_id,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    if updated.rows_affected() == 0 {
        tracing::warn!(
            customer_id = %customer_id,
            "invoice.payment_failed matched no subscriptions row, likely arrived \
             before checkout.session.completed; failing so the marker rolls back and Stripe retries"
        );
        return Err(ApiError::Internal(anyhow::anyhow!(
            "invoice.payment_failed arrived before its subscriptions row existed"
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_unpaid_open_session_is_expired_and_a_paid_one_refuses() {
        use stripe_shared::CheckoutSessionStatus as Status;
        assert_eq!(
            previous_checkout_action(Some(&Status::Open)),
            PreviousCheckout::Expire
        );
        assert_eq!(
            previous_checkout_action(Some(&Status::Complete)),
            PreviousCheckout::Refuse
        );
        assert_eq!(
            previous_checkout_action(Some(&Status::Expired)),
            PreviousCheckout::Proceed
        );
        assert_eq!(previous_checkout_action(None), PreviousCheckout::Proceed);
    }
}
