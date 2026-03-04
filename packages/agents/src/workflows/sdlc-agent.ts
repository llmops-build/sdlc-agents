import { WorkflowEntrypoint } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { getInstallationToken } from '../github/app';
import { getDefaultBranch, getLatestCommitSha, createBranch, openPR, addComment, closeIssue } from '../github/api';
import { callGateway } from '../lib/llmops';
import plannerPrompt from '../agents/planner.md';
import type { SdlcWorkflowParams, PlanResult, CodingResult, ApprovalEvent } from '../lib/types';

/**
 * 3-step SDLC workflow:
 *   1. Plan  — generate implementation plan via Claude, post as issue comment
 *   2. Code  — spin up sandbox, clone repo, run `claude -p`, commit, push, open PR
 *   3. Wait  — hibernate until human merges/closes the PR (Copilot reviews automatically)
 *   4. Finalize — close issue, update D1 status
 */
export class SdlcAgentWorkflow extends WorkflowEntrypoint<Env, SdlcWorkflowParams> {
	async run(event: Readonly<CloudflareWorkersModule.WorkflowEvent<SdlcWorkflowParams>>, step: CloudflareWorkersModule.WorkflowStep) {
		const params = event.payload;
		const sessionId = `issue-${params.repoOwner}-${params.repoName}-${params.issueNumber}`;

		// ── Step 0: Persist session ──────────────────────────────────────
		await step.do('init-session', async () => {
			const token = await getInstallationToken(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY, params.installationId);
			await addComment(token, params.repoOwner, params.repoName, params.issueNumber, '🤖 **SDLC Agent** picking up this issue. Planning…');

			await this.env.DB.prepare(
				`INSERT OR REPLACE INTO sessions (id, issue_number, repo_owner, repo_name, issue_title, issue_body, status)
				 VALUES (?, ?, ?, ?, ?, ?, 'planning')`,
			)
				.bind(sessionId, params.issueNumber, params.repoOwner, params.repoName, params.issueTitle, params.issueBody)
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
			const token = await getInstallationToken(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY, params.installationId);
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
			await addComment(token, params.repoOwner, params.repoName, params.issueNumber, planComment);

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

			// Fresh token for this step (tokens expire after 1 hour, workflow may have hibernated)
			const token = await getInstallationToken(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY, params.installationId);

			// Create branch on GitHub
			const defaultBranch = await getDefaultBranch(token, params.repoOwner, params.repoName);
			const latestSha = await getLatestCommitSha(token, params.repoOwner, params.repoName, defaultBranch);
			await createBranch(token, params.repoOwner, params.repoName, plan.branchName, latestSha);

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
					await addComment(
						token,
						params.repoOwner,
						params.repoName,
						params.issueNumber,
						`⚠️ Claude Code ran but produced no changes. The plan may need to be more specific.\n\n<details><summary>Claude Code output</summary>\n\n\`\`\`\n${claudeResult.stdout?.slice(0, 2000) ?? '(empty)'}\n\`\`\`\n</details>`,
					);
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
			const pr = await openPR(token, params.repoOwner, params.repoName, {
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
			await this.env.DB.prepare(`UPDATE sessions SET pr_number = ?, pr_url = ?, status = 'awaiting_approval' WHERE id = ?`)
				.bind(pr.number, pr.html_url, sessionId)
				.run();

			await this.env.DB.prepare(
				`INSERT INTO step_logs (session_id, step_name, status, output_summary, duration_ms) VALUES (?, 'code', 'completed', ?, ?)`,
			)
				.bind(sessionId, JSON.stringify({ prNumber: pr.number, prUrl: pr.html_url }), Date.now() - startTime)
				.run();

			// Notify on the issue
			await addComment(
				token,
				params.repoOwner,
				params.repoName,
				params.issueNumber,
				`✅ Implementation complete! PR opened: ${pr.html_url}\n\nCopilot will review automatically. Please merge when ready.`,
			);

			return {
				branchName: plan.branchName,
				prNumber: pr.number,
				prUrl: pr.html_url,
				filesChanged: plan.estimatedFiles,
				commitSha: latestSha,
			} satisfies CodingResult;
		});

		// If no PR was opened (no changes produced), end the workflow early
		if (codingResult.prNumber === 0) {
			return { sessionId, prNumber: 0, prUrl: '' };
		}

		// ── Step 3: Wait for human approval ──────────────────────────────
		// Copilot reviews the PR automatically (configured via repo rulesets).
		// Workflow hibernates here until the PR is merged or closed.
		const approval = await step.waitForEvent<ApprovalEvent>('wait-for-human-approval', {
			timeout: '7 days',
			type: 'pr-resolution',
		});

		// ── Step 4: Finalize ─────────────────────────────────────────────
		await step.do('finalize', async () => {
			const token = await getInstallationToken(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY, params.installationId);

			if (approval.payload.action === 'approved' && approval.payload.merged) {
				// Close the issue as completed
				await closeIssue(token, params.repoOwner, params.repoName, params.issueNumber);
				await this.env.DB.prepare(`UPDATE sessions SET status = 'completed', updated_at = datetime('now') WHERE id = ?`)
					.bind(sessionId)
					.run();
			} else {
				await this.env.DB.prepare(
					`UPDATE sessions SET status = 'failed', error_message = 'PR closed without merge', updated_at = datetime('now') WHERE id = ?`,
				)
					.bind(sessionId)
					.run();
			}

			await this.env.DB.prepare(
				`INSERT INTO step_logs (session_id, step_name, status, output_summary) VALUES (?, 'finalize', 'completed', ?)`,
			)
				.bind(sessionId, JSON.stringify(approval.payload))
				.run();
		});

		return { sessionId, prNumber: codingResult.prNumber, prUrl: codingResult.prUrl };
	}
}
