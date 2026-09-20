//! Deciding, under a lock, whether a caller owns a form.
//!
//! The one thing the invitation, membership and form-lifecycle handlers all
//! need from each other. It lives on its own so those three do not have to
//! share a file to share it, which is the only reason they ever did.

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::{error::ApiError, form_access::FormAccess};

pub(crate) async fn require_owner(
    db: &sqlx::PgPool,
    form_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    let access = FormAccess::load(db, form_id, user_id)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
        .ok_or(ApiError::NotFound)?;
    access.require_owner()
}

pub(crate) async fn lock_and_require_owner(
    transaction: &mut Transaction<'_, Postgres>,
    form_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    lock_and_require_owner_inner(transaction, form_id, user_id, false).await
}

pub(crate) async fn lock_and_require_owner_for_deletion(
    transaction: &mut Transaction<'_, Postgres>,
    form_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    lock_and_require_owner_inner(transaction, form_id, user_id, true).await
}

async fn lock_and_require_owner_inner(
    transaction: &mut Transaction<'_, Postgres>,
    form_id: Uuid,
    user_id: Uuid,
    allow_deleting: bool,
) -> Result<(), ApiError> {
    let form = sqlx::query!(
        "SELECT deletion_started_at FROM forms WHERE id = $1 FOR UPDATE",
        form_id,
    )
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if !matches!(form, Some(row) if allow_deleting || row.deletion_started_at.is_none()) {
        return Err(ApiError::NotFound);
    }

    // Through `FormAccess` rather than comparing the stored strings here. This
    // used to be its own `row.role == "owner" && row.state == "active"`, a
    // second definition of what an active owner is, which would drift the day
    // a role is added or `state` grows a value. `load_for_update` holds the
    // membership row for the rest of the transaction, so the decision cannot
    // go stale between here and the write it authorises.
    let Some(access) = FormAccess::load_for_update(transaction, form_id, user_id)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
    else {
        return Err(ApiError::NotFound);
    };
    access.require_owner()
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Fixtures shared by the tests of the modules that call this one.
    //!
    //! `insert_owner_form` is here rather than copied into each because two
    //! modules need it, and a duplicated fixture is the thing that made adding
    //! a test to this crate expensive in the first place.
    use uuid::Uuid;

    pub(crate) async fn insert_owner_form(db: &sqlx::PgPool) -> (Uuid, Uuid) {
        let owner_id = Uuid::now_v7();
        let form_id = Uuid::now_v7();
        let owner_email = format!("unit-owner-{}@example.com", Uuid::now_v7());
        sqlx::query!(
            "INSERT INTO users (id, email, password_hash)
                 VALUES ($1, $2, 'unit-password-hash')",
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
                    $1, 'unit-title', 'unit-schema', 'unit-public-key'
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
                    'unit-data-key', 'unit-private-key'
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
}
