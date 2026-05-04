use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::error::Result;
use crate::model::IdentityView;
use crate::paths::default_db_path;
use crate::schema::{configure_connection, migrate};

/// TTL for cached identity rows. Rows older than this are considered stale.
const CACHE_TTL_SECS: i64 = 24 * 60 * 60;

pub(crate) fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Host-wide SQLite-backed identity cache.
///
/// The inner `Connection` is guarded by a `Mutex` so that the cache can be
/// shared across multiple tokio tasks via `Arc<IdentityCache>`.
pub struct IdentityCache {
    conn: Mutex<Connection>,
}

impl IdentityCache {
    /// Open (or create) the cache at the given path.
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(db_path)?;
        configure_connection(&conn)?;
        migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open the default host-wide cache at `~/.tenex/identity-cache.db`.
    pub fn open_default() -> Result<Self> {
        Self::open(&default_db_path())
    }

    /// Returns the cached row only if it is fresh (fetched within 24 h).
    /// Returns `None` if the pubkey is absent or if the row is stale.
    pub fn get_cached(&self, pubkey: &str) -> Result<Option<IdentityView>> {
        let threshold = now_secs() - CACHE_TTL_SECS;
        let conn = self.conn.lock().expect("identity cache mutex poisoned");
        let result = conn.query_row(
            "SELECT pubkey, display_name, name, nip05, picture, banner,
                    about, lud16, slug, use_criteria, event_id, created_at, fetched_at
               FROM identities
              WHERE pubkey = ?1 AND fetched_at >= ?2",
            params![pubkey, threshold],
            row_to_view,
        );
        match result {
            Ok(view) => Ok(Some(view)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Returns the cached row regardless of staleness (used for stale-while-revalidate).
    /// Returns `None` only when the pubkey is absent entirely.
    pub fn get_any(&self, pubkey: &str) -> Result<Option<IdentityView>> {
        let conn = self.conn.lock().expect("identity cache mutex poisoned");
        let result = conn.query_row(
            "SELECT pubkey, display_name, name, nip05, picture, banner,
                    about, lud16, slug, use_criteria, event_id, created_at, fetched_at
               FROM identities
              WHERE pubkey = ?1",
            params![pubkey],
            row_to_view,
        );
        match result {
            Ok(view) => Ok(Some(view)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Upsert an identity row. `view.fetched_at` is used as-is; callers are
    /// responsible for setting it to the current time when inserting fresh data.
    pub fn upsert(&self, view: &IdentityView) -> Result<()> {
        let conn = self.conn.lock().expect("identity cache mutex poisoned");
        conn.execute(
            "INSERT INTO identities
                (pubkey, display_name, name, nip05, picture, banner,
                 about, lud16, slug, use_criteria, event_id, created_at, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(pubkey) DO UPDATE SET
                display_name = excluded.display_name,
                name         = excluded.name,
                nip05        = excluded.nip05,
                picture      = excluded.picture,
                banner       = excluded.banner,
                about        = excluded.about,
                lud16        = excluded.lud16,
                slug         = excluded.slug,
                use_criteria = excluded.use_criteria,
                event_id     = excluded.event_id,
                created_at   = excluded.created_at,
                fetched_at   = excluded.fetched_at",
            params![
                view.pubkey,
                view.display_name,
                view.name,
                view.nip05,
                view.picture,
                view.banner,
                view.about,
                view.lud16,
                view.slug,
                view.use_criteria,
                view.event_id,
                view.created_at,
                view.fetched_at,
            ],
        )?;
        Ok(())
    }

    /// Returns the total number of cached rows.
    pub fn count(&self) -> Result<i64> {
        let conn = self.conn.lock().expect("identity cache mutex poisoned");
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM identities", [], |r| r.get(0))?;
        Ok(n)
    }

    /// Returns `true` if the row's `fetched_at` is older than 24 h.
    pub fn is_stale(&self, view: &IdentityView) -> bool {
        now_secs() - view.fetched_at > CACHE_TTL_SECS
    }
}

fn row_to_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<IdentityView> {
    Ok(IdentityView {
        pubkey: row.get(0)?,
        display_name: row.get(1)?,
        name: row.get(2)?,
        nip05: row.get(3)?,
        picture: row.get(4)?,
        banner: row.get(5)?,
        about: row.get(6)?,
        lud16: row.get(7)?,
        slug: row.get(8)?,
        use_criteria: row.get(9)?,
        event_id: row.get(10)?,
        created_at: row.get(11)?,
        fetched_at: row.get(12)?,
    })
}
