use semver::Version;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::time::Instant;
use tauri::State;

const LATEST_RELEASE_API_URL: &str =
    "https://api.github.com/repos/cocoabreak/hiranoa/releases/latest";
const RELEASES_URL: &str = "https://github.com/cocoabreak/hiranoa/releases";
const MAX_RESPONSE_BYTES: u64 = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const RESULT_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    current_version: String,
    latest_version: String,
    update_available: bool,
    release_url: &'static str,
}

#[derive(Default)]
struct UpdateCheckerInner {
    in_flight: bool,
    last_result: Option<(Instant, Result<UpdateCheckResult, String>)>,
}

#[derive(Clone, Default)]
pub struct UpdateCheckerState(Arc<Mutex<UpdateCheckerInner>>);

impl UpdateCheckerState {
    fn cached_or_reserve(&self) -> Result<Option<Result<UpdateCheckResult, String>>, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "更新確認状態のロックに失敗しました".to_string())?;
        if let Some((checked_at, result)) = &state.last_result {
            if checked_at.elapsed() < RESULT_CACHE_TTL {
                return Ok(Some(result.clone()));
            }
        }
        if state.in_flight {
            return Err("更新確認はすでに実行中です".to_string());
        }
        state.in_flight = true;
        Ok(None)
    }

    fn finish(&self, result: Result<UpdateCheckResult, String>) -> Result<(), String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "更新確認状態のロックに失敗しました".to_string())?;
        state.in_flight = false;
        state.last_result = Some((Instant::now(), result));
        Ok(())
    }
}

fn parse_version(value: &str) -> Result<Version, String> {
    Version::parse(value.trim().strip_prefix('v').unwrap_or(value.trim()))
        .map_err(|_| "リリースのバージョン形式が正しくありません".to_string())
}

fn parse_release(body: &[u8], current_version: &str) -> Result<UpdateCheckResult, String> {
    let release: GitHubRelease = serde_json::from_slice(body)
        .map_err(|_| "GitHub Releasesの応答を解析できませんでした".to_string())?;
    let current = parse_version(current_version)?;
    let latest = parse_version(&release.tag_name)?;
    Ok(UpdateCheckResult {
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        update_available: latest > current,
        release_url: RELEASES_URL,
    })
}

fn update_request_config() -> ureq::config::Config {
    ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .timeout_global(Some(REQUEST_TIMEOUT))
        .max_redirects(0)
        .build()
}

fn format_request_error(context: &str, error: &(dyn Error + 'static)) -> String {
    let mut details = format!("{context}\nURL: {LATEST_RELEASE_API_URL}\n{error}");
    let mut source = error.source();
    // Bound the diagnostic chain even if a dependency returns a cyclic source.
    for _ in 0..8 {
        let Some(cause) = source else { break };
        details.push_str(&format!("\nCaused by: {cause}"));
        source = cause.source();
    }
    details
}

fn request_latest_release() -> Result<UpdateCheckResult, String> {
    let agent = update_request_config().new_agent();
    let mut response = agent
        .get(LATEST_RELEASE_API_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "Hiranoa")
        .call()
        .map_err(|error| {
            let context = match error {
                ureq::Error::StatusCode(404) => {
                    "公開されているGitHub Releaseが見つかりませんでした"
                }
                _ => "GitHub Releasesへ接続できませんでした",
            };
            format_request_error(context, &error)
        })?;
    let mut body = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| {
            format_request_error("GitHub Releasesの応答を読み取れませんでした", &error)
        })?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("GitHub Releasesの応答が大きすぎます".to_string());
    }
    parse_release(&body, env!("CARGO_PKG_VERSION"))
}

async fn run_reserved_update_request(
    state: UpdateCheckerState,
    request: impl FnOnce() -> Result<UpdateCheckResult, String> + Send + 'static,
    timeout: Duration,
) -> Result<UpdateCheckResult, String> {
    // OS certificate verification can outlive the HTTP timeout. The detached task
    // retains the reservation until the blocking worker ends, including on panic.
    let task = tauri::async_runtime::spawn(async move {
        let result = match tauri::async_runtime::spawn_blocking(request).await {
            Ok(result) => result,
            Err(_) => Err("更新確認タスクを完了できませんでした".to_string()),
        };
        state.finish(result.clone())?;
        result
    });
    match tokio::time::timeout(timeout, task).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("更新確認タスクを完了できませんでした".to_string()),
        Err(error) => Err(format_request_error(
            "GitHub Releasesの更新確認がタイムアウトしました",
            &error,
        )),
    }
}

