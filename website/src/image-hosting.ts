/**
 * Upload image to Baidu image hosting
 */

const BAIDU_IMAGE_API = 'https://image.baidu.com/aigc/pic_upload';
const BAIDU_REFERER = 'https://image.baidu.com/';

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function md5(str: string): string {
	// Simple MD5 implementation for Cloudflare Worker
	// Using Web Crypto API via our polyfill
	return hexMD5(str);
}

function hexMD5(str: string): string {
	const rotateLeft = (val: number, bits: number) => ((val << bits) | (val >>> (32 - bits))) >>> 0;
	const add = (x: number, y: number) => {
		const lsw = (x & 0xffff) + (y & 0xffff);
		const msw = ((x >>> 16) + (y >>> 16) + (lsw >>> 16)) >>> 0;
		return (msw << 16) | (lsw & 0xffff);
	};
	const S = [
		7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
		5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
		4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
		6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
	];
	const K = new Uint32Array(64);
	for (let i = 0; i < 64; i++) {
		K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);
	}

	const msg = new TextEncoder().encode(str);
	const ml = msg.length;
	const newLen = Math.ceil((ml + 9) / 64) * 64;
	const padded = new Uint8Array(newLen);
	padded.set(msg);
	padded[ml] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(newLen - 4, ml * 8, false);

	let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

	for (let i = 0; i < newLen / 64; i++) {
		const M = new Uint32Array(16);
		for (let j = 0; j < 16; j++) {
			M[j] = view.getUint32((i * 64 + j * 4), false);
		}

		let A = a0, B = b0, C = c0, D = d0;
		for (let j = 0; j < 64; j++) {
			let F, g;
			if (j < 16) {
				F = (B & C) | (~B & D);
				g = j;
			} else if (j < 32) {
				F = (D & B) | (~D & C);
				g = (5 * j + 1) % 16;
			} else if (j < 48) {
				F = B ^ C ^ D;
				g = (3 * j + 5) % 16;
			} else {
				F = C ^ (B | ~D);
				g = (7 * j) % 16;
			}
			const temp = rotateLeft((A + F + K[j] + M[g]) >>> 0, S[j]);
			A = D;
			D = C;
			C = B;
			B = (B + temp) >>> 0;
		}
		a0 = (a0 + A) >>> 0;
		b0 = (b0 + B) >>> 0;
		c0 = (c0 + C) >>> 0;
		d0 = (d0 + D) >>> 0;
	}

	const toHex = (n: number) => {
		const hex = n.toString(16);
		return hex.length === 8 ? hex : '0' + hex;
	};
	return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}

function generateToken(dataBase64: string, timestamp: string): string {
	const s = md5(dataBase64);
	const combined = s + 'pic_edit' + timestamp;
	return md5(combined).slice(0, 5);
}

export async function uploadImageToBaidu(imageUrl: string): Promise<{ url: string } | null> {
	try {
		// Fetch the image
		const imageResponse = await fetch(imageUrl, {
			headers: { 'User-Agent': USER_AGENT },
			signal: AbortSignal.timeout(10000)
		});

		if (!imageResponse.ok) {
			throw new Error(`Failed to fetch image: ${imageResponse.status}`);
		}

		const imageBuffer = await imageResponse.arrayBuffer();
		const imageBase64 = btoa(String.fromCharCode(...new Uint8Array(imageBuffer)));

		// Detect mime type from response headers or default to image/jpeg
		const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
		const dataBase64 = `data:${contentType};base64,${imageBase64}`;

		const timestamp = String(Math.floor(Date.now() / 1000) * 1000);
		const token = generateToken(dataBase64, timestamp);

		const formData = new URLSearchParams();
		formData.append('token', token);
		formData.append('scene', 'pic_edit');
		formData.append('picInfo', dataBase64);
		formData.append('timestamp', timestamp);

		const uploadResponse = await fetch(BAIDU_IMAGE_API, {
			method: 'POST',
			headers: {
				'User-Agent': USER_AGENT,
				'Referer': BAIDU_REFERER,
				'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
			},
			body: formData.toString(),
			signal: AbortSignal.timeout(30000)
		});

		if (!uploadResponse.ok) {
			throw new Error(`Upload failed: ${uploadResponse.status}`);
		}

		const result = await uploadResponse.json() as { data?: { url?: string } };

		if (result?.data?.url) {
			return { url: result.data.url };
		}

		throw new Error('No URL in response');
	} catch (error) {
		console.error('Baidu upload error:', error);
		return null;
	}
}
