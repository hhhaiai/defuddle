import { createHash } from 'node:crypto';
import { parseLinkedomHTML } from './utils/linkedom-compat';

const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const DEFAULT_BAIDU_UPLOAD_ENDPOINT = 'https://image.baidu.com/aigc/pic_upload';
const IMAGE_FETCH_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

const uploadCache = new Map<string, Promise<string | null>>();

export type ImageHostingEnv = {
	BAIDU_UPLOAD_ENDPOINT?: string;
};

export async function rewriteHtmlImagesToBaidu(html: string, pageUrl: string, env: ImageHostingEnv): Promise<string> {
	if (!html || (!html.includes('<img') && !html.includes('poster='))) return html;

	const doc = parseLinkedomHTML(`<!DOCTYPE html><html><body>${html}</body></html>`, pageUrl);
	const imageElements = Array.from(doc.querySelectorAll('img[src]'));
	const videoElements = Array.from(doc.querySelectorAll('video[poster]'));

	await Promise.all(imageElements.map(async (img) => {
		const originalSrc = img.getAttribute('src');
		if (!originalSrc) return;

		const resolvedSrc = resolveImageUrl(originalSrc, pageUrl);
		if (!resolvedSrc || !shouldUploadImage(resolvedSrc)) return;

		const baiduUrl = await uploadImageUrlToBaiduCached(resolvedSrc, env);
		if (baiduUrl) {
			img.setAttribute('src', baiduUrl);
		}
	}));

	await Promise.all(videoElements.map(async (video) => {
		const originalPoster = video.getAttribute('poster');
		if (!originalPoster) return;

		const resolvedPoster = resolveImageUrl(originalPoster, pageUrl);
		if (!resolvedPoster || !shouldUploadImage(resolvedPoster)) return;

		const baiduUrl = await uploadImageUrlToBaiduCached(resolvedPoster, env);
		if (baiduUrl) {
			video.setAttribute('poster', baiduUrl);
		}
	}));

	return doc.body.innerHTML;
}

export async function rewriteImageUrlToBaidu(imageUrl: string, env: ImageHostingEnv): Promise<string> {
	const baiduUrl = await uploadImageUrlToBaiduCached(imageUrl, env);
	return baiduUrl || imageUrl;
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
		const baiduUrl = await uploadImageUrlToBaiduCached(resolvedUrl, env);
		if (baiduUrl) {
			rewritten = rewritten.split(candidate).join(baiduUrl);
		}
	}

	return rewritten;
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

function guessMimeTypeFromUrl(imageUrl: string): string {
	const path = (() => {
		try {
			return new URL(imageUrl).pathname.toLowerCase();
		} catch {
			return imageUrl.toLowerCase();
		}
	})();

	if (path.endsWith('.png')) return 'image/png';
	if (path.endsWith('.gif')) return 'image/gif';
	if (path.endsWith('.webp')) return 'image/webp';
	if (path.endsWith('.svg')) return 'image/svg+xml';
	if (path.endsWith('.bmp')) return 'image/bmp';
	return 'image/jpeg';
}

function generateToken(picInfo: string, timestamp: string): string {
	const first = createHash('md5').update(picInfo).digest('hex');
	const second = createHash('md5').update(`${first}pic_edit${timestamp}`).digest('hex');
	return second.slice(0, 5);
}

function getUploadHeaders(endpoint: string): HeadersInit {
	const endpointUrl = new URL(endpoint);
	const origin = endpointUrl.origin;
	const referer = `${origin}/`;

	return {
		'Accept': '*/*',
		'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		'Origin': origin,
		'Pragma': 'no-cache',
		'Referer': referer,
		'Sec-Fetch-Dest': 'empty',
		'Sec-Fetch-Mode': 'cors',
		'Sec-Fetch-Site': 'same-origin',
		'User-Agent': DEFAULT_USER_AGENT,
		'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"Windows"',
		'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
	};
}

async function uploadImageUrlToBaiduCached(imageUrl: string, env: ImageHostingEnv): Promise<string | null> {
	let pending = uploadCache.get(imageUrl);
	if (!pending) {
		pending = uploadImageUrlToBaidu(imageUrl, env).catch((error) => {
			console.warn('Failed to upload image to Baidu:', imageUrl, error);
			return null;
		});
		uploadCache.set(imageUrl, pending);
	}
	return pending;
}

async function uploadImageUrlToBaidu(imageUrl: string, env: ImageHostingEnv): Promise<string> {
	const imageResponse = await fetch(imageUrl, {
		headers: {
			'Accept': IMAGE_FETCH_ACCEPT,
			'User-Agent': DEFAULT_USER_AGENT,
		},
		signal: AbortSignal.timeout(30000),
	});
	if (!imageResponse.ok) {
		throw new Error(`Failed to fetch image: ${imageResponse.status} ${imageResponse.statusText}`);
	}

	const contentType = imageResponse.headers.get('content-type')?.split(';')[0]?.trim() || guessMimeTypeFromUrl(imageUrl);
	const imageBuffer = await imageResponse.arrayBuffer();
	const base64String = Buffer.from(imageBuffer).toString('base64');
	const picInfo = `data:${contentType};base64,${base64String}`;
	const timestamp = String(Date.now());
	const token = generateToken(picInfo, timestamp);
	const uploadEndpoint = env.BAIDU_UPLOAD_ENDPOINT || DEFAULT_BAIDU_UPLOAD_ENDPOINT;

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
	return baiduUrl;
}
