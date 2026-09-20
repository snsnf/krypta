use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::error::ApiError;

const REGISTER_RATE_LIMIT_MIN: i32 = 1;
const REGISTER_RATE_LIMIT_MAX: i32 = 1000;
const LOGIN_RATE_LIMIT_MIN: i32 = 1;
const LOGIN_RATE_LIMIT_MAX: i32 = 1000;
const DEFAULT_MAX_FORMS_MIN: i32 = 1;
const DEFAULT_MAX_FORMS_MAX: i32 = 100_000;
const DEFAULT_MAX_ATTACHMENT_BYTES_MIN: i64 = 0;
const DEFAULT_MAX_ATTACHMENT_BYTES_MAX: i64 = 1_099_511_627_776;
const DEFAULT_MAX_RESPONSES_MIN: i32 = 0;
const DEFAULT_MAX_RESPONSES_MAX: i32 = 100_000_000;

#[derive(Clone, Debug, Serialize)]
pub struct InstanceSettings {
    pub registration_enabled: bool,
    pub register_rate_limit_per_hour: i32,
    pub login_rate_limit_per_minute: i32,
    pub default_max_forms: i32,
    pub default_max_attachment_bytes: i64,
    /// Null means no response cap, which is what an instance that has never
    /// set this resolves to. The other two defaults are `NOT NULL` because a
    /// form count and a byte budget have always had a floor; the response
    /// allowance did not exist before billing, so its floor is "unlimited".
    pub default_max_responses_per_period: Option<i32>,
}

/// Distinguishes "field absent" from "field present and null" for
/// `default_max_responses_per_period`, so an admin can clear the cap rather
/// than only raise or lower it. The same helper `forms::routes` uses for the
/// form response limits, and for the same reason: `COALESCE($n, column)`
/// cannot express "set this back to null".
fn present<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[expect(
    clippy::option_option,
    reason = "the outer Option is presence and the inner is the value, so an absent field \
              leaves the response cap alone and an explicit null clears it"
)]
pub struct UpdateInstanceSettingsBody {
    pub registration_enabled: Option<bool>,
    pub register_rate_limit_per_hour: Option<i32>,
    pub login_rate_limit_per_minute: Option<i32>,
    pub default_max_forms: Option<i32>,
    pub default_max_attachment_bytes: Option<i64>,
    #[serde(default, deserialize_with = "present")]
    pub default_max_responses_per_period: Option<Option<i32>>,
}

impl UpdateInstanceSettingsBody {
    pub fn validate(&self) -> Result<(), ApiError> {
        validate_range(
            self.register_rate_limit_per_hour,
            REGISTER_RATE_LIMIT_MIN,
            REGISTER_RATE_LIMIT_MAX,
            "register_rate_limit_per_hour",
        )?;
        validate_range(
            self.login_rate_limit_per_minute,
            LOGIN_RATE_LIMIT_MIN,
            LOGIN_RATE_LIMIT_MAX,
            "login_rate_limit_per_minute",
        )?;
        validate_range(
            self.default_max_forms,
            DEFAULT_MAX_FORMS_MIN,
            DEFAULT_MAX_FORMS_MAX,
            "default_max_forms",
        )?;
        validate_range_i64(
            self.default_max_attachment_bytes,
            DEFAULT_MAX_ATTACHMENT_BYTES_MIN,
            DEFAULT_MAX_ATTACHMENT_BYTES_MAX,
            "default_max_attachment_bytes",
        )?;
        validate_range(
            self.default_max_responses_per_period.flatten(),
            DEFAULT_MAX_RESPONSES_MIN,
            DEFAULT_MAX_RESPONSES_MAX,
            "default_max_responses_per_period",
        )?;
        Ok(())
    }
}

fn validate_range(value: Option<i32>, min: i32, max: i32, field: &str) -> Result<(), ApiError> {
    let Some(value) = value else {
        return Ok(());
    };

    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!("{field} is out of range")))
    }
}

fn validate_range_i64(value: Option<i64>, min: i64, max: i64, field: &str) -> Result<(), ApiError> {
    let Some(value) = value else {
        return Ok(());
    };

    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!("{field} is out of range")))
    }
}

