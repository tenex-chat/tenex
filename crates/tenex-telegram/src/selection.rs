use crate::discovery::ProjectRoute;

pub fn parse_project_selection(input: &str, projects: &[ProjectRoute]) -> Option<ProjectRoute> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(selection) = trimmed.parse::<usize>() {
        if (1..=projects.len()).contains(&selection) {
            return projects.get(selection - 1).cloned();
        }
    }

    let normalized = trimmed.to_lowercase();
    projects
        .iter()
        .find(|project| {
            project.project_id.to_lowercase() == normalized
                || project
                    .title
                    .as_deref()
                    .is_some_and(|title| title.to_lowercase() == normalized)
        })
        .cloned()
}

pub fn project_selection_prompt(projects: &[ProjectRoute], is_reminder: bool) -> String {
    let mut lines = vec![
        if is_reminder {
            "I still need to know which project this chat should be bound to.".to_string()
        } else {
            "This chat is not bound to a project yet.".to_string()
        },
        "Reply with one of these numbers:".to_string(),
    ];
    for (index, project) in projects.iter().enumerate() {
        lines.push(format!(
            "{}. {} ({})",
            index + 1,
            project.display_title(),
            project.project_id
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(id: &str, title: Option<&str>) -> ProjectRoute {
        ProjectRoute {
            project_id: id.to_string(),
            title: title.map(str::to_string),
            owner_pubkey: None,
        }
    }

    #[test]
    fn parses_numeric_project_selection() {
        let projects = vec![route("one", Some("One")), route("two", Some("Two"))];

        assert_eq!(
            parse_project_selection("2", &projects).unwrap().project_id,
            "two"
        );
    }

    #[test]
    fn parses_project_id_or_title_selection() {
        let projects = vec![route("project-one", Some("Project One"))];

        assert_eq!(
            parse_project_selection("project-one", &projects)
                .unwrap()
                .project_id,
            "project-one"
        );
        assert_eq!(
            parse_project_selection("project one", &projects)
                .unwrap()
                .project_id,
            "project-one"
        );
    }
}