#[tauri::command(async)]
pub async fn check_for_updates(
    state: State<'_, UpdateCheckerState>,
) -> Result<UpdateCheckResult, String> {
    if let Some(cached) = state.cached_or_reserve()? {
        return cached;
    }
    run_reserved_update_request(
        state.inner().clone(),
        request_latest_release,
        REQUEST_TIMEOUT,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_keeps_reservation_until_worker_finishes_and_caches_its_result() {
        let state = UpdateCheckerState::default();
        assert!(state.cached_or_reserve().unwrap().is_none());
        let (release, wait_for_release) = std::sync::mpsc::channel();
        let result = tauri::async_runtime::block_on(run_reserved_update_request(
            state.clone(),
            move || {
                wait_for_release
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap();
                Err("offline".to_string())
            },
            Duration::from_millis(20),
        ));
        assert!(result.unwrap_err().contains("タイムアウト"));
        assert!(state.cached_or_reserve().is_err());

        release.send(()).unwrap();
        let cached = tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Ok(Some(result)) = state.cached_or_reserve() {
                        return result;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("worker must release its reservation and cache the result")
        });
        assert_eq!(cached, Err("offline".to_string()));
    }

    #[test]
    fn worker_panic_releases_reservation_and_caches_failure() {
        let state = UpdateCheckerState::default();
        state.cached_or_reserve().unwrap();
        let result = tauri::async_runtime::block_on(run_reserved_update_request(
            state.clone(),
            || panic!("simulated worker failure"),
            Duration::from_secs(2),
        ));
        assert!(result.as_ref().unwrap_err().contains("タスク"));
        assert_eq!(state.cached_or_reserve().unwrap(), Some(result));
    }

    #[test]
    fn update_requests_use_platform_verification() {
        let config = update_request_config();
        assert!(matches!(
            config.tls_config().root_certs(),
            ureq::tls::RootCerts::PlatformVerifier
        ));
        assert!(!config.tls_config().disable_verification());
    }

    #[test]
    fn request_errors_include_endpoint_and_http_status() {
        for status in [403, 404, 429] {
            let details = format_request_error("request failed", &ureq::Error::StatusCode(status));
            assert!(details.contains(LATEST_RELEASE_API_URL));
            assert!(details.contains(&status.to_string()));
        }
    }

    #[test]
    fn request_errors_preserve_nested_causes() {
        #[derive(Debug)]
        struct TlsError;
        impl std::fmt::Display for TlsError {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "UnknownIssuer")
            }
        }
        impl Error for TlsError {}

        #[derive(Debug)]
        struct TransportError(TlsError);
        impl std::fmt::Display for TransportError {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "TLS connection failed")
            }
        }
        impl Error for TransportError {
            fn source(&self) -> Option<&(dyn Error + 'static)> {
                Some(&self.0)
            }
        }

        let details = format_request_error("request failed", &TransportError(TlsError));
        assert!(details.contains("TLS connection failed"));
        assert!(details.contains("Caused by: UnknownIssuer"));
    }

    #[test]
    fn release_comparison_accepts_v_prefix_and_detects_newer_versions() {
        let result = parse_release(br#"{"tag_name":"v0.2.0"}"#, "0.1.0").unwrap();
        assert!(result.update_available);
        assert_eq!(result.current_version, "0.1.0");
        assert_eq!(result.latest_version, "0.2.0");
        assert_eq!(result.release_url, RELEASES_URL);
    }

    #[test]
    fn release_comparison_treats_equal_and_older_versions_as_current() {
        assert!(
            !parse_release(br#"{"tag_name":"0.1.0"}"#, "0.1.0")
                .unwrap()
                .update_available
        );
        assert!(
            !parse_release(br#"{"tag_name":"v0.0.9"}"#, "0.1.0")
                .unwrap()
                .update_available
        );
    }

    #[test]
    fn release_comparison_rejects_invalid_payloads_and_versions() {
        assert!(parse_release(br#"{}"#, "0.1.0").is_err());
        assert!(parse_release(br#"{"tag_name":"latest"}"#, "0.1.0").is_err());
        assert!(parse_release(br#"{"tag_name":"v0.2.0"}"#, "invalid").is_err());
    }

    #[test]
    fn update_checker_rejects_concurrency_and_caches_results() {
        let state = UpdateCheckerState::default();
        assert!(state.cached_or_reserve().unwrap().is_none());
        assert!(state.cached_or_reserve().is_err());

        let result = UpdateCheckResult {
            current_version: "0.1.0".to_string(),
            latest_version: "0.2.0".to_string(),
            update_available: true,
            release_url: RELEASES_URL,
        };
        state.finish(Ok(result.clone())).unwrap();
        assert_eq!(state.cached_or_reserve().unwrap(), Some(Ok(result)));
    }
}
