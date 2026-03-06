import { WorkflowEntrypoint } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { getInstallationOctokit } from '../github/octokit';
import type { RevisionWorkflowParams } from '../lib/types';

/**
 * RevisionWorkflow — triggered by PR review feedback.
 *   1. ack-review  — comment on PR, set status to "revision"
 *   2. apply-fixes — sandbox → clone branch → Claude Code with review prompt → push → comment
 */
export class RevisionWorkflow extends WorkflowEntrypoint<Env, RevisionWorkflowParams> {
	async run(event: Readonly<CloudflareWorkersModule.WorkflowEvent<RevisionWorkflowParams>>, step: CloudflareWorkersModule.WorkflowStep) {
		const params = event.payload;

		// ── Step 1: Acknowledge review ──────────────────────────────────
		await step.do('ack-review', async () => {
			const octokit = await getInstallationOctokit(this.env, params.installationId);

			await octokit.rest.issues.createComment({
				owner: params.repoOwner,
				repo: params.repoName,
				issue_number: params.prNumber,
				body: '🔄 **SDLC Agent** received review feedback. Working on revisions…',
			});

			await this.env.DB.prepare(`UPDATE sessions SET status = 'revision', revision_count = COALESCE(revision_count, 0) + 1, updated_at = datetime('now') WHERE id = ?`)
				.bind(params.sessionId)
				.run();
		});

		// ── Step 2: Apply fixes ─────────────────────────────────────────
		await step.do('apply-fixes', async () => {
			const startTime = Date.now();
			const octokit = await getInstallationOctokit(this.env, params.installationId);

			// Get a fresh installation token for git operations
			const { data: { token } } = await octokit.rest.apps.createInstallationAccessToken({
				installation_id: params.installationId,
			});

			const sandbox = getSandbox(this.env.SANDBOX, `revision-${params.sessionId}-${Date.now()}`, { keepAlive: true });

			try {
				const apiKey = this.env.ANTHROPIC_API_KEY;

				await sandbox.setEnvVars({
					ANTHROPIC_API_KEY: apiKey,
					CLAUDE_CODE_OAUTH_TOKEN: apiKey,
					CLAUDE_CODE_USE_BEDROCK: '0',
				});

				// Clone the PR branch
				const cloneUrl = `https://x-access-token:${token}@github.com/${params.repoOwner}/${params.repoName}.git`;
				await sandbox.gitCheckout(cloneUrl, {
					branch: params.branchName,
					targetDir: '/workspace/repo',
				});

				// Build the review context for Claude Code
				const reviewContext = buildReviewPrompt(params);
				const escapedPrompt = reviewContext.replace(/"/g, '\\"');

				const claudeResult = await sandbox.exec(
					`cd /workspace/repo && claude -p "${escapedPrompt}" --allowedTools 'Edit,Write,Bash,Read,Glob,Grep' --output-format json | jq '.result'`,
					{
						timeout: 600_000,
						env: { ANTHROPIC_API_KEY: apiKey, CLAUDE_CODE_OAUTH_TOKEN: apiKey },
					},
				);
				console.log('Revision Claude Code stdout:', claudeResult.stdout);
				if (claudeResult.stderr) console.error('Revision Claude Code stderr:', claudeResult.stderr);

				// Fallback commit if Claude left uncommitted changes
				const statusResult = await sandbox.exec('cd /workspace/repo && git status --porcelain');
				if (statusResult.stdout?.trim()) {
					await sandbox.exec('cd /workspace/repo && git add -A');
					await sandbox.exec(`cd /workspace/repo && git commit -m "fix: address review feedback for PR #${params.prNumber}"`);
				}

				// Check if we have new commits to push
				const logCheck = await sandbox.exec(`cd /workspace/repo && git log origin/${params.branchName}..HEAD --oneline`);

				if (!logCheck.stdout?.trim()) {
					await octokit.rest.issues.createComment({
						owner: params.repoOwner,
						repo: params.repoName,
						issue_number: params.prNumber,
						body: `⚠️ Claude Code ran but produced no new changes for the review feedback.\n\n<details><summary>Claude Code output</summary>\n\n\`\`\`\n${claudeResult.stdout?.slice(0, 2000) ?? '(empty)'}\n\`\`\`\n</details>`,
					});

					await this.env.DB.prepare(`UPDATE sessions SET status = 'awaiting_review', updated_at = datetime('now') WHERE id = ?`)
						.bind(params.sessionId)
						.run();
					return;
				}

				// Push changes
				await sandbox.exec(`cd /workspace/repo && git push origin ${params.branchName}`);
			} finally {
				await sandbox.destroy();
			}

			// Comment on PR with completion
			await octokit.rest.issues.createComment({
				owner: params.repoOwner,
				repo: params.repoName,
				issue_number: params.prNumber,
				body: '✅ Revisions pushed. Please review the updated changes.',
			});

			// Set status back to awaiting_review
			await this.env.DB.prepare(`UPDATE sessions SET status = 'awaiting_review', updated_at = datetime('now') WHERE id = ?`)
				.bind(params.sessionId)
				.run();

			await this.env.DB.prepare(
				`INSERT INTO step_logs (session_id, step_name, status, output_summary, duration_ms) VALUES (?, 'revision', 'completed', ?, ?)`,
			)
				.bind(params.sessionId, JSON.stringify({ reviewId: params.reviewId }), Date.now() - startTime)
				.run();
		});

		return { sessionId: params.sessionId, prNumber: params.prNumber };
	}
}

function buildReviewPrompt(params: RevisionWorkflowParams): string {
	const parts = [
		`A reviewer has requested changes on PR #${params.prNumber} for issue #${params.issueNumber}.`,
		'',
		'## Review Feedback',
	];

	if (params.reviewBody) {
		parts.push('', '### Overall Comment', params.reviewBody);
	}

	if (params.reviewComments.length > 0) {
		parts.push('', '### Inline Comments');
		for (const comment of params.reviewComments) {
			parts.push(
				'',
				`**File: \`${comment.path}\`${comment.line ? ` (line ${comment.line})` : ''}**`,
				'```diff',
				comment.diffHunk,
				'```',
				comment.body,
			);
		}
	}

	parts.push(
		'',
		'## Instructions',
		'Address all the review feedback above. Make the necessary code changes.',
		'After making changes, commit all changes with a descriptive commit message.',
		'Do NOT push — the CI will handle that.',
	);

	return parts.join('\n');
}
