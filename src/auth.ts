import * as vscode from "vscode";
import {
  PublicClientApplication,
  LogLevel,
  type Configuration,
  type AuthenticationResult,
  type AccountInfo,
} from "@azure/msal-node";

const TOKEN_CACHE_SECRET = "codeSummaryToTeams.msalTokenCache";
const ACCOUNT_HOMEID_KEY = "codeSummaryToTeams.accountHomeId";

/**
 * Built-in Azure AD app registration used by published builds of this extension.
 * Multitenant ("organizations") so any work/school tenant's users can sign in
 * and consent without registering their own app.
 *
 * Maintainers: replace REPLACE_WITH_YOUR_CLIENT_ID with the Application (client) ID
 * of your AAD multitenant app registration before publishing.
 */
const DEFAULT_CLIENT_ID = "d856b2a0-5d3a-4aff-b921-44058e546482";
const DEFAULT_TENANT_ID = "0ee67500-ad17-4711-9d1a-57aa97077fe9";

export const GRAPH_SCOPES = [
  "User.Read",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "ChannelMessage.Send",
];

export class AuthService {
  private pca: PublicClientApplication | null = null;
  private clientId = "";
  private tenantId = "";

  constructor(private readonly context: vscode.ExtensionContext) {}

  private async getOrCreateApp(): Promise<PublicClientApplication> {
    const cfg = vscode.workspace.getConfiguration("codeSummaryToTeams");
    const clientId =
      (cfg.get<string>("aadClientId") || "").trim() || DEFAULT_CLIENT_ID;
    const tenantId =
      (cfg.get<string>("aadTenantId") || "").trim() || DEFAULT_TENANT_ID;

    if (!clientId || clientId === "REPLACE_WITH_YOUR_CLIENT_ID") {
      throw new Error(
        'No Azure AD client ID configured. Set "codeSummaryToTeams.aadClientId" in Settings, ' +
          "or use a build of the extension with a baked-in client ID.",
      );
    }

    if (this.pca && this.clientId === clientId && this.tenantId === tenantId) {
      return this.pca;
    }

    const cachedSerialized =
      (await this.context.secrets.get(TOKEN_CACHE_SECRET)) || "";

    const config: Configuration = {
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
      cache: {
        cachePlugin: {
          beforeCacheAccess: async (cacheContext) => {
            if (cachedSerialized) {
              cacheContext.tokenCache.deserialize(cachedSerialized);
            }
          },
          afterCacheAccess: async (cacheContext) => {
            if (cacheContext.cacheHasChanged) {
              const serialized = cacheContext.tokenCache.serialize();
              await this.context.secrets.store(TOKEN_CACHE_SECRET, serialized);
            }
          },
        },
      },
      system: {
        loggerOptions: {
          loggerCallback: () => {
            // silent
          },
          logLevel: LogLevel.Warning,
          piiLoggingEnabled: false,
        },
      },
    };

    this.pca = new PublicClientApplication(config);
    this.clientId = clientId;
    this.tenantId = tenantId;
    return this.pca;
  }

  private async getAccount(): Promise<AccountInfo | null> {
    const pca = await this.getOrCreateApp();
    const homeId = this.context.globalState.get<string>(ACCOUNT_HOMEID_KEY);
    const cache = pca.getTokenCache();
    const accounts = await cache.getAllAccounts();
    if (homeId) {
      const found = accounts.find((a) => a.homeAccountId === homeId);
      if (found) {
        return found;
      }
    }
    return accounts[0] || null;
  }

  /** Returns an access token, prompting via device code if needed. */
  async getAccessToken(): Promise<string> {
    const pca = await this.getOrCreateApp();
    const account = await this.getAccount();

    if (account) {
      try {
        const result = await pca.acquireTokenSilent({
          account,
          scopes: GRAPH_SCOPES,
        });
        if (result?.accessToken) {
          return result.accessToken;
        }
      } catch {
        // fall through to interactive
      }
    }

    return this.signInInteractive();
  }

  /** Forces interactive sign-in via device code. Returns the access token. */
  async signInInteractive(): Promise<string> {
    const pca = await this.getOrCreateApp();
    const result: AuthenticationResult | null =
      await pca.acquireTokenByDeviceCode({
        scopes: GRAPH_SCOPES,
        deviceCodeCallback: (info) => {
          // Show the device code & URL prominently and copy to clipboard.
          const msg = `Microsoft sign-in: open ${info.verificationUri} and enter code ${info.userCode}`;
          vscode.env.clipboard.writeText(info.userCode);
          vscode.window
            .showInformationMessage(
              `${msg} (code copied to clipboard)`,
              "Open Sign-in Page",
            )
            .then((choice) => {
              if (choice === "Open Sign-in Page") {
                vscode.env.openExternal(vscode.Uri.parse(info.verificationUri));
              }
            });
        },
      });
    if (!result?.accessToken) {
      throw new Error("Sign-in failed: no access token returned.");
    }
    if (result.account) {
      await this.context.globalState.update(
        ACCOUNT_HOMEID_KEY,
        result.account.homeAccountId,
      );
    }
    return result.accessToken;
  }

  async signOut(): Promise<void> {
    const pca = await this.getOrCreateApp().catch(() => null);
    if (pca) {
      const cache = pca.getTokenCache();
      const accounts = await cache.getAllAccounts();
      for (const a of accounts) {
        await cache.removeAccount(a);
      }
    }
    await this.context.secrets.delete(TOKEN_CACHE_SECRET);
    await this.context.globalState.update(ACCOUNT_HOMEID_KEY, undefined);
    this.pca = null;
  }
}
