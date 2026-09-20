use axum::extract::State;
use serde::Serialize;
use time::format_description::well_known::Rfc3339;

use crate::{
    admin::guard::InstanceAdmin,
    error::{ApiError, ApiResponse, ApiResult},
    health::probes::{self, Probe},
    state::AppState,
};

#[derive(Serialize)]
struct Dependencies {
    postgres: Probe,
    redis: Probe,
    storage: Probe,
    mail: Probe,
}

#[derive(Serialize)]
struct Backlogs {
    notifications: NotificationsReport,
    attachments: AttachmentsReport,
    invitations: InvitationsReport,
}

#[derive(Serialize)]
struct NotificationsReport {
    due: i64,
    backing_off: i64,
    oldest_pending_at: Option<String>,
}

#[derive(Serialize)]
struct AttachmentsReport {
    cleanup_pending: i64,
    stale_uploads: i64,
    oldest_pending_at: Option<String>,
}

#[derive(Serialize)]
struct InvitationsReport {
    sending: i64,
    delivery_failed: i64,
}

#[derive(Serialize)]
struct Configuration {
    billing: &'static str,
    mail: &'static str,
    passkeys: &'static str,
    backups: &'static str,
}

/// RFC3339 explicitly. `time`'s default `Serialize` emits a numeric array,
/// which has already shipped here once as an `Invalid Date` in the UI. A
/// "stuck since" that renders blank is worse than useless, because blank
/// reads as "nothing is stuck".
fn rfc3339(value: Option<time::OffsetDateTime>) -> Result<Option<String>, ApiError> {
    value
        .map(|at| at.format(&Rfc3339))
        .transpose()
        .map_err(|error| ApiError::Internal(error.into()))
}

/// The whole report in one request.
///
/// Returns 200 even when everything is broken: the status code answers "could
/// I gather the report", not "is everything fine". A monitoring endpoint that
/// fails when things are unhealthy fails exactly when it is needed.
pub async fn handler(
    State(state): State<AppState>,
    admin: InstanceAdmin,
) -> ApiResult<serde_json::Value> {
    let _ = admin.user_id;

    let (postgres, redis, storage, mail) = tokio::join!(
        probes::postgres(&state.db),
        probes::redis(&state),
        probes::storage(&state),
        probes::mail(&state),
    );

    let notifications = crate::forms::notifications::backlog(
        &state.db,
        state.config.response_notify_cooldown_seconds,
    )
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let attachments = crate::attachments::cleanup::backlog(
        &state.db,
        state.config.attachment_upload_stale_seconds,
    )
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let invitations = crate::sharing::invitations::delivery_backlog(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    let checked_at = time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::with_meta(
        serde_json::json!({
            "dependencies": Dependencies { postgres, redis, storage, mail },
            "backlogs": Backlogs {
                notifications: NotificationsReport {
                    due: notifications.due,
                    backing_off: notifications.backing_off,
                    oldest_pending_at: rfc3339(notifications.oldest_pending_at)?,
                },
                attachments: AttachmentsReport {
                    cleanup_pending: attachments.cleanup_pending,
                    stale_uploads: attachments.stale_uploads,
                    oldest_pending_at: rfc3339(attachments.oldest_pending_at)?,
                },
                invitations: InvitationsReport {
                    sending: invitations.sending,
                    delivery_failed: invitations.delivery_failed,
                },
            },
            "configuration": Configuration {
                billing: state.config.billing_status(),
                mail: state.config.mail_status(),
                passkeys: state.config.passkey_status(),
                backups: state.config.backup_status(),
            },
        }),
        serde_json::json!({ "checked_at": checked_at }),
    ))
}
