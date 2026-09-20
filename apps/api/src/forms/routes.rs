use axum::extract::{Query, State};
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    auth::extractor::SessionUser,
    client_ip::ClientIp,
    error::{ApiError, ApiJson, ApiPath, ApiResponse, ApiResult},
    form_access::FormAccess,
    state::AppState,
};

// Both routes below need no session, so the caller's address is the only
// thing to meter. This is an abuse ceiling, not a crowd limit: it is scoped
// per form per source, so a classroom, an office, or a carrier-grade NAT
// sharing one address while opening the SAME form link must stay well inside
// it, and only hammering a single form from one address hits it.
const PUBLIC_FORM_READS_PER_SOURCE_PER_FORM_PER_MINUTE: u32 = 600;
const RESPONSE_EDITS_PER_SOURCE_PER_FORM_PER_MINUTE: u32 = 10;
// Submission carries two limits, and they answer different questions. The
// per-form ceiling bounds the total load one public link can put on the
// service. The per-source one sits underneath it so a single caller cannot
// spend that whole shared budget and turn every other respondent away, which
// is what the per-form key alone allowed. Twenty a minute still lets a room
// behind one address answer the same form together, the same reasoning as the
// read limit above, at a rate a person filling in a form never approaches.
const RESPONSES_PER_FORM_PER_MINUTE: u32 = 100;
const RESPONSES_PER_SOURCE_PER_FORM_PER_MINUTE: u32 = 20;
/// Mirrors `MAX_ATTACHMENTS_PER_FORM` in the attachments module: a response
/// cannot reference more files than a form can hold, so a longer list is a
/// malformed request rather than a large one.
const MAX_ATTACHMENT_REFERENCES_PER_RESPONSE: usize = 20;
/// The largest submission or edit body accepted, set on both routes in
/// `main.rs`. Without it they inherited the framework's 2 MiB default, and the
/// response allowance counts responses, not bytes, so the bytes one allowance
/// could store were bounded only by that accident. Half a MiB is far beyond
/// any answer a person types; the web client refuses to send more and says so.
pub const MAX_RESPONSE_BODY_BYTES: usize = 512 * 1024;

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Distinguishes "absent from the JSON" from "present and null".
///
/// A plain `Option<T>` collapses both to `None`, which is why `update_form`'s
/// `COALESCE` pattern cannot clear a column. Wrapping in a second `Option` and
/// deserializing through this keeps the difference: absent stays `None`, an
/// explicit null becomes `Some(None)`.
fn present<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// The same, for a timestamp that must parse as RFC3339.
#[expect(
    clippy::option_option,
    reason = "the outer Option is presence and the inner is the value; see `present` above"
)]
fn present_rfc3339<'de, D>(
    deserializer: D,
) -> Result<Option<Option<time::OffsetDateTime>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    time::serde::rfc3339::option::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
pub struct CreateFormBody {
    title_ciphertext: String,
    schema_ciphertext: String,
    form_public_key: String,
    wrapped_form_private_key: String,
    wrapped_form_data_key: String,
    /// Present when the form is published as a quiz from the start.
    answer_key_ciphertext: Option<String>,
    // Settings chosen on the draft before its first publish, so a form never
    // exists with settings it was not meant to have. Each is absent in an
    // older client's request and then takes the column default. These are the
    // same plaintext columns update_form already writes; nothing encrypted
    // travels here.
    allow_response_editing: Option<bool>,
    accepting_responses: Option<bool>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    closes_at: Option<time::OffsetDateTime>,
    max_responses: Option<i32>,
    notify_on_response: Option<bool>,
}

pub async fn create_form(
    State(state): State<AppState>,
    user: SessionUser,
    axum::Json(body): axum::Json<CreateFormBody>,
) -> ApiResult<serde_json::Value> {
    // v4, not v7, because this id goes into every public form link. v7 spends
    // its first 48 bits on a millisecond timestamp, so anyone holding a link
    // would learn when the form was created, and anyone holding two would
    // learn their order. v4 also leaves 122 random bits against v7's 74, so
    // the id is correspondingly harder to guess. The cost is index insert
    // locality: v7 keeps primary key inserts at the right edge of the B-tree
    // and v4 scatters them, which is why responses and members keep v7.
    let form_id = Uuid::new_v4();
    let member_id = Uuid::now_v7();
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;

    crate::admin::settings::reserve_form_slot(
        &mut transaction,
        user.user_id,
        state.billing_enabled(),
    )
    .await?;

    sqlx::query!(
        "INSERT INTO forms (
            id, title_ciphertext, schema_ciphertext, form_public_key,
            answer_key_ciphertext, allow_response_editing, accepting_responses,
            closes_at, max_responses
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        form_id,
        &body.title_ciphertext,
        &body.schema_ciphertext,
        &body.form_public_key,
        body.answer_key_ciphertext.as_deref(),
        body.allow_response_editing.unwrap_or(false),
        body.accepting_responses.unwrap_or(true),
        body.closes_at,
        body.max_responses,
    )
    .execute(&mut *transaction)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db_err) if db_err.is_check_violation() => {
            ApiError::BadRequest("invalid form settings".to_string())
        }
        _ => ApiError::Internal(e.into()),
    })?;

    sqlx::query!(
        "INSERT INTO form_members (
            id, form_id, user_id, role, state, key_scheme,
            encrypted_form_data_key, encrypted_form_private_key,
            notify_on_response
         ) VALUES ($1, $2, $3, 'owner', 'active', 'master_wrap_v1', $4, $5, $6)",
        member_id,
        form_id,
        user.user_id,
        &body.wrapped_form_data_key,
        &body.wrapped_form_private_key,
        body.notify_on_response.unwrap_or(true),
    )
    .execute(&mut *transaction)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    transaction
        .commit()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;

    Ok(ApiResponse::ok(json!({ "id": form_id })))
}

