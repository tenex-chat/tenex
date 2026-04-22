use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::nip46::protocol::Nip46Response;

#[derive(Clone, Default)]
pub struct PendingNip46Requests {
    inner: Arc<Mutex<HashMap<String, Sender<Nip46Response>>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum PendingError {
    #[error("nip-46 request {0:?} not found or already completed")]
    Unknown(String),
    #[error("nip-46 response channel closed")]
    Closed,
}

impl PendingNip46Requests {
    pub fn register(&self, id: String) -> Receiver<Nip46Response> {
        let (tx, rx) = channel();
        self.inner.lock().unwrap().insert(id, tx);
        rx
    }

    pub fn cancel(&self, id: &str) {
        self.inner.lock().unwrap().remove(id);
    }

    pub fn complete(&self, response: Nip46Response) -> Result<(), PendingError> {
        let maybe_tx = self.inner.lock().unwrap().remove(&response.id);
        match maybe_tx {
            Some(tx) => tx.send(response).map_err(|_| PendingError::Closed),
            None => Err(PendingError::Unknown(response.id)),
        }
    }

    pub fn wait(
        &self,
        id: &str,
        rx: &Receiver<Nip46Response>,
        timeout: Duration,
    ) -> Result<Nip46Response, RecvTimeoutError> {
        let result = rx.recv_timeout(timeout);
        if result.is_err() {
            self.cancel(id);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn response(id: &str, result: &str) -> Nip46Response {
        Nip46Response {
            id: id.to_string(),
            result: Some(result.to_string()),
            error: None,
        }
    }

    #[test]
    fn register_then_complete_delivers_response() {
        let pending = PendingNip46Requests::default();
        let rx = pending.register("req-1".to_string());

        let completer = pending.clone();
        let handle = thread::spawn(move || {
            completer
                .complete(response("req-1", "ok"))
                .expect("complete must succeed");
        });

        let delivered = pending
            .wait("req-1", &rx, Duration::from_secs(1))
            .expect("wait must receive response");
        handle.join().expect("completer thread must join cleanly");

        assert_eq!(delivered, response("req-1", "ok"));
    }

    #[test]
    fn wait_times_out_and_cleans_up_pending_entry() {
        let pending = PendingNip46Requests::default();
        let rx = pending.register("req-2".to_string());

        let err = pending
            .wait("req-2", &rx, Duration::from_millis(50))
            .expect_err("wait must time out");
        assert!(matches!(err, RecvTimeoutError::Timeout));

        match pending.complete(response("req-2", "late")) {
            Err(PendingError::Unknown(id)) => assert_eq!(id, "req-2"),
            other => panic!("expected Unknown after timeout, got {other:?}"),
        }
    }

    #[test]
    fn cancel_removes_entry() {
        let pending = PendingNip46Requests::default();
        let _rx = pending.register("req-3".to_string());

        pending.cancel("req-3");

        match pending.complete(response("req-3", "value")) {
            Err(PendingError::Unknown(id)) => assert_eq!(id, "req-3"),
            other => panic!("expected Unknown after cancel, got {other:?}"),
        }
    }

    #[test]
    fn concurrent_register_wait_and_complete_from_different_threads() {
        let pending = PendingNip46Requests::default();
        let rx = pending.register("req-4".to_string());

        let completer = pending.clone();
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            completer
                .complete(response("req-4", "done"))
                .expect("complete must succeed");
        });

        let delivered = pending
            .wait("req-4", &rx, Duration::from_secs(1))
            .expect("wait must receive response across threads");
        handle.join().expect("completer thread must join cleanly");

        assert_eq!(delivered, response("req-4", "done"));
    }

    #[test]
    fn complete_returns_closed_if_rx_dropped() {
        let pending = PendingNip46Requests::default();
        let rx = pending.register("req-5".to_string());
        drop(rx);

        match pending.complete(response("req-5", "value")) {
            Err(PendingError::Closed) => {}
            other => panic!("expected Closed after rx drop, got {other:?}"),
        }
    }

    #[test]
    fn default_is_empty_and_clonable() {
        let original = PendingNip46Requests::default();
        let clone = original.clone();

        assert!(
            original.inner.lock().unwrap().is_empty(),
            "default must create an empty map"
        );

        let rx = original.register("req-6".to_string());
        clone
            .complete(response("req-6", "shared"))
            .expect("clone must complete entry registered on original");

        let delivered = original
            .wait("req-6", &rx, Duration::from_secs(1))
            .expect("receiver must observe completion from clone");
        assert_eq!(delivered, response("req-6", "shared"));
    }
}
