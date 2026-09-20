use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{error::ApiError, sharing::models::FormRole};

pub struct FormAccess {
    pub role: FormRole,
    pub state: String,
    pub key_scheme: Option<String>,
    pub encrypted_form_data_key: Option<String>,
    pub encrypted_form_private_key: Option<String>,
}

impl FormAccess {
    /// Builds an access record from a membership row.
    ///
    /// Shared by both loaders so the role vocabulary is parsed once. An
    /// unrecognised role is a decode error rather than a silent downgrade: a
    /// row this build cannot understand must not resolve to "not an owner" and
    /// quietly deny, nor to anything else.
    fn from_parts(
        role: &str,
        state: String,
        key_scheme: Option<String>,
        encrypted_form_data_key: Option<String>,
        encrypted_form_private_key: Option<String>,
    ) -> Result<Self, sqlx::Error> {
        let role = FormRole::try_from(role).map_err(|_| {
            sqlx::Error::Decode(
                std::io::Error::new(std::io::ErrorKind::InvalidData, "unknown form role").into(),
            )
        })?;
        Ok(Self {
            role,
            state,
            key_scheme,
            encrypted_form_data_key,
            encrypted_form_private_key,
        })
    }

    /// Loads the membership inside a transaction, holding it `FOR UPDATE`.
    ///
    /// For the handlers that decide a caller's rights and then write in the
    /// same transaction. `load` reads through the pool, which is right for a
    /// handler that only answers a question, and wrong for one that acts on
    /// the answer: the read would not see the transaction's locks, so a
    /// membership could change between the check and the write.
    ///
    /// This does not replace the `EXISTS (SELECT 1 FROM form_members caller
    /// ...)` clauses welded into some UPDATE statements, and must not be used
    /// to. There the authorization is part of the writing statement, which is
    /// stronger still: there is no window between deciding and acting, because
    /// they are one operation.
    pub async fn load_for_update(
        transaction: &mut Transaction<'_, Postgres>,
        form_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        let row = sqlx::query!(
            "SELECT id, role, state, key_scheme,
                    encrypted_form_data_key, encrypted_form_private_key
             FROM form_members
             WHERE form_id = $1 AND user_id = $2
             FOR UPDATE",
            form_id,
            user_id,
        )
        .fetch_optional(&mut **transaction)
        .await?;

        row.map(|row| {
            Self::from_parts(
                &row.role,
                row.state,
                row.key_scheme,
                row.encrypted_form_data_key,
                row.encrypted_form_private_key,
            )
        })
        .transpose()
    }

    pub async fn load(
        db: &PgPool,
        form_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        let row = sqlx::query!(
            "SELECT id, role, state, key_scheme,
                    encrypted_form_data_key, encrypted_form_private_key
             FROM form_members
             WHERE form_id = $1 AND user_id = $2",
            form_id,
            user_id,
        )
        .fetch_optional(db)
        .await?;

        row.map(|row| {
            Self::from_parts(
                &row.role,
                row.state,
                row.key_scheme,
                row.encrypted_form_data_key,
                row.encrypted_form_private_key,
            )
        })
        .transpose()
    }

    pub fn require_read(&self) -> Result<(), ApiError> {
        if self.state == "active" {
            Ok(())
        } else {
            Err(ApiError::NotFound)
        }
    }

    pub fn require_edit(&self) -> Result<(), ApiError> {
        self.require_read()?;
        match self.role {
            FormRole::Owner | FormRole::Editor => Ok(()),
            FormRole::Viewer => Err(ApiError::NotFound),
        }
    }

    pub fn require_owner(&self) -> Result<(), ApiError> {
        self.require_read()?;
        match self.role {
            FormRole::Owner => Ok(()),
            FormRole::Editor | FormRole::Viewer => Err(ApiError::NotFound),
        }
    }
}
