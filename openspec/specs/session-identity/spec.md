# session-identity Specification

## Purpose
Defines the session identity format used for the title bar, footer status bar, and intercom addendum.

## Requirements
### Requirement: Canonical session identity format

The session identity string — used for the title bar (via `pi.setSessionName`), the footer status bar (via `ctx.ui.setStatus`), and the intercom addendum (via `pi.getSessionName`) — SHALL be just the active role's `name` field.

No intent generation, no placeholder, no summarization.

#### Scenario: Footer shows role name
- **WHEN** a session starts with role `architect`
- **THEN** the footer status shows `"Pi-role: architect"`

#### Scenario: Session name is role name
- **WHEN** a session starts with role `planner`
- **THEN** `pi.setSessionName` is called with `"planner"`

#### Scenario: Intercom addendum receives role name
- **WHEN** `composeSystemPrompt` runs on any turn with role `architect` and intercom mode `both`
- **THEN** the intercom addendum embeds the session name `"architect"`
