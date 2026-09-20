use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::ApiError;

/// Counts the forms this user owns that are currently open.
///
/// This restates `form_is_open` in SQL, which is a duplication the project
/// otherwise forbids: CLAUDE.md names that function the single definition of
/// open. It is unavoidable here, because `form_is_open` is Rust and takes a
/// per-form response count, and this has to be one query rather than one query
/// per form. The agreement test in this file is what keeps the two aligned:
/// change one without the other and it fails there.
///
/// A counter cannot replace this. Two of the three closure conditions, a
/// `closes_at` elapsing and a `max_responses` filling, happen with no code
/// running at all, so there is nothing to decrement.
///
/// Called by `reserve_form_slot` in `apps/api/src/admin/settings.rs`, which
/// checks this live count against the resolved `max_forms` limit instead of
/// the `account_usage.forms_used` counter.
pub async fn open_form_count(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<i64, ApiError> {
    sqlx::query_scalar!(
        r#"SELECT count(*) AS "count!"
           FROM forms f
           JOIN form_members m
             ON m.form_id = f.id AND m.user_id = $1 AND m.role = 'owner' AND m.state = 'active'
           WHERE f.accepting_responses
             AND (f.closes_at IS NULL OR f.closes_at > now())
             AND (
               f.max_responses IS NULL
               OR (SELECT count(*) FROM responses r WHERE r.form_id = f.id) < f.max_responses
             )"#,
        user_id,
    )
    .fetch_one(&mut **tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))
}

/// Whether a subscription row is one Stripe is still billing.
///
/// Only a subscription Stripe considers finished, `canceled` or an
/// `incomplete` one that expired unpaid, is over. A `past_due` or `unpaid`
/// one is still a subscription: it needs a working card, not a second
/// checkout, and it must not be left charging behind a deleted account. The
/// one definition both of those decisions use.
pub fn subscription_is_live(plan_id: &str, status: &str) -> bool {
    plan_id != "free" && !matches!(status, "canceled" | "incomplete_expired")
}

pub async fn has_live_subscription(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    let row = sqlx::query!(
        "SELECT plan_id, status FROM subscriptions WHERE user_id = $1",
        user_id,
    )
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(row.is_some_and(|row| subscription_is_live(&row.plan_id, &row.status)))
}

/// The start of the current usage period: this calendar month, UTC.
///
/// The key `responses_used`, `record_response` and `claim_allowance_warning`
/// below all address `response_usage` by, so the period they read and the
/// period they write can never disagree.
pub fn current_period_start() -> OffsetDateTime {
    let now = OffsetDateTime::now_utc();
    now.replace_day(1)
        .expect("day 1 is valid in every month")
        .replace_time(time::Time::MIDNIGHT)
}

