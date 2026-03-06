import { App } from 'octokit';

let appInstance: App | null = null;

export function getGitHubApp(env: Env): App {
	if (!appInstance) {
		appInstance = new App({
			appId: env.GITHUB_APP_ID,
			privateKey: convertToPkcs8(env.GITHUB_PRIVATE_KEY),
			webhooks: { secret: env.GITHUB_WEBHOOK_SECRET },
		});
	}
	return appInstance;
}

/** Convert PKCS#1 RSA private key to PKCS#8 format. Passes through PKCS#8 keys unchanged. */
function convertToPkcs8(pem: string): string {
	const normalized = pem.replace(/\\n/g, '\n');
	if (!normalized.includes('BEGIN RSA PRIVATE KEY')) {
		return normalized;
	}

	// Extract DER bytes from PKCS#1 PEM
	const pemContents = normalized
		.replace(/-----BEGIN RSA PRIVATE KEY-----/g, '')
		.replace(/-----END RSA PRIVATE KEY-----/g, '')
		.replace(/\s/g, '');
	const pkcs1 = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

	// Wrap PKCS#1 in PKCS#8 ASN.1 envelope
	const rsaOid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
	const algorithmIdentifier = [0x30, rsaOid.length, ...rsaOid];
	const octetString = asn1Wrap(0x04, pkcs1);
	const innerSequence = new Uint8Array([
		...asn1Wrap(0x02, new Uint8Array([0x00])), // version 0
		...algorithmIdentifier,
		...octetString,
	]);
	const pkcs8 = new Uint8Array([0x30, ...encodeLength(innerSequence.length), ...innerSequence]);

	// Re-encode as PEM
	const b64 = btoa(String.fromCharCode(...pkcs8));
	const lines = b64.match(/.{1,64}/g)!;
	return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

function asn1Wrap(tag: number, data: Uint8Array): Uint8Array {
	return new Uint8Array([tag, ...encodeLength(data.length), ...data]);
}

function encodeLength(length: number): number[] {
	if (length < 0x80) return [length];
	const bytes: number[] = [];
	let temp = length;
	while (temp > 0) {
		bytes.unshift(temp & 0xff);
		temp >>= 8;
	}
	return [0x80 | bytes.length, ...bytes];
}

export async function getInstallationOctokit(env: Env, installationId: number) {
	const app = getGitHubApp(env);
	return app.getInstallationOctokit(installationId);
}