#[derive(Deserialize)]
pub struct ListFormsQuery {
    /// Absent or falsy: the default dashboard list, archived memberships
    /// excluded. Any truthy value (`?archived=1`, `true`, etc.): only the
    /// caller's archived memberships. There is no "both" mode: archiving is
    /// meant to clear a form off the default list, not annotate it there.
    archived: Option<String>,
}

fn is_truthy_query_flag(value: &str) -> bool {
    matches!(value, "1" | "true" | "yes")
}

pub async fn list_forms(
    State(state): State<AppState>,
    user: SessionUser,
    Query(query): Query<ListFormsQuery>,
) -> ApiResult<serde_json::Value> {
    let want_archived = query.archived.as_deref().is_some_and(is_truthy_query_flag);

    let memberships = sqlx::query!(
        "SELECT form_id, created_at, archived_at
         FROM form_members
         WHERE user_id = $1
           AND (archived_at IS NOT NULL) = $2
         ORDER BY created_at DESC",
        user.user_id,
        want_archived,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    let mut forms = Vec::with_capacity(memberships.len());
    for membership in memberships {
        let access = FormAccess::load(&state.db, membership.form_id, user.user_id)
            .await
            .map_err(|e| ApiError::Internal(e.into()))?
            .ok_or(ApiError::NotFound)?;
        // The version travels with the title, and that pairing is the point.
        // A rename from the dashboard has to send the version the list was
        // read at, because that is the version the title on screen belongs
        // to. Fetching a fresh one immediately before the write instead makes
        // `expected_version` a no-op: a rename by someone else in between
        // raises the version, the fresh read picks that version up, and the
        // write then overwrites their change with no conflict raised. Do not
        // "simplify" this by dropping it and re-reading at write time.
        let form_row = if access.require_read().is_ok() {
            sqlx::query!(
                "SELECT title_ciphertext, version FROM forms WHERE id = $1",
                membership.form_id,
            )
            .fetch_optional(&state.db)
            .await
            .map_err(|e| ApiError::Internal(e.into()))?
        } else {
            None
        };
        let title_ciphertext = form_row.as_ref().map(|row| row.title_ciphertext.clone());
        let version = form_row.as_ref().map(|row| row.version);
        // `time::OffsetDateTime`'s default `Serialize` is a component array,
        // not a string, and `json!` can't carry the `#[serde(with = "...")]`
        // attribute that fixes this elsewhere in the codebase (see the same
        // comment on `closes_at` in `get_form` below). `archived_at` needs to
        // be a usable timestamp for the client, so format it explicitly.
        let archived_at = membership
            .archived_at
            .map(|archived_at| archived_at.format(&time::format_description::well_known::Rfc3339))
            .transpose()
            .map_err(|e| ApiError::Internal(e.into()))?;
        forms.push(json!({
            "id": membership.form_id,
            "role": access.role.as_str(),
            "membership_state": access.state,
            "title_ciphertext": title_ciphertext,
            "key_scheme": access.key_scheme,
            "encrypted_form_data_key": access.encrypted_form_data_key,
            "encrypted_form_private_key": access.encrypted_form_private_key,
            "created_at": membership.created_at,
            "archived_at": archived_at,
            "version": version,
        }));
    }

    Ok(ApiResponse::ok(json!({ "forms": forms })))
}

pub async fn get_form(
    State(state): State<AppState>,
    user: SessionUser,
    ApiPath(id): ApiPath<Uuid>,
) -> ApiResult<serde_json::Value> {
    let access = FormAccess::load(&state.db, id, user.user_id)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?
        .ok_or(ApiError::NotFound)?;
    access.require_read()?;

    let row = sqlx::query!(
        "SELECT id, title_ciphertext, schema_ciphertext, form_public_key,
                allow_response_editing, accepting_responses, closes_at,
                max_responses, version, created_at, header_attachment_id,
                answer_key_ciphertext
         FROM forms WHERE id = $1",
        id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    let Some(row) = row else {
        return Err(ApiError::NotFound);
    };

    // `time::OffsetDateTime`'s default `Serialize` is a component array, not
    // a string (`serde-well-known` does not imply `serde-human-readable`),
    // and `json!` can't carry the `#[serde(with = "...")]` attribute that
    // fixes this everywhere else in the codebase. Format explicitly instead.
    let closes_at = row
        .closes_at
        .map(|closes_at| closes_at.format(&time::format_description::well_known::Rfc3339))
        .transpose()
        .map_err(|e| ApiError::Internal(e.into()))?;

    // Not in the same transaction as FormAccess::load above: a concurrent
    // leave_form or removal can delete this membership row between the two
    // queries. If it does, the member genuinely no longer has access, so
    // that must surface as NotFound rather than a 500 from fetch_one.
    let notify_on_response = sqlx::query_scalar!(
        "SELECT notify_on_response FROM form_members
         WHERE form_id = $1 AND user_id = $2",
        id,
        user.user_id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?
    .ok_or(ApiError::NotFound)?;

    Ok(ApiResponse::ok(json!({
        "id": row.id,
        "title_ciphertext": row.title_ciphertext,
        "schema_ciphertext": row.schema_ciphertext,
        // Members only. Encrypted under the quiz key, which respondents never
        // hold; get_form_public must never select this column.
        "answer_key_ciphertext": row.answer_key_ciphertext,
        "form_public_key": row.form_public_key,
        "role": access.role.as_str(),
        "membership_state": access.state,
        "key_scheme": access.key_scheme,
        "encrypted_form_private_key": access.encrypted_form_private_key,
        "encrypted_form_data_key": access.encrypted_form_data_key,
        "allow_response_editing": row.allow_response_editing,
        "accepting_responses": row.accepting_responses,
        "closes_at": closes_at,
        "max_responses": row.max_responses,
        "notify_on_response": notify_on_response,
        // A flag, like the public read: the builder only needs to know whether
        // to ask for the image, and the id is never the client's to hold.
        "header_image": row.header_attachment_id.is_some(),
        "version": row.version,
        "created_at": row.created_at,
    })))
}

#[derive(Deserialize)]
#[expect(
    clippy::option_option,
    reason = "the outer Option is presence and the inner is the value, which is what lets an \
              absent field mean leave it alone and an explicit null mean clear it. Collapsing \
              them would make clearing a close date, a cap or a header image impossible."
)]
pub struct UpdateFormBody {
    title_ciphertext: Option<String>,
    schema_ciphertext: Option<String>,
    allow_response_editing: Option<bool>,
    accepting_responses: Option<bool>,
    /// Absent leaves the close date alone; an explicit null clears it.
    #[serde(default, deserialize_with = "present_rfc3339")]
    closes_at: Option<Option<time::OffsetDateTime>>,
    /// Absent leaves the cap alone; an explicit null clears it.
    #[serde(default, deserialize_with = "present")]
    max_responses: Option<Option<i32>>,
    /// Absent leaves the header image alone; an explicit null removes it.
    #[serde(default, deserialize_with = "present")]
    header_attachment_id: Option<Option<Uuid>>,
    /// Absent leaves the answer key alone; an explicit null removes it.
    #[serde(default, deserialize_with = "present")]
    answer_key_ciphertext: Option<Option<String>>,
    expected_version: i64,
}

pub async fn update_form(
    State(state): State<AppState>,
    user: SessionUser,
    ApiPath(id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<UpdateFormBody>,
) -> ApiResult<serde_json::Value> {
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    // Form first, then membership: the order every membership mutation uses,
    // so removing this caller and this edit serialize instead of deadlocking.
    // Deciding the caller's rights under the lock is the point. A pool read
    // here let an Editor removed mid-request still write, because the
    // UPDATE below carries no membership clause of its own.
    let current = sqlx::query!(
        "SELECT accepting_responses, closes_at, max_responses
         FROM forms WHERE id = $1 FOR UPDATE",
        id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::NotFound)?;
    FormAccess::load_for_update(&mut transaction, id, user.user_id)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
        .ok_or(ApiError::NotFound)?
        .require_edit()?;

    // Only an edit that touches one of the three fields deciding "open" can
    // reopen a form, so only that edit pays for the response count.
    if body.accepting_responses.is_some()
        || body.closes_at.is_some()
        || body.max_responses.is_some()
    {
        let response_count = count_responses_under_lock(&mut transaction, id)
            .await
            .map_err(|error| ApiError::Internal(error.into()))?;
        let was_open = form_is_open(
            current.accepting_responses,
            current.closes_at,
            current.max_responses,
            response_count,
        );
        let will_be_open = form_is_open(
            body.accepting_responses
                .unwrap_or(current.accepting_responses),
            body.closes_at.unwrap_or(current.closes_at),
            body.max_responses.unwrap_or(current.max_responses),
            response_count,
        );
        if !was_open && will_be_open {
            // The limit belongs to the owner, not to the Editor who may be
            // the one reopening it.
            let owner_id = sqlx::query_scalar!(
                "SELECT user_id FROM form_members
                 WHERE form_id = $1 AND role = 'owner' AND state = 'active'",
                id,
            )
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| ApiError::Internal(error.into()))?
            .ok_or(ApiError::NotFound)?;
            crate::admin::settings::check_reopen_allowed(
                &mut transaction,
                owner_id,
                state.billing_enabled(),
            )
            .await?;
        }
    }

    // `closes_at` and `max_responses` can't use the `COALESCE($n, column)`
    // pattern above: a null parameter there is indistinguishable from "leave
    // it alone", but the API must also support clearing these two columns
    // (an explicit JSON null). Each gets its own "should update" flag instead,
    // so a `CASE` picks the new value (possibly NULL) only when the field was
    // present in the request body at all.
    let row = sqlx::query!(
        "UPDATE forms SET
            title_ciphertext = COALESCE($1, title_ciphertext),
            schema_ciphertext = COALESCE($2, schema_ciphertext),
            allow_response_editing = COALESCE($3, allow_response_editing),
            accepting_responses = COALESCE($4, accepting_responses),
            closes_at = CASE WHEN $5 THEN $6 ELSE closes_at END,
            max_responses = CASE WHEN $7 THEN $8 ELSE max_responses END,
            -- Same present/absent handling as the two above: a null here means
            -- remove the header, not leave it alone. The subquery is the
            -- authorisation: a caller can only point this at an attachment
            -- that already belongs to this form AND was uploaded by an editor
            -- with a session. The second clause is what keeps the public
            -- header route from being aimed at a respondent's sealed upload,
            -- which is always anonymous and so never carries uploaded_by.
            header_attachment_id = CASE
                WHEN $11 THEN (
                    SELECT a.id FROM attachments a
                    WHERE a.id = $12 AND a.form_id = forms.id
                      AND a.uploaded_by IS NOT NULL
                )
                ELSE header_attachment_id
            END,
            -- The answer key describes the questions, so it is written in this
            -- statement and under this version, never on its own.
            answer_key_ciphertext = CASE WHEN $13 THEN $14 ELSE answer_key_ciphertext END,
            version = version + 1
         WHERE id = $9 AND version = $10 AND deletion_started_at IS NULL
         RETURNING version",
        body.title_ciphertext,
        body.schema_ciphertext,
        body.allow_response_editing,
        body.accepting_responses,
        body.closes_at.is_some(),
        body.closes_at.flatten(),
        body.max_responses.is_some(),
        body.max_responses.flatten(),
        id,
        body.expected_version,
        body.header_attachment_id.is_some(),
        body.header_attachment_id.flatten(),
        body.answer_key_ciphertext.is_some(),
        body.answer_key_ciphertext
            .as_ref()
            .and_then(|key| key.as_deref()),
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db_err) if db_err.is_check_violation() => {
            ApiError::BadRequest("invalid form settings".to_string())
        }
        _ => ApiError::Internal(e.into()),
    })?;

    let row = row.ok_or(ApiError::Conflict)?;

    // The header is served to every respondent, so it must never be reclaimed
    // as an abandoned upload. Claiming an id the subquery above refused is
    // harmless: it names nothing on this form that an editor did not upload.
    if let Some(Some(header_id)) = body.header_attachment_id {
        crate::attachments::cleanup::claim_attachments(&mut transaction, id, &[header_id])
            .await
            .map_err(|error| ApiError::Internal(error.into()))?;
    }

    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(json!({ "version": row.version })))
}

