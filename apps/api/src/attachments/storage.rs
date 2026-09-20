use s3::Region;
use s3::bucket::Bucket;
use s3::creds::Credentials;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
pub struct Storage {
    bucket: Arc<Bucket>,
    operation_timeout: Duration,
}

impl Storage {
    /// `region` is the name that goes into the SigV4 signing scope. Garage
    /// accepts anything (the dev stack uses "garage"); a hosted provider such
    /// as Backblaze B2 rejects a signature whose region does not match the
    /// bucket's, so production sets `S3_REGION` to the provider's value.
    /// Requests are path-style throughout, which every S3-compatible store
    /// supports and which needs no wildcard DNS.
    pub fn new(
        endpoint: String,
        region: String,
        access_key: String,
        secret_key: String,
        bucket_name: String,
        operation_timeout_seconds: u64,
    ) -> anyhow::Result<Self> {
        let region = Region::Custom { region, endpoint };
        let credentials = Credentials::new(Some(&access_key), Some(&secret_key), None, None, None)?;
        let bucket = Bucket::new(&bucket_name, region, credentials)?.with_path_style();
        Ok(Storage {
            bucket: Arc::from(bucket),
            operation_timeout: Duration::from_secs(operation_timeout_seconds),
        })
    }

    pub async fn put(&self, key: &str, bytes: &[u8]) -> anyhow::Result<()> {
        tokio::time::timeout(self.operation_timeout, self.bucket.put_object(key, bytes))
            .await
            .map_err(|_| anyhow::anyhow!("attachment storage operation timed out"))??;
        Ok(())
    }

    pub async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        let response = tokio::time::timeout(self.operation_timeout, self.bucket.get_object(key))
            .await
            .map_err(|_| anyhow::anyhow!("attachment storage operation timed out"))??;
        Ok(response.bytes().to_vec())
    }

    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        let result = tokio::time::timeout(self.operation_timeout, self.bucket.delete_object(key))
            .await
            .map_err(|_| anyhow::anyhow!("attachment storage operation timed out"))?;
        match result {
            Ok(_) | Err(s3::error::S3Error::HttpFailWithBody(404, _)) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Whether the object store answers, using the credentials configured.
    ///
    /// One `ListObjectsV2` capped at a single key: cheap, non-destructive,
    /// and it validates the endpoint, the region and the credentials
    /// together, which is exactly what disagrees when B2 rejects a request
    /// for a region that does not match the bucket.
    ///
    /// Deliberately not `Bucket::list`, which paginates the whole bucket
    /// internally and would turn a health check into an expensive scan.
    pub async fn reachable(&self) -> bool {
        let attempt = tokio::time::timeout(
            self.operation_timeout,
            self.bucket
                .list_page(String::new(), None, None, None, Some(1)),
        )
        .await;
        matches!(attempt, Ok(Ok(_)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reachable_is_false_for_an_endpoint_that_does_not_answer() {
        // Port 1 is reserved and nothing listens there, so this exercises the
        // failure path without depending on the dev stack being down.
        let storage = Storage::new(
            "http://127.0.0.1:1".to_string(),
            "garage".to_string(),
            "key".to_string(),
            "secret".to_string(),
            "krypta".to_string(),
            2,
        )
        .unwrap();

        assert!(!storage.reachable().await);
    }
}
