//! `lnr` (`linearctl`) command line entry point.

mod cli;
mod cortex;
mod graphql;
mod mcp;
mod memory;
mod store;

use std::process::ExitCode;

use tracing_subscriber::EnvFilter;

/// Version text: the release version (`package.json`, stamped by `build.rs`
/// as `LNR_VERSION`) plus the git revision.
const VERSION: &str = concat!(env!("LNR_VERSION"), " (", env!("LNR_BUILD_REV"), ")");

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = cli::run_cli(&args, VERSION);
    ExitCode::from(code)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn demo_and_help_succeed() {
        let code = cli::run_cli(
            &["demo".to_string(), "--id".to_string(), "abc".to_string()],
            VERSION,
        );
        assert_eq!(code, 0);
        let help_code = cli::run_cli(&["--help".to_string()], VERSION);
        assert_eq!(help_code, 0);
    }

    #[test]
    fn version_tracks_package_json() {
        // release-please bumps package.json; the Rust binary must report that
        // version, not the stale Cargo workspace version.
        let package_json = include_str!("../../../package.json");
        let expected = package_json
            .split("\"version\"")
            .nth(1)
            .and_then(|rest| rest.split('"').nth(1))
            .expect("package.json has a version");
        assert!(
            VERSION.starts_with(&format!("{expected} (")),
            "VERSION {VERSION:?} does not start with package.json version {expected:?}"
        );
    }

    #[test]
    fn demo_rejects_bad_id() {
        let code = cli::run_cli(
            &["demo".to_string(), "--id".to_string(), "Bad Id".to_string()],
            VERSION,
        );
        assert_eq!(code, 2);
    }
}
