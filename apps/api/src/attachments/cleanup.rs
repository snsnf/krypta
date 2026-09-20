use sqlx::PgPool;
use uuid::Uuid;

use super::storage::Storage;

/// How long a finished upload may sit unreferenced before it is reclaimed.
///
/// A respondent can upload a file, leave, and come back to their saved draft,
/// which keeps its answers (including the attachment id) for 30 days; see
/// `DRAFT_MAX_AGE_MS` in `apps/web/lib/form-draft.ts`. Reclaiming sooner
/// would delete the file under a draft that is still allowed to be submitted,
/// so this is that lifetime plus a day. Shortening either one means
/// revisiting the other.
pub(crate) const UNCLAIMED_ATTACHMENT_TTL_SECONDS: i64 = 31 * 24 * 60 * 60;

/// Reconciles uploads that crashed or whose object could not be removed.
///
/// Candidate discovery never locks child rows. Every lifecycle mutation locks
/// the form first and then its attachment, preserving the form-first order used
/// by response submission, collaborator mutation, upload, and form deletion.
pub fn spawn(db: PgPool, storage: Storage, stale_seconds: i64, cleanup_interval_seconds: u64) {
    tokio::spawn(async move {
        loop {
            if run_once(&db, &storage, stale_seconds).await.is_err() {
                tracing::error!(
                    failure_kind = "attachment_cleanup",
                    "attachment lifecycle cleanup failed"
                );
            }
            tokio::time::sleep(std::time::Duration::from_secs(cleanup_interval_seconds)).await;
        }
    });
}

async fn run_once(db: &PgPool, storage: &Storage, stale_seconds: i64) -> anyhow::Result<()> {
    let stale_seconds_for_query = stale_seconds as f64;
    let unclaimed_seconds = UNCLAIMED_ATTACHMENT_TTL_SECONDS as f64;
    let form_ids = sqlx::query_scalar!(
        r#"SELECT DISTINCT form_id
           FROM attachments
           WHERE upload_state = 'cleanup_pending'
              OR (
                  upload_state = 'uploading'
                  AND lifecycle_updated_at <= now() - $1 * interval '1 second'
              )
              OR (
                  upload_state = 'ready'
                  AND claimed_at IS NULL
                  AND upload_completed_at <= now() - $2 * interval '1 second'
              )
           ORDER BY form_id
           LIMIT 100"#,
        stale_seconds_for_query,
        unclaimed_seconds,
    )
    .fetch_all(db)
    .await?;

    for form_id in form_ids {
        let attachment_ids = prepare_form_cleanup(db, form_id, stale_seconds).await?;
        for attachment_id in attachment_ids {
            if cleanup_attachment(db, storage, form_id, attachment_id)
                .await
                .is_err()
            {
                tracing::warn!(
                    form_id = %form_id,
                    attachment_id = %attachment_id,
                    failure_kind = "attachment_object_cleanup",
                    "attachment object cleanup will be retried"
                );
            }
        }
    }
    Ok(())
}

async fn prepare_form_cleanup(
    db: &PgPool,
    form_id: Uuid,
    stale_seconds: i64,
) -> anyhow::Result<Vec<Uuid>> {
    let stale_seconds = stale_seconds as f64;
    let mut transaction = db.begin().await?;
    let form_exists =
        sqlx::query_scalar!("SELECT id FROM forms WHERE id = $1 FOR UPDATE", form_id,)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some();
    if !form_exists {
        transaction.commit().await?;
        return Ok(Vec::new());
    }

    sqlx::query!(
        r#"UPDATE attachments
           SET upload_state = 'cleanup_pending', lifecycle_updated_at = now()
           WHERE form_id = $1
             AND upload_state = 'uploading'
             AND lifecycle_updated_at <= now() - $2 * interval '1 second'"#,
        form_id,
        stale_seconds,
    )
    .execute(&mut *transaction)
    .await?;
    // A finished upload no response and no header ever referenced. The header
    // clause is defensive: update_form stamps the header it points at, but a
    // row the form is currently serving must never be reclaimed whatever its
    // stamp says.
    let unclaimed_seconds = UNCLAIMED_ATTACHMENT_TTL_SECONDS as f64;
    sqlx::query!(
        r#"UPDATE attachments
           SET upload_state = 'cleanup_pending', lifecycle_updated_at = now()
           WHERE form_id = $1
             AND upload_state = 'ready'
             AND claimed_at IS NULL
             AND upload_completed_at <= now() - $2 * interval '1 second'
             AND id IS DISTINCT FROM (
                 SELECT header_attachment_id FROM forms WHERE id = $1
             )"#,
        form_id,
        unclaimed_seconds,
    )
    .execute(&mut *transaction)
    .await?;
    let attachment_ids = sqlx::query_scalar!(
        "SELECT id FROM attachments
         WHERE form_id = $1 AND upload_state = 'cleanup_pending'
         ORDER BY id
         FOR UPDATE",
        form_id,
    )
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(attachment_ids)
}

