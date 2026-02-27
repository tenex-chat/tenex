# OpenClaw Onboarding Detection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect an existing OpenClaw installation during TENEX macOS onboarding and offer to import its provider credentials, model config, and agent.

**Architecture:** Three tasks: (1) a pure Swift data-parsing layer (`OpenClawDetector.swift`), (2) a SwiftUI view for the import step (`OpenClawImportView.swift`), and (3) wiring both into the existing `OnboardingView.swift` by adding a new `openclawImport` onboarding step.

**Tech Stack:** Swift 5.9, SwiftUI, Foundation (JSONDecoder, Process)

---

## Background

### OpenClaw file layout

```
~/.openclaw/
├── openclaw.json                              ← main config (agents.defaults.model.primary)
└── agents/
    └── main/
        └── agent/
            └── auth-profiles.json             ← provider credentials
```

`auth-profiles.json` format:
```json
{
  "profiles": {
    "anthropic:default": {
      "type": "token",
      "provider": "anthropic",
      "token": "sk-ant-oat01-..."
    }
  }
}
```

Credential extraction rule by `type`:
- `"token"` → `token` field
- `"api_key"` → `key` field
- `"oauth"` → `access` field

### Model format conversion

OpenClaw: `anthropic/claude-sonnet-4-6`
TENEX: `anthropic:claude-sonnet-4-6`

Replace **only the first slash** with a colon.

### New onboarding step placement

Original flow: `identity → relay → providers → llms → mobileSetup`

New flow (when OpenClaw detected):
`identity → openclawImport → relay → providers → llms → mobileSetup`

The `openclawImport` step is only inserted when OpenClaw is detected. The step is skipped automatically when not detected (Back from relay goes to identity, as before).

### Import actions on "Import & Continue"

1. Write each credential to `store.providers.providers[provider] = ProviderEntry(apiKey: key)` then `store.saveProviders()`
2. Call existing `seedDefaultLLMConfigs()` to generate LLM presets from the now-populated providers
3. Launch `tenex agent import openclaw` as a fire-and-forget background subprocess (it runs asynchronously; onboarding continues immediately)

The agent import subprocess continues independently after onboarding completes. No blocking.

### Tenex binary resolution (for subprocess)

Same lookup order as `DaemonManager.daemonExecutable`, but use `["agent", "import", "openclaw"]` as the subcommand instead of `["daemon"]`:

```
1. Bundle.main.path(forResource: "tenex-daemon")  → ["agent", "import", "openclaw"]
2. <repoRoot>/deps/backend/dist/tenex-daemon       → ["agent", "import", "openclaw"]
3. bun run <repoRoot>/deps/backend/src/index.ts    → ["agent", "import", "openclaw"]
```

`bundlePath` helper (same as DaemonManager):
```swift
private func bundlePath(_ relative: String) -> String {
    if let repoRoot = Bundle.main.infoDictionary?["TenexRepoRoot"] as? String {
        return (repoRoot as NSString).appendingPathComponent(relative)
    }
    return (Bundle.main.resourcePath! as NSString).appendingPathComponent(relative)
}
```

---

## Task 1: Create OpenClawDetector.swift

**Files:**
- Create: `tenex-chat-package/Sources/TenexLauncher/OpenClawDetector.swift`

### Step 1: Write OpenClawDetector.swift

