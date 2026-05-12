import * as vscode from "vscode";
import * as path from "path";
import { getCommitsSince } from "./git";
import { getCopilotChatSummariesSince } from "./copilot";
import { AuthService } from "./auth";
import { listChannels, listJoinedTeams, postChannelMessage } from "./graph";

const CHANNEL_KEY = "codeSummaryToTeams.channel";

interface ChannelMapping {
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
}

let auth: AuthService;

export function activate(context: vscode.ExtensionContext): void {
  auth = new AuthService(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("codeSummaryToTeams.signIn", async () => {
      try {
        await auth.signInInteractive();
        vscode.window.showInformationMessage("Signed in to Microsoft.");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Sign-in failed: ${e.message || e}`);
      }
    }),
    vscode.commands.registerCommand("codeSummaryToTeams.signOut", async () => {
      await auth.signOut();
      vscode.window.showInformationMessage("Signed out of Microsoft.");
    }),
    vscode.commands.registerCommand("codeSummaryToTeams.pickChannel", () =>
      pickChannel(context),
    ),
    vscode.commands.registerCommand(
      "codeSummaryToTeams.clearChannel",
      async () => {
        await context.workspaceState.update(CHANNEL_KEY, undefined);
        vscode.window.showInformationMessage(
          "Teams channel cleared for this workspace.",
        );
      },
    ),
    vscode.commands.registerCommand("codeSummaryToTeams.send", () =>
      sendSummary(context),
    ),
  );
}

export function deactivate(): void {
  // nothing
}

async function pickChannel(
  context: vscode.ExtensionContext,
): Promise<ChannelMapping | undefined> {
  let token: string;
  try {
    token = await auth.getAccessToken();
  } catch (e: any) {
    vscode.window.showErrorMessage(`Auth required: ${e.message || e}`);
    return;
  }

  const teams = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading your Teams…",
    },
    () => listJoinedTeams(token),
  );
  if (!teams.length) {
    vscode.window.showWarningMessage("No joined Teams found for this account.");
    return;
  }
  const teamPick = await vscode.window.showQuickPick(
    teams.map((t) => ({ label: t.displayName, description: t.id, team: t })),
    {
      title: "Select a Team",
      placeHolder: "Pick the team containing your channel",
    },
  );
  if (!teamPick) {
    return;
  }

  const channels = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading channels…",
    },
    () => listChannels(token, teamPick.team.id),
  );
  if (!channels.length) {
    vscode.window.showWarningMessage("No channels visible in that team.");
    return;
  }
  const channelPick = await vscode.window.showQuickPick(
    channels.map((c) => ({
      label: c.displayName,
      description: c.membershipType || "",
      detail: c.id,
      channel: c,
    })),
    { title: `Select a channel in "${teamPick.team.displayName}"` },
  );
  if (!channelPick) {
    return;
  }

  const mapping: ChannelMapping = {
    teamId: teamPick.team.id,
    teamName: teamPick.team.displayName,
    channelId: channelPick.channel.id,
    channelName: channelPick.channel.displayName,
  };
  await context.workspaceState.update(CHANNEL_KEY, mapping);
  vscode.window.showInformationMessage(
    `Mapped this workspace to "${mapping.teamName} / ${mapping.channelName}".`,
  );
  return mapping;
}

interface DurationChoice {
  label: string;
  ms: number | "custom";
}

async function sendSummary(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("Open a workspace folder first.");
    return;
  }

  let mapping = context.workspaceState.get<ChannelMapping>(CHANNEL_KEY);
  if (!mapping) {
    const choice = await vscode.window.showInformationMessage(
      "No Teams channel configured for this workspace. Pick one now?",
      "Pick Channel",
      "Cancel",
    );
    if (choice !== "Pick Channel") {
      return;
    }
    mapping = await pickChannel(context);
    if (!mapping) {
      return;
    }
  }

  const choices: DurationChoice[] = [
    { label: "Last 1 hour", ms: 60 * 60 * 1000 },
    { label: "Last 6 hours", ms: 6 * 60 * 60 * 1000 },
    { label: "Last 1 day", ms: 24 * 60 * 60 * 1000 },
    { label: "Last 3 days", ms: 3 * 24 * 60 * 60 * 1000 },
    { label: "Last 1 week", ms: 7 * 24 * 60 * 60 * 1000 },
    { label: "Custom (hours)…", ms: "custom" },
  ];
  const picked = await vscode.window.showQuickPick(choices, {
    title: "Summary window",
    placeHolder: "How far back to collect summaries?",
  });
  if (!picked) {
    return;
  }

  let durationMs: number;
  let label: string;
  if (picked.ms === "custom") {
    const input = await vscode.window.showInputBox({
      title: "Custom duration in hours",
      prompt: "Enter a positive number of hours",
      validateInput: (v) => {
        const n = Number(v);
        return isFinite(n) && n > 0 ? null : "Enter a positive number";
      },
    });
    if (!input) {
      return;
    }
    const hours = Number(input);
    durationMs = hours * 60 * 60 * 1000;
    label = `Last ${hours} hour(s)`;
  } else {
    durationMs = picked.ms;
    label = picked.label;
  }

  const sinceMs = Date.now() - durationMs;
  const sinceIso = new Date(sinceMs).toISOString();

  const cfg = vscode.workspace.getConfiguration("codeSummaryToTeams");
  const includeCommits = cfg.get<boolean>("includeCommits", true);
  const includeChat = cfg.get<boolean>("includeCopilotChat", true);
  const maxLines = cfg.get<number>("maxLines", 50);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Code Summary to Teams",
    },
    async (progress) => {
      progress.report({ message: "Collecting summaries…" });

      const lines: string[] = [];

      if (includeCommits) {
        const commits = await getCommitsSince(folder.uri.fsPath, sinceIso);
        for (const c of commits) {
          lines.push(`commit ${c.hash}: ${c.subject}`);
        }
      }

      if (includeChat) {
        try {
          const chats = await getCopilotChatSummariesSince(context, sinceMs);
          for (const c of chats) {
            lines.push(`chat: ${c.text}`);
          }
        } catch {
          // ignore
        }
      }

      const trimmed = lines.slice(0, maxLines);
      const omitted = lines.length - trimmed.length;
      if (omitted > 0) {
        trimmed.push(`…and ${omitted} more not shown.`);
      }

      const wsName = folder.name || path.basename(folder.uri.fsPath);
      const subject = `Code summary — ${wsName} (${label})`;
      const html = renderHtml(subject, trimmed);

      progress.report({ message: "Posting to Teams…" });
      try {
        const token = await auth.getAccessToken();
        await postChannelMessage(
          token,
          mapping!.teamId,
          mapping!.channelId,
          html,
          subject,
        );
        vscode.window.showInformationMessage(
          `Sent ${trimmed.length} summary line(s) to ${mapping!.teamName} / ${mapping!.channelName}.`,
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to post to Teams: ${err.message || err}`,
        );
      }
    },
  );
}

function renderHtml(subject: string, lines: string[]): string {
  const items = lines.length
    ? lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")
    : "<li><i>(no changes in selected window)</i></li>";
  return `<p><b>${escapeHtml(subject)}</b></p><ul>${items}</ul>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
