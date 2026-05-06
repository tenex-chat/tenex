---
name: report
description: Publish reports to Nostr — either NIP-23 long-form markdown articles (kind:30023) via report_publish, or rich HTML reports via html_publish
tools:
  - report_publish
  - html_publish
---

## html_publish — Rich HTML Reports

Use `html_publish` to create and publish a visual HTML report that appears in the client's Reports tab.

### Single file
```
html_publish(
  title="Q1 Performance Summary",
  description="One-line description shown in the report list",
  path="$AGENT_HOME/report.html",
  slug="q1-performance-summary"
)
```

### Multi-file bundle (directory)
The directory **must** contain `index.html`. All files are zipped and uploaded together.
```
html_publish(
  title="Dashboard",
  description="Interactive project dashboard",
  path="$AGENT_HOME/dashboard/",
  slug="dashboard"
)
```

### Relative links work
Within a bundle, relative links between files work correctly in the viewer:
- `<a href="details.html">` → navigates to `details.html` in the same bundle
- `<link rel="stylesheet" href="style.css">` → loads `style.css` from the bundle
- `<script src="chart.js">` → loads `chart.js` from the bundle
- `<img src="images/logo.png">` → loads image from the bundle

### Guidelines
- Always include `<meta charset="UTF-8">` and `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
- Self-contained HTML with inline CSS is simplest; external CDN resources (e.g. Chart.js from a CDN URL) also work since the viewer allows network access
- Avoid absolute `file://` paths — use relative paths for all intra-bundle references
- The `description` is shown as the subtitle in the report list — keep it to one sentence
- `slug` is a stable identifier emitted as a `["d", <slug>]` tag — re-publishing with the same slug replaces the prior version, so use a fresh slug per distinct report and reuse the same slug to update one
