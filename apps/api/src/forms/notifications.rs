use sqlx::PgPool;
use uuid::Uuid;

use crate::mail::{self, Mailer};

/// Emails members that responses arrived, at most once per cooldown window.
///
/// This runs out of band deliberately. `submit_response` is anonymous and rate
/// limited at 100 per form per minute, so sending inline would both make a
/// respondent wait on SMTP and turn a public link into a mail amplifier.
pub fn spawn(
    db: PgPool,
    mailer: Mailer,
    web_base_url: String,
    cooldown_seconds: i64,
    sweep_interval_seconds: u64,
) {
    tokio::spawn(async move {
        loop {
            if run_once(&db, &mailer, &web_base_url, cooldown_seconds)
                .await
                .is_err()
            {
                tracing::error!(
                    failure_kind = "response_notification_sweep",
                    "response notification sweep failed"
                );
            }
            tokio::time::sleep(std::time::Duration::from_secs(sweep_interval_seconds)).await;
        }
    });
}

/// Bounds how long a claimed row's lock can be held while mail is in flight.
/// The row is locked FOR UPDATE across this send, so a hung mail server would
/// otherwise block user-facing writes to that membership for lettre's full
/// 60-second default.
const MAIL_SEND_TIMEOUT_SECS: u64 = 20;

/// Ceiling on the retry delay after repeated delivery failures, in minutes.
///
/// A day. Long enough that a permanently undeliverable address costs one
/// connection attempt daily rather than one per sweep, short enough that an
/// address which starts working again is picked up without anyone intervening.
const MAX_NOTIFY_BACKOFF_MINUTES: i32 = 24 * 60;

pub(crate) struct DueMember {
    pub member_id: Uuid,
    pub form_id: Uuid,
    pub email: String,
}

/// The members the next sweep would notify.
///
/// Extracted from `run_once` so the sweep and the agreement test select
/// through the same literal. `backlog` still repeats the predicate, because
/// `query!` takes a string literal and cannot interpolate, but two copies
/// under one test is the floor this design can reach.
pub(crate) async fn due_members(
    db: &PgPool,
    cooldown_seconds: i64,
) -> sqlx::Result<Vec<DueMember>> {
    let cooldown = cooldown_seconds as f64;
    sqlx::query_as!(
        DueMember,
        r#"SELECT fm.id AS "member_id!", fm.form_id AS "form_id!", u.email AS "email!"
           FROM form_members fm
           JOIN users u ON u.id = fm.user_id AND u.suspended_at IS NULL
           WHERE fm.notify_on_response
             AND fm.state = 'active'
             AND (
               fm.last_notified_at IS NULL
               OR fm.last_notified_at <= now() - $1 * interval '1 second'
             )
             AND (
               fm.notify_retry_after IS NULL
               OR fm.notify_retry_after <= now()
             )
             AND EXISTS (
               SELECT 1 FROM responses r
               WHERE r.form_id = fm.form_id
                 AND r.created_at > COALESCE(fm.last_notified_at, fm.created_at)
             )
           ORDER BY fm.last_notified_at ASC NULLS FIRST, fm.id
           LIMIT 200"#,
        cooldown,
    )
    .fetch_all(db)
    .await
}

pub(crate) async fn run_once(
    db: &PgPool,
    mailer: &Mailer,
    web_base_url: &str,
    cooldown_seconds: i64,
) -> anyhow::Result<()> {
    let due = due_members(db, cooldown_seconds).await?;

    for member in due {
        if notify_member(db, mailer, web_base_url, &member, cooldown_seconds)
            .await
            .is_err()
        {
            tracing::warn!(
                member_id = %member.member_id,
                form_id = %member.form_id,
                failure_kind = "response_notification_delivery",
                "response notification will be retried"
            );
            if let Err(error) = record_delivery_failure(db, member.member_id).await {
                tracing::error!(
                    member_id = %member.member_id,
                    error = %error,
                    failure_kind = "response_notification_backoff",
                    "could not record a delivery failure"
                );
            }
        }
    }
    Ok(())
}

