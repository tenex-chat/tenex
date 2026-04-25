//! Backend-status timing constant. The publish loop itself runs in
//! `backend_status_driver` as an event-driven task with its own
//! `tokio::time::sleep_until`; this module exists only to keep the
//! interval constant in one place.

pub const BACKEND_STATUS_TICK_INTERVAL_SECONDS: u64 = 30;
