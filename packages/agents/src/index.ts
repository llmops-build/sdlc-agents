import { Hono, type Context } from 'hono';
import { Sandbox } from '@cloudflare/sandbox';
import { SdlcAgentWorkflow } from './workflows/sdlc-agent';
import { verifyWebhookSignature } from './github/webhooks';
import type { IssuesLabeledPayload, PullRequestClosedPayload } from './lib/types';

export { SdlcAgentWorkflow, Sandbox };

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

	const valid = await verifyWebhookSignature(c.env.GITHUB_WEBHOOK_SECRET, signature, body);
	if (!valid) {
		return c.json({ error: 'Invalid signature' }, 401);
	}

	const event = c.req.header('x-github-event');
	const payload = JSON.parse(body);

	if (event === 'issues' && payload.action === 'labeled') {
		return handleIssueLabeled(c, payload as IssuesLabeledPayload);
	}

	if (event === 'pull_request' && payload.action === 'closed') {
		return handlePRClosed(c, payload as PullRequestClosedPayload);
	}

	return c.json({ message: 'Event ignored' }, 200);
});

/** Handle issues.labeled — kick off a new SDLC workflow */
async function handleIssueLabeled(c: AppContext, payload: IssuesLabeledPayload) {
	const label = payload.label.name;
	if (label !== 'agent') {
		return c.json({ message: `Label "${label}" ignored, only "agent" triggers workflow` }, 200);
	}

	if (!payload.installation?.id) {
		return c.json({ error: 'Missing installation ID in webhook payload' }, 400);
	}

	const repo = payload.repository;
	const issue = payload.issue;
	const instanceId = `issue-${repo.full_name}-${issue.number}`;

	try {
		const instance = await c.env.SDLC_AGENT_WORKFLOW.create({
			id: instanceId,
			params: {
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
	} catch (err: any) {
		// If the workflow already exists (duplicate label event), return 409
		if (err.message?.includes('already exists')) {
			return c.json({ message: 'Workflow already running for this issue', instanceId }, 409);
		}
		throw err;
	}
}

/** Handle pull_request.closed — send event to resume hibernating workflow */
async function handlePRClosed(c: AppContext, payload: PullRequestClosedPayload) {
	const pr = payload.pull_request;
	const repo = payload.repository;

	// Find the workflow instance by scanning for a matching PR branch
	// The branch name format from our planner is deterministic
	// We look up the session in D1 to find the workflow instance ID
	const session = await c.env.DB.prepare(
		`SELECT id FROM sessions WHERE repo_owner = ? AND repo_name = ? AND pr_number = ? AND status = 'awaiting_approval'`
	)
		.bind(repo.owner.login, repo.name, pr.number)
		.first<{ id: string }>();

	if (!session) {
		return c.json({ message: 'No matching workflow found for this PR' }, 200);
	}

	const instance = await c.env.SDLC_AGENT_WORKFLOW.get(session.id);
	await instance.sendEvent({
		type: 'pr-resolution',
		payload: {
			action: pr.merged ? 'approved' : 'rejected',
			prNumber: pr.number,
			merged: pr.merged,
		},
	});

	return c.json({ message: 'Event sent to workflow', instanceId: session.id }, 200);
}

export default app;