/// What the notification sweep still owes.
///
/// `due` repeats `run_once`'s selection predicate, and it has to: `query!`
/// takes a literal and the project forbids runtime-checked SQL, so there is
/// no way to share the clause. The agreement test in this module is what
/// keeps the two from drifting. Note the absence of `LIMIT 200`: the sweep
/// takes a page at a time, but the backlog is the whole queue, which is the
/// number worth seeing.
///
/// `due` and `backing_off` are not disjoint: once a member's
/// `notify_retry_after` elapses it is genuinely both due and backing off, so
/// the two counts can overlap and must not be added together.
pub(crate) struct NotificationBacklog {
    pub due: i64,
    pub backing_off: i64,
    pub oldest_pending_at: Option<time::OffsetDateTime>,
}

/// Not yet called outside this module's own tests: a later task assembles it
/// into the admin health report.
pub(crate) async fn backlog(
    db: &PgPool,
    cooldown_seconds: i64,
) -> sqlx::Result<NotificationBacklog> {
    let cooldown = cooldown_seconds as f64;
    let row = sqlx::query!(
        r#"SELECT
             count(*) FILTER (
               WHERE fm.notify_on_response
                 AND fm.state = 'active'
                 AND (
                   fm.last_notified_at IS NULL
                   OR fm.last_notified_at <= now() - $1 * interval '1 second'
                 )
                 AND (
                   fm.notify_retry_after IS NULL
                   OR fm.notify_retry_after <= now()
                 )
                 AND EXISTS (
                   SELECT 1 FROM responses r
                   WHERE r.form_id = fm.form_id
                     AND r.created_at > COALESCE(fm.last_notified_at, fm.created_at)
                 )
             ) AS "due!",
             count(*) FILTER (
               WHERE fm.notify_on_response
                 AND fm.state = 'active'
                 AND fm.notify_failure_count > 0
             ) AS "backing_off!",
             min(COALESCE(fm.last_notified_at, fm.created_at)) FILTER (
               WHERE fm.notify_on_response
                 AND fm.state = 'active'
                 AND EXISTS (
                   SELECT 1 FROM responses r
                   WHERE r.form_id = fm.form_id
                     AND r.created_at > COALESCE(fm.last_notified_at, fm.created_at)
                 )
             ) AS "oldest_pending_at?"
           FROM form_members fm
           JOIN users u ON u.id = fm.user_id AND u.suspended_at IS NULL"#,
        cooldown,
    )
    .fetch_one(db)
    .await?;

    Ok(NotificationBacklog {
        due: row.due,
        backing_off: row.backing_off,
        oldest_pending_at: row.oldest_pending_at,
    })
}

