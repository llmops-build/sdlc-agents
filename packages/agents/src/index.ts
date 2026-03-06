import { Hono, type Context } from 'hono';
import { Sandbox } from '@cloudflare/sandbox';
import { SdlcAgentWorkflow } from './workflows/sdlc-agent';
import { RevisionWorkflow } from './workflows/revision';
import { getGitHubApp, getInstallationOctokit } from './github/octokit';
import type { IssuesLabeledPayload, PullRequestClosedPayload, PullRequestReviewPayload, ReviewComment } from './lib/types';

export { SdlcAgentWorkflow, RevisionWorkflow, Sandbox };

type AppEnv = { Bindings: Env };
type AppContext = Context<AppEnv>;

const app = new Hono<AppEnv>();

// ── Health check ─────────────────────────────────────────────────────
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Workflow status ──────────────────────────────────────────────────
app.get('/status/:instanceId', async (c) => {
	const instanceId = c.req.param('instanceId');
	try {
		const instance = await c.env.SDLC_AGENT_WORKFLOW.get(instanceId);
		const status = await instance.status();
		return c.json({ instanceId, status });
	} catch (err) {
		return c.json({ error: 'Instance not found' }, 404);
	}
});

// ── GitHub webhook handler ───────────────────────────────────────────
app.post('/webhooks/github', async (c) => {
	const body = await c.req.text();
	const signature = c.req.header('x-hub-signature-256');

	if (!signature) {
		return c.json({ error: 'Missing signature' }, 401);
	}

	const ghApp = getGitHubApp(c.env);
	const verified = await ghApp.webhooks.verify(body, signature);
	if (!verified) {
		return c.json({ error: 'Invalid signature' }, 401);
	}

	const event = c.req.header('x-github-event');
	const payload = JSON.parse(body);
	console.log(`Webhook received: event=${event}, action=${payload.action}`);

	try {
		if (event === 'issues' && payload.action === 'labeled') {
			return await handleIssueLabeled(c, payload as IssuesLabeledPayload);
		}

		if (event === 'pull_request_review' && payload.action === 'submitted') {
			return await handlePRReviewSubmitted(c, payload as PullRequestReviewPayload);
		}

		if (event === 'pull_request' && payload.action === 'closed') {
			const prPayload = payload as PullRequestClosedPayload;
			if (prPayload.pull_request.merged) {
				return await handlePRMerged(c, prPayload);
			}
			return await handlePRClosedWithoutMerge(c, prPayload);
		}

		return c.json({ message: 'Event ignored' }, 200);
	} catch (err: any) {
		console.error('Webhook handler error:', err);
		return c.json({ error: err.message ?? 'Internal error' }, 500);
	}
});

/** Handle issues.labeled — kick off a new SDLC workflow */
async function handleIssueLabeled(c: AppContext, payload: IssuesLabeledPayload) {
	const label = payload.label.name;
	if (label !== 'agent') {
		return c.json({ message: `Label "${label}" ignored, only "agent" triggers workflow` }, 200);
	}

	const sender = payload.sender?.login;
	if (sender !== 'chtushar') {
		return c.json({ message: `Sender "${sender}" not authorized to trigger workflow` }, 200);
	}

	if (!payload.installation?.id) {
		return c.json({ error: 'Missing installation ID in webhook payload' }, 400);
	}

	const repo = payload.repository;
	const issue = payload.issue;
	const instanceId = `issue-${repo.owner.login}-${repo.name}-${issue.number}-${Date.now()}`;

	const instance = await c.env.SDLC_AGENT_WORKFLOW.create({
		id: instanceId,
		params: {
			instanceId,
			issueNumber: issue.number,
			repoOwner: repo.owner.login,
			repoName: repo.name,
			issueTitle: issue.title,
			issueBody: issue.body ?? '',
			installationId: payload.installation.id,
			labelTrigger: label,
		},
	});

	return c.json({ message: 'Workflow started', instanceId: instance.id }, 201);
}

