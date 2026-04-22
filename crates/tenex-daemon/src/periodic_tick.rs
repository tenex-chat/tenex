use std::collections::BTreeMap;

use serde::Serialize;
use thiserror::Error;

pub const PERIODIC_TICK_SCHEDULER_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PeriodicTickError {
    #[error("periodic task name must be non-empty")]
    EmptyName,
    #[error("periodic task `{name}` interval_seconds must be greater than zero")]
    ZeroInterval { name: String },
    #[error("periodic task `{name}` is already registered")]
    DuplicateTask { name: String },
    #[error("periodic task `{name}` is not registered")]
    UnknownTask { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeriodicTaskSpec {
    pub name: String,
    pub interval_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PeriodicTaskEntry {
    spec: PeriodicTaskSpec,
    next_due_at: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PeriodicScheduler {
    tasks: BTreeMap<String, PeriodicTaskEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodicTaskSnapshot {
    pub name: String,
    pub interval_seconds: u64,
    pub next_due_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodicSchedulerSnapshot {
    pub schema_version: u32,
    pub tasks: Vec<PeriodicTaskSnapshot>,
}

impl PeriodicScheduler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_task(
        &mut self,
        name: impl Into<String>,
        interval_seconds: u64,
        first_due_at: u64,
    ) -> Result<(), PeriodicTickError> {
        let name = name.into();
        if name.is_empty() {
            return Err(PeriodicTickError::EmptyName);
        }
        if interval_seconds == 0 {
            return Err(PeriodicTickError::ZeroInterval { name });
        }
        if self.tasks.contains_key(&name) {
            return Err(PeriodicTickError::DuplicateTask { name });
        }
        self.tasks.insert(
            name.clone(),
            PeriodicTaskEntry {
                spec: PeriodicTaskSpec {
                    name,
                    interval_seconds,
                },
                next_due_at: first_due_at,
            },
        );
        Ok(())
    }

    pub fn has_task(&self, name: &str) -> bool {
        self.tasks.contains_key(name)
    }

    pub fn remove_task(&mut self, name: &str) -> Result<(), PeriodicTickError> {
        if self.tasks.remove(name).is_none() {
            return Err(PeriodicTickError::UnknownTask {
                name: name.to_string(),
            });
        }
        Ok(())
    }

    /// Returns task names whose `next_due_at <= now`, advancing each returned
    /// task's schedule so it won't re-fire at this `now`. Catch-up is collapsed:
    /// a single overdue task fires once regardless of how many intervals have
    /// elapsed, with the next deadline anchored at `now + interval_seconds`.
    pub fn take_due(&mut self, now: u64) -> Vec<String> {
        let mut due = Vec::new();
        for entry in self.tasks.values_mut() {
            if entry.next_due_at <= now {
                due.push(entry.spec.name.clone());
                entry.next_due_at = now.saturating_add(entry.spec.interval_seconds);
            }
        }
        due.sort();
        due
    }

    /// Seconds from `now` to the earliest next deadline. Returns `Some(0)` if a
    /// task is already due, and `None` if no tasks are registered.
    pub fn next_deadline_in(&self, now: u64) -> Option<u64> {
        self.tasks
            .values()
            .map(|entry| entry.next_due_at.saturating_sub(now))
            .min()
    }

    pub fn inspect(&self) -> PeriodicSchedulerSnapshot {
        let mut tasks: Vec<PeriodicTaskSnapshot> = self
            .tasks
            .values()
            .map(|entry| PeriodicTaskSnapshot {
                name: entry.spec.name.clone(),
                interval_seconds: entry.spec.interval_seconds,
                next_due_at: entry.next_due_at,
            })
            .collect();
        tasks.sort_by(|left, right| left.name.cmp(&right.name));
        PeriodicSchedulerSnapshot {
            schema_version: PERIODIC_TICK_SCHEDULER_SCHEMA_VERSION,
            tasks,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_rejects_empty_name() {
        let mut sched = PeriodicScheduler::new();
        let err = sched.register_task("", 30, 0).unwrap_err();
        assert_eq!(err, PeriodicTickError::EmptyName);
    }

    #[test]
    fn register_rejects_zero_interval() {
        let mut sched = PeriodicScheduler::new();
        let err = sched.register_task("heartbeat", 0, 0).unwrap_err();
        assert_eq!(
            err,
            PeriodicTickError::ZeroInterval {
                name: "heartbeat".to_string()
            }
        );
    }

    #[test]
    fn register_rejects_duplicate_name() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("heartbeat", 30, 0).unwrap();
        let err = sched.register_task("heartbeat", 60, 0).unwrap_err();
        assert_eq!(
            err,
            PeriodicTickError::DuplicateTask {
                name: "heartbeat".to_string()
            }
        );
    }

    #[test]
    fn remove_unknown_task_returns_error() {
        let mut sched = PeriodicScheduler::new();
        let err = sched.remove_task("missing").unwrap_err();
        assert_eq!(
            err,
            PeriodicTickError::UnknownTask {
                name: "missing".to_string()
            }
        );
    }

    #[test]
    fn take_due_returns_nothing_before_first_deadline() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("heartbeat", 30, 100).unwrap();
        assert!(sched.take_due(50).is_empty());
        assert!(sched.take_due(99).is_empty());
    }

    #[test]
    fn take_due_fires_when_first_deadline_reached() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("heartbeat", 30, 100).unwrap();
        let due = sched.take_due(100);
        assert_eq!(due, vec!["heartbeat".to_string()]);
    }

    #[test]
    fn take_due_advances_next_deadline_by_interval() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("heartbeat", 30, 100).unwrap();
        let _ = sched.take_due(100);
        assert!(sched.take_due(129).is_empty());
        let due = sched.take_due(130);
        assert_eq!(due, vec!["heartbeat".to_string()]);
    }

    #[test]
    fn take_due_collapses_catchup_to_single_fire() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("heartbeat", 30, 100).unwrap();
        let due = sched.take_due(500);
        assert_eq!(due, vec!["heartbeat".to_string()]);
        let next = sched.next_deadline_in(500).unwrap();
        assert_eq!(next, 30);
    }

    #[test]
    fn take_due_returns_names_sorted() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("zeta", 10, 100).unwrap();
        sched.register_task("alpha", 10, 100).unwrap();
        sched.register_task("mu", 10, 100).unwrap();
        let due = sched.take_due(100);
        assert_eq!(
            due,
            vec!["alpha".to_string(), "mu".to_string(), "zeta".to_string()]
        );
    }

    #[test]
    fn multiple_tasks_fire_independently() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("heartbeat", 30, 100).unwrap();
        sched.register_task("status", 60, 100).unwrap();
        let due = sched.take_due(100);
        assert_eq!(due, vec!["heartbeat".to_string(), "status".to_string()]);
        assert!(sched.take_due(129).is_empty());
        let due = sched.take_due(130);
        assert_eq!(due, vec!["heartbeat".to_string()]);
        let due = sched.take_due(160);
        assert_eq!(due, vec!["heartbeat".to_string(), "status".to_string()]);
    }

    #[test]
    fn next_deadline_in_reports_zero_when_overdue() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("heartbeat", 30, 100).unwrap();
        assert_eq!(sched.next_deadline_in(150), Some(0));
    }

    #[test]
    fn next_deadline_in_reports_time_to_next_task() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("heartbeat", 30, 200).unwrap();
        assert_eq!(sched.next_deadline_in(150), Some(50));
    }

    #[test]
    fn next_deadline_in_without_tasks_is_none() {
        let sched = PeriodicScheduler::new();
        assert_eq!(sched.next_deadline_in(0), None);
    }

    #[test]
    fn next_deadline_in_picks_soonest_task() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("heartbeat", 30, 200).unwrap();
        sched.register_task("status", 60, 175).unwrap();
        assert_eq!(sched.next_deadline_in(150), Some(25));
    }

    #[test]
    fn remove_task_stops_firing() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("heartbeat", 30, 100).unwrap();
        sched.remove_task("heartbeat").unwrap();
        assert!(sched.take_due(200).is_empty());
        assert_eq!(sched.next_deadline_in(200), None);
    }

    #[test]
    fn has_task_reports_registration_state() {
        let mut sched = PeriodicScheduler::new();
        assert!(!sched.has_task("heartbeat"));
        sched.register_task("heartbeat", 30, 100).unwrap();
        assert!(sched.has_task("heartbeat"));
        sched.remove_task("heartbeat").unwrap();
        assert!(!sched.has_task("heartbeat"));
    }

    #[test]
    fn inspect_reports_schema_and_sorted_tasks() {
        let mut sched = PeriodicScheduler::new();
        sched.register_task("zeta", 30, 150).unwrap();
        sched.register_task("alpha", 60, 200).unwrap();
        let snapshot = sched.inspect();
        assert_eq!(
            snapshot.schema_version,
            PERIODIC_TICK_SCHEDULER_SCHEMA_VERSION
        );
        assert_eq!(
            snapshot.tasks,
            vec![
                PeriodicTaskSnapshot {
                    name: "alpha".to_string(),
                    interval_seconds: 60,
                    next_due_at: 200,
                },
                PeriodicTaskSnapshot {
                    name: "zeta".to_string(),
                    interval_seconds: 30,
                    next_due_at: 150,
                },
            ]
        );
    }

    #[test]
    fn inspect_empty_scheduler_has_no_tasks() {
        let sched = PeriodicScheduler::new();
        let snapshot = sched.inspect();
        assert_eq!(
            snapshot.schema_version,
            PERIODIC_TICK_SCHEDULER_SCHEMA_VERSION
        );
        assert!(snapshot.tasks.is_empty());
    }
}