pub async fn get_form_public(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    ApiPath(id): ApiPath<Uuid>,
) -> ApiResult<serde_json::Value> {
    let allowed = crate::rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("public_form:{id}:source:{client_ip}"),
        PUBLIC_FORM_READS_PER_SOURCE_PER_FORM_PER_MINUTE,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let row = sqlx::query!(
        "SELECT title_ciphertext, schema_ciphertext, form_public_key, accepting_responses,
                closes_at, max_responses, header_attachment_id
         FROM forms WHERE id = $1",
        id,
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    let Some(row) = row else {
        return Err(ApiError::NotFound);
    };

    // Only worth counting when there is a cap to compare against: this is
    // the hottest public path in the app, and the count is never used
    // otherwise.
    let response_count = if row.max_responses.is_some() {
        sqlx::query_scalar!("SELECT count(*) FROM responses WHERE form_id = $1", id,)
            .fetch_one(&state.db)
            .await
            .map_err(|e| ApiError::Internal(e.into()))?
            .unwrap_or(0)
    } else {
        0
    };

    let mut accepting = form_is_open(
        row.accepting_responses,
        row.closes_at,
        row.max_responses,
        ResponseCount::reported(response_count),
    );

    // Only worth resolving the owner and checking the account allowance when
    // the form would otherwise be open, for the same reason `response_count`
    // above is only computed when there is a cap: this is the hottest public
    // path in the app. Folding this in here means a respondent sees the
    // ordinary closed-form page instead of filling in a form that would then
    // be rejected at submission by the same check in `submit_response`.
    if accepting {
        let owner_user_id = sqlx::query_scalar!(
            "SELECT user_id FROM form_members
             WHERE form_id = $1 AND role = 'owner' AND state = 'active'",
            id,
        )
        .fetch_optional(&state.db)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;

        accepting = match owner_user_id {
            Some(owner_user_id) => {
                let mut transaction = state
                    .db
                    .begin()
                    .await
                    .map_err(|e| ApiError::Internal(e.into()))?;
                let used =
                    crate::billing::quota::responses_used(&mut transaction, owner_user_id).await?;
                let allowance = crate::admin::settings::max_responses_for_user(
                    &mut transaction,
                    owner_user_id,
                    state.billing_enabled(),
                )
                .await?;
                transaction
                    .commit()
                    .await
                    .map_err(|e| ApiError::Internal(e.into()))?;
                !crate::admin::settings::response_allowance_exhausted(used, allowance)
            }
            None => false,
        };
    }

    Ok(ApiResponse::ok(json!({
        "title_ciphertext": row.title_ciphertext,
        "schema_ciphertext": row.schema_ciphertext,
        "form_public_key": row.form_public_key,
        // Computed, not the raw column: a respondent learns only "open" or
        // "closed" and never which limit stopped them. `get_form` keeps
        // returning the raw column, because the owner's toggle must show the
        // actual setting. The two endpoints differ deliberately.
        "accepting_responses": accepting,
        // A flag, never the id: the client only needs to know whether to ask
        // for /header-image, and that route authorises against this same
        // column rather than against anything the client sends back.
        "header_image": row.header_attachment_id.is_some(),
    })))
}

/// A response count, carrying where it came from.
///
/// This parameter used to be a bare `i64`, and the two kinds of caller went
/// through the same door. `submit_response`'s cheap early-out passed a literal
/// `0`; its authoritative check, twenty lines further down, passed a count
/// taken under `FOR UPDATE OF forms, owner_user`. Nothing in the signature
/// told them apart, so a new call site had no way to know which one it was
/// writing, and counting before the lock is the obvious implementation and the
/// wrong one: two requests arriving together read the same total, both pass,
/// and the cap is exceeded.
///
/// There is deliberately no constructor for a count taken under a lock.
/// `count_responses_under_lock` is the only thing that produces one, and it
/// takes the transaction, so the count and the lock cannot drift apart.
/// Everything else says `reported` at the call site, which is a loud thing to
/// write in a path that is meant to enforce a cap.
#[derive(Clone, Copy)]
pub(crate) struct ResponseCount(i64);

impl ResponseCount {
    /// A count taken outside any lock, so it may be stale by the time it is
    /// read. Correct for telling a respondent whether a form looks open, and
    /// for gating an attachment upload: neither is the moment the cap is
    /// actually enforced.
    pub(crate) fn reported(value: i64) -> Self {
        Self(value)
    }
}

/// Counts a form's responses inside a transaction that already holds
/// `FOR UPDATE OF forms, owner_user` on it.
///
/// The only source of a count that may decide whether one more response is
/// allowed. Taking the count before opening the transaction, or before the
/// lock, is what this exists to make awkward to write.
pub(crate) async fn count_responses_under_lock(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    form_id: Uuid,
) -> Result<ResponseCount, sqlx::Error> {
    let count = sqlx::query_scalar!("SELECT count(*) FROM responses WHERE form_id = $1", form_id,)
        .fetch_one(&mut **transaction)
        .await?
        .unwrap_or(0);
    Ok(ResponseCount(count))
}

/// Whether a form may accept another response.
///
/// The single definition of "open", and it stays single deliberately: two
/// copies of this rule is how a client and a server come to disagree about
/// whether a form is open, and the disagreement surfaces as a respondent
/// filling in a form that then rejects them. `submit_response` enforces it,
/// `get_form_public` reports it, and both attachment upload sites gate on it.
///
/// `form_is_provisionally_open` below is not a second copy: it answers a
/// strictly weaker question, and anything it lets through still meets this.
pub(crate) fn form_is_open(
    accepting_responses: bool,
    closes_at: Option<time::OffsetDateTime>,
    max_responses: Option<i32>,
    response_count: ResponseCount,
) -> bool {
    let response_count = response_count.0;
    if !accepting_responses {
        return false;
    }
    if let Some(closes_at) = closes_at
        && closes_at <= time::OffsetDateTime::now_utc()
    {
        return false;
    }
    if let Some(max_responses) = max_responses
        && response_count >= i64::from(max_responses)
    {
        return false;
    }
    true
}

/// Whether a form is closed for a reason that needs no response count.
///
/// The cheap early-out in `submit_response`, so an obviously closed form does
/// not cost a transaction. It answers a strictly weaker question than
/// `form_is_open`: every form this rejects is closed, but a form it accepts
/// may still be full. It cannot be used to admit a response, which is the
/// whole point, and it takes no count so there is no count to get wrong.
///
/// This replaced passing a literal `0` to `form_is_open`, which read as a real
/// check and was not one.
pub(crate) fn form_is_provisionally_open(
    accepting_responses: bool,
    closes_at: Option<time::OffsetDateTime>,
) -> bool {
    if !accepting_responses {
        return false;
    }
    !matches!(closes_at, Some(closes_at) if closes_at <= time::OffsetDateTime::now_utc())
}

#[derive(Deserialize)]
pub struct SubmitResponseBody {
    ciphertext: String,
    /// The uploads this response references, so they are not reclaimed as
    /// abandoned. See `attachments::cleanup::claim_attachments`.
    #[serde(default)]
    attachment_ids: Vec<Uuid>,
}

fn check_attachment_references(attachment_ids: &[Uuid]) -> Result<(), ApiError> {
    if attachment_ids.len() > MAX_ATTACHMENT_REFERENCES_PER_RESPONSE {
        return Err(ApiError::BadRequest(
            "Invalid attachment reference.".to_string(),
        ));
    }
    Ok(())
}

pub async fn submit_response(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    ApiPath(form_id): ApiPath<Uuid>,
    axum::Json(body): axum::Json<SubmitResponseBody>,
) -> ApiResult<serde_json::Value> {
    check_attachment_references(&body.attachment_ids)?;

    // Both limits run before any database work, so a caller being turned
    // away costs a Redis call and nothing more. The per-source limit goes
    // first: a request it refuses must not also spend the form's shared
    // budget, or one caller could still exhaust that budget by being refused.
    let allowed = crate::rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("responses:{form_id}:source:{client_ip}"),
        RESPONSES_PER_SOURCE_PER_FORM_PER_MINUTE,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }
    let allowed = crate::rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("responses:{form_id}"),
        RESPONSES_PER_FORM_PER_MINUTE,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let form = sqlx::query!(
        "SELECT forms.id, forms.allow_response_editing, forms.accepting_responses,
                forms.closes_at, forms.max_responses
         FROM forms
         JOIN form_members owner
           ON owner.form_id = forms.id
          AND owner.role = 'owner'
          AND owner.state = 'active'
         JOIN users owner_user
           ON owner_user.id = owner.user_id
          AND owner_user.suspended_at IS NULL
         WHERE forms.id = $1",
        form_id
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    let Some(form) = form else {
        return Err(ApiError::NotFound);
    };
    // Cheap early-out before the transaction, so an obviously closed form does
    // not cost one. It cannot see the cap, and deliberately so: the
    // transactional check below, which counts under the row lock, is the only
    // thing that decides whether one more response is allowed.
    if !form_is_provisionally_open(form.accepting_responses, form.closes_at) {
        return Err(ApiError::FormClosed);
    }

    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let form = sqlx::query!(
        "SELECT forms.allow_response_editing, forms.accepting_responses,
                forms.closes_at, forms.max_responses, owner.user_id AS owner_user_id,
                owner_user.email AS owner_email
         FROM forms
         JOIN form_members owner
           ON owner.form_id = forms.id
          AND owner.role = 'owner'
          AND owner.state = 'active'
         JOIN users owner_user
           ON owner_user.id = owner.user_id
          AND owner_user.suspended_at IS NULL
         WHERE forms.id = $1
         FOR UPDATE OF forms, owner_user",
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let Some(form) = form else {
        return Err(ApiError::NotFound);
    };

    // Counted inside the transaction, after FOR UPDATE OF forms, so concurrent
    // submissions serialize on the form row. `count_responses_under_lock` is
    // the only thing that produces a count this check will accept, which is
    // what keeps the count and the lock from drifting apart.
    let response_count = count_responses_under_lock(&mut transaction, form_id)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    if !form_is_open(
        form.accepting_responses,
        form.closes_at,
        form.max_responses,
        response_count,
    ) {
        return Err(ApiError::FormClosed);
    }

    // The account allowance is per-user, not per-form, so the `FOR UPDATE OF
    // forms` lock above does not serialize it: two submissions to two
    // different forms owned by the same person would lock two different
    // forms rows and race past each other. What actually serializes this
    // check is `FOR UPDATE OF forms, owner_user` locking the owner's users
    // row, which every form of that owner joins to. Removing `owner_user`
    // from that lock list, or moving the suspension check off this same
    // joined row, breaks the account-level check even though the per-form
    // cap above would keep working. The error is the same `FormClosed` an
    // ordinary closed form produces, so a respondent cannot tell a billing
    // limit from any other reason a form stopped accepting responses.
    let used = crate::billing::quota::responses_used(&mut transaction, form.owner_user_id).await?;
    let allowance = crate::admin::settings::max_responses_for_user(
        &mut transaction,
        form.owner_user_id,
        state.billing_enabled(),
    )
    .await?;
    if crate::admin::settings::response_allowance_exhausted(used, allowance) {
        return Err(ApiError::FormClosed);
    }

    let edit_token = if form.allow_response_editing {
        let mut token_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut token_bytes);
        Some(base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            token_bytes,
        ))
    } else {
        None
    };
    let edit_token_hash = edit_token.as_deref().map(hash_token);

    let response_id = Uuid::now_v7();
    sqlx::query!(
        "INSERT INTO responses (id, form_id, ciphertext, edit_token_hash)
         VALUES ($1, $2, $3, $4)",
        response_id,
        form_id,
        body.ciphertext,
        edit_token_hash,
    )
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;

    crate::attachments::cleanup::claim_attachments(&mut transaction, form_id, &body.attachment_ids)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    // In the same transaction as the insert above: a rolled-back submission
    // must not burn allowance, and a committed one must always count.
    crate::billing::quota::record_response(&mut transaction, form.owner_user_id).await?;

    // `used` was read before this response was recorded, so the count after
    // the insert above is `used + 1`. Claiming inside the same transaction as
    // the insert keeps the claim itself atomic with the count it warns about;
    // the mail send below stays outside the transaction and after commit, so
    // a slow or failed send can never roll back the respondent's answer.
    let new_used = used + 1;
    // No allowance is no warning: there is no threshold to be four fifths of
    // the way to. An instance that does not bill and has set no default never
    // sends this mail at all.
    let warned_allowance = match allowance.map(i64::from) {
        Some(allowance) if allowance > 0 && new_used * 5 >= allowance * 4 => {
            crate::billing::quota::claim_allowance_warning(&mut transaction, form.owner_user_id)
                .await?
                .then_some(allowance)
        }
        _ => None,
    };

    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    if let Some(allowance) = warned_allowance {
        let mail = crate::mail::allowance_warning_mail(
            &form.owner_email,
            new_used,
            allowance,
            &state.config.web_base_url,
        );
        // The error itself is not logged: an SMTP relay's reply can quote the
        // recipient address, and every other mail path drops it for that
        // reason. The user id is enough to find the account.
        if state.mailer.send(mail).await.is_err() {
            tracing::warn!(
                user_id = %form.owner_user_id,
                failure_kind = "allowance_warning_mail",
                "failed to send allowance warning mail"
            );
        }
    }

    Ok(ApiResponse::ok(
        json!({ "id": response_id, "edit_token": edit_token }),
    ))
}