```swift
import Foundation

struct OpenClawCredential {
    let provider: String   // e.g. "anthropic"
    let apiKey: String     // e.g. "sk-ant-oat01-..."
}

struct OpenClawDetected {
    let stateDir: URL
    let credentials: [OpenClawCredential]
    let primaryModel: String?  // TENEX format, e.g. "anthropic:claude-sonnet-4-6"
}

struct OpenClawDetector {

    static func detect() -> OpenClawDetected? {
        guard let stateDir = findStateDir() else { return nil }
        return OpenClawDetected(
            stateDir: stateDir,
            credentials: readCredentials(stateDir: stateDir),
            primaryModel: readPrimaryModel(stateDir: stateDir)
        )
    }

    // MARK: - Private

    private static let configNames = ["openclaw.json", "clawdbot.json", "moldbot.json", "moltbot.json"]

    private static func findStateDir() -> URL? {
        if let envPath = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"] {
            let url = URL(fileURLWithPath: envPath)
            if hasConfig(url) { return url }
        }

        let home = URL(fileURLWithPath: NSHomeDirectory())
        for name in [".openclaw", ".clawdbot", ".moldbot", ".moltbot"] {
            let candidate = home.appendingPathComponent(name)
            if hasConfig(candidate) { return candidate }
        }

        return nil
    }

    private static func hasConfig(_ dir: URL) -> Bool {
        configNames.contains {
            FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path)
        }
    }

    private static func readCredentials(stateDir: URL) -> [OpenClawCredential] {
        let url = stateDir.appendingPathComponent("agents/main/agent/auth-profiles.json")
        guard let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(AuthProfilesFile.self, from: data)
        else { return [] }

        var credentials: [OpenClawCredential] = []
        for (_, profile) in file.profiles {
            let key: String?
            switch profile.type {
            case "token":   key = profile.token
            case "api_key": key = profile.key
            case "oauth":   key = profile.access
            default:        key = nil
            }
            guard let apiKey = key, !apiKey.isEmpty else { continue }
            // One credential per provider (take the first)
            guard !credentials.contains(where: { $0.provider == profile.provider }) else { continue }
            credentials.append(OpenClawCredential(provider: profile.provider, apiKey: apiKey))
        }
        return credentials
    }

    private static func readPrimaryModel(stateDir: URL) -> String? {
        for name in configNames {
            let url = stateDir.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url),
                  let config = try? JSONDecoder().decode(OpenClawConfig.self, from: data),
                  let raw = config.agents?.defaults?.model?.primary
            else { continue }
            return convertModelFormat(raw)
        }
        return nil
    }

    static func convertModelFormat(_ model: String) -> String {
        guard let idx = model.firstIndex(of: "/") else { return model }
        var result = model
        result.replaceSubrange(idx...idx, with: ":")
        return result
    }
}

// MARK: - Decodable helpers (file-private)

private struct AuthProfilesFile: Decodable {
    let profiles: [String: AuthProfile]
}

private struct AuthProfile: Decodable {
    let type: String
    let provider: String
    var token: String?
    var key: String?
    var access: String?
}

private struct OpenClawConfig: Decodable {
    let agents: AgentsSection?
    struct AgentsSection: Decodable {
        let defaults: DefaultsSection?
        struct DefaultsSection: Decodable {
            let model: ModelSection?
            struct ModelSection: Decodable {
                let primary: String?
            }
        }
    }
}
```

### Step 2: Verify it compiles

```bash
cd /Users/pablofernandez/Work/tenex-chat-package
xcodebuild -project TenexLauncher.xcodeproj -scheme TenexLauncher build 2>&1 | tail -20
```

If the project uses Tuist, run:
```bash
tuist generate && xcodebuild -workspace TenexLauncher.xcworkspace -scheme TenexLauncher build 2>&1 | tail -20
```

