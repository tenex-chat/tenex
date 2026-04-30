//! Token-bucket-style rate limiter for outbound embedding API calls.
//!
//! Each `await_slot()` call returns no sooner than the next allowed
//! tick. Backoff is opt-in via `backoff_after_failure()` — the scheduler
//! and backfill loops call it after a 429 / 5xx response.

use std::time::Duration;

use tokio::time::{sleep, Instant};

pub struct Pacer {
    interval: Duration,
    next: tokio::sync::Mutex<Instant>,
    failure_streak: tokio::sync::Mutex<u32>,
}

impl Pacer {
    pub fn from_per_sec(per_sec: f64) -> Self {
        let per_sec = per_sec.max(0.1); // floor: at least 1 every 10s
        let interval = Duration::from_secs_f64(1.0 / per_sec);
        Self {
            interval,
            next: tokio::sync::Mutex::new(Instant::now()),
            failure_streak: tokio::sync::Mutex::new(0),
        }
    }

    /// Wait until the next slot is available.
    pub async fn await_slot(&self) {
        let mut next = self.next.lock().await;
        let now = Instant::now();
        if now < *next {
            let wait = *next - now;
            drop(next);
            sleep(wait).await;
            let mut next = self.next.lock().await;
            *next = Instant::now() + self.interval;
        } else {
            *next = now + self.interval;
        }
    }

    /// Apply backoff after a failure. Doubles up to a 60 s ceiling.
    pub async fn backoff_after_failure(&self) {
        let mut streak = self.failure_streak.lock().await;
        *streak = streak.saturating_add(1);
        let exp = (*streak).min(8); // 2^8 = 256 → clamped to 60s below
        drop(streak);

        let backoff_secs = (1u64 << exp).min(60);
        sleep(Duration::from_secs(backoff_secs)).await;
    }

    pub async fn reset_failures(&self) {
        let mut streak = self.failure_streak.lock().await;
        *streak = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use std::time::Instant;

    #[tokio::test]
    async fn await_slot_paces_calls() {
        // 50/sec ⇒ 20ms apart; 5 calls ⇒ ~80ms minimum total wait.
        let pacer = Pacer::from_per_sec(50.0);
        let start = Instant::now();
        for _ in 0..5 {
            pacer.await_slot().await;
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(60),
            "expected paced delay; elapsed={elapsed:?}"
        );
    }
}
