//! Relative-time + uptime formatters.
//!
//! Mirrors `src/lib/time.ts` verbatim. Three pure functions:
//!
//! - [`format_time_ago`] — long form (`"2 hours ago"`, `"45 minutes ago"`,
//!   `"just now"`) over millisecond timestamps.
//! - [`format_relative_time_short`] — short form (`"2h ago"`, `"45m ago"`,
//!   `"just now"`) over **second** timestamps. Note the unit difference
//!   from the long form.
//! - [`format_uptime_ms`] — `"<H>h <M>m <S>s"` over a millisecond
//!   duration.
//!
//! Each function takes the "now" timestamp explicitly for testability —
//! the TS source calls `Date.now()` directly which is harder to fixture.
//! Production callers pass `now_ms()` / `now_secs()` from
//! [`crate::utils::time::now_ms`] / [`crate::utils::time::now_secs`].

/// Wall-clock now in milliseconds since the Unix epoch. Saturates at 0
/// if the system clock is before 1970.
pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Wall-clock now in seconds since the Unix epoch. Saturates at 0.
pub fn now_secs() -> u64 {
    now_ms() / 1000
}

/// Mirror `formatTimeAgo` (`time.ts:9-38`). Long-form relative-time
/// over millisecond timestamps.
///
/// Order matters — months/weeks/days/hours/minutes/seconds checks fall
/// through in source order, so a 25-minute span returns `"25 minutes
/// ago"`, not `"1500 seconds ago"`.
///
/// `"<n> seconds ago"` is the only branch that gates on a 30s threshold
/// — anything <30s collapses to `"just now"` to avoid misleading
/// millisecond-level reports.
///
/// Singular/plural matches TS `> 1 ? "s" : ""` exactly: `1 month ago`
/// stays singular, `2 months ago` plural. The `"<seconds> seconds ago"`
/// branch is always plural per TS source (no singular `"1 second ago"`
/// path because anything ≤30s renders as `"just now"`).
pub fn format_time_ago(timestamp_ms: u64, now_ms: u64) -> String {
    let diff = now_ms.saturating_sub(timestamp_ms);
    let seconds = diff / 1000;
    let minutes = seconds / 60;
    let hours = minutes / 60;
    let days = hours / 24;
    let weeks = days / 7;
    let months = days / 30;

    if months > 0 {
        return format!("{months} month{} ago", plural(months));
    }
    if weeks > 0 {
        return format!("{weeks} week{} ago", plural(weeks));
    }
    if days > 0 {
        return format!("{days} day{} ago", plural(days));
    }
    if hours > 0 {
        return format!("{hours} hour{} ago", plural(hours));
    }
    if minutes > 0 {
        return format!("{minutes} minute{} ago", plural(minutes));
    }
    if seconds > 30 {
        return format!("{seconds} seconds ago");
    }
    "just now".to_owned()
}

/// Mirror `formatRelativeTimeShort` (`time.ts:45-60`). Short-form
/// relative-time over **second** timestamps.
///
/// Branches: <60s → `"just now"`; <3600s → `"<m>m ago"`; <86400s →
/// `"<h>h ago"`; otherwise → `"<d>d ago"`.
///
/// Note: there is no plural toggle here — the TS source emits `"1m
/// ago"`, `"2m ago"`, etc. uniformly.
pub fn format_relative_time_short(timestamp_sec: u64, now_sec: u64) -> String {
    let diff = now_sec.saturating_sub(timestamp_sec);
    if diff < 60 {
        return "just now".to_owned();
    }
    if diff < 3600 {
        return format!("{}m ago", diff / 60);
    }
    if diff < 86400 {
        return format!("{}h ago", diff / 3600);
    }
    format!("{}d ago", diff / 86400)
}

/// Mirror `formatUptime` (`time.ts:65-73`). Takes a millisecond
/// duration directly — the TS source passes `null → "N/A"` for missing
/// start time; Rust callers pass `Option<u64>` and handle the `None`
/// case explicitly. See [`format_uptime_or_na`] for the TS-faithful
/// `Option` wrapper.
///
/// Note: the TS source uses `Math.floor(diff / 3600000)` for hours
/// without rolling over to days — `25h 0m 0s` stays as-is rather than
/// becoming `1d 1h ...`. Mirrored.
pub fn format_uptime_ms(diff_ms: u64) -> String {
    let hours = diff_ms / 3_600_000;
    let minutes = (diff_ms % 3_600_000) / 60_000;
    let seconds = (diff_ms % 60_000) / 1000;
    format!("{hours}h {minutes}m {seconds}s")
}

/// `formatUptime(startTime: Date | null)` (`time.ts:65-73`). Mirrors
/// the `if (!startTime) return "N/A"` guard.
pub fn format_uptime_or_na(start_ms: Option<u64>, now_ms: u64) -> String {
    match start_ms {
        None => "N/A".to_owned(),
        Some(start) => format_uptime_ms(now_ms.saturating_sub(start)),
    }
}

