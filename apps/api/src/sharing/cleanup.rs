use sqlx::PgPool;

pub fn spawn(db: PgPool) {
    tokio::spawn(async move {
        loop {
            if run(&db).await.is_err() {
                tracing::error!(
                    failure_kind = "database",
                    "invitation lifecycle cleanup failed"
                );
            }
            tokio::time::sleep(std::time::Duration::from_secs(60 * 60)).await;
        }
    });
}

async fn run(db: &PgPool) -> Result<(), sqlx::Error> {
    let mut transaction = db.begin().await?;
    sqlx::query!(
        "UPDATE form_invitations
         SET status = 'delivery_failed', token_hash = NULL, updated_at = now()
         WHERE status = 'sending' AND updated_at <= now() - interval '5 minutes'"
    )
    .execute(&mut *transaction)
    .await?;
    sqlx::query!(
        "UPDATE form_invitations
         SET status = 'expired', token_hash = NULL, updated_at = now()
         WHERE status = 'pending' AND expires_at <= now()"
    )
    .execute(&mut *transaction)
    .await?;
    sqlx::query!(
        "DELETE FROM form_invitations
         WHERE status IN ('expired', 'revoked', 'delivery_failed')
           AND updated_at <= now() - interval '30 days'"
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    async fn test_db() -> PgPool {
        crate::test_db::pool().await
    }

    async fn insert_form(db: &PgPool) -> (Uuid, Uuid) {
        let owner_id = Uuid::now_v7();
        let form_id = Uuid::now_v7();
        let owner_email = format!("cleanup-owner-{}@example.com", Uuid::now_v7());
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash)
             VALUES ($1, $2, 'cleanup-password-hash')",
            owner_id,
            owner_email,
        )
        .execute(db)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO forms (
                id, title_ciphertext, schema_ciphertext, form_public_key
             ) VALUES (
                $1, 'cleanup-title', 'cleanup-schema', 'cleanup-public-key'
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
                'cleanup-data-key', 'cleanup-private-key'
             )",
            Uuid::now_v7(),
            form_id,
            owner_id,
        )
        .execute(db)
        .await
        .unwrap();
        (owner_id, form_id)
    }

    #[tokio::test]
    async fn cleanup_fails_stale_sends_expires_overdue_invites_and_deletes_old_terminal_rows() {
        let db = test_db().await;
        let (owner_id, form_id) = insert_form(&db).await;
        let stale_sending_id = Uuid::now_v7();
        let overdue_pending_id = Uuid::now_v7();
        let fresh_pending_id = Uuid::now_v7();
        let old_expired_id = Uuid::now_v7();
        let old_revoked_id = Uuid::now_v7();
        let old_failed_id = Uuid::now_v7();
        let sending_hash = format!("{0}{0}", Uuid::now_v7().simple());
        let overdue_hash = format!("{0}{0}", Uuid::now_v7().simple());
        let fresh_hash = format!("{0}{0}", Uuid::now_v7().simple());

        sqlx::query!(
            "INSERT INTO form_invitations (
                id, form_id, invited_email, role, status, token_hash, expires_at, updated_at
             ) VALUES
                ($1, $7, $8, 'viewer', 'sending', $9, now() + interval '7 days', now() - interval '6 minutes'),
                ($2, $7, $10, 'viewer', 'pending', $11, now() - interval '1 second', now()),
                ($3, $7, $12, 'viewer', 'pending', $13, now() + interval '7 days', now()),
                ($4, $7, $14, 'viewer', 'expired', NULL, now() - interval '31 days', now() - interval '31 days'),
                ($5, $7, $15, 'viewer', 'revoked', NULL, now() - interval '31 days', now() - interval '31 days'),
                ($6, $7, $16, 'viewer', 'delivery_failed', NULL, now() - interval '31 days', now() - interval '31 days')",
            stale_sending_id,
            overdue_pending_id,
            fresh_pending_id,
            old_expired_id,
            old_revoked_id,
            old_failed_id,
            form_id,
            format!("stale-send-{}@example.com", Uuid::now_v7()),
            sending_hash,
            format!("overdue-{}@example.com", Uuid::now_v7()),
            overdue_hash,
            format!("fresh-{}@example.com", Uuid::now_v7()),
            fresh_hash,
            format!("old-expired-{}@example.com", Uuid::now_v7()),
            format!("old-revoked-{}@example.com", Uuid::now_v7()),
            format!("old-failed-{}@example.com", Uuid::now_v7()),
        )
        .execute(&db)
        .await
        .unwrap();

        run(&db).await.unwrap();

        let stale = sqlx::query!(
            "SELECT status, token_hash FROM form_invitations WHERE id = $1",
            stale_sending_id,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(stale.status, "delivery_failed");
        assert!(stale.token_hash.is_none());

        let overdue = sqlx::query!(
            "SELECT status, token_hash FROM form_invitations WHERE id = $1",
            overdue_pending_id,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(overdue.status, "expired");
        assert!(overdue.token_hash.is_none());

        let fresh = sqlx::query!(
            "SELECT status, token_hash FROM form_invitations WHERE id = $1",
            fresh_pending_id,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(fresh.status, "pending");
        assert_eq!(fresh.token_hash.as_deref().map(str::len), Some(64));

        let old_terminal_count: i64 = sqlx::query_scalar!(
            "SELECT count(*) FROM form_invitations WHERE id IN ($1, $2, $3)",
            old_expired_id,
            old_revoked_id,
            old_failed_id,
        )
        .fetch_one(&db)
        .await
        .unwrap()
        .unwrap_or(0);
        assert_eq!(old_terminal_count, 0);

        sqlx::query!("DELETE FROM forms WHERE id = $1", form_id)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query!("DELETE FROM users WHERE id = $1", owner_id)
            .execute(&db)
            .await
            .unwrap();
    }
}