/// Claims one member, sends, and stamps the watermark in a single transaction.
///
/// The send is inside the transaction so a failure rolls back and the next
/// sweep retries rather than silently burning the notification. That makes
/// delivery at-least-once: a crash between a successful send and the commit
/// repeats an email. That is the right way round: a duplicate is an
/// annoyance, a dropped notification is the thing this feature exists to
/// prevent.
async fn notify_member(
    db: &PgPool,
    mailer: &Mailer,
    web_base_url: &str,
    member: &DueMember,
    cooldown_seconds: i64,
) -> anyhow::Result<()> {
    let mut transaction = db.begin().await?;
    let cooldown = cooldown_seconds as f64;

    // SKIP LOCKED so a second API instance sweeping concurrently cannot claim
    // the same row and send twice. The cooldown is re-checked here, under the
    // lock, rather than trusted from the candidate snapshot: up to 200 rows
    // are processed sequentially with a network send each, so by the time a
    // given row is claimed the snapshot can be minutes old, and another
    // instance (or an earlier pass) may already have stamped it since.
    let claimed = sqlx::query!(
        "SELECT last_notified_at, created_at
         FROM form_members
         WHERE id = $1 AND notify_on_response AND state = 'active'
           AND (
             last_notified_at IS NULL
             OR last_notified_at <= now() - $2 * interval '1 second'
           )
         FOR UPDATE SKIP LOCKED",
        member.member_id,
        cooldown,
    )
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(claimed) = claimed else {
        transaction.commit().await?;
        return Ok(());
    };

    // COALESCE onto the member's own created_at is load-bearing: without it a
    // collaborator who joins a form with 500 existing responses is told about
    // all 500 the moment they accept.
    let watermark = claimed.last_notified_at.unwrap_or(claimed.created_at);
    let counted = sqlx::query!(
        "SELECT count(*) AS \"count!\", max(created_at) AS newest
         FROM responses
         WHERE form_id = $1 AND created_at > $2",
        member.form_id,
        watermark,
    )
    .fetch_one(&mut *transaction)
    .await?;

    if counted.count == 0 {
        transaction.commit().await?;
        return Ok(());
    }

    let lang = mail::language_for_email(db, &member.email).await;
    tokio::time::timeout(
        std::time::Duration::from_secs(MAIL_SEND_TIMEOUT_SECS),
        mailer.send(mail::response_notification_mail(
            &member.email,
            member.form_id,
            counted.count,
            web_base_url,
            lang,
        )),
    )
    .await
    .map_err(|_| anyhow::anyhow!("response notification send timed out"))??;

    // Stamp the newest response actually counted, not now(). responses.created_at
    // defaults to the inserting transaction's start time. If that transaction
    // began before this sweep's transaction but committed after the count above
    // took its snapshot, now() here would already be later than that response's
    // created_at, permanently skipping it from every future count. Stamping
    // max(created_at) instead narrows that window rather than closing it: a
    // response whose transaction began before this sweep's but committed after
    // the count's snapshot can still carry a created_at older than the maximum
    // stamped here, and stays permanently skipped.
    let newest = counted
        .newest
        .ok_or_else(|| anyhow::anyhow!("counted responses but found no newest timestamp"))?;
    // Cleared in the same transaction as the watermark, so a delivery that
    // succeeds but fails to commit leaves the backoff intact rather than
    // resetting it for a send the recipient never received.
    sqlx::query!(
        "UPDATE form_members
         SET last_notified_at = $1, notify_failure_count = 0, notify_retry_after = NULL
         WHERE id = $2",
        newest,
        member.member_id,
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

/// Schedules the next attempt for a member whose delivery just failed.
///
/// Deliberately its own statement rather than part of `notify_member`'s
/// transaction: that transaction rolls back on a failed send, which is what
/// preserves the retry, and an increment written inside it would roll back with
/// everything else and leave the count permanently at zero.
///
/// The delay doubles per consecutive failure and is capped at a day, so a
/// transient outage recovers within minutes while a genuinely dead address
/// settles at one attempt per day instead of one per sweep. Nothing here gives
/// up on a member: `notify_retry_after` only defers, because a dropped
/// notification is the thing this feature exists to prevent.
async fn record_delivery_failure(db: &PgPool, member_id: Uuid) -> anyhow::Result<()> {
    sqlx::query!(
        "UPDATE form_members
         SET notify_failure_count = notify_failure_count + 1,
             notify_retry_after = now() + make_interval(
                 mins => least(power(2, notify_failure_count)::int, $2)
             )
         WHERE id = $1",
        member_id,
        MAX_NOTIFY_BACKOFF_MINUTES,
    )
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::Mailer;

    async fn test_db() -> PgPool {
        crate::test_db::pool().await
    }

    /// A member on a form that already has one response, so the sweep's
    /// `EXISTS` clause is satisfied. Returns the user, member and form ids,
    /// so the caller can tear the fixture down with `drop_fixture`.
    async fn insert_member_with_response(
        db: &PgPool,
        notify: bool,
        retry_after_seconds: Option<i64>,
        failure_count: i32,
    ) -> (Uuid, Uuid, Uuid) {
        let user_id = Uuid::now_v7();
        let form_id = Uuid::now_v7();
        let member_id = Uuid::now_v7();
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash)
             VALUES ($1, $2, 'backlog-test-hash')",
            user_id,
            format!("backlog-{}@example.com", Uuid::now_v7()),
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO forms (id, title_ciphertext, schema_ciphertext, form_public_key)
             VALUES ($1, 'ct', 'ct', 'pk')",
            form_id,
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO form_members (
                 id, form_id, user_id, role, state, key_scheme,
                 encrypted_form_data_key, encrypted_form_private_key,
                 notify_on_response, notify_failure_count, notify_retry_after
             ) VALUES (
                 $1, $2, $3, 'owner', 'active', 'master_wrap_v1', 'k', 'k',
                 $4, $5,
                 CASE WHEN $6::bigint IS NULL THEN NULL
                      ELSE now() + ($6::bigint * interval '1 second') END
             )",
            member_id,
            form_id,
            user_id,
            notify,
            failure_count,
            retry_after_seconds,
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO responses (id, form_id, ciphertext) VALUES ($1, $2, 'ct')",
            Uuid::now_v7(),
            form_id,
        )
        .execute(db)
        .await
        .unwrap();
        (user_id, member_id, form_id)
    }

    /// A form owned by a fresh user, notifications on, no watermark.
    async fn form_with_notifying_owner(db: &PgPool) -> (Uuid, Uuid, String) {
        let owner_id = Uuid::now_v7();
        let form_id = Uuid::now_v7();
        let email = format!("notify-{owner_id}@example.com");
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash)
             VALUES ($1, $2, 'notify-test-hash')",
            owner_id,
            email,
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO forms (id, title_ciphertext, schema_ciphertext, form_public_key)
             VALUES ($1, 'title', 'schema', 'public-key')",
            form_id,
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO form_members (
                id, form_id, user_id, role, state, key_scheme,
                encrypted_form_data_key, encrypted_form_private_key, notify_on_response
             ) VALUES ($1, $2, $3, 'owner', 'active', 'master_wrap_v1',
                       'data-key', 'private-key', true)",
            Uuid::now_v7(),
            form_id,
            owner_id,
        )
        .execute(db)
        .await
        .unwrap();
        (owner_id, form_id, email)
    }

    async fn add_responses(db: &PgPool, form_id: Uuid, count: usize) {
        for _ in 0..count {
            sqlx::query!(
                "INSERT INTO responses (id, form_id, ciphertext) VALUES ($1, $2, 'sealed')",
                Uuid::now_v7(),
                form_id,
            )
            .execute(db)
            .await
            .unwrap();
        }
    }

    /// Adds a second notifying editor to an existing form, before any
    /// responses are inserted, so their watermark is the membership's own
    /// `created_at` just like the owner's.
    async fn add_notifying_editor(db: &PgPool, form_id: Uuid) -> (Uuid, String) {
        let editor_id = Uuid::now_v7();
        let editor_email = format!("editor-{editor_id}@example.com");
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash)
             VALUES ($1, $2, 'notify-test-hash')",
            editor_id,
            editor_email,
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO form_members (
                id, form_id, user_id, role, state, key_scheme,
                encrypted_form_data_key, encrypted_form_private_key, notify_on_response
             ) VALUES ($1, $2, $3, 'editor', 'active', 'account_sealed_box_v1',
                       'data-key', 'private-key', true)",
            Uuid::now_v7(),
            form_id,
            editor_id,
        )
        .execute(db)
        .await
        .unwrap();
        (editor_id, editor_email)
    }

    async fn drop_fixture(db: &PgPool, owner_id: Uuid, form_id: Uuid) {
        sqlx::query!("DELETE FROM forms WHERE id = $1", form_id)
            .execute(db)
            .await
            .unwrap();
        sqlx::query!("DELETE FROM users WHERE id = $1", owner_id)
            .execute(db)
            .await
            .unwrap();
    }

    fn sent_to(mailer: &Mailer, email: &str) -> Vec<crate::mail::Mail> {
        mailer
            .captured()
            .into_iter()
            .filter(|mail| mail.to == email)
            .collect()
    }

    #[tokio::test]
    async fn a_burst_produces_one_email_carrying_the_count() {
        let db = test_db().await;
        let mailer = Mailer::capture();
        let (owner_id, form_id, email) = form_with_notifying_owner(&db).await;
        add_responses(&db, form_id, 12).await;

        run_once(&db, &mailer, "https://krypta.example", 3600)
            .await
            .unwrap();

        let sent = sent_to(&mailer, &email);
        assert_eq!(sent.len(), 1);
        assert!(sent[0].text.contains("12 new responses"));

        drop_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn a_second_pass_inside_the_cooldown_sends_nothing() {
        let db = test_db().await;
        let mailer = Mailer::capture();
        let (owner_id, form_id, email) = form_with_notifying_owner(&db).await;
        add_responses(&db, form_id, 2).await;

        run_once(&db, &mailer, "https://krypta.example", 3600)
            .await
            .unwrap();
        add_responses(&db, form_id, 5).await;
        run_once(&db, &mailer, "https://krypta.example", 3600)
            .await
            .unwrap();

        assert_eq!(sent_to(&mailer, &email).len(), 1);

        drop_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn a_pass_after_the_cooldown_reports_only_the_new_responses() {
        let db = test_db().await;
        let mailer = Mailer::capture();
        let (owner_id, form_id, email) = form_with_notifying_owner(&db).await;
        add_responses(&db, form_id, 2).await;

        run_once(&db, &mailer, "https://krypta.example", 3600)
            .await
            .unwrap();
        add_responses(&db, form_id, 5).await;
        // A zero cooldown makes the window lapse immediately.
        run_once(&db, &mailer, "https://krypta.example", 0)
            .await
            .unwrap();

        let sent = sent_to(&mailer, &email);
        assert_eq!(sent.len(), 2);
        assert!(sent[1].text.contains("5 new responses"));

        drop_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn a_lapsed_cooldown_with_no_new_responses_sends_nothing() {
        let db = test_db().await;
        let mailer = Mailer::capture();
        let (owner_id, form_id, email) = form_with_notifying_owner(&db).await;
        add_responses(&db, form_id, 3).await;

        run_once(&db, &mailer, "https://krypta.example", 0)
            .await
            .unwrap();
        run_once(&db, &mailer, "https://krypta.example", 0)
            .await
            .unwrap();

        assert_eq!(sent_to(&mailer, &email).len(), 1);

        drop_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn a_member_who_opted_out_is_never_mailed() {
        let db = test_db().await;
        let mailer = Mailer::capture();
        let (owner_id, form_id, email) = form_with_notifying_owner(&db).await;
        sqlx::query!(
            "UPDATE form_members SET notify_on_response = false WHERE form_id = $1",
            form_id,
        )
        .execute(&db)
        .await
        .unwrap();

        // Positive control: a second notifying member on the same form proves
        // the sweep actually reached this form, so the owner's empty inbox
        // below means "opted out", not "never swept."
        let (editor_id, editor_email) = add_notifying_editor(&db, form_id).await;

        add_responses(&db, form_id, 4).await;

        run_once(&db, &mailer, "https://krypta.example", 0)
            .await
            .unwrap();

        assert_eq!(sent_to(&mailer, &editor_email).len(), 1);
        assert!(sent_to(&mailer, &email).is_empty());

        drop_fixture(&db, owner_id, form_id).await;
        sqlx::query!("DELETE FROM users WHERE id = $1", editor_id)
            .execute(&db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_member_is_not_told_about_responses_that_predate_them() {
        let db = test_db().await;
        let mailer = Mailer::capture();
        let (owner_id, form_id, owner_email) = form_with_notifying_owner(&db).await;
        add_responses(&db, form_id, 6).await;

        // A collaborator who joins now must not hear about those six.
        let joiner_id = Uuid::now_v7();
        let joiner_email = format!("joiner-{joiner_id}@example.com");
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash)
             VALUES ($1, $2, 'notify-test-hash')",
            joiner_id,
            joiner_email,
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO form_members (
                id, form_id, user_id, role, state, key_scheme,
                encrypted_form_data_key, encrypted_form_private_key, notify_on_response
             ) VALUES ($1, $2, $3, 'editor', 'active', 'account_sealed_box_v1',
                       'data-key', 'private-key', true)",
            Uuid::now_v7(),
            form_id,
            joiner_id,
        )
        .execute(&db)
        .await
        .unwrap();

        run_once(&db, &mailer, "https://krypta.example", 0)
            .await
            .unwrap();

        // Positive control: the owner IS due for those six and should hear
        // about them, proving the sweep reached this form at all, so the
        // joiner's empty inbox below means "predates membership," not "never
        // swept."
        assert_eq!(sent_to(&mailer, &owner_email).len(), 1);
        assert!(
            sent_to(&mailer, &joiner_email).is_empty(),
            "a new member was told about history that predates their membership",
        );

        drop_fixture(&db, owner_id, form_id).await;
        sqlx::query!("DELETE FROM users WHERE id = $1", joiner_id)
            .execute(&db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_suspended_user_is_never_mailed() {
        let db = test_db().await;
        let mailer = Mailer::capture();
        let (owner_id, form_id, email) = form_with_notifying_owner(&db).await;
        sqlx::query!(
            "UPDATE users SET suspended_at = now() WHERE id = $1",
            owner_id,
        )
        .execute(&db)
        .await
        .unwrap();

        // Positive control: a second notifying member on the same form proves
        // the sweep actually reached this form, so the suspended owner's
        // empty inbox below means "suspended", not "never swept."
        let (editor_id, editor_email) = add_notifying_editor(&db, form_id).await;

        add_responses(&db, form_id, 3).await;

        run_once(&db, &mailer, "https://krypta.example", 0)
            .await
            .unwrap();

        assert_eq!(sent_to(&mailer, &editor_email).len(), 1);
        assert!(sent_to(&mailer, &email).is_empty());

        drop_fixture(&db, owner_id, form_id).await;
        sqlx::query!("DELETE FROM users WHERE id = $1", editor_id)
            .execute(&db)
            .await
            .unwrap();
    }

    async fn backoff_state(db: &PgPool, form_id: Uuid) -> (i32, bool) {
        let row = sqlx::query!(
            "SELECT notify_failure_count, notify_retry_after
             FROM form_members WHERE form_id = $1",
            form_id,
        )
        .fetch_one(db)
        .await
        .unwrap();
        (row.notify_failure_count, row.notify_retry_after.is_some())
    }

    /// A failed send must schedule a retry rather than leaving the member at
    /// the head of the queue, which is what let one bad address be retried on
    /// every sweep forever.
    #[tokio::test]
    async fn a_failed_send_schedules_a_retry_instead_of_returning_immediately() {
        let db = test_db().await;
        let (owner_id, form_id, _) = form_with_notifying_owner(&db).await;
        add_responses(&db, form_id, 1).await;

        run_once(&db, &Mailer::failing(), "https://krypta.example", 3600)
            .await
            .unwrap();

        let (failures, has_retry_after) = backoff_state(&db, form_id).await;
        assert_eq!(failures, 1, "a failed send must be counted");
        assert!(
            has_retry_after,
            "a failed send must schedule a retry, or the member stays at the queue head forever"
        );

        drop_fixture(&db, owner_id, form_id).await;
    }

    /// The property this whole change exists for: a member that is backing off
    /// must not consume a slot in the batch, so healthy members still get mail.
    #[tokio::test]
    async fn a_backing_off_member_does_not_starve_a_healthy_one() {
        let db = test_db().await;
        let (failing_owner, failing_form, failing_email) = form_with_notifying_owner(&db).await;
        add_responses(&db, failing_form, 1).await;

        // Burn one delivery so this member is now backing off.
        run_once(&db, &Mailer::failing(), "https://krypta.example", 3600)
            .await
            .unwrap();

        let (healthy_owner, healthy_form, healthy_email) = form_with_notifying_owner(&db).await;
        add_responses(&db, healthy_form, 1).await;

        let mailer = Mailer::capture();
        run_once(&db, &mailer, "https://krypta.example", 3600)
            .await
            .unwrap();

        assert_eq!(
            sent_to(&mailer, &healthy_email).len(),
            1,
            "a healthy member must still be notified while another is backing off"
        );
        assert!(
            sent_to(&mailer, &failing_email).is_empty(),
            "a backing-off member must be excluded from the batch until its retry is due"
        );

        drop_fixture(&db, failing_owner, failing_form).await;
        drop_fixture(&db, healthy_owner, healthy_form).await;
    }

    /// Backoff must not be sticky: one bad hour cannot leave a working address
    /// permanently delayed.
    #[tokio::test]
    async fn a_successful_send_clears_the_backoff() {
        let db = test_db().await;
        let (owner_id, form_id, email) = form_with_notifying_owner(&db).await;
        add_responses(&db, form_id, 1).await;

        run_once(&db, &Mailer::failing(), "https://krypta.example", 3600)
            .await
            .unwrap();
        // Clear the scheduled retry so the next sweep considers the member,
        // standing in for the retry window having elapsed.
        sqlx::query!(
            "UPDATE form_members SET notify_retry_after = NULL WHERE form_id = $1",
            form_id,
        )
        .execute(&db)
        .await
        .unwrap();

        let mailer = Mailer::capture();
        run_once(&db, &mailer, "https://krypta.example", 3600)
            .await
            .unwrap();

        assert_eq!(sent_to(&mailer, &email).len(), 1);
        let (failures, has_retry_after) = backoff_state(&db, form_id).await;
        assert_eq!(failures, 0, "a success must reset the failure count");
        assert!(!has_retry_after, "a success must clear the scheduled retry");

        drop_fixture(&db, owner_id, form_id).await;
    }

    /// The count must agree with what the sweep would actually select.
    ///
    /// `sqlx::query!` takes a string literal and cannot interpolate a shared
    /// constant, and the project forbids runtime-checked SQL, so the due
    /// predicate is necessarily written twice. This is what keeps the two
    /// copies honest: a number that is nearly right is worse on a monitoring
    /// page than no number at all.
    ///
    /// The comparison is scoped to this test's own fixtures, never to a
    /// global snapshot: `backlog` counts the whole table, and comparing it
    /// against a `LIMIT 200` query's length raced any sibling test creating
    /// a due member of its own. A before/after delta around fixtures this
    /// test owns and always tears down is what keeps the assertion honest
    /// regardless of what else is in the table.
    #[tokio::test]
    async fn the_backlog_count_agrees_with_what_the_sweep_selects() {
        let db = test_db().await;
        let cooldown = 3600_i64;

        let before = backlog(&db, cooldown).await.unwrap();

        // A member with an unseen response: due.
        let (due_user, due_member, due_form) =
            insert_member_with_response(&db, true, None, 0).await;
        let due_watermark = sqlx::query!(
            "SELECT created_at FROM form_members WHERE id = $1",
            due_member,
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .created_at;
        // A member in retry backoff: not due, but counted as backing off.
        let (backoff_user, backoff_member, backoff_form) =
            insert_member_with_response(&db, true, Some(3600), 2).await;
        // Notifications off: neither.
        let (off_user, off_member, off_form) =
            insert_member_with_response(&db, false, None, 0).await;

        let report = backlog(&db, cooldown).await.unwrap();
        // due_members carries LIMIT 200 and backlog deliberately does not, so
        // the counts only agree while the queue is under that page size. The
        // fixtures here are three rows, well under it.
        let swept: Vec<Uuid> = due_members(&db, cooldown)
            .await
            .unwrap()
            .into_iter()
            .map(|member| member.member_id)
            .collect();

        assert!(
            swept.contains(&due_member),
            "the due fixture should be swept"
        );
        assert!(
            !swept.contains(&backoff_member),
            "a backing-off fixture must not be swept"
        );
        assert!(
            !swept.contains(&off_member),
            "a fixture with notifications off must not be swept"
        );

        assert_eq!(
            report.due - before.due,
            1,
            "backlog.due must move by exactly one for this test's one due fixture"
        );
        assert_eq!(
            report.backing_off - before.backing_off,
            1,
            "backlog.backing_off must move by exactly one for this test's one backing-off fixture"
        );
        // The due fixture was inserted before the backing-off one, so its
        // watermark is the earlier of the two this test contributes. Fold in
        // whatever the table already held before this test's fixtures, so
        // the assertion stays exact without assuming an otherwise-empty
        // table.
        let expected_oldest = match before.oldest_pending_at {
            Some(existing) if existing < due_watermark => existing,
            _ => due_watermark,
        };
        assert_eq!(
            report.oldest_pending_at,
            Some(expected_oldest),
            "oldest_pending_at must equal the earlier of the prior watermark and this test's own due fixture"
        );

        drop_fixture(&db, due_user, due_form).await;
        drop_fixture(&db, backoff_user, backoff_form).await;
        drop_fixture(&db, off_user, off_form).await;
    }
}
