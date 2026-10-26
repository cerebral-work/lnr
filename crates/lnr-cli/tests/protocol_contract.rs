//! Offline contract tests for framing, discovery, HTTP failures, and readback.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};

fn mcp(input: &str, read_only: bool) -> Vec<Value> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lnr"));
    command.args(["mcp", "serve"]);
    if read_only {
        command.arg("--read-only");
    }
    let mut child = command
        .env_remove("LINEAR_API_KEY")
        .env_remove("LINEARCTL_TEST_SCENARIO")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn negotiates_sdk_protocol_versions_and_falls_back_for_unknown() {
    for requested in [
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
        "2024-11-05",
        "2024-10-07",
        "2099-01-01",
    ] {
        let request = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":requested}});
        let response = mcp(&format!("{request}\n"), false);
        let expected = if requested == "2099-01-01" {
            "2025-11-25"
        } else {
            requested
        };
        assert_eq!(response[0]["result"]["protocolVersion"], expected);
    }
}

#[test]
fn read_only_discovery_and_dispatch_both_deny_mutations_without_auth() {
    let requests = [
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"comment_issue","arguments":{"id":"ENG-1","body":"never post"}}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"queue_admission","arguments":{}}}),
    ];
    let input = requests
        .iter()
        .map(|value| format!("{value}\n"))
        .collect::<String>();
    let output = mcp(&input, true);
    let tools = output[0]["result"]["tools"].as_array().unwrap();
    assert!(tools
        .iter()
        .all(|tool| tool["annotations"]["readOnlyHint"] == true));
    for name in ["comment_issue", "file_issue", "issue_close"] {
        assert!(tools.iter().all(|tool| tool["name"] != name));
    }
    for name in ["cortex_repo_query", "issue_comments"] {
        assert!(tools.iter().any(|tool| tool["name"] == name));
    }
    assert_eq!(output[1]["result"]["isError"], true);
    assert!(output[1]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("read-only"));
    assert_eq!(output[2]["result"]["isError"], false);
}

#[test]
fn malformed_frames_return_errors_and_next_frame_still_works() {
    let input = concat!(
        "{broken}\n",
        "[]\n",
        "{\"id\":1,\"method\":\"ping\"}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"queue_admission\",\"arguments\":[]}}\n",
        "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"comment_issue\",\"arguments\":{}}}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n"
    );
    let output = mcp(input, false);
    assert_eq!(output.len(), 5); // notification never executes or replies
    assert_eq!(output[0]["error"]["code"], -32700);
    assert_eq!(output[1]["error"]["code"], -32600);
    assert_eq!(output[2]["error"]["code"], -32600);
    assert_eq!(output[3]["error"]["code"], -32602);
    assert_eq!(output[4]["result"], json!({}));
}

#[test]
fn oversized_frame_is_rejected_without_parsing_or_dispatch() {
    let output = mcp(&"x".repeat(1_048_577), false);
    assert_eq!(output.len(), 1);
    assert_eq!(output[0]["error"]["code"], -32600);
}

/// One local HTTP exchange, recording the actual JSON bytes sent by curl.
fn http_request(args: &[&str], response: &str) -> (std::process::Output, Value) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let reply = response.to_owned();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let (head_end, length) = loop {
            let mut chunk = [0; 4096];
            let count = stream.read(&mut chunk).unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                break (end + 4, length);
            }
        };
        while bytes.len() < head_end + length {
            let mut chunk = [0; 4096];
            let count = stream.read(&mut chunk).unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&chunk[..count]);
        }
        let request: Value = serde_json::from_slice(&bytes[head_end..head_end + length]).unwrap();
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", reply.len(), reply).unwrap();
        request
    });
    let output = Command::new(env!("CARGO_BIN_EXE_lnr"))
        .args(args)
        .env("LINEAR_API_KEY", "test-key")
        .env("LINEAR_API_URL", endpoint)
        .env_remove("LINEARCTL_TEST_SCENARIO")
        .output()
        .unwrap();
    (output, server.join().unwrap())
}

