import * as https from 'https';
import { URL } from 'url';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface TeamRef {
  id: string;
  displayName: string;
}

export interface ChannelRef {
  id: string;
  displayName: string;
  membershipType?: string;
}

export async function listJoinedTeams(token: string): Promise<TeamRef[]> {
  const data = await graphGet<{ value: TeamRef[] }>(token, '/me/joinedTeams?$select=id,displayName');
  return data.value || [];
}

export async function listChannels(token: string, teamId: string): Promise<ChannelRef[]> {
  const data = await graphGet<{ value: ChannelRef[] }>(
    token,
    `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName,membershipType`
  );
  return data.value || [];
}

export async function postChannelMessage(
  token: string,
  teamId: string,
  channelId: string,
  htmlBody: string,
  subject?: string
): Promise<void> {
  const path = `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
  const body: Record<string, unknown> = {
    body: { contentType: 'html', content: htmlBody },
  };
  if (subject) {
    body.subject = subject;
  }
  await graphPost(token, path, body);
}

function graphGet<T>(token: string, path: string): Promise<T> {
  return graphRequest<T>(token, 'GET', path);
}

function graphPost(token: string, path: string, body: unknown): Promise<unknown> {
  return graphRequest<unknown>(token, 'POST', path, body);
}

function graphRequest<T>(
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(GRAPH + path);
    const data = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        port: 443,
        headers,
      },
      res => {
        let resp = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (resp += chunk));
        res.on('end', () => {
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            if (!resp) {
              resolve(undefined as unknown as T);
              return;
            }
            try {
              resolve(JSON.parse(resp) as T);
            } catch (e) {
              reject(new Error(`Graph: invalid JSON response: ${(e as Error).message}`));
            }
          } else {
            reject(new Error(`Graph ${method} ${path} -> ${status}: ${resp.slice(0, 500)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}