/// One page of a form's responses, in submission order.
///
/// Paged because the rows are written by anyone holding the form link, and the
/// listing used to read all of them into one response in a process every
/// account shares, so its memory followed the form's total stored ciphertext
/// rather than anything this request asked for. A page stops at
/// `RESPONSES_PER_PAGE` rows or once it has passed `RESPONSE_PAGE_BYTES` of
/// ciphertext, whichever comes first, and always carries at least one row so
/// an oversized one can never stall the listing.
///
/// The cursor is the last id the client received. Response ids are UUIDv7, so
/// ordering by id is submission order, and a cursor that names a response
/// deleted between pages still orders correctly, where an offset or a lookup
/// of that row would skip or stop.
#[derive(Deserialize)]
pub struct ListResponsesQuery {
    cursor: Option<String>,
}

const RESPONSES_PER_PAGE: i64 = 500;
const RESPONSE_PAGE_BYTES: i64 = 4 * 1024 * 1024;

pub async fn list_responses(
    State(state): State<AppState>,
    user: SessionUser,
    ApiPath(form_id): ApiPath<Uuid>,
    Query(query): Query<ListResponsesQuery>,
) -> ApiResult<serde_json::Value> {
    let access = FormAccess::load(&state.db, form_id, user.user_id)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?
        .ok_or(ApiError::NotFound)?;
    access.require_read()?;

    let cursor = query
        .cursor
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| ApiError::BadRequest("Invalid cursor".to_string()))?;

    // The running total is computed in id order as rows stream past the
    // limit, so the database stops reading once the page is full rather than
    // summing the whole form first. A row is kept while the bytes before it
    // are under budget, which is what guarantees the first row always is.
    let rows = sqlx::query!(
        r#"SELECT id AS "id!", ciphertext AS "ciphertext!", created_at AS "created_at!"
           FROM (
               SELECT id, ciphertext, created_at,
                      sum(octet_length(ciphertext)) OVER (ORDER BY id) AS running
               FROM responses
               WHERE form_id = $1 AND ($2::uuid IS NULL OR id > $2)
               ORDER BY id
               LIMIT $3
           ) page
           WHERE page.running - octet_length(page.ciphertext) < $4
           ORDER BY id"#,
        form_id,
        cursor,
        RESPONSES_PER_PAGE,
        RESPONSE_PAGE_BYTES,
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    let next_cursor = match rows.last() {
        Some(last) => sqlx::query_scalar!(
            r#"SELECT EXISTS (
                   SELECT 1 FROM responses WHERE form_id = $1 AND id > $2
               ) AS "more!""#,
            form_id,
            last.id,
        )
        .fetch_one(&state.db)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?
        .then_some(last.id),
        None => None,
    };

    let responses: Vec<_> = rows
        .into_iter()
        .map(|r| json!({ "id": r.id, "ciphertext": r.ciphertext, "created_at": r.created_at }))
        .collect();
    Ok(ApiResponse::ok(
        json!({ "responses": responses, "next_cursor": next_cursor }),
    ))
}

