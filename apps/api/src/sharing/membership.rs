//! Who is on a form, in what role, and with which key material.

use axum::extract::State;
use uuid::Uuid;

use crate::sharing::access::lock_and_require_owner;
use crate::{
    auth::extractor::SessionUser,
    error::{ApiError, ApiJson, ApiPath, ApiResponse, ApiResult},
    mail,
    sharing::models::{
        CollaborationInvitation, CollaborationMember, CollaborationResponse, FormRole,
        MemberPreferencesBody, MembershipStateResponse, ProvisioningItem, ProvisioningResponse,
        PutMemberGrantBody, UpdateMemberRoleBody,
    },
    state::AppState,
};

pub async fn collaboration(
    State(state): State<AppState>,
    ApiPath(form_id): ApiPath<Uuid>,
    user: SessionUser,
) -> ApiResult<CollaborationResponse> {
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    lock_and_require_owner(&mut transaction, form_id, user.user_id).await?;

    let member_rows = sqlx::query!(
        r#"SELECT members.id, users.email::text AS "email!", members.role,
                  members.state, members.created_at, members.updated_at
           FROM form_members members
           JOIN users ON users.id = members.user_id
           WHERE members.form_id = $1
           ORDER BY members.created_at, members.id"#,
        form_id,
    )
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let members = member_rows
        .into_iter()
        .map(|row| {
            Ok(CollaborationMember {
                id: row.id,
                email: row.email,
                role: FormRole::try_from(row.role.as_str()).map_err(ApiError::Internal)?,
                state: row.state,
                created_at: row.created_at,
                updated_at: row.updated_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;

    let invitation_rows = sqlx::query!(
        r#"SELECT id, invited_email::text AS "invited_email!", role, status,
                  expires_at, created_at, updated_at
           FROM form_invitations
           WHERE form_id = $1
             AND status IN ('sending', 'pending', 'delivery_failed')
           ORDER BY created_at, id"#,
        form_id,
    )
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let invitations = invitation_rows
        .into_iter()
        .map(|row| {
            Ok(CollaborationInvitation {
                id: row.id,
                invited_email: row.invited_email,
                role: FormRole::try_from(row.role.as_str()).map_err(ApiError::Internal)?,
                status: row.status,
                expires_at: row.expires_at,
                created_at: row.created_at,
                updated_at: row.updated_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;

    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(ApiResponse::ok(CollaborationResponse {
        members,
        invitations,
    }))
}

pub async fn update_member_role(
    State(state): State<AppState>,
    ApiPath((form_id, member_id)): ApiPath<(Uuid, Uuid)>,
    user: SessionUser,
    ApiJson(body): ApiJson<UpdateMemberRoleBody>,
) -> ApiResult<serde_json::Value> {
    if matches!(body.role, FormRole::Owner) {
        return Err(ApiError::BadRequest("Invalid request".to_string()));
    }

    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let form = sqlx::query_scalar!(
        "SELECT id FROM forms
         WHERE id = $1 AND deletion_started_at IS NULL
         FOR UPDATE",
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if form.is_none() {
        return Err(ApiError::NotFound);
    }

    let updated = sqlx::query_scalar!(
        // The owner check is part of the writing statement, not a step before
        // it. That is deliberate and stronger than calling `FormAccess`: there
        // is no window between deciding the caller may write and writing,
        // because they are one operation. Do not "tidy" this into a load and
        // a check; `FormAccess::load` reads through the pool and would not
        // even see this transaction's locks.
        "UPDATE form_members target
         SET role = $1, updated_at = now()
         WHERE target.id = $2 AND target.form_id = $3
           AND target.role IN ('editor', 'viewer') AND target.state = 'active'
           AND EXISTS (
             SELECT 1 FROM form_members caller
             WHERE caller.form_id = target.form_id AND caller.user_id = $4
               AND caller.role = 'owner' AND caller.state = 'active'
           )
         RETURNING target.id",
        body.role.as_str(),
        member_id,
        form_id,
        user.user_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if updated.is_none() {
        return Err(ApiError::NotFound);
    }
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(ApiResponse::ok(
        serde_json::json!({ "role": body.role.as_str() }),
    ))
}

pub async fn remove_member(
    State(state): State<AppState>,
    ApiPath((form_id, member_id)): ApiPath<(Uuid, Uuid)>,
    user: SessionUser,
) -> ApiResult<serde_json::Value> {
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    lock_and_require_owner(&mut transaction, form_id, user.user_id).await?;
    let removed = sqlx::query_scalar!(
        "DELETE FROM form_members
         WHERE id = $1 AND form_id = $2 AND role IN ('editor', 'viewer')
         RETURNING id",
        member_id,
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if removed.is_none() {
        return Err(ApiError::NotFound);
    }
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(ApiResponse::ok(serde_json::json!({})))
}

pub async fn leave_form(
    State(state): State<AppState>,
    ApiPath(form_id): ApiPath<Uuid>,
    user: SessionUser,
) -> ApiResult<serde_json::Value> {
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let form = sqlx::query_scalar!(
        "SELECT id FROM forms
         WHERE id = $1 AND deletion_started_at IS NULL
         FOR UPDATE",
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if form.is_none() {
        return Err(ApiError::NotFound);
    }
    let removed = sqlx::query_scalar!(
        "DELETE FROM form_members
         WHERE form_id = $1 AND user_id = $2 AND role IN ('editor', 'viewer')
         RETURNING id",
        form_id,
        user.user_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if removed.is_none() {
        return Err(ApiError::NotFound);
    }
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(ApiResponse::ok(serde_json::json!({})))
}

/// Sets the caller's own per-form state: notification preference and/or
/// dashboard archive status.
///
/// Authorization is active membership and nothing else: every role may set
/// these, because both are facts about the caller rather than about the form.
/// The UPDATE is keyed on the session's own user_id, so there is no shape of
/// request that sets another member's preference or archives the form on
/// someone else's dashboard. Each field is `CASE WHEN $n IS NOT NULL THEN ...
/// ELSE column END` rather than `COALESCE`, because both are already plain
/// `Option<bool>` with no "leave alone" value to coalesce onto: passing NULL
/// through the parameter is exactly how "omitted from the request" is
/// expressed once serde has collapsed `None` for us.
pub async fn set_notification_preference(
    State(state): State<AppState>,
    ApiPath(form_id): ApiPath<Uuid>,
    user: SessionUser,
    ApiJson(body): ApiJson<MemberPreferencesBody>,
) -> ApiResult<serde_json::Value> {
    let updated = sqlx::query!(
        // Turning notifications on seeds the watermark to now() in the same
        // statement, so a fresh opt-in on a long-lived busy form is not
        // mailed one email counting every response since the member joined.
        // Turning them off leaves the watermark alone: clearing it would
        // make a later re-enable replay history all over again.
        //
        // Turning them on also clears any delivery backoff, so a member who
        // re-enables does not silently inherit a retry window earned by an
        // address that may since have been fixed.
        //
        // archived: true stores now(), false stores NULL, omitted (NULL
        // parameter) leaves the column as it is.
        "UPDATE form_members
         SET notify_on_response = CASE WHEN $1::boolean IS NOT NULL THEN $1 ELSE notify_on_response END,
             last_notified_at = CASE WHEN $1::boolean IS TRUE THEN now() ELSE last_notified_at END,
             notify_failure_count = CASE WHEN $1::boolean IS TRUE THEN 0 ELSE notify_failure_count END,
             notify_retry_after = CASE WHEN $1::boolean IS TRUE THEN NULL ELSE notify_retry_after END,
             archived_at = CASE
                 WHEN $2::boolean IS TRUE THEN now()
                 WHEN $2::boolean IS FALSE THEN NULL
                 ELSE archived_at
             END,
             updated_at = now()
         WHERE form_id = $3 AND user_id = $4 AND state = 'active'
         RETURNING notify_on_response, archived_at",
        body.notify_on_response,
        body.archived,
        form_id,
        user.user_id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    let Some(updated) = updated else {
        return Err(ApiError::NotFound);
    };

    // `time::OffsetDateTime`'s default `Serialize` is a component array, not
    // a string, and `json!` can't carry the `#[serde(with = "...")]`
    // attribute that fixes this everywhere else; see the identical comment
    // on `closes_at` in `forms::routes::get_form`.
    let archived_at = updated
        .archived_at
        .map(|archived_at| archived_at.format(&time::format_description::well_known::Rfc3339))
        .transpose()
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(serde_json::json!({
        "notify_on_response": updated.notify_on_response,
        "archived_at": archived_at,
    })))
}

pub async fn provisioning(
    State(state): State<AppState>,
    user: SessionUser,
) -> ApiResult<ProvisioningResponse> {
    let rows = sqlx::query!(
        r#"SELECT target.form_id, target.id AS member_id,
                  recipient.sharing_public_key AS "recipient_sharing_public_key!",
                  owner.key_scheme AS "owner_key_scheme!",
                  owner.encrypted_form_data_key AS "owner_encrypted_form_data_key!",
                  owner.encrypted_form_private_key AS "owner_encrypted_form_private_key!"
           FROM form_members owner
           JOIN forms ON forms.id = owner.form_id AND forms.deletion_started_at IS NULL
           JOIN form_members target ON target.form_id = owner.form_id
           JOIN users recipient ON recipient.id = target.user_id
           WHERE owner.user_id = $1 AND owner.role = 'owner' AND owner.state = 'active'
             AND owner.key_scheme IS NOT NULL
             AND owner.encrypted_form_data_key IS NOT NULL
             AND owner.encrypted_form_private_key IS NOT NULL
             AND target.state = 'awaiting_keys'
             AND target.role IN ('editor', 'viewer')
             AND recipient.sharing_public_key IS NOT NULL
             AND recipient.sharing_key_version = 1
           ORDER BY target.created_at, target.id"#,
        user.user_id,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let items = rows
        .into_iter()
        .map(|row| ProvisioningItem {
            form_id: row.form_id,
            member_id: row.member_id,
            recipient_sharing_public_key: row.recipient_sharing_public_key,
            owner_key_scheme: row.owner_key_scheme,
            owner_encrypted_form_data_key: row.owner_encrypted_form_data_key,
            owner_encrypted_form_private_key: row.owner_encrypted_form_private_key,
        })
        .collect();
    Ok(ApiResponse::ok(ProvisioningResponse { items }))
}

pub async fn put_member_grant(
    State(state): State<AppState>,
    ApiPath((form_id, member_id)): ApiPath<(Uuid, Uuid)>,
    user: SessionUser,
    ApiJson(body): ApiJson<PutMemberGrantBody>,
) -> ApiResult<MembershipStateResponse> {
    if body.recipient_sharing_public_key.is_empty()
        || body.encrypted_form_data_key.is_empty()
        || body.encrypted_form_private_key.is_empty()
    {
        return Err(ApiError::BadRequest("Invalid request".to_string()));
    }

    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let form = sqlx::query_scalar!(
        "SELECT id FROM forms
         WHERE id = $1 AND deletion_started_at IS NULL
         FOR UPDATE",
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if form.is_none() {
        return Err(ApiError::NotFound);
    }

    let activated_user_id = sqlx::query_scalar!(
        // Both EXISTS clauses are part of the writing statement rather than
        // checks before it, and both must stay that way. The first binds the
        // grant to the exact sharing key the owner sealed to, so a recipient
        // who rotates their key between the owner reading it and this write
        // cannot end up holding a grant sealed to a key they no longer have.
        // The second is the owner authorization. Neither has a window between
        // deciding and acting, because deciding and acting are one statement;
        // splitting either into a `FormAccess` call would create one.
        "UPDATE form_members target
         SET state = 'active', key_scheme = 'account_sealed_box_v1',
             encrypted_form_data_key = $1, encrypted_form_private_key = $2,
             updated_at = now()
         WHERE target.id = $3 AND target.form_id = $4
           AND target.state = 'awaiting_keys' AND target.role IN ('editor', 'viewer')
           AND EXISTS (
             SELECT 1 FROM users recipient
             WHERE recipient.id = target.user_id
               AND recipient.sharing_public_key = $5
               AND recipient.sharing_key_version = 1
           )
           AND EXISTS (
             SELECT 1 FROM form_members owner
             WHERE owner.form_id = target.form_id AND owner.user_id = $6
               AND owner.role = 'owner' AND owner.state = 'active'
           )
         RETURNING target.user_id",
        &body.encrypted_form_data_key,
        &body.encrypted_form_private_key,
        member_id,
        form_id,
        &body.recipient_sharing_public_key,
        user.user_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    let recipient_email = if let Some(recipient_user_id) = activated_user_id {
        Some(
            sqlx::query_scalar!(
                r#"SELECT email::text AS "email!" FROM users WHERE id = $1"#,
                recipient_user_id,
            )
            .fetch_one(&mut *transaction)
            .await
            .map_err(|error| ApiError::Internal(error.into()))?,
        )
    } else {
        let identical_retry = sqlx::query_scalar!(
            "SELECT EXISTS(
               SELECT 1 FROM form_members target
               JOIN users recipient ON recipient.id = target.user_id
               WHERE target.id = $1 AND target.form_id = $2
                 AND target.state = 'active'
                 AND target.key_scheme = 'account_sealed_box_v1'
                 AND target.encrypted_form_data_key = $3
                 AND target.encrypted_form_private_key = $4
                 AND recipient.sharing_public_key = $5
                 AND recipient.sharing_key_version = 1
                 AND EXISTS (
                   SELECT 1 FROM form_members owner
                   WHERE owner.form_id = target.form_id AND owner.user_id = $6
                     AND owner.role = 'owner' AND owner.state = 'active'
                 )
             )",
            member_id,
            form_id,
            &body.encrypted_form_data_key,
            &body.encrypted_form_private_key,
            &body.recipient_sharing_public_key,
            user.user_id,
        )
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
        .unwrap_or(false);
        if !identical_retry {
            return Err(ApiError::NotFound);
        }
        None
    };

    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    if let Some(recipient_email) = recipient_email
        && state
            .mailer
            .send(mail::form_ready_mail(
                &recipient_email,
                mail::language_for_email(&state.db, &recipient_email).await,
            ))
            .await
            .is_err()
    {
        tracing::error!(
            form_id = %form_id,
            member_id = %member_id,
            failure_kind = "form_ready_delivery",
            "form ready delivery failed after activation"
        );
    }
    Ok(ApiResponse::ok(MembershipStateResponse {
        membership_state: "active",
    }))
}
