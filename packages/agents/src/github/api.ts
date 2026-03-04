/**
 * GitHub REST API wrappers.
 * Each function takes a token so callers can pass a fresh installation token per step.
 */

const GITHUB_API = 'https://api.github.com';
const HEADERS = (token: string) => ({
	Authorization: `token ${token}`,
	Accept: 'application/vnd.github+json',
	'User-Agent': 'sdlc-agents-worker',
	'X-GitHub-Api-Version': '2022-11-28',
});

async function ghFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${GITHUB_API}${path}`, {
		...init,
		headers: { ...HEADERS(token), ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`GitHub API error ${res.status} ${path}: ${body}`);
	}
	return res.json() as Promise<T>;
}

/** Get the default branch name for a repo */
export async function getDefaultBranch(token: string, owner: string, repo: string): Promise<string> {
	const data = await ghFetch<{ default_branch: string }>(token, `/repos/${owner}/${repo}`);
	return data.default_branch;
}

/** Get the latest commit SHA on a branch */
export async function getLatestCommitSha(token: string, owner: string, repo: string, branch: string): Promise<string> {
	const data = await ghFetch<{ object: { sha: string } }>(token, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
	return data.object.sha;
}

/** Create a new branch from a given SHA */
export async function createBranch(token: string, owner: string, repo: string, branchName: string, sha: string): Promise<void> {
	await ghFetch<unknown>(token, `/repos/${owner}/${repo}/git/refs`, {
		method: 'POST',
		body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
	});
}

/** Open a pull request */
export async function openPR(
	token: string,
	owner: string,
	repo: string,
	opts: { title: string; body: string; head: string; base: string }
): Promise<{ number: number; html_url: string }> {
	return ghFetch<{ number: number; html_url: string }>(token, `/repos/${owner}/${repo}/pulls`, {
		method: 'POST',
		body: JSON.stringify(opts),
	});
}

/** Add a comment to an issue or PR */
export async function addComment(token: string, owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
	await ghFetch<unknown>(token, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
		method: 'POST',
		body: JSON.stringify({ body }),
	});
}

/** Close an issue */
export async function closeIssue(token: string, owner: string, repo: string, issueNumber: number): Promise<void> {
	await ghFetch<unknown>(token, `/repos/${owner}/${repo}/issues/${issueNumber}`, {
		method: 'PATCH',
		body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
	});
}
