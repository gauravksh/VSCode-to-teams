# Code Summary to Teams

Post single-line code-change summaries — taken from **git commits** and **Copilot chat history** — to a **Microsoft Teams channel** for a chosen window (last 1 hour, 1 day, 1 week, or custom).

- **Webhookless.** Uses Microsoft Graph with delegated auth (MSAL device-code).
- **Per-workspace channel mapping.** Each workspace can post to a different Teams channel.
- **No setup for end users.** The extension ships with a built-in multitenant Azure AD app; you just sign in with your work/school account.

---

## For end users

### Install

Install **Code Summary to Teams** from the VS Code Marketplace.

### First run

1. Command Palette → **`Code Summary: Sign in to Microsoft (Teams)`**.
   - A device code appears (and is auto-copied to clipboard). Open the link, paste the code, sign in with your **work or school** Microsoft account, and approve consent.
2. **`Code Summary: Pick Teams Channel for this Workspace`** → pick a Team, then a Channel. The mapping is saved per workspace.
3. **`Code Summary: Send to Teams`** → pick a window (1h / 6h / 1d / 3d / 1wk / custom hours).

> Personal Microsoft accounts (outlook.com / hotmail.com) **cannot** post Teams channel messages — Teams requires a work/school account.
>
> Your tenant admin may need to approve the extension the first time anyone in the org signs in (one-time consent for the four delegated Graph permissions listed below).

### Commands

| Command                                                | Description                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `Code Summary: Sign in to Microsoft (Teams)`           | Device-code sign-in. Tokens cached in VS Code SecretStorage.                   |
| `Code Summary: Sign out of Microsoft (Teams)`          | Clears cached tokens.                                                          |
| `Code Summary: Pick Teams Channel for this Workspace`  | Pick Team + Channel via Graph; stored in `workspaceState`.                     |
| `Code Summary: Clear Teams Channel for this Workspace` | Forget the saved channel for this workspace.                                   |
| `Code Summary: Send to Teams`                          | Collect commits + Copilot chat lines for the chosen window and post via Graph. |

### Settings

All settings are optional.

| Setting                                 | Default         | Purpose                                          |
| --------------------------------------- | --------------- | ------------------------------------------------ |
| `codeSummaryToTeams.includeCommits`     | `true`          | Include git commit subjects.                     |
| `codeSummaryToTeams.includeCopilotChat` | `true`          | Include Copilot chat prompts (best-effort).      |
| `codeSummaryToTeams.maxLines`           | `50`            | Max lines per Teams message.                     |
| `codeSummaryToTeams.aadClientId`        | _(bundled)_     | Advanced: override the bundled AAD app.          |
| `codeSummaryToTeams.aadTenantId`        | `organizations` | Advanced: restrict sign-in to a specific tenant. |

### How it works

- **Commits**: `git log --no-merges --since=<iso>` in the first workspace folder.
- **Copilot chat**: best-effort scan of `…/User/workspaceStorage/**/chat*.json`. Format is undocumented and may change between VS Code versions; if parsing fails, commits are still sent.
- **Posting**: `POST https://graph.microsoft.com/v1.0/teams/{teamId}/channels/{channelId}/messages` with an HTML body listing the lines.

### Privacy & security

- The extension is a **delegated** Graph client — it acts only as the signed-in user, with the four scopes below.
- Refresh tokens are stored in **VS Code SecretStorage** (OS keychain on macOS/Windows/Linux).
- Channel mapping (team/channel IDs) is stored in **`workspaceState`** (local).
- The extension calls only `login.microsoftonline.com` and `graph.microsoft.com`.

### Required Graph permissions (delegated)

- `User.Read`
- `Team.ReadBasic.All`
- `Channel.ReadBasic.All`
- `ChannelMessage.Send`

---

## For maintainers / publishers

This section is for whoever publishes the extension to the VS Code Marketplace.

### 1. Register the multitenant AAD app (once)

1. Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration**.
   - **Supported account types:** _Accounts in any organizational directory (multitenant)_.
   - **Redirect URI:** leave blank (device-code flow).
2. **Authentication** → set **Allow public client flows = Yes**. Save.
3. **API permissions** → Microsoft Graph → **Delegated**: add `User.Read`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Send`. Grant admin consent in your home tenant.
4. (Recommended) **Branding & properties** → set publisher domain, logo, terms-of-service URL, privacy-statement URL. Verify the publisher domain so other tenants' admins see a trusted publisher banner during consent.
5. Copy the **Application (client) ID**.

### 2. Bake the client ID into the extension

Open [src/auth.ts](src/auth.ts) and set:

```ts
const DEFAULT_CLIENT_ID = "<your-client-id-guid>";
const DEFAULT_TENANT_ID = "organizations"; // multitenant work/school
```

### 3. Marketplace metadata

In [package.json](package.json) replace:

- `publisher` → your Marketplace publisher name (create one at https://marketplace.visualstudio.com/manage).
- `repository.url` → your public repo URL.

Also add an `icon` (`128x128` PNG) and bump `version` for each release.

### 4. Build & publish

```bash
npm install
npm run compile
npm run package         # produces a .vsix you can side-load to test
npm run publish         # publishes to the Marketplace (requires `vsce login <publisher>`)
```

Get a Personal Access Token from Azure DevOps for `vsce login` per the official docs: https://code.visualstudio.com/api/working-with-extensions/publishing-extension

### 5. Tenant-admin consent UX

The first time a user from a new tenant signs in, they'll see a Microsoft consent screen for the four delegated scopes. If your tenant admin has disabled user consent, an admin must approve once — they can use the admin-consent URL:

```
https://login.microsoftonline.com/{tenantId}/adminconsent?client_id={yourClientId}
```

Publishing a verified publisher domain reduces friction here.

---

## Limitations

- Only the **first** workspace folder's git history is scanned.
- Posting to **shared** channels (`membershipType: shared`) may have additional tenant restrictions.
- Copilot chat extraction is best-effort against an internal VS Code on-disk format.
