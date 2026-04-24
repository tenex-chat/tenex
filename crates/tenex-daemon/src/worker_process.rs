use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use thiserror::Error;

use crate::worker_protocol::{
    AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES, AGENT_WORKER_MAX_FRAME_BYTES,
    AgentWorkerShutdownMessageInput, WorkerProtocolConfig, WorkerProtocolError,
    build_agent_worker_shutdown_message, decode_agent_worker_protocol_frame,
    encode_agent_worker_protocol_frame, validate_worker_protocol_config,
};
use crate::worker_session::frame_pump::WorkerFrameReceiver;

const WORKER_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Error)]
pub enum WorkerProcessError {
    #[error("worker process io error: {0}")]
    Io(#[from] io::Error),
    #[error("worker protocol error: {0}")]
    Protocol(#[from] WorkerProtocolError),
    #[error("worker process missing {0} pipe")]
    MissingPipe(&'static str),
    #[error("worker boot timed out after {timeout_ms}ms; stderr: {stderr}")]
    BootTimeout { timeout_ms: u64, stderr: String },
    #[error("worker message timed out after {timeout_ms}ms; stderr: {stderr}")]
    MessageTimeout { timeout_ms: u64, stderr: String },
    #[error("worker exit timed out after {timeout_ms}ms; stderr: {stderr}")]
    ExitTimeout { timeout_ms: u64, stderr: String },
    #[error("worker stdout reader stopped; stderr: {stderr}")]
    MessageChannelClosed { stderr: String },
    #[error("worker stdin is closed")]
    StdinClosed,
    #[error("worker sent {actual} when {expected} was expected")]
    UnexpectedWorkerMessage {
        expected: &'static str,
        actual: String,
    },
    #[error("worker boot error {code}: {message}")]
    WorkerBootError { code: String, message: String },
    #[error("invalid worker ready message: {0}")]
    InvalidReadyMessage(String),
}

pub type WorkerProcessResult<T> = Result<T, WorkerProcessError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentWorkerCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
}

impl AgentWorkerCommand {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            current_dir: None,
            env: BTreeMap::new(),
        }
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn current_dir(mut self, current_dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(current_dir.into());
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    fn build(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.args);

        if let Some(current_dir) = &self.current_dir {
            command.current_dir(current_dir);
        }

        for (key, value) in &self.env {
            command.env(key, value);
        }

        command
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentWorkerProcessConfig {
    pub boot_timeout: Duration,
}

impl Default for AgentWorkerProcessConfig {
    fn default() -> Self {
        Self {
            boot_timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentWorkerReady {
    pub worker_id: String,
    pub pid: u64,
    pub protocol: WorkerProtocolConfig,
    pub message: Value,
}

pub struct BootedAgentWorkerProcess {
    pub ready: AgentWorkerReady,
    pub process: AgentWorkerProcess,
}

/// Protocol-level I/O bound to a worker's stdio streams.
///
/// Owns the stdin writer, the background stdout frame reader, and the
/// background stderr collector. Independent of whether the worker is a real
/// subprocess — `AgentWorkerProcess` wraps this plus a `Child` handle.
pub(crate) struct AgentWorkerChannel {
    stdin: Option<Box<dyn Write + Send>>,
    frames: mpsc::Receiver<WorkerProcessResult<Vec<u8>>>,
    stderr: Arc<Mutex<String>>,
}

impl AgentWorkerChannel {
    pub(crate) fn new(
        stdin: Box<dyn Write + Send>,
        stdout: Box<dyn Read + Send>,
        stderr: Box<dyn Read + Send>,
    ) -> Self {
        Self {
            stdin: Some(stdin),
            frames: spawn_stdout_reader(stdout),
            stderr: spawn_stderr_collector(stderr),
        }
    }

    pub(crate) fn send_message(&mut self, value: &Value) -> WorkerProcessResult<()> {
        let frame = encode_agent_worker_protocol_frame(value)?;
        let stdin = self.stdin.as_mut().ok_or(WorkerProcessError::StdinClosed)?;
        stdin.write_all(&frame)?;
        stdin.flush()?;
        Ok(())
    }

    pub(crate) fn request_shutdown(
        &mut self,
        correlation_id: &str,
        sequence: u64,
        timestamp: u64,
        reason: &str,
        force_kill_timeout_ms: u64,
    ) -> WorkerProcessResult<()> {
        let message = build_agent_worker_shutdown_message(AgentWorkerShutdownMessageInput {
            correlation_id: correlation_id.to_string(),
            sequence,
            timestamp,
            reason: reason.to_string(),
            force_kill_timeout_ms,
        })?;
        self.send_message(&message)
    }

    pub(crate) fn close_stdin(&mut self) {
        self.stdin = None;
    }

    pub(crate) fn next_message(&mut self, timeout: Duration) -> WorkerProcessResult<Value> {
        let frame = self.next_frame_timeout(timeout)?;
        Ok(decode_agent_worker_protocol_frame(&frame)?)
    }

    pub(crate) fn stderr_snapshot(&self) -> String {
        self.stderr
            .lock()
            .map(|stderr| stderr.clone())
            .unwrap_or_default()
    }

    pub(crate) fn next_frame_blocking(&mut self) -> WorkerProcessResult<Vec<u8>> {
        match self.frames.recv() {
            Ok(frame) => frame,
            Err(_) => Err(WorkerProcessError::MessageChannelClosed {
                stderr: self.stderr_snapshot(),
            }),
        }
    }

    fn next_frame_timeout(&mut self, timeout: Duration) -> WorkerProcessResult<Vec<u8>> {
        match self.frames.recv_timeout(timeout) {
            Ok(frame) => frame,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(WorkerProcessError::MessageTimeout {
                timeout_ms: duration_millis(timeout),
                stderr: self.stderr_snapshot(),
            }),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(WorkerProcessError::MessageChannelClosed {
                    stderr: self.stderr_snapshot(),
                })
            }
        }
    }

    fn read_ready(&mut self, timeout: Duration) -> WorkerProcessResult<AgentWorkerReady> {
        let frame = match self.frames.recv_timeout(timeout) {
            Ok(frame) => frame?,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(WorkerProcessError::BootTimeout {
                    timeout_ms: duration_millis(timeout),
                    stderr: self.stderr_snapshot(),
                });
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(WorkerProcessError::MessageChannelClosed {
                    stderr: self.stderr_snapshot(),
                });
            }
        };

        parse_ready_message(decode_agent_worker_protocol_frame(&frame)?)
    }
}

pub struct AgentWorkerProcess {
    child: Child,
    channel: AgentWorkerChannel,
}

impl AgentWorkerProcess {
    pub fn spawn(
        command: &AgentWorkerCommand,
        config: &AgentWorkerProcessConfig,
    ) -> WorkerProcessResult<BootedAgentWorkerProcess> {
        let mut child = command
            .build()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or(WorkerProcessError::MissingPipe("stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(WorkerProcessError::MissingPipe("stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or(WorkerProcessError::MissingPipe("stderr"))?;

        let channel = AgentWorkerChannel::new(Box::new(stdin), Box::new(stdout), Box::new(stderr));
        let mut process = AgentWorkerProcess { child, channel };

        let ready = match process.channel.read_ready(config.boot_timeout) {
            Ok(ready) => ready,
            Err(error) => {
                let _ = process.kill();
                return Err(error);
            }
        };

        Ok(BootedAgentWorkerProcess { ready, process })
    }

    pub fn send_message(&mut self, value: &Value) -> WorkerProcessResult<()> {
        self.channel.send_message(value)
    }

    pub fn request_shutdown(
        &mut self,
        correlation_id: &str,
        sequence: u64,
        timestamp: u64,
        reason: &str,
        force_kill_timeout_ms: u64,
    ) -> WorkerProcessResult<()> {
        self.channel.request_shutdown(
            correlation_id,
            sequence,
            timestamp,
            reason,
            force_kill_timeout_ms,
        )
    }

    pub fn close_stdin(&mut self) {
        self.channel.close_stdin();
    }

    pub fn next_message(&mut self, timeout: Duration) -> WorkerProcessResult<Value> {
        self.channel.next_message(timeout)
    }

    pub fn wait_for_exit(&mut self, timeout: Duration) -> WorkerProcessResult<ExitStatus> {
        let deadline = Instant::now() + timeout;

        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(status);
            }

            if Instant::now() >= deadline {
                return Err(WorkerProcessError::ExitTimeout {
                    timeout_ms: duration_millis(timeout),
                    stderr: self.stderr_snapshot(),
                });
            }

            thread::sleep(WORKER_POLL_INTERVAL);
        }
    }

    pub fn kill(&mut self) -> WorkerProcessResult<()> {
        if self.child.try_wait()?.is_none() {
            self.child.kill()?;
            let _ = self.child.wait();
        }
        Ok(())
    }

    pub fn stderr_snapshot(&self) -> String {
        self.channel.stderr_snapshot()
    }
}

impl WorkerProcessError {
    pub fn is_worker_input_closed(&self) -> bool {
        match self {
            Self::Io(error) => matches!(
                error.kind(),
                io::ErrorKind::BrokenPipe
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::NotConnected
            ),
            Self::StdinClosed => true,
            _ => false,
        }
    }
}

impl WorkerFrameReceiver for AgentWorkerProcess {
    type Error = WorkerProcessError;

    fn receive_worker_frame(&mut self) -> Result<Vec<u8>, Self::Error> {
        self.channel.next_frame_blocking()
    }
}

impl Drop for AgentWorkerProcess {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

pub fn read_agent_worker_protocol_frame<R: Read>(reader: &mut R) -> WorkerProcessResult<Vec<u8>> {
    let mut length_prefix = [0_u8; AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES];
    reader.read_exact(&mut length_prefix)?;

    let payload_byte_length = u32::from_be_bytes(length_prefix) as usize;
    let max_payload_bytes =
        AGENT_WORKER_MAX_FRAME_BYTES as usize - AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES;
    if payload_byte_length > max_payload_bytes {
        return Err(WorkerProtocolError::FramePayloadTooLarge {
            payload_bytes: payload_byte_length,
            max_payload_bytes,
        }
        .into());
    }

    let mut frame =
        Vec::with_capacity(AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES + payload_byte_length);
    frame.extend_from_slice(&length_prefix);
    frame.resize(
        AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES + payload_byte_length,
        0,
    );
    reader.read_exact(&mut frame[AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES..])?;

    Ok(frame)
}

pub fn read_agent_worker_protocol_message<R: Read>(reader: &mut R) -> WorkerProcessResult<Value> {
    let frame = read_agent_worker_protocol_frame(reader)?;
    Ok(decode_agent_worker_protocol_frame(&frame)?)
}

fn spawn_stdout_reader<R>(mut stdout: R) -> mpsc::Receiver<WorkerProcessResult<Vec<u8>>>
where
    R: Read + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        loop {
            let frame = read_agent_worker_protocol_frame(&mut stdout);
            let should_continue = frame.is_ok();
            if sender.send(frame).is_err() || !should_continue {
                break;
            }
        }
    });
    receiver
}

fn spawn_stderr_collector<R>(mut stderr: R) -> Arc<Mutex<String>>
where
    R: Read + Send + 'static,
{
    let output = Arc::new(Mutex::new(String::new()));
    let thread_output = output.clone();

    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if let Ok(mut output) = thread_output.lock() {
                        output.push_str(&String::from_utf8_lossy(&buffer[..read]));
                    }
                }
                Err(_) => break,
            }
        }
    });

    output
}

