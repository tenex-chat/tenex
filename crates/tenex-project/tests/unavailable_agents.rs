use std::fs;
use std::io::{BufRead, ErrorKind, Write};
use std::os::unix::net::UnixListener;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tempfile::TempDir;
use tenex_project::Project;
use tracing::field::{Field, Visit};
use tracing_subscriber::layer::Context;
use tracing_subscriber::prelude::*;
use tracing_subscriber::Layer;

const OWNER_PK: &str = "c506be742732723deaaf8260d2b43d75d33420c601c05a9e1fa3b7986cc1b957";
const AGENT_PK: &str = "0eb926fe0fb742ed7970f6bcd3c009287d72ddb4b2cf2e0ec8480b5780325eb9";

fn write_event_json(base: &std::path::Path, d_tag: &str) {
    let projects_dir = base.join("projects").join(d_tag);
    fs::create_dir_all(&projects_dir).unwrap();

    let event = serde_json::json!({
        "id": "event-id-abc",
        "pubkey": OWNER_PK,
        "kind": 31933,
        "created_at": 1_700_000_000_i64,
        "tags": [
            ["d", d_tag],
            ["title", "My Project"],
            ["p", AGENT_PK],
        ],
    });
    fs::write(
        projects_dir.join("event.json"),
        serde_json::to_vec(&event).unwrap(),
    )
    .unwrap();
}

fn serve_identity_once(
    base: &std::path::Path,
    display_name: &str,
) -> Option<mpsc::Receiver<String>> {
    let socket_path = base.join("identity.sock");
    let _ = fs::remove_file(&socket_path);
    let listener = match UnixListener::bind(&socket_path) {
        Ok(listener) => listener,
        Err(err) if err.kind() == ErrorKind::PermissionDenied => {
            eprintln!("skipping identity socket test: {err}");
            return None;
        }
        Err(err) => panic!("failed to bind identity socket: {err}"),
    };
    listener.set_nonblocking(true).unwrap();

    let response = serde_json::json!({
        "pubkey": AGENT_PK,
        "display_name": display_name,
        "name": "fallback-name",
        "nip05": null,
        "picture": null,
        "banner": null,
        "about": null,
        "lud16": null,
        "event_id": "kind0-event-id",
        "created_at": 1_700_000_000_i64,
        "fetched_at": 1_700_000_001_i64,
    })
    .to_string();

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut request = String::new();
                    std::io::BufReader::new(stream.try_clone().unwrap())
                        .read_line(&mut request)
                        .unwrap();
                    stream.write_all(response.as_bytes()).unwrap();
                    stream.write_all(b"\n").unwrap();
                    let _ = tx.send(request);
                    return;
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => {
                    let _ = tx.send(format!("ERR {e}"));
                    return;
                }
            }

            if Instant::now() >= deadline {
                let _ = tx.send("TIMEOUT".to_string());
                return;
            }
        }
    });
    Some(rx)
}

#[derive(Clone)]
struct CaptureLayer {
    records: Arc<Mutex<Vec<String>>>,
}

impl<S> Layer<S> for CaptureLayer
where
    S: tracing::Subscriber,
{
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = CaptureVisitor { fields: Vec::new() };
        event.record(&mut visitor);
        self.records.lock().unwrap().push(visitor.fields.join(" "));
    }
}

struct CaptureVisitor {
    fields: Vec<String>,
}

impl Visit for CaptureVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.fields.push(format!("{}={value:?}", field.name()));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.fields.push(format!("{}={value}", field.name()));
    }
}

#[test]
fn agents_logs_identity_name_for_missing_member_file() {
    let tmp = TempDir::new().unwrap();
    write_event_json(tmp.path(), "my-project");
    let Some(identity_request) = serve_identity_once(tmp.path(), "Remote Agent") else {
        return;
    };

    let records = Arc::new(Mutex::new(Vec::new()));
    let subscriber = tracing_subscriber::registry().with(CaptureLayer {
        records: records.clone(),
    });

    tracing::subscriber::with_default(subscriber, || {
        let p = Project::open("my-project", tmp.path()).unwrap();
        assert!(p.agents().unwrap().is_empty());
    });

    assert_eq!(
        identity_request
            .recv_timeout(Duration::from_secs(2))
            .unwrap(),
        format!("RESOLVE {AGENT_PK}\n")
    );

    let logs = records.lock().unwrap().join("\n");
    assert!(
        logs.contains("Skipping unavailable agent Remote Agent"),
        "{logs}"
    );
    assert!(logs.contains(AGENT_PK), "{logs}");
    assert!(!logs.contains("read agent file"), "{logs}");
    assert!(!logs.contains("No such file"), "{logs}");
    assert!(!logs.contains("skipping unreadable agent file"), "{logs}");
}
