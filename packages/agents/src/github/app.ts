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

/** Import a PEM private key for RS256 signing (handles both PKCS#1 and PKCS#8) */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
	// Normalize literal \n (from env vars) to actual newlines
	const normalized = pem.replace(/\\n/g, '\n');

	const isPkcs1 = normalized.includes('BEGIN RSA PRIVATE KEY');
	const pemContents = normalized
		.replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
		.replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
		.replace(/\s/g, '');

	const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

	if (isPkcs1) {
		// PKCS#1 → wrap in PKCS#8 ASN.1 envelope for crypto.subtle
		const pkcs8 = wrapPkcs1InPkcs8(binaryDer);
		return crypto.subtle.importKey('pkcs8', pkcs8.buffer as ArrayBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
	}
	return crypto.subtle.importKey('pkcs8', binaryDer.buffer as ArrayBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** Wrap a PKCS#1 RSA key in a PKCS#8 envelope */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
	// PKCS#8 header for RSA: SEQUENCE { SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
	const rsaOid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
	const algorithmIdentifier = [0x30, rsaOid.length, ...rsaOid];
	const octetString = asn1Length(0x04, pkcs1);
	const innerSequence = new Uint8Array([
		...asn1Length(0x02, new Uint8Array([0x00])), // version 0
		...algorithmIdentifier,
		...octetString,
	]);
	return new Uint8Array([0x30, ...encodeLength(innerSequence.length), ...innerSequence]);
}

function asn1Length(tag: number, data: Uint8Array): Uint8Array {
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
