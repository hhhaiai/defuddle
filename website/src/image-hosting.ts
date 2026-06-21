/**
 * Upload image to Baidu image hosting.
 *
 * This mirrors the known-good Python implementation:
 *   token = md5(md5(picInfo) + "pic_edit" + timestamp).slice(0, 5)
 *   timestamp = current milliseconds
 *   payload = application/x-www-form-urlencoded
 */

import { createHash } from 'node:crypto';

const BAIDU_IMAGE_API = 'https://image.baidu.com/aigc/pic_upload';
const IMAGE_FETCH_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export type ImageHostingEnv = {
	BAIDU_UPLOAD_ENDPOINT?: string;
};

function generateToken(picInfo: string, timestamp: string): string {
	const first = createHash('md5').update(picInfo).digest('hex');
	const second = createHash('md5').update(`${first}pic_edit${timestamp}`).digest('hex');
	return second.slice(0, 5);
}

function guessMimeTypeFromUrl(imageUrl: string): string {
	try {
		const pathname = new URL(imageUrl).pathname.toLowerCase();
		if (pathname.endsWith('.png')) return 'image/png';
		if (pathname.endsWith('.gif')) return 'image/gif';
		if (pathname.endsWith('.webp')) return 'image/webp';
		if (pathname.endsWith('.svg')) return 'image/svg+xml';
		if (pathname.endsWith('.bmp')) return 'image/bmp';
		return 'image/jpeg';
	} catch {
		return 'image/jpeg';
	}
}

function getUploadHeaders(endpoint: string): HeadersInit {
	const endpointUrl = new URL(endpoint);
	const origin = endpointUrl.origin;

	return {
		'Accept': '*/*',
		'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		'Origin': origin,
		'Pragma': 'no-cache',
		'Referer': `${origin}/`,
		'Sec-Fetch-Dest': 'empty',
		'Sec-Fetch-Mode': 'cors',
		'Sec-Fetch-Site': 'same-origin',
		'User-Agent': USER_AGENT,
		'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"Windows"',
		'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
	};
}

function resolveImageUrl(imageUrl: string, pageUrl: string): string | null {
	try {
		return new URL(imageUrl, pageUrl).toString();
	} catch {
		return null;
	}
}

function shouldUploadImage(imageUrl: string): boolean {
	try {
		const parsed = new URL(imageUrl);
		if (!['http:', 'https:'].includes(parsed.protocol)) return false;
		if (parsed.hostname.includes('baidu.com') || parsed.hostname.includes('bcebos.com')) return false;
		return true;
	} catch {
		return false;
	}
}

export async function rewriteMarkdownAssetUrlsToBaidu(markdown: string, pageUrl: string, env: ImageHostingEnv): Promise<string> {
	if (!markdown) return markdown;

	const candidates = new Set<string>();
	for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		if (match[1]) candidates.add(match[1]);
	}
	for (const match of markdown.matchAll(/\b(?:src|poster)=["']([^"']+)["']/g)) {
		if (match[1]) candidates.add(match[1]);
	}

	let rewritten = markdown;
	for (const candidate of candidates) {
		const resolvedUrl = resolveImageUrl(candidate, pageUrl);
		if (!resolvedUrl || !shouldUploadImage(resolvedUrl)) continue;
		const result = await uploadImageToBaidu(resolvedUrl, env);
		if (result?.url) {
			rewritten = rewritten.split(candidate).join(result.url);
		}
	}

	return rewritten;
}

export async function uploadImageToBaidu(imageUrl: string, env: ImageHostingEnv = {}): Promise<{ url: string } | null> {
	try {
		const imageResponse = await fetch(imageUrl, {
			headers: {
				'Accept': IMAGE_FETCH_ACCEPT,
				'User-Agent': USER_AGENT,
			},
			signal: AbortSignal.timeout(30000),
		});
		if (!imageResponse.ok) {
			throw new Error(`Failed to fetch image: ${imageResponse.status} ${imageResponse.statusText}`);
		}

		const contentType = imageResponse.headers.get('content-type')?.split(';')[0]?.trim() || guessMimeTypeFromUrl(imageUrl);
		const imageBuffer = await imageResponse.arrayBuffer();
		const imageBase64 = Buffer.from(imageBuffer).toString('base64');
		const picInfo = `data:${contentType};base64,${imageBase64}`;
		const timestamp = String(Date.now());
		const token = generateToken(picInfo, timestamp);
		const uploadEndpoint = env.BAIDU_UPLOAD_ENDPOINT || BAIDU_IMAGE_API;

		const payload = new URLSearchParams({
			token,
			scene: 'pic_edit',
			picInfo,
			timestamp,
		});

		const uploadResponse = await fetch(uploadEndpoint, {
			method: 'POST',
			headers: getUploadHeaders(uploadEndpoint),
			body: payload.toString(),
			signal: AbortSignal.timeout(30000),
		});
		if (!uploadResponse.ok) {
			throw new Error(`Baidu upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
		}

		const result = await uploadResponse.json() as { data?: { url?: string } };
		const baiduUrl = result?.data?.url;
		if (!baiduUrl) {
			throw new Error(`Unexpected Baidu upload response: ${JSON.stringify(result)}`);
		}
		return { url: baiduUrl };
	} catch (error) {
		console.error('Baidu upload error:', error);
		return null;
	}
}
