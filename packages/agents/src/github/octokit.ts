import { App } from 'octokit';

let appInstance: App | null = null;

export function getGitHubApp(env: Env): App {
	if (!appInstance) {
		appInstance = new App({
			appId: env.GITHUB_APP_ID,
			privateKey: env.GITHUB_PRIVATE_KEY,
			webhooks: { secret: env.GITHUB_WEBHOOK_SECRET },
		});
	}
	return appInstance;
}

export async function getInstallationOctokit(env: Env, installationId: number) {
	const app = getGitHubApp(env);
	return app.getInstallationOctokit(installationId);
}
