//! Cloudflare R2 (S3 API) holds preview images and post pictures. Turso keeps the row, R2 keeps the
//! bytes. The bucket stays private: images are served back through /previews/<hash>.jpg and
//! /images/<id> by the server, so nothing depends on the bucket having a public domain.

use rust_s3::creds::Credentials;
use rust_s3::{Bucket, Region};

pub struct R2 {
    bucket: Box<Bucket>,
}

impl R2 {
    /// None when R2 is not configured, e.g. local dev: callers fall back to Turso blobs.
    pub fn from_env() -> Option<R2> {
        let var = |k: &str| std::env::var(k).ok().filter(|s| !s.is_empty());
        let (account, key, secret, bucket) = (
            var("R2_ACCOUNT_ID")?,
            var("R2_ACCESS_KEY_ID")?,
            var("R2_SECRET_ACCESS_KEY")?,
            var("R2_BUCKET")?,
        );
        let region = Region::Custom {
            region: "auto".into(),
            endpoint: format!("https://{account}.r2.cloudflarestorage.com"),
        };
        let creds = Credentials::new(Some(&key), Some(&secret), None, None, None).ok()?;
        let bucket = Bucket::new(&bucket, region, creds).ok()?.with_path_style();
        Some(R2 { bucket })
    }

    /// Store bytes, returning the key, or None if the write failed.
    pub async fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Option<String> {
        match self
            .bucket
            .put_object_with_content_type(key, bytes, content_type)
            .await
        {
            Ok(r) if (200..300).contains(&r.status_code()) => Some(key.to_string()),
            Ok(r) => {
                eprintln!("r2 put {key} failed: HTTP {}", r.status_code());
                None
            }
            Err(e) => {
                eprintln!("r2 put {key} failed: {e}");
                None
            }
        }
    }

    pub async fn get(&self, key: &str) -> Option<(Vec<u8>, String)> {
        let r = self.bucket.get_object(key).await.ok()?;
        if r.status_code() != 200 {
            return None;
        }
        let kind = r
            .headers()
            .get("content-type")
            .cloned()
            .unwrap_or_else(|| "image/jpeg".into());
        Some((r.to_vec(), kind))
    }

    pub async fn delete(&self, key: &str) {
        let _ = self.bucket.delete_object(key).await;
    }
}
