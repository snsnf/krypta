use reqwest::Client;

fn base_url() -> String {
    std::env::var("TEST_API_BASE").unwrap_or_else(|_| "http://localhost:8080".to_string())
}

/// The public probe must say up or down and nothing else. Naming the failing
/// dependency publicly would hand an attacker the architecture and tell them
/// when the instance is weakest.
#[tokio::test]
async fn the_public_readiness_probe_answers_without_detail() {
    let client = Client::new();
    let response = client
        .get(format!("{}/api/v1/health", base_url()))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.text().await.unwrap();
    assert_eq!(body, "ok");
    for leak in ["postgres", "redis", "storage", "mail", "latency"] {
        assert!(!body.contains(leak), "public probe must not mention {leak}");
    }
}

/// Liveness stays liveness: a dependency-aware healthcheck restarts the
/// container whenever Postgres hiccups.
#[tokio::test]
async fn the_liveness_probe_is_still_a_static_ok() {
    let client = Client::new();
    let response = client
        .get(format!("{}/health", base_url()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.unwrap(), "ok");
}

use serde_json::Value;

/// The detailed report is admin-only, and a non-admin gets the same generic
/// rejection as every other admin route.
#[tokio::test]
async fn the_detailed_report_is_admin_only() {
    let client = Client::new();
    let response = client
        .get(format!("{}/api/v1/admin/health", base_url()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["success"], Value::Bool(false));
    for leak in ["postgres", "redis", "backlog"] {
        assert!(
            !body.to_string().contains(leak),
            "an unauthenticated caller must learn nothing about {leak}"
        );
    }
}
