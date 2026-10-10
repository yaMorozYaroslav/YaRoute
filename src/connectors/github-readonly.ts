import { ConnectorRegistry } from './connector-registry';

/** Implementations must obtain short-lived installation tokens from a secure vault. */
export interface GithubInstallationCredentials {
  tokenFor(ownerId: string, connectionId: string, installationId: string): Promise<string>;
}
export type GithubHttp = (url: string, init: RequestInit) => Promise<Response>;
export class GithubReadonlyConnector {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly credentials: GithubInstallationCredentials,
    private readonly http: GithubHttp = fetch,
  ) {}
  private async request(ownerId: string, connectionId: string, repo: string, suffix: string) {
    const connection = await this.registry.require(ownerId, connectionId, 'ci:read');
    if (connection.provider !== 'github' || !connection.installationId) throw new Error('GITHUB_INSTALLATION_REQUIRED');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes('..')) throw new Error('GITHUB_REPOSITORY_INVALID');
    const token = await this.credentials.tokenFor(ownerId, connectionId, connection.installationId);
    if (!token) throw new Error('GITHUB_CREDENTIAL_UNAVAILABLE');
    const response = await this.http('https://api.github.com/repos/' + repo + suffix, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error',
    });
    if (!response.ok) throw new Error(response.status === 404 ? 'GITHUB_NOT_FOUND' : 'GITHUB_API_FAILED');
    return response.json();
  }
  async workflows(ownerId: string, connectionId: string, repo: string) {
    return this.request(ownerId, connectionId, repo, '/actions/workflows?per_page=30');
  }
  async runs(ownerId: string, connectionId: string, repo: string, branch = 'master') {
    if (!/^[A-Za-z0-9_./-]{1,120}$/.test(branch) || branch.includes('..')) throw new Error('GITHUB_BRANCH_INVALID');
    return this.request(ownerId, connectionId, repo, '/actions/runs?per_page=30&branch=' + encodeURIComponent(branch));
  }
  async jobs(ownerId: string, connectionId: string, repo: string, runId: number) {
    if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('GITHUB_RUN_INVALID');
    return this.request(ownerId, connectionId, repo, '/actions/runs/' + runId + '/jobs?per_page=100');
  }
}
