use axum::{
    extract::{Query, State},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    admin::{guard::InstanceAdmin, settings},
    error::{ApiError, ApiPath, ApiResponse},
    state::AppState,
};

const DEFAULT_PAGE_LIMIT: usize = 50;
const MAX_PAGE_LIMIT: usize = 100;

#[derive(Deserialize)]
struct Rfc3339Timestamp(#[serde(with = "time::serde::rfc3339")] OffsetDateTime);

#[derive(Clone, Copy, Debug)]
pub enum AuditAction {
    SettingsUpdated,
    AccountSuspended,
    AccountReactivated,
    FormTransferred,
    AccountDeletionStarted,
    AccountDeleted,
}

impl AuditAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SettingsUpdated => "settings_updated",
            Self::AccountSuspended => "account_suspended",
            Self::AccountReactivated => "account_reactivated",
            Self::FormTransferred => "form_transferred",
            Self::AccountDeletionStarted => "account_deletion_started",
            Self::AccountDeleted => "account_deleted",
        }
    }

    fn parse(value: &str) -> Result<Self, ApiError> {
        match value {
            "settings_updated" => Ok(Self::SettingsUpdated),
            "account_suspended" => Ok(Self::AccountSuspended),
            "account_reactivated" => Ok(Self::AccountReactivated),
            "form_transferred" => Ok(Self::FormTransferred),
            "account_deletion_started" => Ok(Self::AccountDeletionStarted),
            "account_deleted" => Ok(Self::AccountDeleted),
            _ => Err(ApiError::BadRequest("Invalid audit action".to_string())),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum AuditResult {
    Succeeded,
    Rejected,
    Failed,
}

impl AuditResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self, ApiError> {
        match value {
            "succeeded" => Ok(Self::Succeeded),
            "rejected" => Ok(Self::Rejected),
            "failed" => Ok(Self::Failed),
            _ => Err(ApiError::BadRequest("Invalid audit result".to_string())),
        }
    }
}

#[derive(Serialize)]
struct SettingsResponse {
    registration_enabled: bool,
    register_rate_limit_per_hour: i32,
    login_rate_limit_per_minute: i32,
    default_max_forms: i32,
    default_max_attachment_bytes: i64,
    /// Null means this instance caps responses only through a plan, or not at
    /// all when it does not bill.
    default_max_responses_per_period: Option<i32>,
    mail_configured: bool,
    /// Whether this instance bills. When it does, `plans` resolves for every
    /// account and the three `default_*` quotas above are unreachable, so the
    /// admin screen has to say so rather than present them as live settings.
    billing_enabled: bool,
}

#[derive(Serialize)]
struct PageCursor {
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    id: Uuid,
}

#[derive(Serialize)]
struct AccountsResponse {
    accounts: Vec<AccountSummary>,
    next_cursor: Option<PageCursor>,
}

#[derive(Serialize)]
struct EligibleOwnershipTransfersResponse {
    transfers: Vec<EligibleOwnershipTransfer>,
}

#[derive(Serialize)]
struct EligibleOwnershipTransfer {
    form_id: Uuid,
    editor_member_ids: Vec<Uuid>,
}

#[derive(Serialize)]
struct AuditResponse {
    events: Vec<AuditEventSummary>,
    next_cursor: Option<PageCursor>,
}

#[derive(Serialize)]
struct AccountSummary {
    id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    instance_admin: bool,
    suspended: bool,
    totp_enabled: bool,
    max_forms: Option<i32>,
    max_attachment_bytes: Option<i64>,
    max_responses: Option<i32>,
    forms_used: i32,
    attachment_bytes_used: i64,
}

#[derive(Serialize)]
struct AuditEventSummary {
    id: Uuid,
    actor_user_id: Uuid,
    target_user_id: Option<Uuid>,
    action: String,
    result: String,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

#[derive(Deserialize)]
pub struct RawAccountsQuery {
    limit: Option<String>,
    search: Option<String>,
    cursor_id: Option<String>,
    cursor_created_at: Option<String>,
}

#[derive(Deserialize)]
pub struct RawAuditQuery {
    limit: Option<String>,
    action: Option<String>,
    result: Option<String>,
    cursor_id: Option<String>,
    cursor_created_at: Option<String>,
}

fn parse_optional_usize(value: Option<String>, field: &str) -> Result<Option<usize>, ApiError> {
    value
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| ApiError::BadRequest(format!("Invalid {field}")))
        })
        .transpose()
}

fn page_limit(limit: Option<String>) -> Result<usize, ApiError> {
    let limit = parse_optional_usize(limit, "limit")?.unwrap_or(DEFAULT_PAGE_LIMIT);
    if !(1..=MAX_PAGE_LIMIT).contains(&limit) {
        return Err(ApiError::BadRequest("Invalid limit".to_string()));
    }
    Ok(limit)
}

fn parse_uuid(value: &str, field: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value).map_err(|_| ApiError::BadRequest(format!("Invalid {field}")))
}

fn parse_rfc3339(value: &str, field: &str) -> Result<OffsetDateTime, ApiError> {
    serde_json::from_str::<Rfc3339Timestamp>(&format!("{value:?}"))
        .map(|timestamp| timestamp.0)
        .map_err(|_| ApiError::BadRequest(format!("Invalid {field}")))
}

