use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

const SIGKILL_GRACE_MS: u64 = 5_000;

pub(super) fn terminate_process_group(pid: u32) -> bool {
    let pgid = -(pid as i32);
    let term_rc = unsafe { libc::kill(pgid, libc::SIGTERM) };
    if term_rc != 0 {
        return false;
    }
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SIGKILL_GRACE_MS)).await;
        unsafe {
            libc::kill(pgid, libc::SIGKILL);
        }
    });
    true
}

pub(super) fn status_signal(status: &std::process::ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        status.signal().map(|signal| format!("SIG{signal}"))
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}
