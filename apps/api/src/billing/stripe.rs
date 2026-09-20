use std::sync::Arc;

/// Everything Stripe needs, present only when the instance is configured for
/// billing. All fields are read by the billing routes in `apps/api/src/billing/routes.rs`.
#[derive(Clone)]
pub struct StripeContext {
    pub client: stripe::Client,
    pub webhook_secret: String,
    pub portal_return_url: String,
    pub price_monthly: String,
    pub price_yearly: String,
}

impl StripeContext {
    pub fn new(
        secret_key: &str,
        webhook_secret: String,
        portal_return_url: String,
        price_monthly: String,
        price_yearly: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            client: stripe::Client::new(secret_key),
            webhook_secret,
            portal_return_url,
            price_monthly,
            price_yearly,
        })
    }
}

/// The two ways verification can fail, kept deliberately distinct.
///
/// `InvalidSignature` means the request must be rejected outright: either the
/// HMAC did not match, the timestamp fell outside tolerance, or the body was
/// not even valid UTF-8 so no signature comparison could be trusted in the
/// first place.
///
/// `Unparseable` means the signature verified but `stripe_webhook` could not
/// deserialize the event body, which happens for an event type this crate
/// version does not know or one whose shape gained a field it does not
/// expect. That is not a forgery, and per the Stripe webhook spec an
/// unrecognized event must still be acknowledged (a 2xx), or Stripe retries
/// the same undeliverable event forever. The webhook handler in `routes.rs`
/// acknowledges and ignores this error; the type exists to keep the two
/// outcomes distinct.
#[derive(Debug)]
pub enum WebhookVerifyError {
    InvalidSignature,
    Unparseable,
}

/// Verifies a webhook against Stripe's signature over the RAW body.
///
/// The caller must hand over the exact bytes Stripe sent. Deserializing first
/// and re-serializing changes them, and the signature will not match. That is
/// why the handler takes `axum::body::Bytes` rather than a `Json` extractor,
/// which would consume the body.
///
/// Verification is delegated rather than hand-rolled. The scheme has a
/// timestamp tolerance and needs a constant-time comparison, and a mistake here
/// is a forged subscription rather than a visible bug.
///
/// Called by the webhook handler in `routes.rs`.
pub fn verify_webhook(
    payload: &[u8],
    signature: &str,
    secret: &str,
) -> Result<stripe_webhook::Event, WebhookVerifyError> {
    let payload = std::str::from_utf8(payload).map_err(|_| WebhookVerifyError::InvalidSignature)?;
    stripe_webhook::Webhook::construct_event(payload, signature, secret).map_err(
        |error| match error {
            stripe_webhook::WebhookError::BadParse(_) => WebhookVerifyError::Unparseable,
            stripe_webhook::WebhookError::BadKey
            | stripe_webhook::WebhookError::BadHeader(_)
            | stripe_webhook::WebhookError::BadSignature
            | stripe_webhook::WebhookError::BadTimestamp(_) => WebhookVerifyError::InvalidSignature,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(payload: &[u8], secret: &str, timestamp: i64) -> String {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(format!("{timestamp}.").as_bytes());
        mac.update(payload);
        format!(
            "t={timestamp},v1={}",
            hex::encode(mac.finalize().into_bytes())
        )
    }

    const SECRET: &str = "whsec_test_secret";

    /// A minimal but structurally complete `checkout.session.completed`
    /// event. `stripe_webhook` deserializes `data.object` into the full
    /// `CheckoutSession` type, which has several required (non-`Option`)
    /// fields beyond the identifiers, so this carries just enough of them
    /// (`automatic_tax`, `custom_fields`, `custom_text`, `expires_at`,
    /// `mode`, `payment_method_types`, `payment_status`, `shipping_options`)
    /// for that struct to parse. Every other field on `CheckoutSession` is
    /// `Option<T>`, which serde treats as absent-when-missing.
    fn payload() -> Vec<u8> {
        br#"{"id":"evt_1","object":"event","type":"checkout.session.completed","api_version":"2020-08-27","created":1,"livemode":false,"pending_webhooks":0,"request":null,"data":{"object":{"id":"cs_1","object":"checkout.session","automatic_tax":{"enabled":false},"created":1,"custom_fields":[],"custom_text":{},"expires_at":1,"livemode":false,"mode":"payment","payment_method_types":[],"payment_status":"paid","shipping_options":[]}}}"#.to_vec()
    }

    #[test]
    fn a_correctly_signed_payload_is_accepted() {
        let body = payload();
        let ts = time::OffsetDateTime::now_utc().unix_timestamp();
        let event = verify_webhook(&body, &sign(&body, SECRET, ts), SECRET)
            .expect("a correctly signed payload must verify");
        assert_eq!(event.id.to_string(), "evt_1");
    }

    /// The negative case is the one that matters. A verifier that accepts
    /// everything passes the positive test and protects nothing.
    ///
    /// The tampered byte at index 10 sits inside `"checkout.session.completed"`
    /// (the `c` of `checkout`), which XORed with `0x01` stays valid ASCII, so
    /// the tampered body still passes `str::from_utf8` and reaches the actual
    /// signature comparison instead of being turned away earlier by a UTF-8
    /// failure. An earlier version of this test flipped a byte inside the
    /// `evt_1` id with `0xff`, which produced an invalid UTF-8 continuation
    /// byte and made the test pass for the wrong reason: it never exercised
    /// the signature check at all.
    #[test]
    fn a_tampered_payload_is_rejected() {
        let body = payload();
        let ts = time::OffsetDateTime::now_utc().unix_timestamp();
        let signature = sign(&body, SECRET, ts);
        let mut tampered = body.clone();
        let index = body
            .windows(b"checkout".len())
            .position(|window| window == b"checkout")
            .expect("fixture must contain the event type");
        tampered[index] ^= 0x01;
        assert!(
            std::str::from_utf8(&tampered).is_ok(),
            "the tampered byte must stay valid UTF-8 so the test exercises signature comparison"
        );
        match verify_webhook(&tampered, &signature, SECRET) {
            Err(WebhookVerifyError::InvalidSignature) => {}
            other => panic!(
                "a payload that does not match its signature must be rejected as an invalid signature, got {other:?}"
            ),
        }
    }

    #[test]
    fn a_signature_made_with_another_secret_is_rejected() {
        let body = payload();
        let ts = time::OffsetDateTime::now_utc().unix_timestamp();
        assert!(
            verify_webhook(&body, &sign(&body, "whsec_wrong", ts), SECRET).is_err(),
            "a signature from the wrong secret must be rejected"
        );
    }
}
