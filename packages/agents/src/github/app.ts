/**
 * GitHub App authentication using Web Crypto API.
 * No npm dependencies — uses crypto.subtle for RS256 JWT signing.
 */

/** Base64url-encode a buffer */
function base64url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Import a PKCS#8 PEM private key for RS256 signing */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
	const pemContents = pem
		.replace(/-----BEGIN PRIVATE KEY-----/g, '')
		.replace(/-----END PRIVATE KEY-----/g, '')
		.replace(/\s/g, '');
	const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
	return crypto.subtle.importKey('pkcs8', binaryDer.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** Generate a GitHub App JWT (valid for up to 10 minutes) */
export async function generateJWT(appId: string, privateKey: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: 'RS256', typ: 'JWT' };
	const payload = {
		iat: now - 60, // issued 60s in the past to account for clock drift
		exp: now + 600, // 10 minute expiry
		iss: appId,
	};

	const encodedHeader = base64url(new TextEncoder().encode(JSON.stringify(header)).buffer as ArrayBuffer);
	const encodedPayload = base64url(new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer);
	const signingInput = `${encodedHeader}.${encodedPayload}`;

	const key = await importPrivateKey(privateKey);
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));

	return `${signingInput}.${base64url(signature)}`;
}

/** Exchange a GitHub App JWT for an installation access token */
export async function getInstallationToken(appId: string, privateKey: string, installationId: number): Promise<string> {
	const jwt = await generateJWT(appId, privateKey);
	const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${jwt}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'sdlc-agents-worker',
			'X-GitHub-Api-Version': '2022-11-28',
		},
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Failed to get installation token (${response.status}): ${body}`);
	}

	const data = (await response.json()) as { token: string };
	return data.token;
}