#[derive(Deserialize)]
pub struct DeleteResponseBody {
    /// Attachment ids the response referenced.
    ///
    /// The server cannot derive these: the link from a response to its files
    /// lives inside the encrypted ciphertext, which the API has no key for. The
    /// browser decrypted the response to display it and supplies them here.
    ///
    /// An empty list is accepted and cannot be validated: the server cannot
    /// distinguish a response with no files from a client that forgot to send
    /// them.
    ///
    /// The ownership check below is form-scoped, not response-scoped: an id
    /// belonging to a different response of the *same* form is accepted and
    /// cleaned up too. This is deliberate and grants nothing new, since an
    /// Editor may already delete every response on the form.
    attachment_ids: Vec<Uuid>,
}

pub async fn delete_response(
    State(state): State<AppState>,
    user: SessionUser,
    ApiPath((form_id, response_id)): ApiPath<(Uuid, Uuid)>,
    ApiJson(body): ApiJson<DeleteResponseBody>,
) -> ApiResult<serde_json::Value> {
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    // Form first, matching the lock order submit_response and every attachment
    // path use. A different order here risks a deadlock against them.
    let form_exists = sqlx::query_scalar!(
        "SELECT id FROM forms WHERE id = $1 AND deletion_started_at IS NULL FOR UPDATE",
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .is_some();
    if !form_exists {
        return Err(ApiError::NotFound);
    }
    // Decided under the form lock, which every membership change also takes,
    // so an Editor removed while this request was in flight cannot still
    // destroy a response. A pool read before the transaction allowed exactly
    // that.
    //
    // Deleting responses can reopen a form that had reached its response cap,
    // and this path deliberately does not apply the open-form limit that
    // `update_form` applies to a reopen. Refusing a deletion would leave the
    // owner unable to remove data they hold, which is worse than one form
    // over the limit; reaching the cap first is the costly half of that cycle.
    FormAccess::load_for_update(&mut transaction, form_id, user.user_id)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
        .ok_or(ApiError::NotFound)?
        .require_edit()?;

    // Keyed on form_id too, so a response id belonging to another form cannot
    // be deleted through this form's path.
    let deleted = sqlx::query_scalar!(
        "DELETE FROM responses WHERE id = $1 AND form_id = $2 RETURNING id",
        response_id,
        form_id,
    )
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if deleted.is_none() {
        return Err(ApiError::NotFound);
    }

    for attachment_id in body.attachment_ids {
        let transitioned = crate::attachments::cleanup::mark_deleted_by_owner(
            &mut transaction,
            form_id,
            attachment_id,
        )
        .await
        .map_err(ApiError::Internal)?;
        if !transitioned {
            // Rolls back the response delete too. Skipping silently would hide
            // a client bug behind a successful response. BadRequest, not
            // NotFound: the client's `not_found` handling treats that code as
            // "already gone" and would otherwise swallow this rejection too.
            return Err(ApiError::BadRequest("Invalid attachment reference.".into()));
        }
    }

    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(json!({})))
}