fn plural(n: u64) -> &'static str {
    if n > 1 {
        "s"
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── format_time_ago ─────────────────────────────────────────────────

    const SECOND: u64 = 1_000;
    const MINUTE: u64 = 60 * SECOND;
    const HOUR: u64 = 60 * MINUTE;
    const DAY: u64 = 24 * HOUR;
    const WEEK: u64 = 7 * DAY;
    const MONTH_30D: u64 = 30 * DAY;

    fn ago(ms: u64) -> String {
        let now = 1_000_000_000_000u64;
        format_time_ago(now - ms, now)
    }

    #[test]
    fn time_ago_just_now_under_30s() {
        assert_eq!(ago(0), "just now");
        assert_eq!(ago(15 * SECOND), "just now");
        assert_eq!(ago(30 * SECOND), "just now");
    }

    #[test]
    fn time_ago_seconds_above_30s_uses_seconds() {
        assert_eq!(ago(31 * SECOND), "31 seconds ago");
        assert_eq!(ago(59 * SECOND), "59 seconds ago");
    }

    #[test]
    fn time_ago_singular_minute() {
        assert_eq!(ago(MINUTE), "1 minute ago");
    }

    #[test]
    fn time_ago_plural_minutes() {
        assert_eq!(ago(2 * MINUTE), "2 minutes ago");
        assert_eq!(ago(45 * MINUTE), "45 minutes ago");
    }

    #[test]
    fn time_ago_singular_hour() {
        assert_eq!(ago(HOUR), "1 hour ago");
    }

    #[test]
    fn time_ago_plural_hours() {
        assert_eq!(ago(2 * HOUR), "2 hours ago");
        assert_eq!(ago(23 * HOUR), "23 hours ago");
    }

    #[test]
    fn time_ago_singular_day() {
        assert_eq!(ago(DAY), "1 day ago");
    }

    #[test]
    fn time_ago_plural_days() {
        assert_eq!(ago(6 * DAY), "6 days ago");
    }

    #[test]
    fn time_ago_singular_week() {
        assert_eq!(ago(WEEK), "1 week ago");
    }

    #[test]
    fn time_ago_plural_weeks() {
        // 14 days = 2 weeks (still under 30 days = no months yet)
        assert_eq!(ago(2 * WEEK), "2 weeks ago");
    }

    #[test]
    fn time_ago_singular_month() {
        assert_eq!(ago(MONTH_30D), "1 month ago");
    }

    #[test]
    fn time_ago_plural_months() {
        assert_eq!(ago(2 * MONTH_30D), "2 months ago");
    }

    #[test]
    fn time_ago_clock_drift_does_not_panic() {
        // Future timestamp → saturating_sub returns 0 → "just now".
        assert_eq!(format_time_ago(2_000, 1_000), "just now");
    }

    // ── format_relative_time_short ──────────────────────────────────────

    fn short(secs_ago: u64) -> String {
        let now = 1_700_000_000u64;
        format_relative_time_short(now - secs_ago, now)
    }

    #[test]
    fn short_just_now_under_60s() {
        assert_eq!(short(0), "just now");
        assert_eq!(short(59), "just now");
    }

    #[test]
    fn short_minutes() {
        assert_eq!(short(60), "1m ago");
        assert_eq!(short(45 * 60), "45m ago");
        assert_eq!(short(59 * 60), "59m ago");
    }

    #[test]
    fn short_hours() {
        assert_eq!(short(60 * 60), "1h ago");
        assert_eq!(short(2 * 60 * 60), "2h ago");
        assert_eq!(short(23 * 60 * 60), "23h ago");
    }

    #[test]
    fn short_days() {
        assert_eq!(short(24 * 60 * 60), "1d ago");
        assert_eq!(short(3 * 24 * 60 * 60), "3d ago");
        // Doesn't roll up to weeks/months — stays as days.
        assert_eq!(short(60 * 24 * 60 * 60), "60d ago");
    }

    #[test]
    fn short_clock_drift_does_not_panic() {
        assert_eq!(format_relative_time_short(2_000, 1_000), "just now");
    }

    // ── format_uptime ──────────────────────────────────────────────────

    #[test]
    fn uptime_zero() {
        assert_eq!(format_uptime_ms(0), "0h 0m 0s");
    }

    #[test]
    fn uptime_under_one_minute() {
        assert_eq!(format_uptime_ms(45_000), "0h 0m 45s");
    }

    #[test]
    fn uptime_minutes_and_seconds() {
        assert_eq!(format_uptime_ms(2 * MINUTE + 30 * SECOND), "0h 2m 30s");
    }

    #[test]
    fn uptime_full_hms() {
        assert_eq!(
            format_uptime_ms(3 * HOUR + 7 * MINUTE + 11 * SECOND),
            "3h 7m 11s"
        );
    }

    #[test]
    fn uptime_does_not_roll_over_to_days() {
        // TS source does NOT roll up — 25h 0m 0s stays as-is.
        assert_eq!(format_uptime_ms(25 * HOUR), "25h 0m 0s");
    }

    #[test]
    fn uptime_or_na_returns_na_for_none() {
        assert_eq!(format_uptime_or_na(None, 1_000), "N/A");
    }

    #[test]
    fn uptime_or_na_computes_diff_for_some() {
        assert_eq!(
            format_uptime_or_na(Some(1_000), 1_000 + 5 * MINUTE),
            "0h 5m 0s"
        );
    }

    // ── now_* helpers ──────────────────────────────────────────────────

    #[test]
    fn now_ms_returns_nonzero_post_1970() {
        // Smoke check — system clock should be >0 since 1970.
        assert!(now_ms() > 1_000_000_000_000); // post-2001 sanity
    }

    #[test]
    fn now_secs_is_now_ms_divided_by_1000() {
        let ms = now_ms();
        let s = now_secs();
        // Within ±2 seconds of each other (the two calls aren't atomic).
        let derived_s = ms / 1000;
        assert!(s.abs_diff(derived_s) <= 2);
    }
}
