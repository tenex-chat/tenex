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