fn parse_ready_message(message: Value) -> WorkerProcessResult<AgentWorkerReady> {
    match message_type(&message).as_deref() {
        Some("ready") => {}
        Some("boot_error") => return Err(parse_boot_error(&message)),
        Some(actual) => {
            return Err(WorkerProcessError::UnexpectedWorkerMessage {
                expected: "ready",
                actual: actual.to_string(),
            });
        }
        None => {
            return Err(WorkerProcessError::UnexpectedWorkerMessage {
                expected: "ready",
                actual: "<missing>".to_string(),
            });
        }
    }

    let worker_id = required_string(&message, "workerId")?.to_string();
    let pid = required_u64(&message, "pid")?;
    let protocol = message
        .get("protocol")
        .cloned()
        .ok_or_else(|| WorkerProcessError::InvalidReadyMessage("missing protocol".to_string()))
        .and_then(|value| {
            serde_json::from_value::<WorkerProtocolConfig>(value)
                .map_err(|error| WorkerProcessError::InvalidReadyMessage(error.to_string()))
        })?;
    validate_worker_protocol_config(&protocol)?;

    Ok(AgentWorkerReady {
        worker_id,
        pid,
        protocol,
        message,
    })
}

fn parse_boot_error(message: &Value) -> WorkerProcessError {
    let error = message.get("error");
    let code = error
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("boot_error")
        .to_string();
    let message = error
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("worker reported boot_error")
        .to_string();

    WorkerProcessError::WorkerBootError { code, message }
}

fn required_string<'a>(message: &'a Value, key: &str) -> WorkerProcessResult<&'a str> {
    message
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| WorkerProcessError::InvalidReadyMessage(format!("invalid {key}")))
}

fn required_u64(message: &Value, key: &str) -> WorkerProcessResult<u64> {
    message
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| WorkerProcessError::InvalidReadyMessage(format!("invalid {key}")))
}