fn parse_cursor(
    cursor_created_at: Option<String>,
    cursor_id: Option<String>,
) -> Result<Option<(OffsetDateTime, Uuid)>, ApiError> {
    match (cursor_created_at, cursor_id) {
        (None, None) => Ok(None),
        (Some(created_at), Some(id)) => Ok(Some((
            parse_rfc3339(&created_at, "cursor_created_at")?,
            parse_uuid(&id, "cursor_id")?,
        ))),
        _ => Err(ApiError::BadRequest("Invalid cursor".to_string())),
    }
}

enum AccountSearch {
    ExactEmail(String),
    UuidPrefix(String),
}

fn parse_account_search(search: Option<String>) -> Result<Option<AccountSearch>, ApiError> {
    let Some(search) = search else {
        return Ok(None);
    };

    let trimmed = search.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed != search {
        return Err(ApiError::BadRequest("Invalid account search".to_string()));
    }

    if trimmed.contains('@') {
        let normalized = trimmed.to_ascii_lowercase();
        if normalized != trimmed {
            return Err(ApiError::BadRequest("Invalid account search".to_string()));
        }
        return Ok(Some(AccountSearch::ExactEmail(normalized)));
    }

    let normalized = trimmed.to_ascii_lowercase();
    if normalized.len() > 36
        || !normalized
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
    {
        return Err(ApiError::BadRequest("Invalid account search".to_string()));
    }

    Ok(Some(AccountSearch::UuidPrefix(normalized)))
}

fn settings_response(
    settings: &settings::InstanceSettings,
    mail_configured: bool,
    billing_enabled: bool,
) -> SettingsResponse {
    SettingsResponse {
        registration_enabled: settings.registration_enabled,
        register_rate_limit_per_hour: settings.register_rate_limit_per_hour,
        login_rate_limit_per_minute: settings.login_rate_limit_per_minute,
        default_max_forms: settings.default_max_forms,
        default_max_attachment_bytes: settings.default_max_attachment_bytes,
        default_max_responses_per_period: settings.default_max_responses_per_period,
        mail_configured,
        billing_enabled,
    }
}

pub async fn get_settings(
    State(state): State<AppState>,
    admin: InstanceAdmin,
) -> Result<impl IntoResponse, ApiError> {
    let _ = admin.user_id;
    let settings = settings::load(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(settings_response(
        &settings,
        state.config.mail_configured(),
        state.billing_enabled(),
    )))
}

pub async fn patch_settings(
    State(state): State<AppState>,
    admin: InstanceAdmin,
    crate::error::ApiJson(body): crate::error::ApiJson<settings::UpdateInstanceSettingsBody>,
) -> Result<impl IntoResponse, ApiError> {
    let _ = admin.user_id;
    let settings = settings::update(&state.db, body).await?;

    Ok(ApiResponse::ok(settings_response(
        &settings,
        state.config.mail_configured(),
        state.billing_enabled(),
    )))
}

