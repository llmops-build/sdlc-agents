/**
 * GitHub webhook signature verification using HMAC-SHA256.
 */

/** Verify the X-Hub-Signature-256 header against the raw request body */
export async function verifyWebhookSignature(secret: string, signature: string, body: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

	const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
	const digest = 'sha256=' + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');

	// Constant-time comparison
	if (digest.length !== signature.length) return false;
	const a = encoder.encode(digest);
	const b = encoder.encode(signature);
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a[i] ^ b[i];
	}
	return mismatch === 0;
}
