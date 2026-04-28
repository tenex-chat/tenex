//! [`Project`] — the typed, file-backed handle.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::{Error, Result};
use crate::id::{normalize_project_id, ProjectDTag};
use crate::migrations;
use crate::models::{Agent, ProjectAgent, ProjectMetadata};
use crate::paths;
use crate::signer::{signer_for, Signer, SignerError};

/// Handle to a single project's SQLite file. Wraps a `rusqlite::Connection`.
pub struct Project {
    conn: Connection,
    d_tag: ProjectDTag,
    db_path: PathBuf,
}

impl Project {
    /// Open (or create) the project DB for `project_id` under `base_dir`.
    ///
    /// `project_id` may be a NIP-33 coordinate (`31933:<pubkey>:<dTag>`) or a
    /// bare dTag — both resolve to the same DB file.
    pub fn open(project_id: &str, base_dir: &Path) -> Result<Self> {
        let d_tag = normalize_project_id(project_id)?;
        let db_path = paths::project_db(base_dir, &d_tag);
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(&db_path)?;
        migrations::initialize(&mut conn)?;
        Ok(Self { conn, d_tag, db_path })
    }

    /// Open under [`paths::default_base_dir`].
    pub fn open_default(project_id: &str) -> Result<Self> {
        let base = paths::default_base_dir();
        Self::open(project_id, &base)
    }

