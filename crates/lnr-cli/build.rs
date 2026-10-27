//! Build-time version stamp. Captures `git describe` into `LNR_BUILD_REV`
//! so `--version` can print the commit. The value is `unknown` when the
//! build tree is not a git checkout.
//!
//! Also reads the release version from the repository's `package.json` into
//! `LNR_VERSION`: release-please bumps that file, not the Cargo workspace
//! version, so `CARGO_PKG_VERSION` lags behind every release.

use std::path::Path;
use std::process::Command;

/// Read `"version"` from `package.json` at the repository root. Falls back to
/// `CARGO_PKG_VERSION` when the file is missing or has no version field.
fn package_json_version(manifest_dir: &str) -> String {
    let path = Path::new(manifest_dir).join("../../package.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let fallback = || std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());
    let Ok(text) = std::fs::read_to_string(&path) else {
        return fallback();
    };
    let Some(rest) = text.split("\"version\"").nth(1) else {
        return fallback();
    };
    rest.split('"')
        .nth(1)
        .filter(|v| !v.is_empty())
        .map_or_else(fallback, str::to_owned)
}

/// Run git with `args`. Return trimmed stdout, or None on any failure.
fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn main() {
    // Rebuild when the checked-out commit moves. A worktree keeps HEAD in its
    // own git dir and branch refs in the common dir, so watch both.
    if let Some(git_dir) = git(&["rev-parse", "--git-dir"]) {
        println!("cargo:rerun-if-changed={git_dir}/HEAD");
        if let Ok(head) = std::fs::read_to_string(format!("{git_dir}/HEAD")) {
            if let Some(reference) = head.trim().strip_prefix("ref: ") {
                let common = git(&["rev-parse", "--git-common-dir"]).unwrap_or(git_dir);
                println!("cargo:rerun-if-changed={common}/{reference}");
            }
        }
    }

    let rev =
        git(&["describe", "--always", "--dirty", "--abbrev=7"]).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=LNR_BUILD_REV={rev}");

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    println!(
        "cargo:rustc-env=LNR_VERSION={}",
        package_json_version(&manifest_dir)
    );
}