pub(crate) async fn mark_cleanup_pending(
    db: &PgPool,
    form_id: Uuid,
    attachment_id: Uuid,
) -> anyhow::Result<bool> {
    let mut transaction = db.begin().await?;
    let form_exists =
        sqlx::query_scalar!("SELECT id FROM forms WHERE id = $1 FOR UPDATE", form_id,)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some();
    let transitioned = if form_exists {
        sqlx::query!(
            "UPDATE attachments
             SET upload_state = 'cleanup_pending', lifecycle_updated_at = now()
             WHERE id = $1 AND form_id = $2 AND upload_state = 'uploading'",
            attachment_id,
            form_id,
        )
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1
    } else {
        false
    };
    transaction.commit().await?;
    Ok(transitioned)
}

/// Transitions an attachment to `cleanup_pending` because the owner deleted
/// the response that referenced it. The predicate is `upload_state <>
/// 'cleanup_pending'`, so it accepts `ready` and `uploading` alike: the
/// caller holds the form lock, so no upload can be concurrently finalizing,
/// and `upload_attachment`'s finalize re-checks `upload_state = 'uploading'`
/// and fails cleanly if this already moved it, so accepting `uploading` here
/// is safe rather than a narrowing worth undoing.
///
/// Deliberately separate from `mark_cleanup_pending`, which transitions only
/// `uploading` rows and is asserted to refuse `ready` ones. That guard exists so
/// crash recovery can never destroy a committed upload; this is the opposite
/// case, a person asked for the file to go, and giving it its own function
/// keeps the guard's meaning intact.
///
/// Runs inside the caller's transaction so the response row and its attachments
/// commit or roll back together, and therefore does NOT lock the form: the
/// caller has already taken that lock, preserving the form-first order every
/// other attachment path uses.
///
/// Returns false when no attachment with that id belongs to that form, which
/// the caller treats as a failed request rather than a no-op.
pub(crate) async fn mark_deleted_by_owner(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    form_id: Uuid,
    attachment_id: Uuid,
) -> anyhow::Result<bool> {
    let transitioned = sqlx::query!(
        "UPDATE attachments
         SET upload_state = 'cleanup_pending', lifecycle_updated_at = now()
         WHERE id = $1 AND form_id = $2 AND upload_state <> 'cleanup_pending'",
        attachment_id,
        form_id,
    )
    .execute(&mut **transaction)
    .await?
    .rows_affected()
        == 1;
    Ok(transitioned)
}

