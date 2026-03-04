/**
 * Augment the Env interface with secrets that are set via `wrangler secret put`.
 * These are not in wrangler.jsonc so wrangler types doesn't generate them.
 */
interface Env {
	GITHUB_APP_ID: string;
	GITHUB_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	OPENROUTER_API_KEY: string;
	ANTHROPIC_API_KEY: string;
}

/** Allow importing .md files as text (wrangler Text module rule) */
declare module '*.md' {
	const content: string;
	export default content;
}