pub async fn list_accounts(
    State(state): State<AppState>,
    admin: InstanceAdmin,
    Query(query): Query<RawAccountsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let _ = admin.user_id;
    let limit = page_limit(query.limit)?;
    let cursor = parse_cursor(query.cursor_created_at, query.cursor_id)?;
    let search = parse_account_search(query.search)?;
    let exact_email = match &search {
        Some(AccountSearch::ExactEmail(email)) => Some(email.as_str()),
        _ => None,
    };
    let id_prefix = match &search {
        Some(AccountSearch::UuidPrefix(prefix)) => Some(format!("{prefix}%")),
        _ => None,
    };
    let cursor_created_at = cursor.map(|(created_at, _)| created_at);
    let cursor_id = cursor.map(|(_, id)| id);
    let query_limit = i64::try_from(limit + 1).map_err(|error| ApiError::Internal(error.into()))?;

    let mut rows = sqlx::query!(
        "SELECT
            users.id,
            users.created_at,
            users.instance_admin,
            (users.suspended_at IS NOT NULL) AS \"suspended!\",
            users.totp_enabled,
            account_quotas.max_forms,
            account_quotas.max_attachment_bytes,
            account_quotas.max_responses,
            COALESCE(account_usage.forms_used, 0) AS \"forms_used!\",
            COALESCE(account_usage.attachment_bytes_used, 0) AS \"attachment_bytes_used!\"
         FROM users
         LEFT JOIN account_quotas ON account_quotas.user_id = users.id
         LEFT JOIN account_usage ON account_usage.user_id = users.id
         WHERE ($1::text IS NULL OR users.email = $1)
           AND ($2::text IS NULL OR users.id::text LIKE $2)
           AND (
                $3::timestamptz IS NULL
                OR $4::uuid IS NULL
                OR (users.created_at, users.id) < ($3, $4)
           )
         ORDER BY users.created_at DESC, users.id DESC
         LIMIT $5",
        exact_email,
        id_prefix,
        cursor_created_at,
        cursor_id,
        query_limit,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    let has_more = rows.len() > limit;
    if has_more {
        rows.truncate(limit);
    }

    let accounts = rows
        .iter()
        .map(|row| AccountSummary {
            id: row.id,
            created_at: row.created_at,
            instance_admin: row.instance_admin,
            suspended: row.suspended,
            totp_enabled: row.totp_enabled,
            max_forms: row.max_forms,
            max_attachment_bytes: row.max_attachment_bytes,
            max_responses: row.max_responses,
            forms_used: row.forms_used,
            attachment_bytes_used: row.attachment_bytes_used,
        })
        .collect::<Vec<_>>();
    let next_cursor = if has_more {
        rows.last().map(|row| PageCursor {
            created_at: row.created_at,
            id: row.id,
        })
    } else {
        None
    };

    Ok(ApiResponse::ok(AccountsResponse {
        accounts,
        next_cursor,
    }))
}

/// Lists only the identifiers needed to resolve shared-form ownership before
/// deleting an account. Form ciphertext, titles, keys, and member identities
/// remain outside the administrator API boundary.
pub async fn list_eligible_ownership_transfers(
    State(state): State<AppState>,
    ApiPath(target_user_id): ApiPath<Uuid>,
    admin: InstanceAdmin,
) -> Result<impl IntoResponse, ApiError> {
    let _ = admin.user_id;
    let rows = sqlx::query!(
        r#"SELECT owner.form_id, editor.id AS "editor_member_id?"
           FROM form_members owner
           LEFT JOIN form_members editor
             ON editor.form_id = owner.form_id
            AND editor.role = 'editor'
            AND editor.state = 'active'
           WHERE owner.user_id = $1
             AND owner.role = 'owner'
             AND owner.state = 'active'
             AND EXISTS (
               SELECT 1
               FROM form_members shared
               WHERE shared.form_id = owner.form_id
                 AND shared.user_id <> $1
             )
           ORDER BY owner.form_id, editor.id"#,
        target_user_id,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    let mut transfers: Vec<EligibleOwnershipTransfer> = Vec::new();
    for row in rows {
        if transfers
            .last()
            .is_none_or(|transfer| transfer.form_id != row.form_id)
        {
            transfers.push(EligibleOwnershipTransfer {
                form_id: row.form_id,
                editor_member_ids: Vec::new(),
            });
        }
        if let Some(editor_member_id) = row.editor_member_id {
            transfers
                .last_mut()
                .expect("transfer was pushed for every result row")
                .editor_member_ids
                .push(editor_member_id);
        }
    }

    Ok(ApiResponse::ok(EligibleOwnershipTransfersResponse {
        transfers,
    }))
}

pub async fn list_audit(
    State(state): State<AppState>,
    admin: InstanceAdmin,
    Query(query): Query<RawAuditQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let _ = admin.user_id;
    let limit = page_limit(query.limit)?;
    let cursor = parse_cursor(query.cursor_created_at, query.cursor_id)?;
    let action = match query.action {
        Some(action) => Some(AuditAction::parse(&action)?.as_str()),
        None => None,
    };
    let result = match query.result {
        Some(result) => Some(AuditResult::parse(&result)?.as_str()),
        None => None,
    };
    let cursor_created_at = cursor.map(|(created_at, _)| created_at);
    let cursor_id = cursor.map(|(_, id)| id);
    let query_limit = i64::try_from(limit + 1).map_err(|error| ApiError::Internal(error.into()))?;

    let mut rows = sqlx::query!(
        "SELECT
            id,
            actor_user_id,
            target_user_id,
            action,
            result,
            created_at
         FROM admin_audit_events
         WHERE ($1::text IS NULL OR action = $1)
           AND ($2::text IS NULL OR result = $2)
           AND (
                $3::timestamptz IS NULL
                OR $4::uuid IS NULL
                OR (created_at, id) < ($3, $4)
           )
         ORDER BY created_at DESC, id DESC
         LIMIT $5",
        action,
        result,
        cursor_created_at,
        cursor_id,
        query_limit,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    let has_more = rows.len() > limit;
    if has_more {
        rows.truncate(limit);
    }

    let events = rows
        .iter()
        .map(|row| AuditEventSummary {
            id: row.id,
            actor_user_id: row.actor_user_id,
            target_user_id: row.target_user_id,
            action: row.action.clone(),
            result: row.result.clone(),
            created_at: row.created_at,
        })
        .collect::<Vec<_>>();
    let next_cursor = if has_more {
        rows.last().map(|row| PageCursor {
            created_at: row.created_at,
            id: row.id,
        })
    } else {
        None
    };

    Ok(ApiResponse::ok(AuditResponse {
        events,
        next_cursor,
    }))
}

pub async fn record_audit(
    transaction: &mut Transaction<'_, Postgres>,
    actor_id: Uuid,
    target_id: Option<Uuid>,
    action: AuditAction,
    result: AuditResult,
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO admin_audit_events (id, actor_user_id, target_user_id, action, result)
         VALUES ($1, $2, $3, $4, $5)",
        Uuid::now_v7(),
        actor_id,
        target_id,
        action.as_str(),
        result.as_str(),
    )
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(())
}
