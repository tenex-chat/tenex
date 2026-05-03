use anyhow::Result;

fn main() -> Result<()> {
    let telemetry = tenex_telemetry::init(tenex_telemetry::TelemetryInit {
        service_name: "tenex-identity".to_string(),
        base_dir: None,
        kind: tenex_telemetry::TelemetryKind::Subprocess,
        extra_resource: vec![],
    });
    let result = tenex_identity::run_daemon_sync();
    telemetry.shutdown();
    result
}