fn message_type(message: &Value) -> Option<String> {
    message
        .get("type")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

pub fn bun_protocol_probe_command(
    repository_root: &Path,
    bun_program: impl Into<PathBuf>,
) -> AgentWorkerCommand {
    AgentWorkerCommand::new(bun_program)
        .arg("run")
        .arg("tools/rust-migration/protocol-probe-worker.ts")
        .current_dir(repository_root)
}

pub fn bun_agent_worker_command(
    repository_root: &Path,
    bun_program: impl Into<PathBuf>,
) -> AgentWorkerCommand {
    AgentWorkerCommand::new(bun_program)
        .arg("run")
        .arg("src/agents/execution/worker/agent-worker.ts")
        .current_dir(repository_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publish_outbox::{
        accept_worker_publish_request, build_accepted_publish_result, drain_pending_publish_outbox,
        read_pending_publish_outbox_record, read_published_publish_outbox_record,
    };
    use crate::relay_publisher::{NostrRelayPublisher, RelayPublisherConfig};
    use crate::worker_protocol::{
        AGENT_WORKER_PROTOCOL_ENCODING, AGENT_WORKER_PROTOCOL_VERSION,
        AGENT_WORKER_STREAM_BATCH_MAX_BYTES, AGENT_WORKER_STREAM_BATCH_MS, WorkerProtocolFixture,
    };
    use serde_json::json;
    use std::fs;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tungstenite::Message;

    const WORKER_PROTOCOL_FIXTURE: &str = include_str!(
        "../../../src/test-utils/fixtures/worker-protocol/agent-execution.compat.json"
    );
    const AGENT_PRIVATE_KEY_HEX: &str =
        "1111111111111111111111111111111111111111111111111111111111111111";
    const AGENT_PUBKEY: &str = "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
    const DELEGATE_AGENT_PRIVATE_KEY_HEX: &str =
        "2222222222222222222222222222222222222222222222222222222222222222";
    const DELEGATE_AGENT_PUBKEY: &str =
        "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("crate must live under repo_root/crates/tenex-daemon")
            .to_path_buf()
    }

    #[test]
    fn reads_raw_frame_from_stream() {
        let message = json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "ping",
            "correlationId": "rust_stream_reader",
            "sequence": 1,
            "timestamp": 1710000700000_u64,
            "timeoutMs": 5000,
        });
        let frame = encode_agent_worker_protocol_frame(&message).expect("frame must encode");
        let mut reader = io::Cursor::new(frame.clone());

        assert_eq!(
            read_agent_worker_protocol_frame(&mut reader).expect("frame must read"),
            frame
        );
    }

    #[test]
    fn reads_complete_frame_from_stream() {
        let message = json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "ping",
            "correlationId": "rust_stream_reader",
            "sequence": 1,
            "timestamp": 1710000700000_u64,
            "timeoutMs": 5000,
        });
        let frame = encode_agent_worker_protocol_frame(&message).expect("frame must encode");
        let mut reader = io::Cursor::new(frame);

        assert_eq!(
            read_agent_worker_protocol_message(&mut reader).expect("frame must decode"),
            message
        );
    }

    #[test]
    fn builds_bun_protocol_probe_command() {
        let command = bun_protocol_probe_command(&repo_root(), "bun");

        assert_eq!(command.program, PathBuf::from("bun"));
        assert_eq!(
            command.args,
            vec![
                "run".to_string(),
                "tools/rust-migration/protocol-probe-worker.ts".to_string()
            ]
        );
        assert_eq!(command.current_dir, Some(repo_root()));
    }

    #[test]
    fn builds_bun_agent_worker_command() {
        let command = bun_agent_worker_command(&repo_root(), "bun");

        assert_eq!(command.program, PathBuf::from("bun"));
        assert_eq!(
            command.args,
            vec![
                "run".to_string(),
                "src/agents/execution/worker/agent-worker.ts".to_string()
            ]
        );
        assert_eq!(command.current_dir, Some(repo_root()));
    }

    #[test]
    fn protocol_probe_round_trips_over_in_process_pipes() {
        let fake = InProcessProtocolProbeFake::start();
        let InProcessProtocolProbeFake {
            mut channel,
            ready,
            worker,
        } = fake;

        assert_eq!(ready.protocol.version, AGENT_WORKER_PROTOCOL_VERSION);
        assert!(ready.worker_id.starts_with("protocol-probe-"));

        channel
            .send_message(&json!({
                "version": AGENT_WORKER_PROTOCOL_VERSION,
                "type": "ping",
                "correlationId": "rust_probe",
                "sequence": 10,
                "timestamp": 1710000700100_u64,
                "timeoutMs": 5000,
            }))
            .expect("ping must send");

        let pong = channel
            .next_message(Duration::from_secs(1))
            .expect("pong must arrive");
        assert_eq!(pong.get("type").and_then(Value::as_str), Some("pong"));
        assert_eq!(
            pong.get("correlationId").and_then(Value::as_str),
            Some("rust_probe")
        );
        assert_eq!(
            pong.get("replyingToSequence").and_then(Value::as_u64),
            Some(10)
        );

        channel
            .request_shutdown("rust_probe", 11, 1710000700200, "rust probe complete", 5000)
            .expect("shutdown must send");
        channel.close_stdin();

        worker
            .join()
            .expect("in-process probe thread must join")
            .expect("in-process probe must exit cleanly");
    }

    #[test]
    fn protocol_probe_surface_boot_timeout_when_fake_stays_silent() {
        let (stdin_reader, stdin_writer) = io::pipe().expect("stdin pipe");
        let (stdout_reader, stdout_writer) = io::pipe().expect("stdout pipe");
        let (stderr_reader, stderr_writer) = io::pipe().expect("stderr pipe");

        let mut channel = AgentWorkerChannel::new(
            Box::new(stdin_writer),
            Box::new(stdout_reader),
            Box::new(stderr_reader),
        );

        let err = channel
            .read_ready(Duration::from_millis(50))
            .expect_err("silent fake must cause boot timeout");
        match err {
            WorkerProcessError::BootTimeout { timeout_ms, .. } => assert_eq!(timeout_ms, 50),
            other => panic!("expected BootTimeout, got {other:?}"),
        }

        // Dropping these here keeps the worker-side pipe ends alive long enough
        // that the read_ready above cannot observe EOF and race the boot-timeout
        // assertion.
        drop(stdin_reader);
        drop(stdout_writer);
        drop(stderr_writer);
    }

    #[test]
    #[cfg_attr(
        not(feature = "integration"),
        ignore = "requires Bun and repo TypeScript dependencies"
    )]
    fn bun_protocol_probe_round_trips_over_stdio() {
        let bun = std::env::var("BUN_BIN").unwrap_or_else(|_| "bun".to_string());
        let command = bun_protocol_probe_command(&repo_root(), bun);
        let mut worker = AgentWorkerProcess::spawn(
            &command,
            &AgentWorkerProcessConfig {
                boot_timeout: Duration::from_secs(5),
            },
        )
        .expect("probe worker must boot");

        assert_eq!(worker.ready.protocol.version, AGENT_WORKER_PROTOCOL_VERSION);

        worker
            .process
            .send_message(&json!({
                "version": AGENT_WORKER_PROTOCOL_VERSION,
                "type": "ping",
                "correlationId": "rust_probe",
                "sequence": 10,
                "timestamp": 1710000700100_u64,
                "timeoutMs": 5000,
            }))
            .expect("ping must send");

        let pong = worker
            .process
            .next_message(Duration::from_secs(5))
            .expect("pong must arrive");
        assert_eq!(pong.get("type").and_then(Value::as_str), Some("pong"));
        assert_eq!(
            pong.get("replyingToSequence").and_then(Value::as_u64),
            Some(10)
        );

        worker
            .process
            .request_shutdown("rust_probe", 11, 1710000700200, "rust probe complete", 5000)
            .expect("shutdown must send");
        worker.process.close_stdin();

        let status = worker
            .process
            .wait_for_exit(Duration::from_secs(5))
            .expect("worker must exit");
        assert!(status.success(), "worker exited with {status}");
    }

    #[test]
    #[cfg_attr(
        not(feature = "integration"),
        ignore = "requires Bun and repo TypeScript dependencies"
    )]
    fn bun_agent_worker_mock_execution_round_trips_over_stdio() {
        let fixture: WorkerProtocolFixture =
            serde_json::from_str(WORKER_PROTOCOL_FIXTURE).expect("fixture must parse");
        let execute_message = fixture
            .valid_messages
            .iter()
            .find(|message| message.name == "execute")
            .expect("fixture must include execute message")
            .message
            .clone();

        let bun = std::env::var("BUN_BIN").unwrap_or_else(|_| "bun".to_string());
        let command =
            bun_agent_worker_command(&repo_root(), bun).env("TENEX_AGENT_WORKER_ENGINE", "mock");
        let mut worker = AgentWorkerProcess::spawn(
            &command,
            &AgentWorkerProcessConfig {
                boot_timeout: Duration::from_secs(5),
            },
        )
        .expect("agent worker must boot");

        assert_eq!(worker.ready.protocol.version, AGENT_WORKER_PROTOCOL_VERSION);

        worker
            .process
            .send_message(&execute_message)
            .expect("execute must send");

        let execution_started = worker
            .process
            .next_message(Duration::from_secs(5))
            .expect("execution_started must arrive");
        assert_eq!(
            execution_started.get("type").and_then(Value::as_str),
            Some("execution_started")
        );

        let stream_delta = worker
            .process
            .next_message(Duration::from_secs(5))
            .expect("stream_delta must arrive");
        assert_eq!(
            stream_delta.get("type").and_then(Value::as_str),
            Some("stream_delta")
        );

        let complete = worker
            .process
            .next_message(Duration::from_secs(5))
            .expect("complete must arrive");
        assert_eq!(
            complete.get("type").and_then(Value::as_str),
            Some("complete")
        );
        assert_eq!(
            complete.get("finalRalState").and_then(Value::as_str),
            Some("completed")
        );

        let status = worker
            .process
            .wait_for_exit(Duration::from_secs(5))
            .expect("worker must exit");
        assert!(status.success(), "worker exited with {status}");
    }

    #[test]
    #[cfg_attr(
        not(feature = "integration"),
        ignore = "requires Bun and repo TypeScript dependencies"
    )]
    fn bun_agent_worker_real_tool_execution_round_trips_filesystem_state() {
        let fixture = FilesystemBackedAgentFixture::create()
            .expect("filesystem-backed agent fixture must be created");

        let bun = PathBuf::from(std::env::var("BUN_BIN").unwrap_or_else(|_| "bun".to_string()));
        let command = bun_agent_worker_command(&repo_root(), bun.clone())
            .env("TENEX_AGENT_WORKER_ENGINE", "agent")
            .env("TENEX_BASE_DIR", fixture.tenex_base_path_string())
            .env("USE_MOCK_LLM", "true")
            .env("LOG_LEVEL", "silent");
        let mut worker = AgentWorkerProcess::spawn(
            &command,
            &AgentWorkerProcessConfig {
                boot_timeout: Duration::from_secs(5),
            },
        )
        .expect("agent worker must boot");

        assert_eq!(worker.ready.protocol.version, AGENT_WORKER_PROTOCOL_VERSION);

        worker
            .process
            .send_message(&fixture.execute_message)
            .expect("execute must send");

        let execution_started = worker
            .process
            .next_message(Duration::from_secs(10))
            .expect("execution_started must arrive");
        assert_eq!(
            execution_started.get("type").and_then(Value::as_str),
            Some("execution_started")
        );

        let observed =
            collect_worker_messages_until_terminal(&mut worker.process, &fixture.daemon_dir());
        assert!(observed.iter().any(|message| {
            message.get("type").and_then(Value::as_str) == Some("tool_call_completed")
                && message.get("toolName").and_then(Value::as_str) == Some("todo_write")
        }));
        assert!(observed.iter().any(|message| {
            message.get("type").and_then(Value::as_str) == Some("publish_request")
                && publish_request_content(message).map(str::trim) == Some("Executing todo_write")
        }));
        assert!(observed.iter().any(|message| {
            message.get("type").and_then(Value::as_str) == Some("publish_request")
                && publish_request_content(message).map(str::trim)
                    == Some("Todo tool path complete.")
        }));
        assert_publish_requests_persisted(&fixture, &observed);

        let complete = observed
            .iter()
            .find(|message| message.get("type").and_then(Value::as_str) == Some("complete"))
            .expect("complete message must arrive");
        assert_eq!(
            complete.get("finalRalState").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            complete
                .get("publishedUserVisibleEvent")
                .and_then(Value::as_bool),
            Some(true)
        );

        let status = worker
            .process
            .wait_for_exit(Duration::from_secs(5))
            .expect("worker must exit");
        assert!(status.success(), "worker exited with {status}");

        let conversation: Value = serde_json::from_str(
            &fs::read_to_string(fixture.conversation_path())
                .expect("conversation transcript must be readable"),
        )
        .expect("conversation transcript must parse");
        let messages = conversation
            .get("messages")
            .and_then(Value::as_array)
            .expect("conversation messages must be an array");
        assert!(messages.iter().any(|message| {
            message.get("messageType").and_then(Value::as_str) == Some("tool-call")
                && message_tool_data_contains(message, "todo_write")
        }));
        assert!(messages.iter().any(|message| {
            message.get("messageType").and_then(Value::as_str) == Some("tool-result")
                && message_tool_data_contains(message, "todo_write")
        }));

        let first_todo = conversation
            .get("agentTodos")
            .and_then(|todos| todos.get(AGENT_PUBKEY))
            .and_then(Value::as_array)
            .and_then(|todos| todos.first())
            .expect("agent todo must be persisted");
        assert_eq!(
            first_todo.get("id").and_then(Value::as_str),
            Some("worker-rust-tool-path")
        );
        assert_eq!(
            first_todo.get("status").and_then(Value::as_str),
            Some("done")
        );
    }

    #[test]
    #[cfg_attr(
        not(feature = "integration"),
        ignore = "requires Bun and repo TypeScript dependencies"
    )]
    fn bun_agent_worker_publish_requests_relay_through_rust_outbox() {
        let fixture = FilesystemBackedAgentFixture::create()
            .expect("filesystem-backed agent fixture must be created");

        let bun = PathBuf::from(std::env::var("BUN_BIN").unwrap_or_else(|_| "bun".to_string()));
        let command = bun_agent_worker_command(&repo_root(), bun.clone())
            .env("TENEX_AGENT_WORKER_ENGINE", "agent")
            .env("TENEX_BASE_DIR", fixture.tenex_base_path_string())
            .env("USE_MOCK_LLM", "true")
            .env("LOG_LEVEL", "silent");
        let mut worker = AgentWorkerProcess::spawn(
            &command,
            &AgentWorkerProcessConfig {
                boot_timeout: Duration::from_secs(5),
            },
        )
        .expect("agent worker must boot");

        worker
            .process
            .send_message(&fixture.execute_message)
            .expect("execute must send");

        let execution_started = worker
            .process
            .next_message(Duration::from_secs(10))
            .expect("execution_started must arrive");
        assert_eq!(
            execution_started.get("type").and_then(Value::as_str),
            Some("execution_started")
        );

        let observed =
            collect_worker_messages_until_terminal(&mut worker.process, &fixture.daemon_dir());
        let publish_requests = observed
            .iter()
            .filter(|message| {
                message.get("type").and_then(Value::as_str) == Some("publish_request")
            })
            .collect::<Vec<_>>();
        assert!(
            publish_requests.len() >= 2,
            "real worker must emit tool-progress and final publish requests"
        );

        let status = worker
            .process
            .wait_for_exit(Duration::from_secs(5))
            .expect("worker must exit");
        assert!(status.success(), "worker exited with {status}");

        let mock_relay = MultiPublishMockRelay::start(publish_requests.len());
        let config =
            RelayPublisherConfig::new(vec![mock_relay.url.clone()], Duration::from_secs(2))
                .expect("mock relay config must be valid");
        let mut publisher = NostrRelayPublisher::new(config);

        let outcomes =
            drain_pending_publish_outbox(fixture.daemon_dir(), &mut publisher, 1710001000200)
                .expect("pending outbox must drain through Rust relay publisher");

        assert_eq!(outcomes.len(), publish_requests.len());
        let expected_events = publish_requests
            .iter()
            .map(|message| {
                let event = message
                    .get("event")
                    .cloned()
                    .expect("publish request must include signed event");
                let event_id = event
                    .get("id")
                    .and_then(Value::as_str)
                    .expect("publish request event must include id")
                    .to_string();
                (event_id, event)
            })
            .collect::<BTreeMap<_, _>>();
        let mut relayed_events = BTreeMap::new();
        for _ in 0..publish_requests.len() {
            let frame = mock_relay
                .published_frames
                .recv_timeout(Duration::from_secs(5))
                .expect("mock relay must receive published event");
            assert_eq!(frame.get(0).and_then(Value::as_str), Some("EVENT"));
            let event = frame
                .get(1)
                .cloned()
                .expect("EVENT frame must contain signed event");
            let event_id = event
                .get("id")
                .and_then(Value::as_str)
                .expect("relayed event must include id")
                .to_string();
            relayed_events.insert(event_id, event);
        }

        assert_eq!(relayed_events, expected_events);
        assert_typescript_consumes_relayed_events(
            &repo_root(),
            &bun,
            &relayed_events.values().cloned().collect::<Vec<_>>(),
        );
        for event_id in expected_events.keys() {
            assert!(
                read_pending_publish_outbox_record(fixture.daemon_dir(), event_id)
                    .expect("pending outbox read must succeed")
                    .is_none()
            );
            let published = read_published_publish_outbox_record(fixture.daemon_dir(), event_id)
                .expect("published outbox read must succeed")
                .expect("published outbox record must exist");
            assert_eq!(published.event.id, *event_id);
        }

        mock_relay.join();
    }

    #[test]
    #[cfg_attr(
        not(feature = "integration"),
        ignore = "requires Bun and repo TypeScript dependencies"
    )]
    fn bun_agent_worker_real_non_initial_ral_round_trips_filesystem_state() {
        let mut fixture = FilesystemBackedAgentFixture::create()
            .expect("filesystem-backed agent fixture must be created");
        fixture.execute_message["correlationId"] = json!("rust_real_ral_two_exec_01");
        fixture.execute_message["ralNumber"] = json!(2);
        fixture.execute_message["ralClaimToken"] = json!("claim_rust_real_ral_two");

        let bun = std::env::var("BUN_BIN").unwrap_or_else(|_| "bun".to_string());
        let command = bun_agent_worker_command(&repo_root(), bun)
            .env("TENEX_AGENT_WORKER_ENGINE", "agent")
            .env("TENEX_BASE_DIR", fixture.tenex_base_path_string())
            .env("USE_MOCK_LLM", "true")
            .env("LOG_LEVEL", "silent");
        let mut worker = AgentWorkerProcess::spawn(
            &command,
            &AgentWorkerProcessConfig {
                boot_timeout: Duration::from_secs(5),
            },
        )
        .expect("agent worker must boot");

        worker
            .process
            .send_message(&fixture.execute_message)
            .expect("execute must send");

        let execution_started = worker
            .process
            .next_message(Duration::from_secs(10))
            .expect("execution_started must arrive");
        assert_eq!(
            execution_started.get("type").and_then(Value::as_str),
            Some("execution_started")
        );
        assert_eq!(
            execution_started.get("ralNumber").and_then(Value::as_u64),
            Some(2)
        );

        let observed =
            collect_worker_messages_until_terminal(&mut worker.process, &fixture.daemon_dir());
        let complete = observed
            .iter()
            .find(|message| message.get("type").and_then(Value::as_str) == Some("complete"))
            .expect("complete message must arrive");
        assert_eq!(
            complete.get("finalRalState").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(complete.get("ralNumber").and_then(Value::as_u64), Some(2));

        let status = worker
            .process
            .wait_for_exit(Duration::from_secs(5))
            .expect("worker must exit");
        assert!(status.success(), "worker exited with {status}");

        let conversation: Value = serde_json::from_str(
            &fs::read_to_string(fixture.conversation_path())
                .expect("conversation transcript must be readable"),
        )
        .expect("conversation transcript must parse");
        let messages = conversation
            .get("messages")
            .and_then(Value::as_array)
            .expect("conversation messages must be an array");
        assert!(messages.iter().any(|message| message_content_matches_ral(
            message,
            "please write a todo before you answer",
            2
        )));
    }

    #[test]
    #[cfg_attr(
        not(feature = "integration"),
        ignore = "requires Bun and repo TypeScript dependencies"
    )]
    fn bun_agent_worker_real_delegation_reports_waiting_state() {
        let mut fixture = FilesystemBackedAgentFixture::create()
            .expect("filesystem-backed agent fixture must be created");
        let trigger_content = "please delegate this to worker-agent and wait";
        let delegation_prompt = "Investigate the delegated worker path.";
        fixture.execute_message["correlationId"] = json!("rust_real_delegate_wait_exec_01");
        fixture.execute_message["triggeringEnvelope"]["content"] = json!(trigger_content);
        write_delegation_provider_config(&fixture, trigger_content, delegation_prompt)
            .expect("delegation provider config must be written");

        let bun = std::env::var("BUN_BIN").unwrap_or_else(|_| "bun".to_string());
        let command = bun_agent_worker_command(&repo_root(), bun)
            .env("TENEX_AGENT_WORKER_ENGINE", "agent")
            .env("TENEX_BASE_DIR", fixture.tenex_base_path_string())
            .env("USE_MOCK_LLM", "true")
            .env("LOG_LEVEL", "silent");
        let mut worker = AgentWorkerProcess::spawn(
            &command,
            &AgentWorkerProcessConfig {
                boot_timeout: Duration::from_secs(5),
            },
        )
        .expect("agent worker must boot");

        worker
            .process
            .send_message(&fixture.execute_message)
            .expect("execute must send");

        let execution_started = worker
            .process
            .next_message(Duration::from_secs(10))
            .expect("execution_started must arrive");
        assert_eq!(
            execution_started.get("type").and_then(Value::as_str),
            Some("execution_started")
        );

        let observed =
            collect_worker_messages_until_terminal(&mut worker.process, &fixture.daemon_dir());
        let registration = observed
            .iter()
            .find(|message| {
                message.get("type").and_then(Value::as_str) == Some("delegation_registered")
            })
            .expect("delegation_registered message must arrive");
        assert_eq!(
            registration.get("recipientPubkey").and_then(Value::as_str),
            Some(DELEGATE_AGENT_PUBKEY)
        );
        assert_eq!(
            registration.get("delegationType").and_then(Value::as_str),
            Some("standard")
        );
        let delegation_conversation_id = registration
            .get("delegationConversationId")
            .and_then(Value::as_str)
            .expect("delegation conversation id must be present");

        assert!(observed.iter().any(|message| {
            message.get("type").and_then(Value::as_str) == Some("tool_call_completed")
                && message.get("toolName").and_then(Value::as_str) == Some("delegate")
        }));
        assert!(observed.iter().any(|message| {
            message.get("type").and_then(Value::as_str) == Some("publish_request")
                && publish_request_content(message).map(str::trim) == Some(delegation_prompt)
                && publish_request_has_p_tag(message, DELEGATE_AGENT_PUBKEY)
        }));
        assert_publish_requests_persisted(&fixture, &observed);

        let terminal = observed
            .iter()
            .find(|message| {
                message.get("type").and_then(Value::as_str) == Some("waiting_for_delegation")
            })
            .expect("waiting_for_delegation terminal message must arrive");
        assert_eq!(
            terminal.get("finalRalState").and_then(Value::as_str),
            Some("waiting_for_delegation")
        );
        assert_eq!(
            terminal
                .get("pendingDelegationsRemain")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            terminal
                .get("publishedUserVisibleEvent")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(
            terminal
                .get("pendingDelegations")
                .and_then(Value::as_array)
                .is_some_and(|ids| ids
                    .iter()
                    .any(|id| id.as_str() == Some(delegation_conversation_id)))
        );
        assert!(
            observed
                .iter()
                .all(|message| { message.get("type").and_then(Value::as_str) != Some("complete") })
        );

        let status = worker
            .process
            .wait_for_exit(Duration::from_secs(5))
            .expect("worker must exit");
        assert!(status.success(), "worker exited with {status}");

        let conversation: Value = serde_json::from_str(
            &fs::read_to_string(fixture.conversation_path())
                .expect("conversation transcript must be readable"),
        )
        .expect("conversation transcript must parse");
        let messages = conversation
            .get("messages")
            .and_then(Value::as_array)
            .expect("conversation messages must be an array");
        assert!(messages.iter().any(|message| {
            message.get("messageType").and_then(Value::as_str) == Some("tool-call")
                && message_tool_data_contains(message, "delegate")
        }));
        assert!(messages.iter().any(|message| {
            message.get("messageType").and_then(Value::as_str) == Some("tool-result")
                && message_tool_data_contains(message, "delegate")
        }));
    }

    #[test]
    #[cfg_attr(
        not(feature = "integration"),
        ignore = "requires Bun and repo TypeScript dependencies"
    )]
    fn bun_agent_worker_real_no_response_reports_terminal_state() {
        let mut fixture = FilesystemBackedAgentFixture::create()
            .expect("filesystem-backed agent fixture must be created");
        let trigger_content = "please count this silently and do not reply";
        fixture.execute_message["correlationId"] = json!("rust_real_no_response_exec_01");
        configure_telegram_trigger(&mut fixture, trigger_content);
        write_no_response_provider_config(&fixture, trigger_content)
            .expect("no_response provider config must be written");

        let bun = std::env::var("BUN_BIN").unwrap_or_else(|_| "bun".to_string());
        let command = bun_agent_worker_command(&repo_root(), bun)
            .env("TENEX_AGENT_WORKER_ENGINE", "agent")
            .env("TENEX_BASE_DIR", fixture.tenex_base_path_string())
            .env("USE_MOCK_LLM", "true")
            .env("LOG_LEVEL", "silent");
        let mut worker = AgentWorkerProcess::spawn(
            &command,
            &AgentWorkerProcessConfig {
                boot_timeout: Duration::from_secs(5),
            },
        )
        .expect("agent worker must boot");

        worker
            .process
            .send_message(&fixture.execute_message)
            .expect("execute must send");

        let execution_started = worker
            .process
            .next_message(Duration::from_secs(10))
            .expect("execution_started must arrive");
        assert_eq!(
            execution_started.get("type").and_then(Value::as_str),
            Some("execution_started")
        );

        let observed =
            collect_worker_messages_until_terminal(&mut worker.process, &fixture.daemon_dir());
        assert!(observed.iter().any(|message| {
            message.get("type").and_then(Value::as_str) == Some("silent_completion_requested")
        }));
        assert!(observed.iter().any(|message| {
            message.get("type").and_then(Value::as_str) == Some("tool_call_completed")
                && message.get("toolName").and_then(Value::as_str) == Some("no_response")
        }));

        let terminal = observed
            .iter()
            .find(|message| message.get("type").and_then(Value::as_str) == Some("no_response"))
            .expect("no_response terminal message must arrive");
        assert_eq!(
            terminal.get("finalRalState").and_then(Value::as_str),
            Some("no_response")
        );
        assert_eq!(
            terminal
                .get("publishedUserVisibleEvent")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            terminal
                .get("pendingDelegationsRemain")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert!(
            observed
                .iter()
                .all(|message| { message.get("type").and_then(Value::as_str) != Some("complete") })
        );

        let status = worker
            .process
            .wait_for_exit(Duration::from_secs(5))
            .expect("worker must exit");
        assert!(status.success(), "worker exited with {status}");

        let conversation: Value = serde_json::from_str(
            &fs::read_to_string(fixture.conversation_path())
                .expect("conversation transcript must be readable"),
        )
        .expect("conversation transcript must parse");
        let messages = conversation
            .get("messages")
            .and_then(Value::as_array)
            .expect("conversation messages must be an array");
        assert!(messages.iter().any(|message| {
            message.get("messageType").and_then(Value::as_str) == Some("tool-call")
                && message_tool_data_contains(message, "no_response")
        }));
        assert!(messages.iter().any(|message| {
            message.get("messageType").and_then(Value::as_str) == Some("tool-result")
                && message_tool_data_contains(message, "no_response")
        }));
    }

    fn collect_worker_messages_until_terminal(
        process: &mut AgentWorkerProcess,
        daemon_dir: &Path,
    ) -> Vec<Value> {
        let mut observed = Vec::new();

        for _ in 0..30 {
            let message = process
                .next_message(Duration::from_secs(10))
                .expect("worker message must arrive");
            let message_type = message
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string);
            if message_type.as_deref() == Some("publish_request") {
                accept_publish_request_and_send_result(process, daemon_dir, &message);
            }
            observed.push(message);

            if matches!(
                message_type.as_deref(),
                Some("complete" | "waiting_for_delegation" | "no_response" | "error")
            ) {
                return observed;
            }
        }

        panic!("worker did not emit a terminal message");
    }

    fn accept_publish_request_and_send_result(
        process: &mut AgentWorkerProcess,
        daemon_dir: &Path,
        message: &Value,
    ) {
        let request_sequence = message
            .get("sequence")
            .and_then(Value::as_u64)
            .expect("publish request must have sequence");
        let timestamp = message
            .get("timestamp")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let record = accept_worker_publish_request(daemon_dir, message, timestamp + 1)
            .expect("publish request must durably accept into outbox");
        let publish_result =
            build_accepted_publish_result(&record, request_sequence + 10_000, timestamp + 2);

        process
            .send_message(&publish_result)
            .expect("publish_result must send");
    }

    fn assert_publish_requests_persisted(
        fixture: &FilesystemBackedAgentFixture,
        observed: &[Value],
    ) {
        for message in observed.iter().filter(|message| {
            message.get("type").and_then(Value::as_str) == Some("publish_request")
        }) {
            let event_id = message
                .get("event")
                .and_then(|event| event.get("id"))
                .and_then(Value::as_str)
                .expect("publish request must have signed event id");
            assert!(
                read_pending_publish_outbox_record(fixture.daemon_dir(), event_id)
                    .expect("outbox record read must succeed")
                    .is_some(),
                "publish request {event_id} must have a pending outbox record"
            );
        }
    }

    fn message_tool_data_contains(message: &Value, tool_name: &str) -> bool {
        message
            .get("toolData")
            .and_then(Value::as_array)
            .is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| part.get("toolName").and_then(Value::as_str) == Some(tool_name))
            })
    }

    fn publish_request_content(message: &Value) -> Option<&str> {
        message
            .get("event")
            .and_then(|event| event.get("content"))
            .and_then(Value::as_str)
    }

    fn publish_request_has_p_tag(message: &Value, pubkey: &str) -> bool {
        message
            .get("event")
            .and_then(|event| event.get("tags"))
            .and_then(Value::as_array)
            .is_some_and(|tags| {
                tags.iter().any(|tag| {
                    tag.as_array().is_some_and(|parts| {
                        parts.first().and_then(Value::as_str) == Some("p")
                            && parts.get(1).and_then(Value::as_str) == Some(pubkey)
                    })
                })
            })
    }

    fn message_content_matches_ral(message: &Value, content: &str, ral_number: u64) -> bool {
        message.get("content").and_then(Value::as_str) == Some(content)
            && message.get("ral").and_then(Value::as_u64) == Some(ral_number)
    }

    fn configure_telegram_trigger(fixture: &mut FilesystemBackedAgentFixture, content: &str) {
        let owner_pubkey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let project_id = fixture.project_id.clone();
        let conversation_id = fixture.conversation_id.clone();
        let envelope = &mut fixture.execute_message["triggeringEnvelope"];

        envelope["transport"] = json!("telegram");
        envelope["principal"] = json!({
            "id": "telegram:user:project-owner",
            "transport": "telegram",
            "linkedPubkey": owner_pubkey,
            "displayName": "Project Owner",
            "kind": "human",
        });
        envelope["channel"] = json!({
            "id": format!("telegram:chat:{project_id}"),
            "transport": "telegram",
            "kind": "group",
            "projectBinding": format!("31933:{owner_pubkey}:{project_id}"),
        });
        envelope["message"] = json!({
            "id": format!("telegram:{conversation_id}"),
            "transport": "telegram",
            "nativeId": conversation_id,
        });
        envelope["content"] = json!(content);
    }

    fn write_no_response_provider_config(
        fixture: &FilesystemBackedAgentFixture,
        trigger_content: &str,
    ) -> io::Result<()> {
        write_json_file(
            fixture.tenex_base_path.join("providers.json"),
            &json!({
                "providers": {
                    "mock": {
                        "apiKey": "mock",
                        "options": {
                            "responses": [
                                {
                                    "trigger": {
                                        "userMessage": trigger_content,
                                        "agentName": "project-manager",
                                        "iterationCount": 1,
                                    },
                                    "response": {
                                        "toolCalls": [
                                            {
                                                "function": "no_response",
                                                "args": {},
                                            },
                                        ],
                                    },
                                    "priority": 20,
                                },
                            ],
                        },
                    },
                },
            }),
        )
    }

    fn write_delegation_provider_config(
        fixture: &FilesystemBackedAgentFixture,
        trigger_content: &str,
        delegation_prompt: &str,
    ) -> io::Result<()> {
        write_json_file(
            fixture.tenex_base_path.join("providers.json"),
            &json!({
                "providers": {
                    "mock": {
                        "apiKey": "mock",
                        "options": {
                            "responses": [
                                {
                                    "trigger": {
                                        "userMessage": trigger_content,
                                        "agentName": "project-manager",
                                        "iterationCount": 1,
                                    },
                                    "response": {
                                        "toolCalls": [
                                            {
                                                "function": "delegate",
                                                "args": {
                                                    "recipient": "worker-agent",
                                                    "prompt": delegation_prompt,
                                                },
                                            },
                                        ],
                                    },
                                    "priority": 20,
                                },
                                {
                                    "trigger": {
                                        "agentName": "project-manager",
                                        "iterationCount": 2,
                                    },
                                    "response": {
                                        "content": "Waiting for worker-agent to finish.",
                                    },
                                    "priority": 10,
                                },
                            ],
                        },
                    },
                },
            }),
        )
    }

    fn assert_typescript_consumes_relayed_events(
        repository_root: &Path,
        bun_program: &Path,
        events: &[Value],
    ) {
        let mut child = std::process::Command::new(bun_program)
            .arg("run")
            .arg("tools/rust-migration/nostr-consume-probe.ts")
            .current_dir(repository_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("TypeScript Nostr consume probe must spawn");

        {
            let mut stdin = child
                .stdin
                .take()
                .expect("TypeScript Nostr consume probe stdin must be piped");
            serde_json::to_writer(&mut stdin, &json!({ "events": events }))
                .expect("relayed events must serialize for TypeScript probe");
            stdin
                .write_all(b"\n")
                .expect("TypeScript Nostr consume probe stdin must accept newline");
        }

        let output = child
            .wait_with_output()
            .expect("TypeScript Nostr consume probe must exit");
        assert!(
            output.status.success(),
            "TypeScript Nostr consume probe failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        let probe_result: Value = serde_json::from_slice(&output.stdout)
            .expect("TypeScript Nostr consume probe stdout must be JSON");
        assert_eq!(probe_result.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            probe_result
                .get("events")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(events.len())
        );
    }

    struct MultiPublishMockRelay {
        url: String,
        published_frames: mpsc::Receiver<Value>,
        handle: thread::JoinHandle<()>,
    }

    impl MultiPublishMockRelay {
        fn start(expected_connections: usize) -> Self {
            let listener =
                TcpListener::bind("127.0.0.1:0").expect("mock relay must bind local port");
            listener
                .set_nonblocking(true)
                .expect("mock relay listener must become nonblocking");
            let url = format!(
                "ws://{}",
                listener
                    .local_addr()
                    .expect("mock relay must expose local addr")
            );
            let (sender, published_frames) = mpsc::channel();

            let handle = thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut accepted = 0;
                while accepted < expected_connections {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            stream
                                .set_nonblocking(false)
                                .expect("mock relay stream must become blocking");
                            let mut websocket = tungstenite::accept(stream)
                                .expect("mock relay handshake must succeed");
                            let message = websocket.read().expect("mock relay must read event");
                            let value: Value = serde_json::from_str(
                                message
                                    .to_text()
                                    .expect("mock relay event message must be text"),
                            )
                            .expect("mock relay event message must be json");
                            let event_id = value
                                .get(1)
                                .and_then(|event| event.get("id"))
                                .and_then(Value::as_str)
                                .expect("EVENT frame must include event id")
                                .to_string();
                            sender
                                .send(value)
                                .expect("mock relay must send captured frame");
                            websocket
                                .send(Message::text(
                                    serde_json::to_string(&json!(["OK", event_id, true, "stored"]))
                                        .expect("mock relay OK frame must serialize"),
                                ))
                                .expect("mock relay must send OK frame");
                            accepted += 1;
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            if Instant::now() > deadline {
                                panic!(
                                    "mock relay accepted {accepted} of {expected_connections} expected connections"
                                );
                            }
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("mock relay accept failed: {error}"),
                    }
                }
            });

            Self {
                url,
                published_frames,
                handle,
            }
        }

        fn join(self) {
            self.handle.join().expect("mock relay thread must join");
        }
    }

    struct FilesystemBackedAgentFixture {
        root_path: PathBuf,
        tenex_base_path: PathBuf,
        project_id: String,
        conversation_id: String,
        execute_message: Value,
    }

    impl FilesystemBackedAgentFixture {
        fn create() -> io::Result<Self> {
            let root_path = unique_worker_root();
            let tenex_base_path = root_path.join(".tenex");
            let project_id = "worker-rust-real-project".to_string();
            let owner_pubkey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            let conversation_id =
                "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_string();
            let project_base_path = root_path.join("projects").join(&project_id).join("work");
            let metadata_path = tenex_base_path.join("projects").join(&project_id);
            let agents_path = tenex_base_path.join("agents");

            fs::create_dir_all(&project_base_path)?;
            fs::create_dir_all(&metadata_path)?;
            fs::create_dir_all(&agents_path)?;

            let git_init = std::process::Command::new("git")
                .arg("init")
                .current_dir(&project_base_path)
                .output()?;
            if !git_init.status.success() {
                return Err(io::Error::other(format!(
                    "git init failed: {}",
                    String::from_utf8_lossy(&git_init.stderr)
                )));
            }

            write_json_file(
                tenex_base_path.join("config.json"),
                &json!({
                    "whitelistedPubkeys": [owner_pubkey],
                    "relays": [],
                    "logging": { "level": "silent" },
                }),
            )?;
            write_json_file(
                tenex_base_path.join("llms.json"),
                &json!({
                    "default": "default",
                    "configurations": {
                        "default": {
                            "provider": "mock",
                            "model": "mock-model",
                        },
                    },
                }),
            )?;
            write_json_file(
                tenex_base_path.join("providers.json"),
                &json!({
                    "providers": {
                        "mock": {
                            "apiKey": "mock",
                            "options": {
                                "responses": [
                                    {
                                        "trigger": {
                                            "userMessage": "please write a todo before you answer",
                                            "agentName": "project-manager",
                                            "iterationCount": 1,
                                        },
                                        "response": {
                                            "toolCalls": [
                                                {
                                                    "function": "todo_write",
                                                    "args": {
                                                        "todos": [
                                                            {
                                                                "id": "worker-rust-tool-path",
                                                                "title": "Verify Rust worker tool path",
                                                                "status": "done",
                                                            },
                                                        ],
                                                        "force": true,
                                                    },
                                                },
                                            ],
                                        },
                                        "priority": 20,
                                    },
                                    {
                                        "trigger": {
                                            "agentName": "project-manager",
                                            "iterationCount": 2,
                                        },
                                        "response": {
                                            "content": "Todo tool path complete.",
                                        },
                                        "priority": 10,
                                    },
                                ],
                            },
                        },
                    },
                }),
            )?;
            write_json_file(
                agents_path.join(format!("{AGENT_PUBKEY}.json")),
                &json!({
                    "nsec": AGENT_PRIVATE_KEY_HEX,
                    "slug": "project-manager",
                    "name": "project-manager",
                    "role": "project-manager",
                    "category": "orchestrator",
                    "instructions": "You are the project-manager agent. Current Phase: execute. Reply plainly.",
                    "status": "active",
                    "default": {
                        "model": "default",
                        "tools": [],
                        "skills": [],
                        "blockedSkills": [],
                        "mcpAccess": [],
                    },
                }),
            )?;
            write_json_file(
                agents_path.join(format!("{DELEGATE_AGENT_PUBKEY}.json")),
                &json!({
                    "nsec": DELEGATE_AGENT_PRIVATE_KEY_HEX,
                    "slug": "worker-agent",
                    "name": "worker-agent",
                    "role": "worker-agent",
                    "category": "worker",
                    "instructions": "You are the worker-agent. Current Phase: execute. Reply plainly.",
                    "status": "active",
                    "default": {
                        "model": "default",
                        "tools": [],
                        "skills": [],
                        "blockedSkills": [],
                        "mcpAccess": [],
                    },
                }),
            )?;
            write_json_file(
                agents_path.join("index.json"),
                &json!({
                    "bySlug": {
                        "project-manager": {
                            "pubkey": AGENT_PUBKEY,
                            "projectIds": [project_id],
                        },
                        "worker-agent": {
                            "pubkey": DELEGATE_AGENT_PUBKEY,
                            "projectIds": [project_id],
                        },
                    },
                    "byEventId": {},
                    "byProject": {
                        project_id.clone(): [AGENT_PUBKEY, DELEGATE_AGENT_PUBKEY],
                    },
                }),
            )?;

            let execute_message = json!({
                "version": AGENT_WORKER_PROTOCOL_VERSION,
                "type": "execute",
                "correlationId": "rust_real_tool_exec_01",
                "sequence": 1,
                "timestamp": 1710000800000_u64,
                "projectId": project_id,
                "projectBasePath": path_string(&project_base_path),
                "metadataPath": path_string(&metadata_path),
                "agentPubkey": AGENT_PUBKEY,
                "conversationId": conversation_id,
                "ralNumber": 1,
                "ralClaimToken": "claim_rust_real_exec_01",
                "triggeringEnvelope": {
                    "transport": "nostr",
                    "principal": {
                        "id": format!("nostr:{owner_pubkey}"),
                        "transport": "nostr",
                        "linkedPubkey": owner_pubkey,
                        "displayName": "Project Owner",
                        "kind": "human",
                    },
                    "channel": {
                        "id": format!("nostr:project:31933:{owner_pubkey}:{project_id}"),
                        "transport": "nostr",
                        "kind": "project",
                        "projectBinding": format!("31933:{owner_pubkey}:{project_id}"),
                    },
                    "message": {
                        "id": format!("nostr:{conversation_id}"),
                        "transport": "nostr",
                        "nativeId": conversation_id,
                    },
                    "recipients": [
                        {
                            "id": format!("nostr:{AGENT_PUBKEY}"),
                            "transport": "nostr",
                            "linkedPubkey": AGENT_PUBKEY,
                            "kind": "agent",
                        },
                    ],
                    "content": "please write a todo before you answer",
                    "occurredAt": 1710000800_u64,
                    "capabilities": ["reply"],
                    "metadata": {
                        "eventKind": 1,
                        "eventTagCount": 3,
                    },
                },
                "executionFlags": {
                    "isDelegationCompletion": false,
                    "hasPendingDelegations": false,
                    "debug": true,
                },
            });

            Ok(Self {
                root_path,
                tenex_base_path,
                project_id,
                conversation_id,
                execute_message,
            })
        }

        fn tenex_base_path_string(&self) -> String {
            path_string(&self.tenex_base_path)
        }

        fn conversation_path(&self) -> PathBuf {
            self.tenex_base_path
                .join("projects")
                .join(&self.project_id)
                .join("conversations")
                .join(format!("{}.json", self.conversation_id))
        }

        fn daemon_dir(&self) -> PathBuf {
            self.tenex_base_path.join("daemon")
        }
    }

    impl Drop for FilesystemBackedAgentFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root_path);
        }
    }

    fn write_json_file(path: impl AsRef<Path>, value: &Value) -> io::Result<()> {
        fs::write(
            path,
            serde_json::to_string_pretty(value).map_err(io::Error::other)?,
        )
    }

    fn unique_worker_root() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "tenex-rust-agent-worker-{}-{unique}",
            std::process::id()
        ))
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// In-process stand-in for `tools/rust-migration/protocol-probe-worker.ts`.
    ///
    /// Runs the probe's ready/ping/pong/shutdown state machine on a background
    /// thread connected to an `AgentWorkerChannel` through OS pipes. The
    /// daemon-side `AgentWorkerChannel` is indistinguishable from one wired to
    /// a real subprocess, exercising the same protocol handshake, framing, and
    /// shutdown paths without booting a TypeScript runtime.
    struct InProcessProtocolProbeFake {
        channel: AgentWorkerChannel,
        ready: AgentWorkerReady,
        worker: thread::JoinHandle<Result<(), String>>,
    }

    impl InProcessProtocolProbeFake {
        fn start() -> Self {
            let (worker_stdin_reader, daemon_stdin_writer) =
                io::pipe().expect("stdin pipe must open");
            let (daemon_stdout_reader, worker_stdout_writer) =
                io::pipe().expect("stdout pipe must open");
            let (daemon_stderr_reader, _stderr_writer) = io::pipe().expect("stderr pipe must open");

            let worker = thread::spawn(move || {
                run_in_process_protocol_probe(worker_stdin_reader, worker_stdout_writer)
            });

            let mut channel = AgentWorkerChannel::new(
                Box::new(daemon_stdin_writer),
                Box::new(daemon_stdout_reader),
                Box::new(daemon_stderr_reader),
            );
            let ready = channel
                .read_ready(Duration::from_secs(1))
                .expect("in-process probe ready must arrive");

            Self {
                channel,
                ready,
                worker,
            }
        }
    }

    fn run_in_process_protocol_probe(
        mut stdin: io::PipeReader,
        mut stdout: io::PipeWriter,
    ) -> Result<(), String> {
        let mut sequence = 0_u64;
        let mut next_sequence = || {
            sequence += 1;
            sequence
        };

        let ready = json!({
            "version": AGENT_WORKER_PROTOCOL_VERSION,
            "type": "ready",
            "correlationId": "worker_boot",
            "sequence": next_sequence(),
            "timestamp": 1_710_000_700_000_u64,
            "workerId": format!("protocol-probe-{}", std::process::id()),
            "pid": u64::from(std::process::id()),
            "protocol": {
                "version": AGENT_WORKER_PROTOCOL_VERSION,
                "encoding": AGENT_WORKER_PROTOCOL_ENCODING,
                "maxFrameBytes": AGENT_WORKER_MAX_FRAME_BYTES,
                "streamBatchMs": AGENT_WORKER_STREAM_BATCH_MS,
                "streamBatchMaxBytes": AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
            },
        });
        write_probe_frame(&mut stdout, &ready)?;

        loop {
            let message = match read_agent_worker_protocol_message(&mut stdin) {
                Ok(message) => message,
                Err(WorkerProcessError::Io(error))
                    if matches!(
                        error.kind(),
                        io::ErrorKind::UnexpectedEof | io::ErrorKind::BrokenPipe
                    ) =>
                {
                    return Err("daemon closed stdin before sending shutdown".to_string());
                }
                Err(error) => return Err(format!("probe read failed: {error}")),
            };

            let message_type = message
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| "probe message missing type".to_string())?;

            match message_type {
                "ping" => {
                    let correlation_id = message
                        .get("correlationId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "ping missing correlationId".to_string())?
                        .to_string();
                    let replying_to_sequence = message
                        .get("sequence")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| "ping missing sequence".to_string())?;
                    let pong = json!({
                        "version": AGENT_WORKER_PROTOCOL_VERSION,
                        "type": "pong",
                        "correlationId": correlation_id,
                        "sequence": next_sequence(),
                        "timestamp": 1_710_000_700_100_u64,
                        "replyingToSequence": replying_to_sequence,
                    });
                    write_probe_frame(&mut stdout, &pong)?;
                }
                "shutdown" => return Ok(()),
                other => return Err(format!("unexpected probe message type: {other}")),
            }
        }
    }

    fn write_probe_frame(stdout: &mut io::PipeWriter, value: &Value) -> Result<(), String> {
        let frame = encode_agent_worker_protocol_frame(value)
            .map_err(|error| format!("probe frame encode failed: {error}"))?;
        stdout
            .write_all(&frame)
            .map_err(|error| format!("probe stdout write failed: {error}"))?;
        stdout
            .flush()
            .map_err(|error| format!("probe stdout flush failed: {error}"))
    }
}