/// Marks finished uploads as referenced, so the reaper leaves them alone.
///
/// The server cannot see which files a response names, because that link is
/// inside the ciphertext, so the client sends the ids alongside it, exactly as
/// response deletion already does. An id that names nothing claimable on this
/// form is ignored rather than rejected: the worst a wrong id can do is keep
/// an upload alive that would otherwise have been reclaimed, and failing the
/// submission over it would lose the respondent's answers instead.
pub(crate) async fn claim_attachments(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    form_id: Uuid,
    attachment_ids: &[Uuid],
) -> sqlx::Result<()> {
    if attachment_ids.is_empty() {
        return Ok(());
    }
    sqlx::query!(
        "UPDATE attachments
         SET claimed_at = now()
         WHERE form_id = $1
           AND id = ANY($2)
           AND upload_state = 'ready'
           AND claimed_at IS NULL",
        form_id,
        attachment_ids,
    )
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UploadReconcileOutcome {
    Ready,
    Cleaned,
    MissingCleaned,
}

/// Resolves an upload whose transaction outcome is uncertain without ever
/// deleting storage while a committed `ready` row may remain.
pub(crate) async fn reconcile_upload(
    db: &PgPool,
    storage: &Storage,
    form_id: Uuid,
    attachment_id: Uuid,
) -> anyhow::Result<UploadReconcileOutcome> {
    // This conditional mark is non-destructive for ready/missing rows. If the
    // following fresh inspection fails, pending/uploading metadata remains and
    // background reconciliation can retry without risking a committed object.
    let _ = mark_cleanup_pending(db, form_id, attachment_id).await?;

    let mut transaction = db.begin().await?;
    let form_exists =
        sqlx::query_scalar!("SELECT id FROM forms WHERE id = $1 FOR UPDATE", form_id,)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some();
    if !form_exists {
        transaction.commit().await?;
        let key = format!("attachments/{form_id}/{attachment_id}");
        storage.delete(&key).await?;
        return Ok(UploadReconcileOutcome::MissingCleaned);
    }

    let upload_state = sqlx::query_scalar!(
        "SELECT upload_state FROM attachments
         WHERE id = $1 AND form_id = $2
         FOR UPDATE",
        attachment_id,
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await?;
    match upload_state.as_deref() {
        Some("ready") => {
            transaction.commit().await?;
            Ok(UploadReconcileOutcome::Ready)
        }
        Some("uploading") => {
            let transitioned = sqlx::query!(
                "UPDATE attachments
                 SET upload_state = 'cleanup_pending', lifecycle_updated_at = now()
                 WHERE id = $1 AND form_id = $2 AND upload_state = 'uploading'",
                attachment_id,
                form_id,
            )
            .execute(&mut *transaction)
            .await?;
            if transitioned.rows_affected() != 1 {
                anyhow::bail!("attachment upload state changed during reconciliation");
            }
            transaction.commit().await?;
            cleanup_attachment(db, storage, form_id, attachment_id).await?;
            Ok(UploadReconcileOutcome::Cleaned)
        }
        Some("cleanup_pending") => {
            transaction.commit().await?;
            cleanup_attachment(db, storage, form_id, attachment_id).await?;
            Ok(UploadReconcileOutcome::Cleaned)
        }
        Some(_) => anyhow::bail!("invalid attachment upload state"),
        None => {
            transaction.commit().await?;
            let key = format!("attachments/{form_id}/{attachment_id}");
            storage.delete(&key).await?;
            Ok(UploadReconcileOutcome::MissingCleaned)
        }
    }
}

/// Deletes the object before removing its only persisted retry reference.
/// A missing object is successful because `Storage::delete` is idempotent.
pub(crate) async fn cleanup_attachment(
    db: &PgPool,
    storage: &Storage,
    form_id: Uuid,
    attachment_id: Uuid,
) -> anyhow::Result<()> {
    let key = format!("attachments/{form_id}/{attachment_id}");

    // Confirm the destructive state using the global form-first order. Once a
    // row is cleanup_pending there is no transition back to ready, so storage
    // deletion remains safe after releasing this short transaction.
    let mut verification = db.begin().await?;
    let form_exists =
        sqlx::query_scalar!("SELECT id FROM forms WHERE id = $1 FOR UPDATE", form_id,)
            .fetch_optional(&mut *verification)
            .await?
            .is_some();
    let may_delete = if form_exists {
        let upload_state = sqlx::query_scalar!(
            "SELECT upload_state FROM attachments
             WHERE id = $1 AND form_id = $2
             FOR UPDATE",
            attachment_id,
            form_id,
        )
        .fetch_optional(&mut *verification)
        .await?;
        matches!(upload_state.as_deref(), Some("cleanup_pending") | None)
    } else {
        true
    };
    verification.commit().await?;
    if !may_delete {
        return Ok(());
    }

    storage.delete(&key).await?;

    let mut transaction = db.begin().await?;
    let form_exists =
        sqlx::query_scalar!("SELECT id FROM forms WHERE id = $1 FOR UPDATE", form_id,)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some();
    if !form_exists {
        transaction.commit().await?;
        return Ok(());
    }

    let owner_id = sqlx::query_scalar!(
        "SELECT user_id
         FROM form_members
         WHERE form_id = $1 AND role = 'owner' AND state = 'active'
         FOR UPDATE",
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| anyhow::anyhow!("missing active owner during attachment cleanup"))?;

    let byte_size = sqlx::query_scalar!(
        "DELETE FROM attachments
         WHERE id = $1 AND form_id = $2 AND upload_state = 'cleanup_pending'
         RETURNING byte_size",
        attachment_id,
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await?;
    if let Some(byte_size) = byte_size {
        sqlx::query!(
            "UPDATE forms
             SET attachment_count = GREATEST(attachment_count - 1, 0),
                 attachment_bytes = GREATEST(attachment_bytes - $1, 0)
             WHERE id = $2",
            byte_size,
            form_id,
        )
        .execute(&mut *transaction)
        .await?;
        crate::admin::settings::release_attachment_bytes(&mut transaction, owner_id, byte_size)
            .await
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    }
    transaction.commit().await?;
    Ok(())
}

/// What the attachment reaper still owes.
///
/// `stale_uploads` is the interesting number: a reservation older than the
/// stale window means the reaper has stopped draining, which produces no
/// error anyone sees and no external check notices.
pub(crate) struct CleanupBacklog {
    pub cleanup_pending: i64,
    pub stale_uploads: i64,
    pub oldest_pending_at: Option<time::OffsetDateTime>,
}

pub(crate) async fn backlog(db: &PgPool, stale_seconds: i64) -> sqlx::Result<CleanupBacklog> {
    let stale = stale_seconds as f64;
    let row = sqlx::query!(
        r#"SELECT
             count(*) FILTER (WHERE upload_state = 'cleanup_pending')
               AS "cleanup_pending!",
             count(*) FILTER (
               WHERE upload_state = 'uploading'
                 AND lifecycle_updated_at <= now() - $1 * interval '1 second'
             ) AS "stale_uploads!",
             min(lifecycle_updated_at) FILTER (WHERE upload_state = 'cleanup_pending')
               AS "oldest_pending_at?"
           FROM attachments"#,
        stale,
    )
    .fetch_one(db)
    .await?;

    Ok(CleanupBacklog {
        cleanup_pending: row.cleanup_pending,
        stale_uploads: row.stale_uploads,
        oldest_pending_at: row.oldest_pending_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_storage() -> Storage {
        dotenvy::dotenv().ok();
        Storage::new(
            std::env::var("S3_ENDPOINT").unwrap(),
            std::env::var("S3_REGION").unwrap_or_else(|_| "garage".to_string()),
            std::env::var("S3_ACCESS_KEY").unwrap(),
            std::env::var("S3_SECRET_KEY").unwrap(),
            std::env::var("S3_BUCKET").unwrap(),
            5,
        )
        .unwrap()
    }

    async fn ready_attachment(db: &PgPool) -> (Uuid, Uuid, Uuid) {
        let owner_id = Uuid::now_v7();
        let form_id = Uuid::now_v7();
        let attachment_id = Uuid::now_v7();
        let owner_email = format!("attachment-reconcile-{owner_id}@example.com");
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash)
             VALUES ($1, $2, 'attachment-reconcile-hash')",
            owner_id,
            owner_email,
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO forms (
                id, title_ciphertext, schema_ciphertext, form_public_key,
                attachment_count, attachment_bytes
             ) VALUES (
                $1, 'title', 'schema', 'public-key', 1, 3
             )",
            form_id,
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO form_members (
                id, form_id, user_id, role, state, key_scheme,
                encrypted_form_data_key, encrypted_form_private_key
             ) VALUES (
                $1, $2, $3, 'owner', 'active', 'master_wrap_v1',
                'data-key', 'private-key'
             )",
            Uuid::now_v7(),
            form_id,
            owner_id,
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO attachments (id, form_id, byte_size)
             VALUES ($1, $2, 3)",
            attachment_id,
            form_id,
        )
        .execute(db)
        .await
        .unwrap();
        (owner_id, form_id, attachment_id)
    }

    async fn delete_fixture(db: &PgPool, owner_id: Uuid, form_id: Uuid) {
        sqlx::query!("DELETE FROM forms WHERE id = $1", form_id)
            .execute(db)
            .await
            .unwrap();
        sqlx::query!("DELETE FROM users WHERE id = $1", owner_id)
            .execute(db)
            .await
            .unwrap();
    }

    /// Held by every test here that moves a row into a state `backlog`
    /// counts. The backlog test compares two table-wide counts, so a
    /// transition made by a parallel test between them reads as its own.
    async fn backlog_counts_lock() -> tokio::sync::MutexGuard<'static, ()> {
        static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        LOCK.lock().await
    }

    async fn backdate_completion(db: &PgPool, attachment_id: Uuid, seconds: i64) {
        sqlx::query(
            "UPDATE attachments
             SET upload_completed_at = now() - $2 * interval '1 second'
             WHERE id = $1",
        )
        .bind(attachment_id)
        .bind(seconds as f64)
        .execute(db)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn an_unclaimed_upload_past_its_lifetime_is_reclaimed() {
        let _counts = backlog_counts_lock().await;
        let db = crate::test_db::pool().await;
        let (owner_id, form_id, attachment_id) = ready_attachment(&db).await;
        backdate_completion(&db, attachment_id, UNCLAIMED_ATTACHMENT_TTL_SECONDS + 60).await;

        let reclaimed = prepare_form_cleanup(&db, form_id, 60).await.unwrap();

        assert_eq!(reclaimed, vec![attachment_id]);
        delete_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn a_recent_or_claimed_upload_is_left_alone() {
        let db = crate::test_db::pool().await;
        let (owner_id, form_id, recent_id) = ready_attachment(&db).await;
        let claimed_id = Uuid::now_v7();
        sqlx::query!(
            "INSERT INTO attachments (id, form_id, byte_size) VALUES ($1, $2, 3)",
            claimed_id,
            form_id,
        )
        .execute(&db)
        .await
        .unwrap();
        backdate_completion(&db, claimed_id, UNCLAIMED_ATTACHMENT_TTL_SECONDS + 60).await;
        let mut transaction = db.begin().await.unwrap();
        claim_attachments(&mut transaction, form_id, &[claimed_id])
            .await
            .unwrap();
        transaction.commit().await.unwrap();

        let reclaimed = prepare_form_cleanup(&db, form_id, 60).await.unwrap();

        assert!(
            reclaimed.is_empty(),
            "{recent_id} or {claimed_id} was reclaimed"
        );
        delete_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn the_header_image_is_never_reclaimed() {
        let db = crate::test_db::pool().await;
        let (owner_id, form_id, attachment_id) = ready_attachment(&db).await;
        backdate_completion(&db, attachment_id, UNCLAIMED_ATTACHMENT_TTL_SECONDS + 60).await;
        sqlx::query!(
            "UPDATE forms SET header_attachment_id = $1 WHERE id = $2",
            attachment_id,
            form_id,
        )
        .execute(&db)
        .await
        .unwrap();

        let reclaimed = prepare_form_cleanup(&db, form_id, 60).await.unwrap();

        assert!(reclaimed.is_empty());
        sqlx::query!(
            "UPDATE forms SET header_attachment_id = NULL WHERE id = $1",
            form_id
        )
        .execute(&db)
        .await
        .unwrap();
        delete_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn cleanup_mark_never_downgrades_a_ready_attachment() {
        let db = crate::test_db::pool().await;
        let (owner_id, form_id, attachment_id) = ready_attachment(&db).await;

        mark_cleanup_pending(&db, form_id, attachment_id)
            .await
            .unwrap();

        let upload_state = sqlx::query_scalar!(
            "SELECT upload_state FROM attachments WHERE id = $1",
            attachment_id,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(upload_state, "ready");

        delete_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn ambiguous_commit_ready_keeps_object_and_readability() {
        let db = crate::test_db::pool().await;
        let storage = test_storage();
        let (owner_id, form_id, attachment_id) = ready_attachment(&db).await;
        let key = format!("attachments/{form_id}/{attachment_id}");
        let bytes = [21_u8, 22, 23];
        storage.put(&key, &bytes).await.unwrap();

        let outcome = reconcile_upload(&db, &storage, form_id, attachment_id)
            .await
            .unwrap();

        assert_eq!(outcome, UploadReconcileOutcome::Ready);
        assert_eq!(
            sqlx::query_scalar!(
                "SELECT upload_state FROM attachments WHERE id = $1",
                attachment_id,
            )
            .fetch_one(&db)
            .await
            .unwrap(),
            "ready"
        );
        assert_eq!(storage.get(&key).await.unwrap(), bytes);

        storage.delete(&key).await.unwrap();
        delete_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn cleanup_attachment_refuses_to_delete_a_ready_object() {
        let db = crate::test_db::pool().await;
        let storage = test_storage();
        let (owner_id, form_id, attachment_id) = ready_attachment(&db).await;
        let key = format!("attachments/{form_id}/{attachment_id}");
        let bytes = [24_u8, 25, 26];
        storage.put(&key, &bytes).await.unwrap();

        cleanup_attachment(&db, &storage, form_id, attachment_id)
            .await
            .unwrap();

        assert_eq!(storage.get(&key).await.unwrap(), bytes);
        assert_eq!(
            sqlx::query_scalar!(
                "SELECT upload_state FROM attachments WHERE id = $1",
                attachment_id,
            )
            .fetch_one(&db)
            .await
            .unwrap(),
            "ready"
        );

        storage.delete(&key).await.unwrap();
        delete_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn ambiguous_commit_uploading_transitions_then_cleans_safely() {
        let _counts = backlog_counts_lock().await;
        let db = crate::test_db::pool().await;
        let storage = test_storage();
        let (owner_id, form_id, attachment_id) = ready_attachment(&db).await;
        sqlx::query!(
            "UPDATE attachments
             SET upload_state = 'uploading', upload_completed_at = NULL,
                 lifecycle_updated_at = now()
             WHERE id = $1",
            attachment_id,
        )
        .execute(&db)
        .await
        .unwrap();
        let key = format!("attachments/{form_id}/{attachment_id}");
        storage.put(&key, &[31_u8, 32, 33]).await.unwrap();

        let outcome = reconcile_upload(&db, &storage, form_id, attachment_id)
            .await
            .unwrap();

        assert_eq!(outcome, UploadReconcileOutcome::Cleaned);
        assert_eq!(
            sqlx::query_scalar!(
                "SELECT count(*) FROM attachments WHERE id = $1",
                attachment_id,
            )
            .fetch_one(&db)
            .await
            .unwrap()
            .unwrap_or(0),
            0
        );
        let form = sqlx::query!(
            "SELECT attachment_count, attachment_bytes FROM forms WHERE id = $1",
            form_id,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(form.attachment_count, 0);
        assert_eq!(form.attachment_bytes, 0);
        assert!(storage.get(&key).await.is_err());

        delete_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn ambiguous_commit_missing_row_deletes_unreferenced_object() {
        let db = crate::test_db::pool().await;
        let storage = test_storage();
        let (owner_id, form_id, attachment_id) = ready_attachment(&db).await;
        sqlx::query!("DELETE FROM attachments WHERE id = $1", attachment_id)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query!(
            "UPDATE forms SET attachment_count = 0, attachment_bytes = 0 WHERE id = $1",
            form_id,
        )
        .execute(&db)
        .await
        .unwrap();
        let key = format!("attachments/{form_id}/{attachment_id}");
        storage.put(&key, &[41_u8, 42, 43]).await.unwrap();

        let outcome = reconcile_upload(&db, &storage, form_id, attachment_id)
            .await
            .unwrap();

        assert_eq!(outcome, UploadReconcileOutcome::MissingCleaned);
        assert!(storage.get(&key).await.is_err());

        delete_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn owner_deletion_transitions_a_ready_attachment() {
        let _counts = backlog_counts_lock().await;
        let db = crate::test_db::pool().await;
        let (owner_id, form_id, attachment_id) = ready_attachment(&db).await;

        let mut transaction = db.begin().await.unwrap();
        let transitioned = mark_deleted_by_owner(&mut transaction, form_id, attachment_id)
            .await
            .unwrap();
        transaction.commit().await.unwrap();

        assert!(transitioned);
        assert_eq!(
            sqlx::query_scalar!(
                "SELECT upload_state FROM attachments WHERE id = $1",
                attachment_id,
            )
            .fetch_one(&db)
            .await
            .unwrap(),
            "cleanup_pending"
        );

        delete_fixture(&db, owner_id, form_id).await;
    }

    #[tokio::test]
    async fn owner_deletion_refuses_an_attachment_from_another_form() {
        let db = crate::test_db::pool().await;
        let (owner_id, form_id, attachment_id) = ready_attachment(&db).await;
        let (other_owner_id, other_form_id, _) = ready_attachment(&db).await;

        let mut transaction = db.begin().await.unwrap();
        let transitioned = mark_deleted_by_owner(&mut transaction, other_form_id, attachment_id)
            .await
            .unwrap();
        transaction.commit().await.unwrap();

        assert!(
            !transitioned,
            "an attachment belonging to another form must not transition",
        );
        assert_eq!(
            sqlx::query_scalar!(
                "SELECT upload_state FROM attachments WHERE id = $1",
                attachment_id,
            )
            .fetch_one(&db)
            .await
            .unwrap(),
            "ready",
            "the attachment must be left untouched",
        );

        delete_fixture(&db, owner_id, form_id).await;
        delete_fixture(&db, other_owner_id, other_form_id).await;
    }

    #[tokio::test]
    async fn backlog_counts_pending_deletions_and_stale_reservations() {
        let _counts = backlog_counts_lock().await;
        let db = backlog_test_db().await;
        let before = backlog(&db, 4).await.unwrap();

        // Use the shared owner-form fixture rather than a bare `INSERT INTO
        // forms`: a form with no owner membership violates an invariant
        // that `sharing_test` checks across the whole table, and a fixture
        // that creates one breaks that unrelated suite.
        let (_owner_id, form_id) =
            crate::sharing::access::test_support::insert_owner_form(&db).await;
        sqlx::query!(
            "INSERT INTO attachments (id, form_id, byte_size, upload_state)
             VALUES ($1, $2, 1, 'cleanup_pending')",
            Uuid::now_v7(),
            form_id,
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO attachments (
                 id, form_id, byte_size, upload_state, upload_completed_at, lifecycle_updated_at
             )
             VALUES ($1, $2, 1, 'uploading', NULL, now() - interval '1 hour')",
            Uuid::now_v7(),
            form_id,
        )
        .execute(&db)
        .await
        .unwrap();

        let after = backlog(&db, 4).await.unwrap();
        assert_eq!(after.cleanup_pending, before.cleanup_pending + 1);
        assert_eq!(after.stale_uploads, before.stale_uploads + 1);
        assert!(after.oldest_pending_at.is_some());
    }

    async fn backlog_test_db() -> PgPool {
        crate::test_db::pool().await
    }
}