pub async fn load(pool: &PgPool) -> Result<InstanceSettings, sqlx::Error> {
    let row = sqlx::query!(
        "SELECT
            registration_enabled,
            register_rate_limit_per_hour,
            login_rate_limit_per_minute,
            default_max_forms,
            default_max_attachment_bytes,
            default_max_responses_per_period
         FROM instance_settings
         WHERE id = TRUE",
    )
    .fetch_one(pool)
    .await?;

    Ok(InstanceSettings {
        registration_enabled: row.registration_enabled,
        register_rate_limit_per_hour: row.register_rate_limit_per_hour,
        login_rate_limit_per_minute: row.login_rate_limit_per_minute,
        default_max_forms: row.default_max_forms,
        default_max_attachment_bytes: row.default_max_attachment_bytes,
        default_max_responses_per_period: row.default_max_responses_per_period,
    })
}

pub async fn update(
    pool: &PgPool,
    patch: UpdateInstanceSettingsBody,
) -> Result<InstanceSettings, ApiError> {
    patch.validate()?;

    let row = sqlx::query!(
        "UPDATE instance_settings
         SET registration_enabled = COALESCE($1, registration_enabled),
             register_rate_limit_per_hour = COALESCE($2, register_rate_limit_per_hour),
             login_rate_limit_per_minute = COALESCE($3, login_rate_limit_per_minute),
             default_max_forms = COALESCE($4, default_max_forms),
             default_max_attachment_bytes = COALESCE($5, default_max_attachment_bytes),
             default_max_responses_per_period = CASE
                 WHEN $6 THEN $7
                 ELSE default_max_responses_per_period
             END,
             updated_at = now()
         WHERE id = TRUE
         RETURNING
             registration_enabled,
             register_rate_limit_per_hour,
             login_rate_limit_per_minute,
             default_max_forms,
             default_max_attachment_bytes,
             default_max_responses_per_period",
        patch.registration_enabled,
        patch.register_rate_limit_per_hour,
        patch.login_rate_limit_per_minute,
        patch.default_max_forms,
        patch.default_max_attachment_bytes,
        patch.default_max_responses_per_period.is_some(),
        patch.default_max_responses_per_period.flatten(),
    )
    .fetch_one(pool)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(InstanceSettings {
        registration_enabled: row.registration_enabled,
        register_rate_limit_per_hour: row.register_rate_limit_per_hour,
        login_rate_limit_per_minute: row.login_rate_limit_per_minute,
        default_max_forms: row.default_max_forms,
        default_max_attachment_bytes: row.default_max_attachment_bytes,
        default_max_responses_per_period: row.default_max_responses_per_period,
    })
}

