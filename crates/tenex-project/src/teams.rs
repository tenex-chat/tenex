use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

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

    let global_path = base_dir.join("teams.json");
    if let Ok(content) = std::fs::read_to_string(&global_path) {
        if let Ok(file) = serde_json::from_str::<TeamsFile>(&content) {
            for (name, def) in file.teams {
                map.insert(name.clone(), normalize(name, def));
            }
        }
    }

    if let Some(id) = project_id {
        let project_path = base_dir.join("projects").join(id).join("teams.json");
        if let Ok(content) = std::fs::read_to_string(&project_path) {
            if let Ok(file) = serde_json::from_str::<TeamsFile>(&content) {
                for (name, def) in file.teams {
                    map.insert(name.clone(), normalize(name, def));
                }
            }
        }
    }

    let mut teams: Vec<Team> = map.into_values().collect();
    teams.sort_by(|a, b| a.name.cmp(&b.name));
    teams
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
