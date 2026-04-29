use anyhow::Result;

fn main() -> Result<()> {
    let telemetry = tenex_telemetry::init("tenex-identity");
    let result = tenex_identity::run_daemon_sync();
    telemetry.shutdown();
    result
}