async fn ensure_usage_row(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO account_usage (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING",
        user_id,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(())
}

async fn usage_row_for_update(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(i32, i64), ApiError> {
    let row = sqlx::query!(
        "SELECT forms_used, attachment_bytes_used
         FROM account_usage
         WHERE user_id = $1
         FOR UPDATE",
        user_id,
    )
    .fetch_one(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok((row.forms_used, row.attachment_bytes_used))
}

async fn lock_active_user_for_update(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), ApiError> {
    let locked_user = sqlx::query_scalar::<_, Uuid>(
        "SELECT id
         FROM users
         WHERE id = $1
           AND suspended_at IS NULL
           AND deletion_started_at IS NULL
         FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if locked_user.is_none() {
        return Err(ApiError::Unauthorized);
    }
    Ok(())
}

/// The three resolvers below share one shape:
/// `COALESCE(account_quotas.X, plans.X, instance_settings.default_X)`.
///
/// **`billing_enabled` is what keeps the plan layer out of the way on an
/// instance with no Stripe configuration.** Migration `0022` seeds a `free`
/// row whose limit columns are all `NOT NULL`, so an ungated join always
/// produces a value and the instance default below it can never be reached.
/// That silently replaced every self-hosted instance's own defaults with the
/// hosted free tier's numbers. Joining `plans` only when billing is on
/// restores the documented behaviour: without Stripe, the plan layer does not
/// exist and an instance resolves exactly as it did before billing shipped.
///
/// Callers pass `state.billing_enabled()` rather than a literal. It is a
/// required parameter precisely so a new call site cannot forget it, and the
/// single definition on `AppState` is so no call site can get it wrong.
///
/// The consequence worth knowing: when billing IS enabled the plan layer
/// always resolves, so the instance default is unreachable for a user with no
/// admin override. That is the intended ordering (the plan is what billing
/// changes; the instance default is the floor for an instance that does not
/// bill), not an oversight.
///
/// `pub(crate)` rather than private: `billing::routes::subscription` reads
/// these too, so its response reports the same limits that are actually
/// enforced instead of restating the plan/quota join.
pub(crate) async fn max_forms_for_user(
    pool_or_tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    billing_enabled: bool,
) -> Result<i32, ApiError> {
    sqlx::query_scalar!(
        r#"SELECT COALESCE(
             account_quotas.max_forms,
             plans.max_open_forms,
             instance_settings.default_max_forms
           ) AS "max_forms!"
           FROM instance_settings
           LEFT JOIN account_quotas ON account_quotas.user_id = $1
           LEFT JOIN subscriptions ON subscriptions.user_id = $1
           LEFT JOIN plans
             ON $2 AND plans.id = entitled_plan_id(subscriptions.status, subscriptions.plan_id)
           WHERE instance_settings.id = TRUE"#,
        user_id,
        billing_enabled,
    )
    .fetch_one(&mut **pool_or_tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))
}

/// Same three layers and the same `billing_enabled` gate as
/// `max_forms_for_user` above.
pub(crate) async fn max_attachment_bytes_for_user(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    billing_enabled: bool,
) -> Result<i64, ApiError> {
    sqlx::query_scalar!(
        r#"SELECT COALESCE(
             account_quotas.max_attachment_bytes,
             plans.max_attachment_bytes,
             instance_settings.default_max_attachment_bytes
           ) AS "max_attachment_bytes!"
           FROM instance_settings
           LEFT JOIN account_quotas ON account_quotas.user_id = $1
           LEFT JOIN subscriptions ON subscriptions.user_id = $1
           LEFT JOIN plans
             ON $2 AND plans.id = entitled_plan_id(subscriptions.status, subscriptions.plan_id)
           WHERE instance_settings.id = TRUE"#,
        user_id,
        billing_enabled,
    )
    .fetch_one(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))
}

/// The response allowance for the current period.
///
/// `None` means no cap at all, and it is the answer on any instance that has
/// not set `instance_settings.default_max_responses_per_period` and is not
/// billing. That is deliberate: responses were never capped before billing
/// shipped, so an instance with no Stripe configuration and no admin-set
/// default must keep collecting without limit.
///
/// Same three layers and the same `billing_enabled` gate as its two
/// neighbours above. Migration `0024` is what added the outer and inner
/// layers; before it, this read `plans` alone.
///
/// Called by `submit_response` and `get_form_public` in
/// `apps/api/src/forms/routes.rs`, alongside `billing::quota::responses_used`.
pub async fn max_responses_for_user(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    billing_enabled: bool,
) -> Result<Option<i32>, ApiError> {
    sqlx::query_scalar!(
        r#"SELECT COALESCE(
             account_quotas.max_responses,
             plans.max_responses_per_period,
             instance_settings.default_max_responses_per_period
           ) AS "max_responses?"
           FROM instance_settings
           LEFT JOIN account_quotas ON account_quotas.user_id = $1
           LEFT JOIN subscriptions ON subscriptions.user_id = $1
           LEFT JOIN plans
             ON $2 AND plans.id = entitled_plan_id(subscriptions.status, subscriptions.plan_id)
           WHERE instance_settings.id = TRUE"#,
        user_id,
        billing_enabled,
    )
    .fetch_one(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))
}

/// Whether `used` responses is already at or past `allowance`.
///
/// The one place that decides what `None` means, so no caller has to
/// remember: no cap is no cap, however many responses have been received.
pub fn response_allowance_exhausted(used: i64, allowance: Option<i32>) -> bool {
    match allowance {
        Some(allowance) => used >= i64::from(allowance),
        None => false,
    }
}