#[test]
fn comments_readback_is_issue_scoped_and_preserves_markdown_and_cursor() {
    let body = "赤鬼 🚀\nquote: \"yes\"\npath: C:\\tmp\\file";
    let response = json!({"data":{"issue":{"id":"uuid", "identifier":"CER-1", "comments":{
        "nodes":[{"id":"receipt-1", "body":body,"url":"https://example.test/comment","createdAt":"2026-10-26T00:00:00Z"}],
        "pageInfo":{"hasNextPage":true,"endCursor":"next-page"}
    }}}});
    let (output, request) = http_request(
        &[
            "comments",
            "--issue",
            "CER-1",
            "--limit",
            "1",
            "--after",
            "prior-page",
            "--json",
        ],
        &response.to_string(),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let page: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(page["comments"][0]["body"], body);
    assert_eq!(page["pageInfo"]["endCursor"], "next-page");
    assert_eq!(
        request["variables"],
        json!({"id":"CER-1", "first":1, "after":"prior-page"})
    );
}

#[test]
fn malformed_or_missing_http_data_is_an_error_instead_of_false_success() {
    for response in ["not JSON", "{}", "{\"data\":null}"] {
        let (output, _) = http_request(&["whoami", "--json"], response);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["error"]["kind"], "other");
        assert!(!String::from_utf8_lossy(&output.stderr).contains("test-key"));
    }
}

#[cfg(unix)]
#[test]
fn cortex_observation_preserves_authority_and_enforces_wire_ceiling() {
    use std::os::unix::fs::PermissionsExt;
    let directory = std::env::temp_dir().join(format!("lnr-cortex-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let script = directory.join("cortex");
    for (body, succeeds) in [
        ("echo '{\"document_type\":\"cortex-resident-repo-query\",\"schema_version\":1,\"authority\":\"observation_only\"}'", true),
        ("echo '{\"document_type\":\"cortex-resident-repo-query\",\"schema_version\":1,\"authority\":\"approved\"}'", false),
        ("head -c 131073 /dev/zero", false),
        ("echo not-json", false),
    ] {
        std::fs::write(&script, format!("#!/bin/sh\n[ \"$*\" = \"repo-query --json --max-patch-bytes 0\" ] || exit 8\n[ \"${{LINEAR_API_KEY+x}}\" != x ] || exit 9\n{body}\n")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let input = json!({"jsonrpc":"2.0", "id":1, "method":"tools/call", "params":{"name":"cortex_repo_query", "arguments":{}}});
        let mut child = Command::new(env!("CARGO_BIN_EXE_lnr"))
            .args(["mcp", "serve", "--read-only"])
            .env("PATH", format!("{}:{}", directory.display(), std::env::var("PATH").unwrap_or_default()))
            .env("LINEAR_API_KEY", "fixture-key-must-not-propagate")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(format!("{input}\n").as_bytes()).unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(result.status.success());
        let output: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(output["result"]["isError"], !succeeds);
        if succeeds {
            assert_eq!(output["result"]["structuredContent"]["authority"], "observation_only");
        }
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn milestone_list_reads_real_metadata_and_exposes_partial_pages() {
    let response = json!({"data":{"project":{"name":"Cortex", "projectMilestones":{
        "nodes":[{"id":"m5", "name":"M5", "targetDate":"2027-02-28", "description":"Deploy"}],
        "pageInfo":{"hasNextPage":true,"endCursor":"continue-here"}
    }}}});
    let (output, request) = http_request(
        &[
            "milestone",
            "list",
            "--project",
            "108e893f-c19a-45ab-b663-c0f80e5820e1",
            "--after",
            "prior-page",
            "--json",
        ],
        &response.to_string(),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(data["milestones"][0]["name"], "M5");
    assert_eq!(data["partial"], true);
    assert_eq!(data["pageInfo"]["endCursor"], "continue-here");
    assert_eq!(request["variables"]["after"], "prior-page");
}
