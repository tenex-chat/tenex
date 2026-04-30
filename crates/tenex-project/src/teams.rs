use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

use crate::normalize_project_id;

/// A resolved team entry — members always includes team_lead.
#[derive(Debug, Clone)]
pub struct Team {
    pub name: String,
    pub description: String,
    pub team_lead: String,
    pub members: Vec<String>,
}

#[derive(Deserialize)]
struct TeamDefinition {
    description: String,
    #[serde(rename = "teamLead")]
    team_lead: String,
    members: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct TeamsFile {
    teams: HashMap<String, TeamDefinition>,
}

/// Load teams from `{base_dir}/teams.json` (global) merged with
/// `{base_dir}/projects/{project_id}/teams.json` (project-specific).
/// Project-specific entries override global ones with the same name.
pub fn load_teams(base_dir: &Path, project_id: Option<&str>) -> Vec<Team> {
    let mut map: HashMap<String, Team> = HashMap::new();

    insert_teams_file(&mut map, base_dir.join("teams.json"));

    if let Some(id) = project_id {
        match normalize_project_id(id) {
            Ok(d_tag) => insert_teams_file(
                &mut map,
                base_dir
                    .join("projects")
                    .join(d_tag.as_str())
                    .join("teams.json"),
            ),
            Err(err) => tracing::warn!(project_id = id, error = %err, "skipping project teams"),
        }
    }

    let mut teams: Vec<Team> = map.into_values().collect();
    teams.sort_by(|a, b| a.name.cmp(&b.name));
    teams
}

fn insert_teams_file(map: &mut HashMap<String, Team>, path: impl AsRef<Path>) {
    let path = path.as_ref();
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to read teams file");
            return;
        }
    };
    let file = match serde_json::from_str::<TeamsFile>(&content) {
        Ok(file) => file,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to parse teams file");
            return;
        }
    };

    for (name, def) in file.teams {
        map.insert(name.clone(), normalize(name, def));
    }
}

fn normalize(name: String, def: TeamDefinition) -> Team {
    let mut members = def.members.unwrap_or_default();
    members.retain(|m| !m.trim().is_empty());
    if !members.contains(&def.team_lead) {
        members.insert(0, def.team_lead.clone());
    }
    Team {
        name,
        description: def.description,
        team_lead: def.team_lead,
        members,
    }
}

/// Returns references to teams whose members list contains `agent_slug`.
pub fn teams_for_agent<'a>(teams: &'a [Team], agent_slug: &str) -> Vec<&'a Team> {
    teams
        .iter()
        .filter(|t| t.members.iter().any(|m| m == agent_slug))
        .collect()
}

/// Render the `<teams-context>` system-prompt fragment.
///
/// `member_teams` — teams the agent belongs to (from [`teams_for_agent`]).
/// `active_team`  — team name from the inbound event's `["team", ...]` tag.
///
/// Mirrors the TypeScript renderer at
/// `src/prompts/fragments/teams-context/index.ts`.
pub fn render_teams_context(member_teams: &[&Team], active_team: Option<&str>) -> String {
    if member_teams.is_empty() && active_team.is_none() {
        return String::new();
    }

    let mut lines = vec!["<teams-context>".to_string()];

    if !member_teams.is_empty() {
        let names: Vec<&str> = member_teams.iter().map(|t| t.name.as_str()).collect();
        lines.push(format!("  You belong to teams: {}", names.join(", ")));
        lines.push("  Team members:".to_string());
        for team in member_teams {
            let label = if active_team.is_some_and(|a| a.eq_ignore_ascii_case(&team.name)) {
                format!("{} (active)", team.name)
            } else {
                team.name.clone()
            };
            lines.push(format!(
                "    {}: lead={}, members={}",
                label,
                team.team_lead,
                team.members.join(", ")
            ));
        }
    }

    if let Some(active) = active_team {
        if !member_teams
            .iter()
            .any(|t| t.name.eq_ignore_ascii_case(active))
        {
            lines.push(format!("  You are operating in team scope: {active}"));
        }
    }

    lines.push("</teams-context>".to_string());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER_PK: &str = "c506be742732723deaaf8260d2b43d75d33420c601c05a9e1fa3b7986cc1b957";

    fn write_teams(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn project_coordinate_loads_project_specific_teams() {
        let tmp = tempfile::tempdir().unwrap();
        write_teams(
            &tmp.path().join("projects/my-project/teams.json"),
            r#"{"teams":{"Core":{"description":"Project team","teamLead":"lead","members":["worker"]}}}"#,
        );

        let teams = load_teams(tmp.path(), Some(&format!("31933:{OWNER_PK}:my-project")));

        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].name, "Core");
        assert_eq!(teams[0].members, vec!["lead", "worker"]);
    }

    #[test]
    fn project_teams_override_global_teams() {
        let tmp = tempfile::tempdir().unwrap();
        write_teams(
            &tmp.path().join("teams.json"),
            r#"{"teams":{"Core":{"description":"Global","teamLead":"global-lead","members":[]}}}"#,
        );
        write_teams(
            &tmp.path().join("projects/my-project/teams.json"),
            r#"{"teams":{"Core":{"description":"Project","teamLead":"project-lead","members":["worker"]}}}"#,
        );

        let teams = load_teams(tmp.path(), Some("my-project"));

        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].description, "Project");
        assert_eq!(teams[0].members, vec!["project-lead", "worker"]);
    }
}
