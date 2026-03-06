import { WorkflowEntrypoint } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { getInstallationOctokit } from '../github/octokit';
import { callGateway } from '../lib/llmops';
import plannerPrompt from '../agents/planner.md';
import type { SdlcWorkflowParams, PlanResult, CodingResult } from '../lib/types';

/**
 * 2-step SDLC workflow:
 *   1. Plan  — generate implementation plan via Claude, post as issue comment
 *   2. Code  — spin up sandbox, clone repo, run `claude -p`, commit, push, open PR
 *
 * After opening the PR, the workflow ends. Review feedback triggers RevisionWorkflow.
 * PR merge/close are handled by simple webhook handlers.
 */
export class SdlcAgentWorkflow extends WorkflowEntrypoint<Env, SdlcWorkflowParams> {
	async run(event: Readonly<CloudflareWorkersModule.WorkflowEvent<SdlcWorkflowParams>>, step: CloudflareWorkersModule.WorkflowStep) {
		const params = event.payload;
		const sessionId = `issue-${params.repoOwner}-${params.repoName}-${params.issueNumber}`;

		// ── Step 0: Persist session ──────────────────────────────────────
		await step.do('init-session', async () => {
			const octokit = await getInstallationOctokit(this.env, params.installationId);
			await octokit.rest.issues.createComment({
				owner: params.repoOwner,
				repo: params.repoName,
				issue_number: params.issueNumber,
				body: '🤖 **SDLC Agent** picking up this issue. Planning…',
			});

			await this.env.DB.prepare(
				`INSERT OR REPLACE INTO sessions (id, workflow_instance_id, issue_number, repo_owner, repo_name, issue_title, issue_body, status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'planning')`,
			)
				.bind(sessionId, params.instanceId, params.issueNumber, params.repoOwner, params.repoName, params.issueTitle, params.issueBody)
				.run();
		});

		// ── Step 1: Plan ─────────────────────────────────────────────────
		const plan = await step.do('plan', async () => {
			const startTime = Date.now();

			// Build user message from issue context
			const userMessage = [
				`## Repository: ${params.repoOwner}/${params.repoName}`,
				'',
				`## Issue Title: ${params.issueTitle}`,
				'',
				`## Issue Body:`,
				params.issueBody || '(no description provided)',
			].join('\n');

			// Call Claude with the planner prompt (loaded from planner.md)
			const response = await callGateway(this.env, {
				system: plannerPrompt,
				messages: [{ role: 'user', content: userMessage }],
			});

			// Parse structured plan from response
			const text = response.text;
			const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
			const result = JSON.parse(jsonMatch[1]!.trim()) as PlanResult;

			if (!result.plan || !result.branchName || !result.estimatedFiles) {
				throw new Error('Invalid plan response: missing required fields');
			}

			// Post plan as issue comment
			const octokit = await getInstallationOctokit(this.env, params.installationId);
			const planComment = [
				'## 📋 Implementation Plan',
				'',
				result.plan,
				'',
				`**Branch:** \`${result.branchName}\``,
				`**Estimated files:** ${result.estimatedFiles.join(', ')}`,
				'',
				'---',
				'_Starting implementation…_',
			].join('\n');
			await octokit.rest.issues.createComment({
				owner: params.repoOwner,
				repo: params.repoName,
				issue_number: params.issueNumber,
				body: planComment,
			});

			// Log step
			await this.env.DB.prepare(
				`INSERT INTO step_logs (session_id, step_name, status, output_summary, duration_ms) VALUES (?, 'plan', 'completed', ?, ?)`,
			)
				.bind(sessionId, JSON.stringify(result), Date.now() - startTime)
				.run();

			await this.env.DB.prepare(`UPDATE sessions SET plan = ?, branch_name = ?, status = 'coding' WHERE id = ?`)
				.bind(result.plan, result.branchName, sessionId)
				.run();

			return result;
		});

		// ── Step 2: Code ─────────────────────────────────────────────────
		const codingResult = await step.do('code', async () => {
			const startTime = Date.now();

			// Fresh Octokit for this step (tokens expire after 1 hour, workflow may have hibernated)
			const octokit = await getInstallationOctokit(this.env, params.installationId);

			// Get a raw token for git clone operations
			const { data: { token } } = await octokit.rest.apps.createInstallationAccessToken({
				installation_id: params.installationId,
			});

			// Create branch on GitHub
			const { data: repoData } = await octokit.rest.repos.get({ owner: params.repoOwner, repo: params.repoName });
			const defaultBranch = repoData.default_branch;
			const { data: refData } = await octokit.rest.git.getRef({ owner: params.repoOwner, repo: params.repoName, ref: `heads/${defaultBranch}` });
			const latestSha = refData.object.sha;

			// Delete existing branch if present (ignore errors)
			try {
				await octokit.rest.git.deleteRef({ owner: params.repoOwner, repo: params.repoName, ref: `heads/${plan.branchName}` });
			} catch {}
			await octokit.rest.git.createRef({ owner: params.repoOwner, repo: params.repoName, ref: `refs/heads/${plan.branchName}`, sha: latestSha });

			// Spin up sandbox container
			const sandbox = getSandbox(this.env.SANDBOX, sessionId, { keepAlive: true });

			try {
				const apiKey = this.env.ANTHROPIC_API_KEY;
				console.log(`ANTHROPIC_API_KEY present: ${!!apiKey}, length: ${apiKey?.length}, prefix: ${apiKey?.slice(0, 7)}...`);

				// Set env vars for Claude Code and git push
				await sandbox.setEnvVars({
					ANTHROPIC_API_KEY: apiKey,
					CLAUDE_CODE_OAUTH_TOKEN: apiKey,
					CLAUDE_CODE_USE_BEDROCK: '0',
				});

				// Clone repo into sandbox
				const cloneUrl = `https://x-access-token:${token}@github.com/${params.repoOwner}/${params.repoName}.git`;
				await sandbox.gitCheckout(cloneUrl, {
					branch: plan.branchName,
					targetDir: '/workspace/repo',
				});

				// Verify env vars are accessible inside the sandbox
				const envCheck = await sandbox.exec('echo "API_KEY=${ANTHROPIC_API_KEY:+yes} OAUTH=${CLAUDE_CODE_OAUTH_TOKEN:+yes}"');
				console.log('Sandbox env check:', envCheck.stdout);

				// Build the prompt for Claude Code
				const claudePrompt = [
					`Implement the following plan for issue #${params.issueNumber}: "${params.issueTitle}"`,
					'',
					plan.plan,
					'',
					`Files to focus on: ${plan.estimatedFiles.join(', ')}`,
					'',
					'After making changes, commit all changes with a descriptive commit message.',
					'Do NOT push — the CI will handle that.',
				].join('\n');

				// Run Claude Code headless (use cd && pattern per official Cloudflare example)
				const escapedPrompt = claudePrompt.replace(/"/g, '\\"');
				const claudeResult = await sandbox.exec(
					`cd /workspace/repo && claude -p "${escapedPrompt}" --allowedTools 'Edit,Write,Bash,Read,Glob,Grep' --output-format json | jq '.result'`,
					{
						timeout: 600_000,
						env: { ANTHROPIC_API_KEY: apiKey, CLAUDE_CODE_OAUTH_TOKEN: apiKey },
					},
				);
				console.log('Claude Code stdout:', claudeResult.stdout);
				if (claudeResult.stderr) console.error('Claude Code stderr:', claudeResult.stderr);

				// If Claude Code left uncommitted changes, commit them as a fallback
				const statusResult = await sandbox.exec('cd /workspace/repo && git status --porcelain');
				if (statusResult.stdout?.trim()) {
					console.log('Uncommitted changes found, creating fallback commit');
					await sandbox.exec('cd /workspace/repo && git add -A');
					await sandbox.exec(`cd /workspace/repo && git commit -m "feat: implement changes for #${params.issueNumber}"`);
				}

				// Check if there are any commits ahead of the base branch
				const logCheck = await sandbox.exec(`cd /workspace/repo && git log origin/${defaultBranch}..HEAD --oneline`);

				if (!logCheck.stdout?.trim()) {
					// No commits at all — report back and bail
					await octokit.rest.issues.createComment({
						owner: params.repoOwner,
						repo: params.repoName,
						issue_number: params.issueNumber,
						body: `⚠️ Claude Code ran but produced no changes. The plan may need to be more specific.\n\n<details><summary>Claude Code output</summary>\n\n\`\`\`\n${claudeResult.stdout?.slice(0, 2000) ?? '(empty)'}\n\`\`\`\n</details>`,
					});
					await this.env.DB.prepare(`UPDATE sessions SET status = 'failed', error_message = 'No changes produced' WHERE id = ?`)
						.bind(sessionId)
						.run();
					return {
						branchName: plan.branchName,
						prNumber: 0,
						prUrl: '',
						filesChanged: [],
						commitSha: latestSha,
					} satisfies CodingResult;
				}

				console.log('Commits to push:', logCheck.stdout);

				// Push the branch
				await sandbox.exec(`cd /workspace/repo && git push --force origin ${plan.branchName}`);
			} finally {
				await sandbox.destroy();
			}

			// Open PR
			const { data: pr } = await octokit.rest.pulls.create({
				owner: params.repoOwner,
				repo: params.repoName,
				title: `[SDLC Agent] ${params.issueTitle}`,
				body: [
					`Closes #${params.issueNumber}`,
					'',
					'## Plan',
					plan.plan,
					'',
					'---',
					'_This PR was generated by the SDLC Agent. Copilot will review automatically._',
				].join('\n'),
				head: plan.branchName,
				base: defaultBranch,
			});

			// Update session
			await this.env.DB.prepare(`UPDATE sessions SET pr_number = ?, pr_url = ?, status = 'awaiting_review' WHERE id = ?`)
				.bind(pr.number, pr.html_url, sessionId)
				.run();

			await this.env.DB.prepare(
				`INSERT INTO step_logs (session_id, step_name, status, output_summary, duration_ms) VALUES (?, 'code', 'completed', ?, ?)`,
			)
				.bind(sessionId, JSON.stringify({ prNumber: pr.number, prUrl: pr.html_url }), Date.now() - startTime)
				.run();

			// Notify on the issue
			await octokit.rest.issues.createComment({
				owner: params.repoOwner,
				repo: params.repoName,
				issue_number: params.issueNumber,
				body: `✅ Implementation complete! PR opened: ${pr.html_url}\n\nCopilot will review automatically. Please merge when ready.`,
			});

			return {
				branchName: plan.branchName,
				prNumber: pr.number,
				prUrl: pr.html_url,
				filesChanged: plan.estimatedFiles,
				commitSha: latestSha,
			} satisfies CodingResult;
		});

		return { sessionId, prNumber: codingResult.prNumber, prUrl: codingResult.prUrl };
	}
}