/** Handle pull_request_review.submitted — launch RevisionWorkflow for review feedback */
async function handlePRReviewSubmitted(c: AppContext, payload: PullRequestReviewPayload) {
	const review = payload.review;
	const repo = payload.repository;
	const pr = payload.pull_request;

	// Skip approved/dismissed reviews — only act on changes_requested or commented
	if (review.state === 'approved' || review.state === 'dismissed') {
		return c.json({ message: `Review state "${review.state}" ignored` }, 200);
	}

	// Skip bot reviews to avoid infinite loops
	if (review.user.login.endsWith('[bot]')) {
		return c.json({ message: 'Bot review ignored' }, 200);
	}

	if (!payload.installation?.id) {
		return c.json({ error: 'Missing installation ID in webhook payload' }, 400);
	}

	// Find session for this PR
	const session = await c.env.DB.prepare(
		`SELECT id, issue_number FROM sessions WHERE repo_owner = ? AND repo_name = ? AND pr_number = ? AND status IN ('awaiting_review', 'revision')`,
	)
		.bind(repo.owner.login, repo.name, pr.number)
		.first<{ id: string; issue_number: number }>();

	if (!session) {
		return c.json({ message: 'No matching session found for this PR' }, 200);
	}

	// Check current status — skip if already in revision (prevent concurrent revisions)
	const currentStatus = await c.env.DB.prepare(`SELECT status FROM sessions WHERE id = ?`)
		.bind(session.id)
		.first<{ status: string }>();

	if (currentStatus?.status === 'revision') {
		return c.json({ message: 'Revision already in progress, skipping' }, 200);
	}

	// Fetch inline review comments
	const octokit = await getInstallationOctokit(c.env, payload.installation.id);
	const { data: comments } = await octokit.rest.pulls.listCommentsForReview({
		owner: repo.owner.login,
		repo: repo.name,
		pull_number: pr.number,
		review_id: review.id,
	});

	const reviewComments: ReviewComment[] = comments.map((c) => ({
		path: c.path,
		line: c.line ?? null,
		body: c.body,
		diffHunk: c.diff_hunk,
	}));

	// Skip if no body and no inline comments
	if (!review.body && reviewComments.length === 0) {
		return c.json({ message: 'Empty review ignored' }, 200);
	}

	const instanceId = `revision-${repo.owner.login}-${repo.name}-${pr.number}-${Date.now()}`;

	const instance = await c.env.REVISION_WORKFLOW.create({
		id: instanceId,
		params: {
			instanceId,
			sessionId: session.id,
			issueNumber: session.issue_number,
			prNumber: pr.number,
			repoOwner: repo.owner.login,
			repoName: repo.name,
			branchName: pr.head.ref,
			installationId: payload.installation.id,
			reviewBody: review.body ?? '',
			reviewComments,
			reviewId: review.id,
		},
	});

	return c.json({ message: 'Revision workflow started', instanceId: instance.id }, 201);
}

/** Handle pull_request.closed with merge — close issue, mark session completed */
async function handlePRMerged(c: AppContext, payload: PullRequestClosedPayload) {
	const pr = payload.pull_request;
	const repo = payload.repository;

	const session = await c.env.DB.prepare(
		`SELECT id, issue_number FROM sessions WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?`,
	)
		.bind(repo.owner.login, repo.name, pr.number)
		.first<{ id: string; issue_number: number }>();

	if (!session) {
		return c.json({ message: 'No matching session found for this PR' }, 200);
	}

	if (payload.installation?.id) {
		const octokit = await getInstallationOctokit(c.env, payload.installation.id);
		await octokit.rest.issues.update({
			owner: repo.owner.login,
			repo: repo.name,
			issue_number: session.issue_number,
			state: 'closed',
			state_reason: 'completed',
		});
	}

	await c.env.DB.prepare(`UPDATE sessions SET status = 'completed', updated_at = datetime('now') WHERE id = ?`)
		.bind(session.id)
		.run();

	return c.json({ message: 'Session marked completed' }, 200);
}

/** Handle pull_request.closed without merge — mark session failed */
async function handlePRClosedWithoutMerge(c: AppContext, payload: PullRequestClosedPayload) {
	const pr = payload.pull_request;
	const repo = payload.repository;

	const session = await c.env.DB.prepare(
		`SELECT id FROM sessions WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?`,
	)
		.bind(repo.owner.login, repo.name, pr.number)
		.first<{ id: string }>();

	if (!session) {
		return c.json({ message: 'No matching session found for this PR' }, 200);
	}

	await c.env.DB.prepare(
		`UPDATE sessions SET status = 'failed', error_message = 'PR closed without merge', updated_at = datetime('now') WHERE id = ?`,
	)
		.bind(session.id)
		.run();

	return c.json({ message: 'Session marked failed' }, 200);
}

export default app;