Expected: no errors (new file adds structs, doesn't change existing code).

### Step 3: Commit

```bash
git -C /Users/pablofernandez/Work/tenex-chat-package add Sources/TenexLauncher/OpenClawDetector.swift
git -C /Users/pablofernandez/Work/tenex-chat-package commit -m "feat(onboarding): add OpenClawDetector for state dir and credential parsing"
```

---

## Task 2: Create OpenClawImportView.swift

**Files:**
- Create: `tenex-chat-package/Sources/TenexLauncher/OpenClawImportView.swift`

This is a pure display view. All actions are callbacks.

### Step 1: Write OpenClawImportView.swift

```swift
import SwiftUI

struct OpenClawImportView: View {
    let detected: OpenClawDetected

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 14) {
                    Image(systemName: "square.and.arrow.down.on.square.fill")
                        .font(.system(size: 36))
                        .foregroundStyle(.accent)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("OpenClaw Installation Found")
                            .font(.headline)
                        Text("Import your existing configuration to skip manual setup.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if !detected.credentials.isEmpty {
                    importCard(
                        icon: "key.fill",
                        title: "Provider Credentials",
                        items: detected.credentials.map { credentialLabel($0) }
                    )
                }

                if let model = detected.primaryModel {
                    importCard(
                        icon: "cpu",
                        title: "Model Configuration",
                        items: [model]
                    )
                }

                importCard(
                    icon: "person.fill",
                    title: "Agent",
                    items: ["Your OpenClaw agent will be imported in the background"]
                )

                Text("You can review and adjust everything on the next screens.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(24)
        }
    }

    private func credentialLabel(_ c: OpenClawCredential) -> String {
        "\(c.provider.prefix(1).uppercased() + c.provider.dropFirst()) API key"
    }

    private func importCard(icon: String, title: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: icon)
                .font(.subheadline.weight(.semibold))

            ForEach(items, id: \.self) { item in
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.caption)
                    Text(item)
                        .font(.body)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(.background.secondary))
    }
}
```

### Step 2: Verify it compiles (same build command as Task 1)

### Step 3: Commit

```bash
git -C /Users/pablofernandez/Work/tenex-chat-package add Sources/TenexLauncher/OpenClawImportView.swift
git -C /Users/pablofernandez/Work/tenex-chat-package commit -m "feat(onboarding): add OpenClawImportView for import step UI"
```

---

## Task 3: Wire OpenClaw into OnboardingView.swift

**Files:**
- Modify: `tenex-chat-package/Sources/TenexLauncher/OnboardingView.swift`

### Step 1: Add `openclawImport` to `OnboardingStep` enum

Find:
```swift
    enum OnboardingStep {
        case identity
        case relay
        case providers
        case llms
        case mobileSetup
    }
```

Replace with:
```swift
    enum OnboardingStep {
        case identity
        case openclawImport
        case relay
        case providers
        case llms
        case mobileSetup
    }
```

### Step 2: Add state variables for OpenClaw detection and agent import

After the existing relay state variables (around line 48), add:

```swift
    // OpenClaw import state
    @State private var openClawDetected: OpenClawDetected? = nil
    @State private var agentImportRunning = false
```

### Step 3: Update `headerSubtitle` computed property

Add the new case before `.relay`:

```swift
        case .openclawImport:
            "Import your existing OpenClaw configuration."
```

### Step 4: Update the content switch in `body`

In the `Group { switch step { ... } }` block, add the new case before `.relay`:

```swift
                case .openclawImport:
                    if let detected = openClawDetected {
                        OpenClawImportView(detected: detected)
                    }
```

### Step 5: Update Back button navigation

In the `Button("Back") { switch step { ... } }` block:

Change:
```swift
                        case .relay: step = .identity
```

Replace with:
```swift
                        case .relay: step = openClawDetected != nil ? .openclawImport : .identity
                        case .openclawImport: step = .identity
```

### Step 6: Update Continue/action buttons

In the `switch step { ... }` navigation section, add the `.openclawImport` case before `.relay`:

```swift
                case .openclawImport:
                    Button("Skip") {
                        step = .relay
                    }
                    .buttonStyle(.bordered)

                    Button("Import & Continue") {
                        applyOpenClawImport()
                        step = .relay
                    }
                    .keyboardShortcut(.defaultAction)
```

### Step 7: Update identity Continue button

Change:
```swift
                    if identityCompleted {
                        Button("Continue") {
                            step = .relay
                        }
```

Replace with:
```swift
                    if identityCompleted {
                        Button("Continue") {
                            step = openClawDetected != nil ? .openclawImport : .relay
                        }
```

### Step 8: Add `onAppear` detection

Add inside the `.onAppear { ... }` block (after the window sizing code):

```swift
            DispatchQueue.global(qos: .userInitiated).async {
                let detected = OpenClawDetector.detect()
                DispatchQueue.main.async {
                    openClawDetected = detected
                }
            }
```

### Step 9: Add `applyOpenClawImport()` helper method

Add after `saveRelayConfig()` (around line 536):

```swift
    // MARK: - OpenClaw Import

    private func applyOpenClawImport() {
        guard let detected = openClawDetected else { return }

        // Write credentials
        for credential in detected.credentials {
            store.providers.providers[credential.provider] = ProviderEntry(apiKey: credential.apiKey)
        }
        store.saveProviders()

        // Seed LLM configs from newly added providers (reuses existing logic)
        seedDefaultLLMConfigs()

        // Launch agent import in background (fire and forget)
        agentImportRunning = true
        Task.detached {
            await runOpenClawAgentImport()
            await MainActor.run { agentImportRunning = false }
        }
    }

    private func runOpenClawAgentImport() async {
        guard let (executable, arguments) = resolveAgentImportExecutable() else { return }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = Pipe()
        process.standardError = Pipe()

        var env = ProcessInfo.processInfo.environment
        let nodeModulesBin = bundlePath("deps/backend/node_modules/.bin")
        env["PATH"] = "\(nodeModulesBin):\(env["PATH"] ?? "")"
        process.environment = env
        process.currentDirectoryURL = URL(fileURLWithPath: bundlePath("deps/backend"))

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            process.terminationHandler = { _ in continuation.resume() }
            do {
                try process.run()
            } catch {
                continuation.resume()
            }
        }
    }

    private func resolveAgentImportExecutable() -> (path: String, arguments: [String])? {
        let subcommand = ["agent", "import", "openclaw"]

        if let bundled = Bundle.main.path(forResource: "tenex-daemon", ofType: nil) {
            return (bundled, subcommand)
        }

        let depsCompiled = bundlePath("deps/backend/dist/tenex-daemon")
        if FileManager.default.fileExists(atPath: depsCompiled) {
            return (depsCompiled, subcommand)
        }

        if let bun = findBun() {
            let entrypoint = bundlePath("deps/backend/src/index.ts")
            if FileManager.default.fileExists(atPath: entrypoint) {
                return (bun, ["run", entrypoint] + subcommand)
            }
        }

        return nil
    }

    private func bundlePath(_ relative: String) -> String {
        if let repoRoot = Bundle.main.infoDictionary?["TenexRepoRoot"] as? String {
            return (repoRoot as NSString).appendingPathComponent(relative)
        }
        return (Bundle.main.resourcePath! as NSString).appendingPathComponent(relative)
    }

    private func findBun() -> String? {
        let candidates = [
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
            "\(NSHomeDirectory())/.bun/bin/bun",
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0) }
    }
```

### Step 10: Build and verify

```bash
# If Tuist project:
cd /Users/pablofernandez/Work/tenex-chat-package
tuist generate
xcodebuild -workspace TenexLauncher.xcworkspace -scheme TenexLauncher build 2>&1 | grep -E "(error:|warning:|BUILD)"
```

Expected: BUILD SUCCEEDED, no errors.

### Step 11: Commit

```bash
git -C /Users/pablofernandez/Work/tenex-chat-package add Sources/TenexLauncher/OnboardingView.swift
git -C /Users/pablofernandez/Work/tenex-chat-package commit -m "feat(onboarding): detect OpenClaw installation and offer import during setup"
```

---

## Verification Checklist

- [ ] `OpenClawDetector.detect()` returns `nil` when `~/.openclaw/` does not exist
- [ ] `OpenClawDetector.detect()` returns credentials and model when `~/.openclaw/` exists with `auth-profiles.json` and `openclaw.json`
- [ ] `convertModelFormat("anthropic/claude-sonnet-4-6")` returns `"anthropic:claude-sonnet-4-6"`
- [ ] `convertModelFormat("openrouter/google/gemini-2.0-flash")` returns `"openrouter:google/gemini-2.0-flash"` (only first slash converted)
- [ ] Onboarding flow without OpenClaw: `identity → relay → providers → llms → mobileSetup` (unchanged)
- [ ] Onboarding flow with OpenClaw: `identity → openclawImport → relay → providers → llms → mobileSetup`
- [ ] Back from relay goes to `openclawImport` if detected, to `identity` if not
- [ ] "Skip" in `openclawImport` step advances to relay without writing credentials
- [ ] "Import & Continue" writes `store.providers` and calls `seedDefaultLLMConfigs()`
- [ ] Agent import subprocess is launched in background (non-blocking)
- [ ] Build succeeds with no errors or new warnings
