use axum::{
    Json,
    extract::{FromRequest, FromRequestParts, Path, Request, rejection::JsonRejection},
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
};
use serde::{Serialize, de::DeserializeOwned};

/// JSON extractor whose framework rejections still use the API envelope.
pub struct ApiJson<T>(pub T);

#[axum::async_trait]
impl<T, S> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| ApiJson(value))
            .map_err(|rejection: JsonRejection| {
                if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    ApiError::PayloadTooLarge
                } else {
                    ApiError::BadRequest("Invalid request".to_string())
                }
            })
    }
}

/// Path extractor whose framework rejections still use the API envelope.
///
/// Axum's own rejection is a plain-text 400 that quotes the parser ("UUID
/// parsing failed: invalid length"), which breaks the envelope every client
/// relies on and describes internals to the caller. A path that does not
/// parse names nothing, so it is answered exactly as a well-formed id for a
/// missing row would be: not found, and no more.
pub struct ApiPath<T>(pub T);

#[axum::async_trait]
impl<T, S> FromRequestParts<S> for ApiPath<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Path::<T>::from_request_parts(parts, state)
            .await
            .map(|Path(value)| ApiPath(value))
            .map_err(|_| ApiError::NotFound)
    }
}

#[derive(Serialize)]
pub struct ApiResponse<T: Serialize> {
    success: bool,
    data: T,
    meta: serde_json::Value,
    error: serde_json::Value,
}

impl<T: Serialize> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        ApiResponse {
            success: true,
            data,
            meta: serde_json::json!({}),
            error: serde_json::Value::Null,
        }
    }

    /// The same envelope with `meta` filled in. `ok` hard-codes an empty
    /// object, which is right for almost every route; the health report needs
    /// to say when it was gathered.
    pub fn with_meta(data: T, meta: serde_json::Value) -> Self {
        ApiResponse {
            success: true,
            data,
            meta,
            error: serde_json::Value::Null,
        }
    }
}

impl<T: Serialize> IntoResponse for ApiResponse<T> {
    fn into_response(self) -> Response {
        Json(self).into_response()
    }
}

pub type ApiResult<T> = Result<ApiResponse<T>, ApiError>;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("invalid request")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("not found")]
    NotFound,
    #[error("wrong account")]
    WrongAccount,
    #[error("conflict")]
    Conflict,
    #[error("form closed")]
    FormClosed,
    /// An admin tried to delete an account that is still paying. Deletion
    /// removes the local subscription row but cannot cancel anything at
    /// Stripe, so the account would go on being charged with no account left
    /// to manage it from. The account holder cancels first.
    #[error("active subscription")]
    ActiveSubscription,
    /// A checkout for this account has been paid and Stripe has not yet
    /// confirmed it, so opening another would sell a second subscription.
    #[error("checkout in progress")]
    CheckoutInProgress,
    #[error("rate limited")]
    RateLimited,
    #[error("payload too large")]
    PayloadTooLarge,
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    success: bool,
    data: serde_json::Value,
    meta: serde_json::Value,
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, "bad_request", msg.clone()),
            ApiError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Unauthorized".to_string(),
            ),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not_found", "Not found".to_string()),
            ApiError::WrongAccount => (
                StatusCode::FORBIDDEN,
                "wrong_account",
                "Use the invited account".to_string(),
            ),
            ApiError::Conflict => (StatusCode::CONFLICT, "conflict", "Conflict".to_string()),
            ApiError::FormClosed => (
                StatusCode::CONFLICT,
                "form_closed",
                "Form is closed".to_string(),
            ),
            ApiError::CheckoutInProgress => (
                StatusCode::CONFLICT,
                "checkout_in_progress",
                "Your payment is still being confirmed. Reload this page in a minute.".to_string(),
            ),
            ApiError::ActiveSubscription => (
                StatusCode::CONFLICT,
                "active_subscription",
                "Cancel the subscription before deleting this account".to_string(),
            ),
            ApiError::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many requests".to_string(),
            ),
            ApiError::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "File is too large".to_string(),
            ),
            ApiError::Internal(err) => {
                tracing::error!(error = %err, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "Something went wrong".to_string(),
                )
            }
        };
        let body = ErrorBody {
            success: false,
            data: serde_json::json!({}),
            meta: serde_json::json!({}),
            error: ErrorDetail { code, message },
        };
        (status, Json(body)).into_response()
    }
}