/// Called by `submit_response` and `get_form_public` in
/// `apps/api/src/forms/routes.rs`. This counter is per-user, not per-form, so
/// `submit_response`'s `FOR UPDATE OF forms` lock alone does not serialize
/// it: two submissions to two different forms owned by the same person would
/// lock two different forms rows. What serializes it is the same query's
/// `FOR UPDATE OF forms, owner_user`, which also locks the owner's users
/// row that every one of their forms joins to. Losing `owner_user` from that
/// lock list would let two racing requests to two of that owner's forms both
/// read the same total and both pass, even though the per-form cap next to
/// it would keep working.
pub async fn responses_used(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<i64, ApiError> {
    let used = sqlx::query_scalar!(
        "SELECT response_count FROM response_usage
         WHERE user_id = $1 AND period_start = $2",
        user_id,
        current_period_start(),
    )
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(i64::from(used.unwrap_or(0)))
}

/// Counts one received response against the period.
///
/// Deleting a response deliberately does not refund this. Metering what was
/// received rather than what is retained is what stops a free account
/// collecting its allowance, exporting, deleting, and collecting it again
/// indefinitely.
///
/// Called by `submit_response` in `apps/api/src/forms/routes.rs`, inside the
/// same transaction as the response insert, so a rolled-back submission
/// cannot burn allowance and a committed one always counts.
pub async fn record_response(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO response_usage (user_id, period_start, response_count)
         VALUES ($1, $2, 1)
         ON CONFLICT (user_id, period_start)
         DO UPDATE SET response_count = response_usage.response_count + 1",
        user_id,
        current_period_start(),
    )
    .execute(&mut **tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(())
}

/// Claims the right to send this period's allowance warning.
///
/// Returns true exactly once per user per period. The guard is a conditional
/// write rather than a read followed by a write, so two concurrent
/// submissions cannot both claim it.
///
/// An INSERT ... ON CONFLICT rather than a plain UPDATE: this can be called
/// before `record_response` has ever created a row for the period (a fresh
/// user warned on their very first response of the month), and a plain
/// UPDATE against a row that does not exist yet always affects zero rows.
/// The ON CONFLICT branch is what makes the claim conditional when the row
/// already exists: it only sets `warned_at` when it was previously null, so
/// a second call in the same period still claims nothing.
pub async fn claim_allowance_warning(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    let claimed = sqlx::query!(
        "INSERT INTO response_usage (user_id, period_start, response_count, warned_at)
         VALUES ($1, $2, 0, now())
         ON CONFLICT (user_id, period_start)
         DO UPDATE SET warned_at = now()
         WHERE response_usage.warned_at IS NULL",
        user_id,
        current_period_start(),
    )
    .execute(&mut **tx)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(claimed.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forms::routes::{ResponseCount, form_is_open};
    // Duration is used only here. Importing it beside OffsetDateTime in the
    // module above would be an unused import in non-test code, which fails
    // `cargo clippy -- -D warnings`.
    use time::Duration;

    async fn test_db() -> sqlx::PgPool {
        crate::test_db::pool().await
    }

    /// The agreement test.
    ///
    /// `form_is_open` is Rust and takes a per-form response count, so counting
    /// open forms in SQL necessarily restates its logic. CLAUDE.md names
    /// `form_is_open` as the single definition of open, and this is the one
    /// place that cannot call it. This test is what stops the two drifting:
    /// change one without the other and it fails here rather than misbilling
    /// quietly.
    #[tokio::test]
    async fn the_sql_count_agrees_with_form_is_open_in_every_state() {
        let db = test_db().await;
        let user_id = Uuid::now_v7();
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'quota-test')",
            user_id,
            format!("quota-{user_id}@example.com"),
        )
        .execute(&db)
        .await
        .unwrap();

        // accepting, no limits: open.
        // manually closed: not open.
        // closes_at in the past: not open.
        // max_responses already met: not open.
        let states: Vec<(bool, Option<OffsetDateTime>, Option<i32>, i64)> = vec![
            (true, None, None, 0),
            (false, None, None, 0),
            (
                true,
                Some(OffsetDateTime::now_utc() - Duration::hours(1)),
                None,
                0,
            ),
            (true, None, Some(1), 1),
        ];

        let mut expected_open = 0i64;
        let mut form_ids = Vec::new();
        for (accepting, closes_at, max_responses, response_count) in &states {
            let form_id = Uuid::now_v7();
            form_ids.push(form_id);
            sqlx::query!(
                "INSERT INTO forms (
                    id, title_ciphertext, schema_ciphertext, form_public_key,
                    accepting_responses, closes_at, max_responses
                 ) VALUES ($1, 'title', 'schema', 'key', $2, $3, $4)",
                form_id,
                accepting,
                *closes_at,
                *max_responses,
            )
            .execute(&db)
            .await
            .unwrap();
            sqlx::query!(
                "INSERT INTO form_members (
                    id, form_id, user_id, role, state, key_scheme,
                    encrypted_form_data_key, encrypted_form_private_key
                 ) VALUES ($1, $2, $3, 'owner', 'active', 'master_wrap_v1', 'd', 'p')",
                Uuid::now_v7(),
                form_id,
                user_id,
            )
            .execute(&db)
            .await
            .unwrap();
            for _ in 0..*response_count {
                sqlx::query!(
                    "INSERT INTO responses (id, form_id, ciphertext)
                     VALUES ($1, $2, 'answers')",
                    Uuid::now_v7(),
                    form_id,
                )
                .execute(&db)
                .await
                .unwrap();
            }
            // Reported, not locked: this test builds each state and then asks
            // the function, with nothing racing it.
            if form_is_open(
                *accepting,
                *closes_at,
                *max_responses,
                ResponseCount::reported(*response_count),
            ) {
                expected_open += 1;
            }
        }

        let mut tx = db.begin().await.unwrap();
        let counted = open_form_count(&mut tx, user_id).await.unwrap();
        tx.commit().await.unwrap();

        assert_eq!(
            counted, expected_open,
            "the SQL open-form count must agree with form_is_open in every state"
        );

        // form_members.user_id is ON DELETE RESTRICT, so the owning forms
        // have to go first. Deleting a form cascades to its form_members and
        // responses rows.
        for form_id in &form_ids {
            sqlx::query!("DELETE FROM forms WHERE id = $1", form_id)
                .execute(&db)
                .await
                .unwrap();
        }
        sqlx::query!("DELETE FROM users WHERE id = $1", user_id)
            .execute(&db)
            .await
            .unwrap();
    }

    /// A new month is a row that does not exist yet, so a missing row is zero
    /// and no reset job is needed.
    #[tokio::test]
    async fn usage_starts_at_zero_and_counts_up_within_a_period() {
        let db = test_db().await;
        let user_id = Uuid::now_v7();
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'quota-test')",
            user_id,
            format!("usage-{user_id}@example.com"),
        )
        .execute(&db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        assert_eq!(responses_used(&mut tx, user_id).await.unwrap(), 0);
        record_response(&mut tx, user_id).await.unwrap();
        record_response(&mut tx, user_id).await.unwrap();
        assert_eq!(responses_used(&mut tx, user_id).await.unwrap(), 2);
        tx.commit().await.unwrap();

        sqlx::query!("DELETE FROM users WHERE id = $1", user_id)
            .execute(&db)
            .await
            .unwrap();
    }

    /// The warning fires once per period, not once per response past the
    /// threshold.
    #[tokio::test]
    async fn the_allowance_warning_is_sent_once_per_period() {
        let db = test_db().await;
        let user_id = Uuid::now_v7();
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'warn-test')",
            user_id,
            format!("warn-{user_id}@example.com"),
        )
        .execute(&db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        assert!(claim_allowance_warning(&mut tx, user_id).await.unwrap());
        assert!(
            !claim_allowance_warning(&mut tx, user_id).await.unwrap(),
            "a second claim in the same period must not send a second email"
        );
        tx.commit().await.unwrap();

        sqlx::query!("DELETE FROM users WHERE id = $1", user_id)
            .execute(&db)
            .await
            .unwrap();
    }
}