pub async fn reserve_form_slot(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    billing_enabled: bool,
) -> Result<(), ApiError> {
    lock_active_user_for_update(transaction, user_id).await?;
    ensure_usage_row(transaction, user_id).await?;

    let open_forms = crate::billing::quota::open_form_count(transaction, user_id).await?;
    let max_forms = max_forms_for_user(transaction, user_id, billing_enabled).await?;
    if open_forms >= i64::from(max_forms) {
        return Err(ApiError::RateLimited);
    }

    sqlx::query!(
        "UPDATE account_usage
         SET forms_used = forms_used + 1,
             updated_at = now()
         WHERE user_id = $1",
        user_id,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(())
}

/// Refuses to reopen a form when its owner is already at the open-form limit.
///
/// `reserve_form_slot` enforces the limit at creation, and a closed form does
/// not count against it. Without this, closing a form, creating another in
/// its slot and reopening the first ends above the limit, and repeating it has
/// no ceiling. Called by `update_form` only when the edit turns a closed form
/// into an open one, before the write, so the form being reopened is not in
/// the count and `>=` admits exactly as creation does.
///
/// The owner is locked with a plain `FOR UPDATE` rather than
/// `lock_active_user_for_update`: the caller may be an Editor, and that helper
/// answers a suspended owner with `Unauthorized`, which the browser would read
/// as the Editor's own session having ended.
pub async fn check_reopen_allowed(
    transaction: &mut Transaction<'_, Postgres>,
    owner_id: Uuid,
    billing_enabled: bool,
) -> Result<(), ApiError> {
    sqlx::query_scalar!("SELECT id FROM users WHERE id = $1 FOR UPDATE", owner_id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    let open_forms = crate::billing::quota::open_form_count(transaction, owner_id).await?;
    let max_forms = max_forms_for_user(transaction, owner_id, billing_enabled).await?;
    if open_forms >= i64::from(max_forms) {
        return Err(ApiError::RateLimited);
    }
    Ok(())
}

pub async fn release_form_slot(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE account_usage
         SET forms_used = GREATEST(forms_used - 1, 0),
             updated_at = now()
         WHERE user_id = $1",
        user_id,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(())
}

pub async fn reserve_attachment_bytes(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    bytes: i64,
    billing_enabled: bool,
) -> Result<(), ApiError> {
    ensure_usage_row(transaction, user_id).await?;

    let (_, attachment_bytes_used) = usage_row_for_update(transaction, user_id).await?;
    let max_attachment_bytes =
        max_attachment_bytes_for_user(transaction, user_id, billing_enabled).await?;
    if attachment_bytes_used > max_attachment_bytes - bytes {
        return Err(ApiError::RateLimited);
    }

    sqlx::query!(
        "UPDATE account_usage
         SET attachment_bytes_used = attachment_bytes_used + $2,
             updated_at = now()
         WHERE user_id = $1",
        user_id,
        bytes,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(())
}

pub async fn transfer_form_usage(
    transaction: &mut Transaction<'_, Postgres>,
    old_owner_id: Uuid,
    new_owner_id: Uuid,
    attachment_bytes: i64,
    billing_enabled: bool,
) -> Result<(), ApiError> {
    if old_owner_id == new_owner_id {
        return Ok(());
    }

    ensure_usage_row(transaction, old_owner_id).await?;
    ensure_usage_row(transaction, new_owner_id).await?;

    let (first_user_id, second_user_id) = if old_owner_id < new_owner_id {
        (old_owner_id, new_owner_id)
    } else {
        (new_owner_id, old_owner_id)
    };
    let first_usage = usage_row_for_update(transaction, first_user_id).await?;
    let second_usage = usage_row_for_update(transaction, second_user_id).await?;
    let old_usage = if first_user_id == old_owner_id {
        first_usage
    } else {
        second_usage
    };
    let new_usage = if first_user_id == new_owner_id {
        first_usage
    } else {
        second_usage
    };

    if old_usage.0 < 1 || old_usage.1 < attachment_bytes {
        return Err(ApiError::Internal(anyhow::anyhow!(
            "account usage invariant violated during ownership transfer"
        )));
    }

    // Counted live, exactly as `reserve_form_slot` does. `max_forms_for_user`
    // returns an OPEN-form ceiling, so measuring it against
    // `account_usage.forms_used`, a count of TOTAL forms that a quietly
    // self-closing form never decrements, made this path enforce a different
    // limit from the one form creation enforces. One limit, one authority.
    //
    // The transfer has not swapped the membership rows yet, so this count
    // does not include the form being handed over: `>=` is the right
    // comparison for admitting one more, same as on creation.
    let new_owner_open_forms =
        crate::billing::quota::open_form_count(transaction, new_owner_id).await?;
    let new_max_forms = max_forms_for_user(transaction, new_owner_id, billing_enabled).await?;
    if new_owner_open_forms >= i64::from(new_max_forms) {
        return Err(ApiError::RateLimited);
    }

    let new_max_attachment_bytes =
        max_attachment_bytes_for_user(transaction, new_owner_id, billing_enabled).await?;
    if new_usage.1 > new_max_attachment_bytes - attachment_bytes {
        return Err(ApiError::RateLimited);
    }

    sqlx::query!(
        "UPDATE account_usage
         SET forms_used = forms_used - 1,
             attachment_bytes_used = attachment_bytes_used - $2,
             updated_at = now()
         WHERE user_id = $1",
        old_owner_id,
        attachment_bytes,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    sqlx::query!(
        "UPDATE account_usage
         SET forms_used = forms_used + 1,
             attachment_bytes_used = attachment_bytes_used + $2,
             updated_at = now()
         WHERE user_id = $1",
        new_owner_id,
        attachment_bytes,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(())
}

pub async fn release_attachment_bytes(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    bytes: i64,
) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE account_usage
         SET attachment_bytes_used = GREATEST(attachment_bytes_used - $2, 0),
             updated_at = now()
         WHERE user_id = $1",
        user_id,
        bytes,
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db() -> sqlx::PgPool {
        crate::test_db::pool().await
    }

    /// The regression this whole layering exists to prevent.
    ///
    /// With no Stripe configured there is no plan layer at all, so every limit
    /// must resolve to the instance default and the response allowance must be
    /// absent entirely. Before the `billing_enabled` gate, the seeded `free`
    /// row's `NOT NULL` columns made the plan layer always win, which silently
    /// cut every self-hosted account from the instance default to 10 forms and
    /// imposed a 250-a-month response cap that had never existed.
    #[tokio::test]
    async fn an_instance_without_billing_resolves_to_its_own_defaults() {
        let db = test_db().await;
        let user_id = Uuid::now_v7();
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'no-billing-test')",
            user_id,
            format!("no-billing-{user_id}@example.com"),
        )
        .execute(&db)
        .await
        .unwrap();

        let defaults = sqlx::query!(
            "SELECT default_max_forms, default_max_attachment_bytes,
                    default_max_responses_per_period
             FROM instance_settings WHERE id = TRUE",
        )
        .fetch_one(&db)
        .await
        .unwrap();

        // A paid subscription must not change any of this either: with
        // billing off, the `subscriptions` row is data nothing reads.
        sqlx::query!(
            "INSERT INTO subscriptions (user_id, plan_id, stripe_customer_id, status)
             VALUES ($1, 'pro', $2, 'active')",
            user_id,
            format!("cus_nobilling_{user_id}"),
        )
        .execute(&db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            max_forms_for_user(&mut tx, user_id, false).await.unwrap(),
            defaults.default_max_forms,
            "with no Stripe configured the form limit must be the instance default"
        );
        assert_eq!(
            max_attachment_bytes_for_user(&mut tx, user_id, false)
                .await
                .unwrap(),
            defaults.default_max_attachment_bytes,
            "with no Stripe configured the attachment budget must be the instance default"
        );
        assert_eq!(
            max_responses_for_user(&mut tx, user_id, false)
                .await
                .unwrap(),
            defaults.default_max_responses_per_period,
            "with no Stripe configured the response allowance must be the instance default, \
             which is None (no cap) unless an admin set one"
        );
        assert!(
            !response_allowance_exhausted(1_000_000, None),
            "no cap must mean no cap, however many responses were received"
        );
        tx.commit().await.unwrap();

        sqlx::query!("DELETE FROM users WHERE id = $1", user_id)
            .execute(&db)
            .await
            .unwrap();
    }

    /// A subscription nothing was ever collected for resolves to free; one
    /// that was paid for and is failing a renewal keeps its plan.
    #[tokio::test]
    async fn an_unpaid_subscription_resolves_to_free_and_a_failing_one_does_not() {
        let db = test_db().await;
        let user_id = Uuid::now_v7();
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'entitled-test')",
            user_id,
            format!("entitled-{user_id}@example.com"),
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO subscriptions (user_id, plan_id, stripe_customer_id, status)
             VALUES ($1, 'pro', $2, 'incomplete')",
            user_id,
            format!("cus_entitled_{user_id}"),
        )
        .execute(&db)
        .await
        .unwrap();

        for (status, expected_forms) in [
            ("incomplete", 10),
            ("incomplete_expired", 10),
            ("past_due", 1000),
            ("unpaid", 1000),
            ("active", 1000),
        ] {
            sqlx::query!(
                "UPDATE subscriptions SET status = $2 WHERE user_id = $1",
                user_id,
                status,
            )
            .execute(&db)
            .await
            .unwrap();
            let mut tx = db.begin().await.unwrap();
            assert_eq!(
                max_forms_for_user(&mut tx, user_id, true).await.unwrap(),
                expected_forms,
                "{status}"
            );
            tx.commit().await.unwrap();
        }

        sqlx::query!("DELETE FROM users WHERE id = $1", user_id)
            .execute(&db)
            .await
            .unwrap();
    }

    /// The ordering is the point: an admin override beats the plan, the plan
    /// beats the instance default, and an account with no subscription resolves
    /// to free.
    #[tokio::test]
    async fn limits_resolve_override_then_plan_then_instance_default() {
        let db = test_db().await;
        let user_id = Uuid::now_v7();
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'resolve-test')",
            user_id,
            format!("resolve-{user_id}@example.com"),
        )
        .execute(&db)
        .await
        .unwrap();

        // No subscription: the free plan's 10 and 250.
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            max_forms_for_user(&mut tx, user_id, true).await.unwrap(),
            10
        );
        assert_eq!(
            max_responses_for_user(&mut tx, user_id, true)
                .await
                .unwrap(),
            Some(250)
        );
        tx.commit().await.unwrap();

        // On pro: the plan's 1000.
        sqlx::query!(
            "INSERT INTO subscriptions (user_id, plan_id, stripe_customer_id, status)
             VALUES ($1, 'pro', $2, 'active')",
            user_id,
            format!("cus_{user_id}"),
        )
        .execute(&db)
        .await
        .unwrap();
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            max_forms_for_user(&mut tx, user_id, true).await.unwrap(),
            1000
        );
        assert_eq!(
            max_responses_for_user(&mut tx, user_id, true)
                .await
                .unwrap(),
            Some(100_000)
        );
        tx.commit().await.unwrap();

        // An admin override wins over the plan, so an account can still be
        // comped or restricted regardless of what it pays. All three limits
        // carry one, the response allowance included since migration 0024.
        sqlx::query!(
            "INSERT INTO account_quotas (user_id, max_forms, max_responses) VALUES ($1, 3, 7)",
            user_id,
        )
        .execute(&db)
        .await
        .unwrap();
        let mut tx = db.begin().await.unwrap();
        assert_eq!(max_forms_for_user(&mut tx, user_id, true).await.unwrap(), 3);
        assert_eq!(
            max_responses_for_user(&mut tx, user_id, true)
                .await
                .unwrap(),
            Some(7)
        );
        tx.commit().await.unwrap();

        sqlx::query!("DELETE FROM users WHERE id = $1", user_id)
            .execute(&db)
            .await
            .unwrap();
    }
}