    pub fn d_tag(&self) -> &ProjectDTag {
        &self.d_tag
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    // =========================================================================
    // Read API
    // =========================================================================

    pub fn metadata(&self) -> Result<Option<ProjectMetadata>> {
        let row = self
            .conn
            .query_row(
                "SELECT d_tag, owner_pubkey, title, repo_url, working_directory,
                        latest_event_id, ingested_at
                   FROM project WHERE id = 1",
                [],
                row_to_metadata,
            )
            .optional()?;
        Ok(row)
    }

    pub fn agents(&self) -> Result<Vec<Agent>> {
        let mut stmt = self.conn.prepare(AGENT_SELECT)?;
        let rows = stmt
            .query_map([], row_to_agent)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn project_agents(&self) -> Result<Vec<ProjectAgent>> {
        let mut stmt = self.conn.prepare(PROJECT_AGENT_SELECT)?;
        let rows = stmt
            .query_map([], row_to_project_agent)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn agent_by_pubkey(&self, pubkey: &str) -> Result<Option<Agent>> {
        let row = self
            .conn
            .query_row(
                &format!("{AGENT_SELECT} WHERE pubkey = ?1"),
                params![pubkey],
                row_to_agent,
            )
            .optional()?;
        Ok(row)
    }

    pub fn agent_by_slug(&self, slug: &str) -> Result<Option<Agent>> {
        let row = self
            .conn
            .query_row(
                &format!("{AGENT_SELECT} WHERE slug = ?1 LIMIT 1"),
                params![slug],
                row_to_agent,
            )
            .optional()?;
        Ok(row)
    }

    pub fn resolve_slug(&self, slug: &str) -> Result<Option<String>> {
        Ok(self.agent_by_slug(slug)?.map(|a| a.pubkey))
    }

    pub fn signer_for_agent(
        &self,
        pubkey: &str,
    ) -> Result<std::result::Result<Box<dyn Signer>, SignerError>> {
        let agent = self
            .agent_by_pubkey(pubkey)?
            .ok_or_else(|| Error::NotFound(format!("agent {pubkey}")))?;
        Ok(signer_for(&agent))
    }

    // =========================================================================
    // Write API
    // =========================================================================

    pub fn upsert_metadata(&self, m: &ProjectMetadata) -> Result<()> {
        self.conn.execute(
            "INSERT INTO project (id, d_tag, owner_pubkey, title, repo_url, working_directory,
                                  latest_event_id, ingested_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                 d_tag = excluded.d_tag,
                 owner_pubkey = excluded.owner_pubkey,
                 title = excluded.title,
                 repo_url = excluded.repo_url,
                 working_directory = COALESCE(excluded.working_directory, project.working_directory),
                 latest_event_id = excluded.latest_event_id,
                 ingested_at = excluded.ingested_at",
            params![
                m.d_tag,
                m.owner_pubkey,
                m.title,
                m.repo_url,
                m.working_directory,
                m.latest_event_id,
                m.ingested_at,
            ],
        )?;
        Ok(())
    }

    pub fn upsert_agent(&self, a: &Agent) -> Result<()> {
        self.conn.execute(
            "INSERT INTO agents (pubkey, slug, name, role, description, instructions, use_criteria,
                                 category, inferred_category, signer_ref, event_id, status,
                                 default_config_json, telegram_config_json, mcp_servers_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(pubkey) DO UPDATE SET
                 slug = excluded.slug,
                 name = excluded.name,
                 role = excluded.role,
                 description = excluded.description,
                 instructions = excluded.instructions,
                 use_criteria = excluded.use_criteria,
                 category = excluded.category,
                 inferred_category = excluded.inferred_category,
                 signer_ref = excluded.signer_ref,
                 event_id = COALESCE(excluded.event_id, agents.event_id),
                 status = excluded.status,
                 default_config_json = excluded.default_config_json,
                 telegram_config_json = excluded.telegram_config_json,
                 mcp_servers_json = excluded.mcp_servers_json",
            params![
                a.pubkey,
                a.slug,
                a.name,
                a.role,
                a.description,
                a.instructions,
                a.use_criteria,
                a.category,
                a.inferred_category,
                a.signer_ref,
                a.event_id,
                a.status,
                a.default_config_json,
                a.telegram_config_json,
                a.mcp_servers_json,
            ],
        )?;
        Ok(())
    }

    pub fn upsert_project_agent(&self, p: &ProjectAgent) -> Result<()> {
        self.conn.execute(
            "INSERT INTO project_agents (agent_pubkey, is_pm, intervention_enabled,
                                         escalation_target)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(agent_pubkey) DO UPDATE SET
                 is_pm = excluded.is_pm,
                 intervention_enabled = excluded.intervention_enabled,
                 escalation_target = excluded.escalation_target",
            params![
                p.agent_pubkey,
                p.is_pm as i64,
                p.intervention_enabled as i64,
                p.escalation_target,
            ],
        )?;
        Ok(())
    }

    pub fn remove_project_agent(&self, agent_pubkey: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM project_agents WHERE agent_pubkey = ?1",
            params![agent_pubkey],
        )?;
        Ok(())
    }

    // =========================================================================
    // Maintenance
    // =========================================================================

    pub fn vacuum(&self) -> Result<()> {
        self.conn.execute_batch("VACUUM")?;
        Ok(())
    }

    pub fn integrity_check(&self) -> Result<String> {
        let result: String = self
            .conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        Ok(result)
    }
}

const AGENT_SELECT: &str = "SELECT pubkey, slug, name, role, description, instructions,
                                   use_criteria, category, inferred_category, signer_ref,
                                   event_id, status, default_config_json, telegram_config_json,
                                   mcp_servers_json FROM agents";

const PROJECT_AGENT_SELECT: &str = "SELECT agent_pubkey, is_pm, intervention_enabled,
                                           escalation_target FROM project_agents";

fn row_to_metadata(r: &Row<'_>) -> rusqlite::Result<ProjectMetadata> {
    Ok(ProjectMetadata {
        d_tag: r.get(0)?,
        owner_pubkey: r.get(1)?,
        title: r.get(2)?,
        repo_url: r.get(3)?,
        working_directory: r.get(4)?,
        latest_event_id: r.get(5)?,
        ingested_at: r.get(6)?,
    })
}

fn row_to_agent(r: &Row<'_>) -> rusqlite::Result<Agent> {
    Ok(Agent {
        pubkey: r.get(0)?,
        slug: r.get(1)?,
        name: r.get(2)?,
        role: r.get(3)?,
        description: r.get(4)?,
        instructions: r.get(5)?,
        use_criteria: r.get(6)?,
        category: r.get(7)?,
        inferred_category: r.get(8)?,
        signer_ref: r.get(9)?,
        event_id: r.get(10)?,
        status: r.get(11)?,
        default_config_json: r.get(12)?,
        telegram_config_json: r.get(13)?,
        mcp_servers_json: r.get(14)?,
    })
}

fn row_to_project_agent(r: &Row<'_>) -> rusqlite::Result<ProjectAgent> {
    let is_pm: i64 = r.get(1)?;
    let intervention_enabled: i64 = r.get(2)?;
    Ok(ProjectAgent {
        agent_pubkey: r.get(0)?,
        is_pm: is_pm != 0,
        intervention_enabled: intervention_enabled != 0,
        escalation_target: r.get(3)?,
    })
}
