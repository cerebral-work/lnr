//! Bounded, read-only integration with Cortex's resident repository observer.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use lnr_domain::error::CliError;
use serde_json::Value;

const MAX_BYTES: u64 = 131_072;

/// Delegate to Cortex; the returned report is evidence, never authority.
pub fn repo_query(directory: Option<&str>) -> Result<Value, CliError> {
    let mut command = Command::new("cortex");
    command
        .args(["repo-query", "--json", "--max-patch-bytes", "0"])
        .env_remove("LINEAR_API_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(path) = directory {
        command.current_dir(path);
    }
    let mut child = command.spawn().map_err(|_| {
        CliError::other(
            "Cannot start Cortex repository observation.",
            "Install cortex and check the directory.",
        )
    })?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(CliError::other("Cannot read Cortex output.", ""));
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = loop {
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Ok(bytes)) if bytes.len() as u64 <= MAX_BYTES => break Ok(bytes),
            Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err(CliError::other(
                    "Cortex output is unreadable or exceeds 128 KiB.",
                    "",
                ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                break Err(CliError::other(
                    "Cortex observation timed out after 5 seconds.",
                    "",
                ));
            }
        }
    };
    // Even a process that closes stdout early must finish within the deadline.
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
    };
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CliError::other(
                    "Cortex repository observation failed or timed out.",
                    "",
                ));
            }
        }
    }
    let report: Value = serde_json::from_slice(&bytes)
        .map_err(|_| CliError::other("Cortex returned invalid JSON.", ""))?;
    if report["document_type"] != "cortex-resident-repo-query"
        || report["schema_version"] != 1
        || report["authority"] != "observation_only"
    {
        return Err(CliError::refused(
            "Unsupported Cortex repository observation contract.",
            "",
        ));
    }
    Ok(report)
}