#[derive(Deserialize)]
pub struct UpdateResponseBody {
    ciphertext: String,
    /// Files the edited response references, including any added in this
    /// edit. Same purpose as on submission.
    #[serde(default)]
    attachment_ids: Vec<Uuid>,
}

pub async fn update_response(
    State(mut state): State<AppState>,
    ClientIp(client_ip): ClientIp,
    // The route is a fixed literal path (`/responses/edit`); no path
    // parameter carries the edit token. The token is a bearer secret
    // (random bytes + SHA-256 hash stored server-side, same class as a
    // session token), so it travels only in the `X-Response-Token` header,
    // never in the URL: request paths (unlike the URL fragment used for the
    // schema decryption key) are the kind of thing a reverse-proxy access
    // log captures by default the moment one is introduced.
    ApiPath(form_id): ApiPath<Uuid>,
    headers: axum::http::HeaderMap,
    axum::Json(body): axum::Json<UpdateResponseBody>,
) -> ApiResult<serde_json::Value> {
    let allowed = crate::rate_limit::check_rate_limit(
        &mut state.redis,
        &format!("response_edit:{form_id}:source:{client_ip}"),
        RESPONSE_EDITS_PER_SOURCE_PER_FORM_PER_MINUTE,
        60,
    )
    .await
    .map_err(ApiError::Internal)?;
    if !allowed {
        return Err(ApiError::RateLimited);
    }

    let Some(token) = headers
        .get("x-response-token")
        .and_then(|v| v.to_str().ok())
    else {
        return Err(ApiError::NotFound);
    };

    let form = sqlx::query!(
        "SELECT allow_response_editing FROM forms WHERE id = $1",
        form_id
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    let Some(form) = form else {
        return Err(ApiError::NotFound);
    };
    if !form.allow_response_editing {
        return Err(ApiError::NotFound);
    }

    check_attachment_references(&body.attachment_ids)?;

    let token_hash = hash_token(token);
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    // Deliberately no allowance check and no `record_response` call here.
    // This edits a response already counted at submission time, so metering
    // it again would double count, and a limit that filled up since then
    // must not block editing a response it already admitted.
    let result = sqlx::query!(
        "UPDATE responses SET ciphertext = $1, updated_at = now()
         WHERE form_id = $2 AND edit_token_hash = $3",
        body.ciphertext,
        form_id,
        token_hash,
    )
    .execute(&mut *transaction)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;

    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }

    // Only after the token has proved this caller holds a response on this
    // form, so an unauthenticated request cannot claim anything.
    crate::attachments::cleanup::claim_attachments(&mut transaction, form_id, &body.attachment_ids)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(ApiResponse::ok(json!({})))
}
