import './polyfill';
import { parseLinkedomHTML } from './utils/linkedom-compat';
import { Defuddle } from './defuddle';
import { toMarkdown } from './markdown';
import { countWords } from './utils';
import type { DefuddleResponse } from './types';
import { rewriteHtmlImagesToBaidu, rewriteImageUrlToBaidu, rewriteMarkdownAssetUrlsToBaidu } from './image-hosting';
import { createHash } from 'node:crypto';

const PRIMARY_HOSTS = ['defuddle.md', 'simitalk.de5.net', 'github.io'];
const BLOCKED_HOSTS = [...PRIMARY_HOSTS, 'defuddle.dev', 'localhost'];

const STATIC_PAGES = new Set(['/', '', '/favicon.ico']);
const CACHE_TTL = 300; // 5 minutes
const CACHE_VERSION = '2026-04-16-image-rewrite-v4-frontmatter';
const RESERVED_QUERY_PARAMS = new Set(['raw', '__cb']);

type Env = {
	BAIDU_UPLOAD_ENDPOINT?: string;
};

type PageMetadata = {
	title?: string;
	author?: string;
	site?: string;
	source: string;
	domain?: string;
	language?: string;
	description?: string;
	wordCount?: number;
};

export type ViewerPageOptions = {
	baiduUploadEndpoint?: string;
	retryDelaysMs?: number[];
};

// --- Baidu image upload (server-side, avoids CORS) ---

const DEFAULT_BAIDU_UPLOAD_ENDPOINT = 'https://image.baidu.com/aigc/pic_upload';
const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Use Node.js crypto via nodejs_compat flag

function generateToken(picInfo: string, timestamp: string): string {
	const first = createHash('md5').update(picInfo).digest('hex');
	const combined = first + 'pic_edit' + timestamp;
	return createHash('md5').update(combined).digest('hex').slice(0, 5);
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

async function uploadImageUrlToBaidu(imageUrl: string, env: Env): Promise<string | null> {
	try {
		const imageResponse = await fetch(imageUrl, {
			headers: {
				'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
				'User-Agent': DEFAULT_USER_AGENT,
			},
			signal: AbortSignal.timeout(30000),
		});
		if (!imageResponse.ok) {
			throw new Error(`Failed to fetch image: ${imageResponse.status}`);
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
			headers: {
				'Accept': '*/*',
				'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'Origin': 'https://image.baidu.com',
				'Pragma': 'no-cache',
				'Referer': 'https://image.baidu.com/',
				'Sec-Fetch-Dest': 'empty',
				'Sec-Fetch-Mode': 'cors',
				'Sec-Fetch-Site': 'same-origin',
				'User-Agent': DEFAULT_USER_AGENT,
				'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
				'sec-ch-ua-mobile': '?0',
				'sec-ch-ua-platform': '"Windows"',
				'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
			},
			body: payload.toString(),
			signal: AbortSignal.timeout(30000),
		});
		if (!uploadResponse.ok) {
			throw new Error(`Baidu upload failed: ${uploadResponse.status}`);
		}

		const result = await uploadResponse.json() as { data?: { url?: string } };
		const baiduUrl = result?.data?.url;
		if (!baiduUrl) {
			throw new Error(`Unexpected Baidu upload response: ${JSON.stringify(result)}`);
		}
		return baiduUrl;
	} catch (error) {
		console.error('Baidu upload error:', error);
		return null;
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			const url = new URL(request.url);

			// Redirect defuddle.dev to defuddle.md
			if (url.hostname.includes('defuddle.dev')) {
				const redirectUrl = new URL(request.url);
				redirectUrl.hostname = 'defuddle.md';
				return Response.redirect(redirectUrl.toString(), 301);
			}

			const path = url.pathname;

			// Cache static pages at the edge
			if (request.method === 'GET' && STATIC_PAGES.has(path)) {
				const cache = caches.default;
				const cacheKey = new Request(url.toString(), request);
				const cachedResponse = await cache.match(cacheKey);
				if (cachedResponse) {
					return cachedResponse;
				}

				const response = await handleRequest(request, url, env, ctx);
				if (response.ok && response.status !== 204 && response.status !== 205) {
					ctx.waitUntil(cache.put(cacheKey, response.clone()));
				}
				return response;
			}

			return await handleRequest(request, url, env, ctx);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'An unexpected error occurred';
			return errorResponse(message, 500);
		}
	},
} satisfies ExportedHandler<Env>;

// --- Shared helpers ---

function htmlResponse(body: string): Response {
	return new Response(body, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'public, max-age=3600',
		},
	});
}

function markdownResponse(body: string): Response {
	return new Response(body, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			'Access-Control-Allow-Origin': '*',
			'Cache-Control': `s-maxage=${CACHE_TTL}`,
		},
	});
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

function errorResponse(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

function shouldRenderHtmlViewer(request: Request, htmlMode: boolean, forceRaw: boolean): boolean {
	if (htmlMode || forceRaw) return false;

	const acceptHeader = request.headers.get('Accept') || '';
	const secFetchDest = request.headers.get('Sec-Fetch-Dest') || '';
	const secFetchMode = request.headers.get('Sec-Fetch-Mode') || '';
	const upgradeInsecureRequests = request.headers.get('Upgrade-Insecure-Requests') || '';

	const explicitlyWantsMarkdown = acceptHeader.includes('text/markdown');
	if (explicitlyWantsMarkdown) return false;

	const explicitlyWantsHtml = acceptHeader.includes('text/html');
	const looksLikeDocumentNavigation =
		secFetchDest === 'document' ||
		secFetchMode === 'navigate' ||
		upgradeInsecureRequests === '1';

	return explicitlyWantsHtml || looksLikeDocumentNavigation;
}

// --- Main request handler ---

async function handleRequest(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const path = url.pathname;

	// --- Landing page ---
	if (path === '/' || path === '') {
		return htmlResponse(getLandingPage());
	}

	// --- Image upload proxy (avoids CORS) ---
	// TEST endpoint
	if (path === '/api/test') {
		return jsonResponse({ ok: true, path });
	}
	if (path === '/api/upload-image' && request.method === 'POST') {
		try {
			const body = await request.json() as { url?: string };
			if (!body.url) {
				return errorResponse('Missing "url" field.', 400);
			}
			const baiduUrl = await uploadImageUrlToBaidu(body.url, env);
			if (!baiduUrl) {
				return errorResponse('Failed to upload image.', 502);
			}
			return jsonResponse({ url: baiduUrl });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'An unexpected error occurred';
			return errorResponse(message, 500);
		}
	}

	// Unknown API routes should 404
	if (path.startsWith('/api/')) {
		return errorResponse('Not found.', 404);
	}

	// --- URL conversion route (catch-all) ---

	// Check for /html/ prefix — returns clean HTML instead of markdown
	const htmlMode = path.startsWith('/html/');
	const urlPath = htmlMode ? path.slice(5) : path;

	// Parse target URL from path
	let targetUrl = urlPath.replace(/^\/+/, '');
	targetUrl = decodeURIComponent(targetUrl);

	const forwardedParams = new URLSearchParams(url.searchParams);
	for (const key of RESERVED_QUERY_PARAMS) {
		forwardedParams.delete(key);
	}
	const forwardedQuery = forwardedParams.toString();
	if (forwardedQuery) {
		targetUrl += (targetUrl.includes('?') ? '&' : '?') + forwardedQuery;
	}

	if (!targetUrl.match(/^https?:\/\//)) {
		targetUrl = 'https://' + targetUrl;
	}

	// Validate URL
	let parsedTarget: URL;
	try {
		parsedTarget = new URL(targetUrl);
	} catch {
		return errorResponse('Invalid URL. Please provide a valid web address.', 400);
	}

	// Block self-referential requests
	if (BLOCKED_HOSTS.some(host => parsedTarget.hostname.includes(host))) {
		return errorResponse('Cannot convert this URL.', 400);
	}

	// Extract preferred language from Accept-Language header
	const language = request.headers.get('Accept-Language')?.split(',')[0]?.split(';')[0]?.trim() || undefined;

	const forceRaw = url.searchParams.has('raw');
	const wantsHtmlViewer = shouldRenderHtmlViewer(request, htmlMode, forceRaw);

	// Build cache key
	const cacheUrl = new URL(targetUrl, 'https://defuddle.md');
	if (htmlMode) cacheUrl.searchParams.set('_fmt', 'html');
	if (wantsHtmlViewer && !forceRaw) cacheUrl.searchParams.set('_viewer', '1');
	if (language) cacheUrl.searchParams.set('_lang', language);
	cacheUrl.searchParams.set('_cv', CACHE_VERSION);
	const cacheKey = new Request(cacheUrl.toString());

	// Check cache
	const cachedResponse = await caches.default.match(cacheKey);
	if (cachedResponse) {
		return cachedResponse;
	}

	try {
		const result = await convertUrl(targetUrl, language, env);

		// Build metadata for viewer page
		const metadata: PageMetadata = {
			title: result.title,
			author: result.author,
			site: result.site,
			source: targetUrl,
			domain: result.domain,
			language: result.language,
			description: result.description,
			wordCount: result.wordCount,
		};

		// Return HTML viewer for browsers (unless ?raw=1 is specified)
		if (wantsHtmlViewer && !forceRaw && !htmlMode) {
			const markdown = formatResponse(result, targetUrl);
			const body = getMarkdownViewerPage(markdown, metadata, {
				baiduUploadEndpoint: env.BAIDU_UPLOAD_ENDPOINT,
			});
			const response = new Response(body, {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': `s-maxage=${CACHE_TTL}`,
				},
			});
			ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
			return response;
		}

		const body = htmlMode ? result.content : formatResponse(result, targetUrl);
		const contentType = htmlMode ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';

		const response = new Response(body, {
			headers: {
				'Content-Type': contentType,
				'Access-Control-Allow-Origin': '*',
				'Cache-Control': `s-maxage=${CACHE_TTL}`,
			},
		});

		// Cache response
		ctx.waitUntil(caches.default.put(cacheKey, response.clone()));

		return response;
	} catch (err) {
		const message = err instanceof Error ? err.message : 'An unexpected error occurred';
		return errorResponse(message, 502);
	}
}

// --- Conversion logic ---

async function convertUrl(targetUrl: string, language?: string, env?: Env): Promise<DefuddleResponse> {
	// Check for YouTube URL
	if (isYouTubeUrl(targetUrl)) {
		return fetchYouTubeContent(targetUrl, language);
	}

	// Fetch the page
	const html = await fetchPage(targetUrl, language);
	const doc = parseLinkedomHTML(html, targetUrl);
	const defuddle = new Defuddle(doc, { url: targetUrl, language });
	const result = await defuddle.parseAsync();

	if (result.content) {
		// Image Baidu upload is temporarily disabled to avoid Worker resource limit issues
		// result.content = await rewriteHtmlImagesToBaidu(result.content, targetUrl, env || {});
	}

		// Convert to markdown
		toMarkdown(result, { markdown: true }, targetUrl);

	return result;
}

function isYouTubeUrl(url: string): boolean {
	try {
		const { hostname } = new URL(url);
		return hostname === 'youtube.com' || hostname === 'www.youtube.com' || hostname === 'youtu.be';
	} catch { return false; }
}

function getYouTubeVideoId(url: string): string {
	try {
		const u = new URL(url);
		if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
		if (u.pathname.includes('/shorts/')) return u.pathname.split('/shorts/')[1].split('/')[0];
		return u.searchParams.get('v') || '';
	} catch { return ''; }
}

async function fetchYouTubeContent(targetUrl: string, language?: string): Promise<DefuddleResponse> {
	const videoId = getYouTubeVideoId(targetUrl);
	if (!videoId) throw new Error('Could not extract YouTube video ID');

	let title = '';
	let author = '';

	try {
		const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`;
		const resp = await fetch(oEmbedUrl, { signal: AbortSignal.timeout(4000) });
		if (resp.ok) {
			const data = await resp.json() as any;
			title = data.title || '';
			author = data.author_name || '';
		}
	} catch {
		// oEmbed failed — proceed with empty metadata
	}

	const schemaOrg = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'VideoObject',
		name: title,
		author,
	});
	const pageTitle = title ? `${title} - YouTube` : 'YouTube';
	const minimalHtml = `<!DOCTYPE html><html><head><title>${pageTitle}</title><script type="application/ld+json">${schemaOrg}<\/script></head><body></body></html>`;

	const doc = parseLinkedomHTML(minimalHtml, targetUrl);
	const defuddle = new Defuddle(doc, { url: targetUrl, language });
	return await defuddle.parseAsync();
}

async function fetchPage(targetUrl: string, language?: string): Promise<string> {
	const ua = getUA(targetUrl);
	const headers: Record<string, string> = {
		'User-Agent': ua,
		'Accept': 'text/html,application/xhtml+xml',
		'Accept-Language': language || 'en-US,en;q=0.9',
	};

	const response = await fetch(targetUrl, {
		headers,
		signal: AbortSignal.timeout(10000),
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch page: ${response.status} ${response.statusText}`);
	}

	return response.text();
}

function getUA(targetUrl: string): string {
	const hostname = new URL(targetUrl).hostname;
	// Use bot UA for GitHub to get SSR content
	if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
		return 'Mozilla/5.0 (compatible; Defuddle/1.0; bot)';
	}
	return 'Mozilla/5.0 (compatible; Defuddle/1.0; +https://defuddle.md)';
}

function quoteYamlString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatResponse(result: DefuddleResponse, sourceUrl: string): string {
	const frontmatter: string[] = ['---'];
	if (result.title) frontmatter.push(`title: ${quoteYamlString(result.title)}`);
	if (result.author) frontmatter.push(`author: ${quoteYamlString(result.author)}`);
	if (result.site) frontmatter.push(`site: ${quoteYamlString(result.site)}`);
	if (result.published) frontmatter.push(`published: ${result.published}`);
	frontmatter.push(`source: ${quoteYamlString(sourceUrl)}`);
	if (result.domain) frontmatter.push(`domain: ${quoteYamlString(result.domain)}`);
	if (result.language) frontmatter.push(`language: ${quoteYamlString(result.language)}`);
	if (result.description) frontmatter.push(`description: ${quoteYamlString(result.description)}`);
	frontmatter.push(`word_count: ${result.wordCount}`);
	frontmatter.push('---');
	return frontmatter.join('\n') + '\n\n' + (result.content || '');
}

// --- Landing page ---

function getLandingPage(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Defuddle — Extract article content as Markdown</title>
	<meta name="description" content="Get the main content of any page as clean, readable Markdown.">
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
			background: #100F0F;
			color: #B7B5AC;
			min-height: 100vh;
		}
		.hero {
			min-height: 70vh;
			display: flex;
			align-items: flex-start;
			justify-content: center;
			padding-top: 22.5vh;
			padding-bottom: 7.5vh;
		}
		.hero-inner {
			max-width: 600px;
			width: 100%;
			padding: 2rem;
		}
		.divider { border: none; border-top: 1px solid #343331; }
		.bottom {
			max-width: 600px;
			width: 100%;
			margin: 0 auto;
			padding: 3rem 2rem;
		}
		h1 {
			font-size: 2rem;
			font-weight: 700;
			margin-bottom: 0.5rem;
			color: #F2F0E5;
		}
		.subtitle {
			color: #878580;
			margin-bottom: 2rem;
			font-size: 1.1rem;
		}
		form {
			display: flex;
			gap: 0.5rem;
		}
		input {
			flex: 1;
			padding: 0.75rem 1rem;
			font-size: 1rem;
			border: 1px solid #343331;
			border-radius: 8px;
			background: #1C1B1A;
			color: #F2F0E5;
			outline: none;
		}
		input:focus { border-color: #575653; }
		input::placeholder { color: #575653; }
		button {
			padding: 0.75rem 1.5rem;
			font-size: 1rem;
			border: none;
			border-radius: 8px;
			background: #F2F0E5;
			color: #1C1B1A;
			font-weight: 600;
			cursor: pointer;
		}
		button:hover { background: #B7B5AC; }
		.api-note {
			padding: 1.5rem;
			background: #1C1B1A;
			border-radius: 8px;
			font-size: 0.9rem;
			color: #878580;
			line-height: 1.5;
		}
		.api-note p + p { margin-top: 0.75rem; }
		.api-note code {
			background: #343331;
			padding: 0.15rem 0.4rem;
			border-radius: 4px;
			font-size: 0.85rem;
			color: #B7B5AC;
		}
		footer {
			text-align: center;
			padding: 2rem;
			color: #575653;
			font-size: 0.85rem;
		}
		footer a { color: #878580; text-decoration: none; }
		footer a:hover { text-decoration: underline; }
		@media (max-width: 480px) {
			form { flex-direction: column; }
			button { width: 100%; }
		}
	</style>
</head>
<body>
	<div class="hero">
		<div class="hero-inner">
			<h1>Defuddle</h1>
			<p class="subtitle">Extract article content as clean Markdown.</p>
			<form id="form">
				<input
					type="text"
					id="url"
					placeholder="https://example.com/article"
					autocomplete="off"
					autofocus
				/>
				<button type="submit">Extract</button>
			</form>
		</div>
	</div>
	<hr class="divider">
	<div class="bottom">
		<div class="api-note">
			<p><strong>API Usage</strong></p>
			<p><code>curl https://defuddle-free.877781132.workers.dev/stephango.com/saw</code></p>
			<p>Append any URL path to convert it to Markdown. Use /html/ prefix for HTML output.</p>
		</div>
		<div class="api-note" style="margin-top: 1rem;">
			<p><strong>Bookmarklet</strong></p>
			<p>Drag this to your bookmarks bar: <a href="javascript:void(location.href=location.origin+'/'+location.href.replace(/^https?:\\/\\//,''))" style="display: inline-block; padding: 0.4rem 0.8rem; background: #343331; color: #F2F0E5; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 0.85rem; cursor: grab;">Defuddle</a></p>
		</div>
	</div>
	<footer>
		Based on <a href="https://github.com/kepano/defuddle">Defuddle</a> ·
		<a href="https://github.com/hhhaiai/defuddle">Deploy your own</a>
	</footer>
	<script>
		document.getElementById('form').addEventListener('submit', function(e) {
			e.preventDefault();
			var url = document.getElementById('url').value.trim();
			if (url) {
				url = url.replace(/^https?:\\/\\//, '');
				window.location.href = '/' + url;
			}
		});
	</script>
</body>
</html>`;
}

// --- Markdown Viewer Page ---

export function getMarkdownViewerPage(markdown: string, metadata: PageMetadata, options: ViewerPageOptions = {}): string {
	const title = metadata.title || metadata.domain || 'Document';
	const baiduUploadEndpoint = options.baiduUploadEndpoint || 'https://image.baidu.com/aigc/pic_upload';
	const retryDelaysMs = options.retryDelaysMs || [1500, 5000, 15000];

	return `<!DOCTYPE html>
<html lang="${metadata.language || 'en'}">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escapeHtml(title)} - Defuddle</title>
	<meta name="description" content="${escapeHtml(metadata.description || '')}">
	<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📄</text></svg>">
	<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
	<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github.min.css">
	<style>
		:root {
			--bg: #f5f7fb;
			--panel: #ffffff;
			--text: #1f2937;
			--muted: #64748b;
			--line: #dbe2ea;
			--primary: #0f172a;
			--header-h: 56px;
		}
		* { box-sizing: border-box; margin: 0; padding: 0; }
		html, body { height: 100%; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
			background: var(--bg);
			color: var(--text);
			display: flex;
			flex-direction: column;
		}
		.app-header {
			min-height: var(--header-h);
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			padding: 10px 18px;
			border-bottom: 1px solid var(--line);
			background: rgba(255, 255, 255, 0.95);
			backdrop-filter: blur(10px);
			position: sticky;
			top: 0;
			z-index: 30;
		}
		.brand-block { min-width: 0; }
		.brand-title { font-size: 16px; font-weight: 700; color: var(--primary); }
		.brand-subtitle { font-size: 11px; color: var(--muted); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		button {
			border: 1px solid var(--line);
			background: var(--panel);
			color: var(--text);
			border-radius: 8px;
			cursor: pointer;
			padding: 8px 14px;
			font-size: 13px;
			font-weight: 500;
			transition: background 0.15s ease, border-color 0.15s ease;
		}
		button:hover { background: #f8fafc; border-color: #cbd5e1; }
		button.primary { background: var(--primary); color: #fff; border-color: var(--primary); }
		button.primary:hover { background: #1e293b; }
		.pane-actions {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.pane-btn {
			padding: 6px 10px;
			font-size: 12px;
		}
		.main-area {
			flex: 1;
			min-height: 0;
			display: flex;
			align-items: stretch;
			gap: 12px;
			padding: 12px 18px 20px;
		}
		.editor-pane, .preview-pane {
			min-width: 0;
			min-height: 0;
			display: flex;
			flex-direction: column;
			background: rgba(255, 255, 255, 0.96);
			border: 1px solid #dde6f0;
			border-radius: 14px;
			box-shadow: 0 4px 16px rgba(15, 23, 42, 0.04);
			overflow: hidden;
		}
		.editor-pane { flex: 0 0 48%; }
		.preview-pane { flex: 1 1 0; }
		.pane-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 10px 14px;
			border-bottom: 1px solid #e7edf5;
			background: linear-gradient(180deg, #fbfdff 0%, #f7f9fc 100%);
			font-size: 12px;
			font-weight: 600;
			color: var(--muted);
		}
		.pane-header-title {
			display: inline-flex;
			align-items: center;
			gap: 8px;
		}
		#md-input {
			flex: 1;
			width: 100%;
			min-height: 0;
			border: none;
			outline: none;
			resize: none;
			padding: 16px 18px;
			background: #fff;
			color: #0f172a;
			font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
			font-size: 14px;
			line-height: 1.7;
			tab-size: 2;
			white-space: pre;
			overflow: auto;
		}
		#md-input::selection { background: rgba(37, 99, 235, 0.18); }
		.preview-content {
			flex: 1;
			width: 100%;
			overflow: auto;
			padding: 18px 22px 28px;
		}
		.markdown-body {
			max-width: 780px;
			line-height: 1.75;
			color: #334155;
			word-break: break-word;
		}
		.markdown-body h1, .markdown-body h2, .markdown-body h3,
		.markdown-body h4, .markdown-body h5, .markdown-body h6 {
			color: #0f172a;
			scroll-margin-top: 70px;
			margin-top: 1.5em;
			margin-bottom: 0.5em;
			font-weight: 700;
		}
		.markdown-body h1 { font-size: 1.75em; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.3em; }
		.markdown-body h2 { font-size: 1.4em; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.25em; }
		.markdown-body h3 { font-size: 1.2em; }
		.markdown-body p { margin: 12px 0; }
		.markdown-body ul, .markdown-body ol { margin: 12px 0; padding-left: 24px; }
		.markdown-body li { margin: 4px 0; }
		.markdown-body blockquote {
			border-left: 4px solid #cbd5e1;
			margin: 12px 0;
			padding: 4px 0 4px 14px;
			color: #475569;
			background: #f8fafc;
		}
		.markdown-body pre {
			background: #0f172a;
			color: #e2e8f0;
			padding: 14px;
			border-radius: 10px;
			overflow: auto;
			font-size: 13px;
		}
		.markdown-body code {
			background: rgba(15, 23, 42, 0.06);
			padding: 0.15em 0.4em;
			border-radius: 5px;
			font-family: "SFMono-Regular", Consolas, monospace;
			font-size: 0.9em;
		}
		.markdown-body pre code {
			background: transparent;
			padding: 0;
			color: inherit;
		}
		.markdown-body table {
			width: 100%;
			border-collapse: collapse;
			display: block;
			overflow-x: auto;
			margin: 12px 0;
		}
		.markdown-body table th, .markdown-body table td {
			border: 1px solid #dbe2ea;
			padding: 8px 12px;
		}
		.markdown-body table th { background: #f8fafc; font-weight: 600; }
		.markdown-body table tr:nth-child(2n) { background: #f8fafc; }
		.markdown-body img, .markdown-body video { max-width: 100%; }
		.markdown-body a { color: #0f172a; }
		.markdown-body hr { border: none; border-top: 1px solid #e2e8f0; margin: 20px 0; }
		@media (max-width: 768px) {
			.main-area { flex-direction: column; padding: 8px 10px 16px; gap: 8px; }
			.editor-pane, .preview-pane { flex: 1 1 auto; min-height: 40vh; }
			.app-header { padding: 8px 12px; gap: 8px; }
			button { padding: 7px 10px; font-size: 12px; }
		}
		@media print {
			.app-header, .pane-header { display: none; }
			.main-area { display: block; padding: 0; }
			.editor-pane { display: none; }
			.preview-pane { border: none; box-shadow: none; }
			.preview-content { padding: 0; }
		}
	</style>
</head>
<body>
	<header class="app-header">
		<div class="brand-block">
			<div class="brand-title">Defuddle</div>
			<div class="brand-subtitle">${escapeHtml(metadata.source)}</div>
		</div>
	</header>
	<main class="main-area">
		<section class="editor-pane">
			<div class="pane-header">
				<span class="pane-header-title">Markdown</span>
				<div class="pane-actions">
					<span id="upload-status" style="font-size:11px;color:#64748b;"></span>
					<button id="copy-markdown-btn" class="pane-btn" type="button" onclick="copyMarkdown(event)" title="Copy markdown to clipboard">复制</button>
				</div>
			</div>
			<textarea id="md-input" spellcheck="false" autocomplete="off" autocapitalize="off">${escapeHtml(markdown)}</textarea>
		</section>
		<section class="preview-pane">
			<div class="pane-header">
				<span class="pane-header-title">Preview</span>
				<div class="pane-actions">
					<button id="export-word-btn" class="pane-btn primary" type="button" onclick="exportWord(event)" title="Save as Word document">保存成 Word</button>
				</div>
			</div>
			<div class="preview-content">
				<div id="md-preview" class="markdown-body"></div>
			</div>
		</section>
	</main>

	<script src="https://cdn.jsdelivr.net/npm/markdown-it@14/dist/markdown-it.min.js"></script>
	<script src="https://cdn.jsdelivr.net/npm/highlightjs@11/build/highlight.min.js"></script>
	<script>
		// Inline FileSaver (minimal implementation for blob download)
		var saveAs = function(data, filename) {
			var url = URL.createObjectURL(data);
			var link = document.createElement('a');
			link.href = url;
			link.download = filename;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
		};
		const mdInput = document.getElementById('md-input');
		const uploadStatus = document.getElementById('upload-status');
		const sourceUrl = ${JSON.stringify(metadata.source)};
		const baiduUploadEndpoint = ${JSON.stringify(baiduUploadEndpoint)};
		const retryDelaysMs = ${JSON.stringify(retryDelaysMs)};
		const uploadTasks = new Map();
		let renderTimer = null;
		let uploadScanTimer = null;

		function escapeHtml(str) {
			return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		}

		function getCurrentMarkdown() {
			return mdInput.value;
		}

		function setCurrentMarkdown(nextMarkdown) {
			if (typeof nextMarkdown !== 'string' || nextMarkdown === mdInput.value) return;
			const selectionStart = mdInput.selectionStart;
			const selectionEnd = mdInput.selectionEnd;
			mdInput.value = nextMarkdown;
			if (document.activeElement === mdInput && Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) {
				const nextStart = Math.min(selectionStart, mdInput.value.length);
				const nextEnd = Math.min(selectionEnd, mdInput.value.length);
				mdInput.setSelectionRange(nextStart, nextEnd);
			}
		}

		function getDownloadBaseName() {
			const match = getCurrentMarkdown().match(/^title:\\s*"?(.+?)"?$/m);
			const fallback = ${JSON.stringify(title)};
			return (match ? match[1] : fallback).replace(/[^a-z0-9\\u4e00-\\u9fa5\\s\\-_.]/gi, '_').trim() || 'document';
		}

		function setButtonFeedback(button, temporaryText) {
			if (!button) return;
			const originalText = button.textContent;
			button.textContent = temporaryText;
			button.disabled = true;
			setTimeout(() => {
				button.textContent = originalText;
				button.disabled = false;
				}, 1200);
		}

		function updateUploadStatus() {
			if (!uploadStatus) return;
			let uploading = 0;
			let retrying = 0;
			let completed = 0;
			for (const task of uploadTasks.values()) {
				if (task.status === 'uploading') uploading++;
				if (task.status === 'retrying') retrying++;
				if (task.status === 'done') completed++;
			}

			if (uploading > 0) {
				uploadStatus.textContent = completed > 0 ? \`上传中 · 已替换 \${completed} 张\` : '上传图片中...';
				return;
			}
			if (retrying > 0) {
				uploadStatus.textContent = completed > 0 ? \`已替换 \${completed} 张，失败项重试中\` : '图片上传重试中...';
				return;
			}
			uploadStatus.textContent = completed > 0 ? \`已替换 \${completed} 张图\` : '';
		}

		function stripFrontmatter(markdown) {
			return markdown.replace(/^---\\n[\\s\\S]*?\\n---\\n*/, '');
		}

		function renderMarkdown() {
			const preview = document.getElementById('md-preview');
			if (!window.markdownit) {
				preview.innerHTML = '<p style="color:#64748b;">Loading renderer...</p>';
				return;
			}
			try {
				const bodyMarkdown = stripFrontmatter(getCurrentMarkdown());
				const md = window.markdownit({
					html: true,
					linkify: true,
					typographer: true,
					breaks: false,
					highlight: function(str, lang) {
						if (lang && window.hljs && window.hljs.getLanguage(lang)) {
							try {
								return '<pre><code class="hljs language-' + escapeHtml(lang) + '">' + window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + '</code></pre>';
							} catch (e) {}
						}
						return '<pre><code>' + escapeHtml(str) + '</code></pre>';
					}
				});
				const html = md.render(bodyMarkdown);
				preview.innerHTML = html;
			} catch (e) {
				preview.innerHTML = '<p style="color:#b91c1c;">Render error: ' + escapeHtml(e.message) + '</p>';
			}
		}

		function escapeRegExp(value) {
			return String(value).replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
		}

		function guessMimeTypeFromUrl(imageUrl) {
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

		function shouldUploadImage(imageUrl) {
			try {
				const parsed = new URL(imageUrl);
				if (!['http:', 'https:'].includes(parsed.protocol)) return false;
				if (parsed.hostname.includes('baidu.com') || parsed.hostname.includes('bcebos.com')) return false;
				return true;
			} catch {
				return false;
			}
		}

		function extractMarkdownImageCandidates(markdown) {
			const candidates = new Map();
			const remember = (rawUrl) => {
				if (!rawUrl) return;
				const candidate = String(rawUrl).trim();
				if (!candidate) return;
				let resolved = candidate;
				try {
					resolved = new URL(candidate, sourceUrl).toString();
				} catch {
					return;
				}
				if (!shouldUploadImage(resolved)) return;
				if (!candidates.has(candidate)) candidates.set(candidate, resolved);
			};

			for (const match of markdown.matchAll(/!\\[[^\\]]*\\]\\(([^)\\s]+)(?:\\s+["'][^"']*["'])?\\)/g)) {
				remember(match[1]);
			}
			for (const match of markdown.matchAll(/\\b(?:src|poster)=["']([^"']+)["']/g)) {
				remember(match[1]);
			}
			return candidates;
		}

		async function md5(str) {
			const msg = new TextEncoder().encode(str);
			const ml = msg.length;
			const newLen = Math.ceil((ml + 9) / 64) * 64;
			const padded = new Uint8Array(newLen);
			padded.set(msg);
			padded[ml] = 0x80;
			const view = new DataView(padded.buffer);
			view.setUint32(newLen - 4, ml * 8, false);

			const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
			const K = new Uint32Array(64);
			for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

			let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

			for (let i = 0; i < newLen / 64; i++) {
				const M = new Uint32Array(16);
				for (let j = 0; j < 16; j++) M[j] = view.getUint32((i * 64 + j * 4), false);
				let A = a0, B = b0, C = c0, D = d0;
				for (let j = 0; j < 64; j++) {
					let F, g;
					if (j < 16) { F = (B & C) | (~B & D); g = j; }
					else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
					else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
					else { F = C ^ (B | ~D); g = (7 * j) % 16; }
					const temp = ((A + F + K[j] + M[g]) << S[j]) | ((A + F + K[j] + M[g]) >>> (32 - S[j]));
					A = D; D = C; C = B; B = (B + temp) >>> 0;
				}
				a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
			}

			return [a0, b0, c0, d0].map((value) => value.toString(16).padStart(8, '0')).join('');
		}

		async function uploadImageToBaidu(imageUrl) {
			try {
				// Call Worker API endpoint instead of Baidu directly (avoids CORS)
				const response = await fetch('/api/upload-image', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ url: imageUrl }),
					signal: AbortSignal.timeout(60000),
				});
				if (!response.ok) throw new Error('Upload failed: ' + response.status);
				const result = await response.json();
				return result?.url || null;
			} catch (error) {
				console.warn('Baidu image upload failed:', imageUrl, error);
				return null;
			}
		}

		function replaceMarkdownImageUrl(originalUrl, newUrl) {
			const current = getCurrentMarkdown();
			if (!current.includes(originalUrl)) return;
			setCurrentMarkdown(current.replace(new RegExp(escapeRegExp(originalUrl), 'g'), newUrl));
			renderMarkdown();
		}

		function queueRetry(candidate, resolvedUrl, attempt) {
			const delay = retryDelaysMs[attempt];
			if (delay == null) {
				uploadTasks.set(candidate, { status: 'failed', attempt });
				updateUploadStatus();
				return;
			}
			uploadTasks.set(candidate, { status: 'retrying', attempt });
			updateUploadStatus();
			setTimeout(() => {
				startUpload(candidate, resolvedUrl, attempt + 1);
			}, delay);
		}

		async function startUpload(candidate, resolvedUrl, attempt = 0) {
			const existingTask = uploadTasks.get(candidate);
			if (existingTask?.status === 'uploading' || existingTask?.status === 'done') return;

			uploadTasks.set(candidate, { status: 'uploading', attempt });
			updateUploadStatus();

			const baiduUrl = await uploadImageToBaidu(resolvedUrl);
			if (!baiduUrl) {
				queueRetry(candidate, resolvedUrl, attempt);
				return;
			}

			uploadTasks.set(candidate, { status: 'done', attempt, baiduUrl });
			replaceMarkdownImageUrl(candidate, baiduUrl);
			updateUploadStatus();
		}

		function scanAndStartUploads() {
			const candidates = extractMarkdownImageCandidates(getCurrentMarkdown());
			for (const [candidate, resolvedUrl] of candidates.entries()) {
				const existingTask = uploadTasks.get(candidate);
				if (existingTask?.status === 'uploading' || existingTask?.status === 'retrying' || existingTask?.status === 'done') {
					continue;
				}
				startUpload(candidate, resolvedUrl, existingTask?.attempt || 0);
			}
			updateUploadStatus();
		}

		function scheduleRender() {
			clearTimeout(renderTimer);
			renderTimer = setTimeout(() => renderMarkdown(), 150);
			clearTimeout(uploadScanTimer);
			uploadScanTimer = setTimeout(() => scanAndStartUploads(), 600);
		}

		mdInput.addEventListener('input', scheduleRender);

		async function copyMarkdown(event) {
			try {
				await navigator.clipboard.writeText(getCurrentMarkdown());
				setButtonFeedback(event?.currentTarget || event?.target, '已复制');
			} catch (e) {
				alert('Failed to copy: ' + e.message);
			}
		}

		function dataUrlToUint8Array(dataUrl) {
			const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
			if (!match) return null;
			const base64 = match[2];
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			return { bytes, mime: match[1] };
		}

		function guessImageType(value, mimeHint) {
			const source = (mimeHint || value || '').toLowerCase();
			if (source.includes('png')) return 'png';
			if (source.includes('jpeg') || source.includes('jpg')) return 'jpeg';
			if (source.includes('gif')) return 'gif';
			if (source.includes('webp')) return 'webp';
			return undefined;
		}

		async function getImageData(src) {
			if (!src) return null;
			const inlineData = dataUrlToUint8Array(src);
			if (inlineData) {
				return { bytes: inlineData.bytes, type: guessImageType(src, inlineData.mime) };
			}

			try {
				const response = await fetch(src);
				if (!response.ok) return null;
				const mime = response.headers.get('content-type') || '';
				const buffer = await response.arrayBuffer();
				return { bytes: new Uint8Array(buffer), type: guessImageType(src, mime) };
			} catch {
				return null;
			}
		}

		function splitTextToRuns(text, options = {}, docx) {
			const { TextRun } = docx;
			const normalized = String(text || '').replace(/\\r\\n/g, '\\n');
			const lines = normalized.split('\\n');
			const runs = [];
			lines.forEach((line, idx) => {
				runs.push(new TextRun({ text: line, ...options }));
				if (idx < lines.length - 1) runs.push(new TextRun({ break: 1 }));
			});
			return runs;
		}

		async function inlineNodeToDocxRunsAsync(node, inherited = {}, docx) {
			const { TextRun, ImageRun, ExternalHyperlink } = docx;
			if (!node) return [];
			if (node.nodeType === Node.TEXT_NODE) return splitTextToRuns(node.textContent || '', inherited, docx);
			if (node.nodeType !== Node.ELEMENT_NODE) return [];

			const tag = (node.tagName || '').toUpperCase();
			if (tag === 'BR') return [new TextRun({ break: 1 })];

			if (tag === 'IMG') {
				const src = node.getAttribute('src') || '';
				const imageData = await getImageData(src);
				if (!imageData) {
					const altText = node.getAttribute('alt') || src;
					return [new TextRun({ text: altText ? '[Image] ' + altText : '[Image]', italics: true, color: '64748B' })];
				}
				const widthAttr = parseInt(node.getAttribute('width') || '', 10);
				const heightAttr = parseInt(node.getAttribute('height') || '', 10);
				const naturalWidth = Number.isFinite(widthAttr) ? widthAttr : 480;
				const naturalHeight = Number.isFinite(heightAttr) ? heightAttr : 320;
				const maxW = 560;
				const ratio = naturalHeight > 0 ? naturalWidth / naturalHeight : 1.5;
				const targetWidth = Math.min(Math.max(naturalWidth, 60), maxW);
				const targetHeight = Math.round(targetWidth / ratio);
				return [new ImageRun({ data: imageData.bytes, transformation: { width: targetWidth, height: targetHeight }, type: imageData.type })];
			}

			if (tag === 'A') {
				const href = node.getAttribute('href');
				const children = [];
				for (const child of Array.from(node.childNodes || [])) {
					children.push(...await inlineNodeToDocxRunsAsync(child, { ...inherited, style: undefined, color: '0563C1', underline: {} }, docx));
				}
				if (href) {
					return [new ExternalHyperlink({ link: href, children })];
				}
				return children;
			}

			const next = { ...inherited };
			if (tag === 'STRONG' || tag === 'B') next.bold = true;
			if (tag === 'EM' || tag === 'I') next.italics = true;
			if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') next.strike = true;
			if (tag === 'CODE') next.font = next.font || 'Courier New';

			const runs = [];
			for (const child of Array.from(node.childNodes || [])) {
				runs.push(...await inlineNodeToDocxRunsAsync(child, next, docx));
			}
			return runs;
		}

		async function inlineContainerToDocxRunsAsync(container, inherited = {}, docx) {
			const { TextRun } = docx;
			if (!container) return [new TextRun({ text: '' })];
			const runs = [];
			for (const child of Array.from(container.childNodes || [])) {
				runs.push(...await inlineNodeToDocxRunsAsync(child, inherited, docx));
			}
			if (!runs.length) runs.push(new TextRun({ text: '' }));
			return runs;
		}

		function headingLevelForTag(tagName, docx) {
			const { HeadingLevel } = docx;
			switch ((tagName || '').toUpperCase()) {
				case 'H1': return HeadingLevel.HEADING_1;
				case 'H2': return HeadingLevel.HEADING_2;
				case 'H3': return HeadingLevel.HEADING_3;
				case 'H4': return HeadingLevel.HEADING_4;
				case 'H5': return HeadingLevel.HEADING_5;
				case 'H6': return HeadingLevel.HEADING_6;
				default: return undefined;
			}
		}

		async function htmlElementToDocxBlocks(rootEl, docx) {
			const { Paragraph, Table, TableRow, TableCell, WidthType, ImageRun, AlignmentType, BorderStyle, TableLayoutType, TextRun } = docx;
			const blocks = [];

			const walkChildren = async (container) => {
				const children = Array.from(container.childNodes || []);
				for (const node of children) {
					if (node.nodeType === Node.TEXT_NODE) {
						const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
						if (text) blocks.push(new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text })], spacing: { after: 120 } }));
						continue;
					}
					if (node.nodeType !== Node.ELEMENT_NODE) continue;
					const tag = node.tagName.toUpperCase();
					if (tag === 'BR') { blocks.push(new Paragraph({ text: '' })); continue; }

					if (/^H[1-6]$/.test(tag)) {
						blocks.push(new Paragraph({
							children: await inlineContainerToDocxRunsAsync(node, {}, docx),
							heading: headingLevelForTag(tag, docx),
							alignment: AlignmentType.LEFT,
							spacing: { after: 180 }
						}));
						continue;
					}

					if (tag === 'P' || tag === 'DIV') {
						const hasBlockChildren = Array.from(node.children || []).some(el => {
							const t = (el.tagName || '').toUpperCase();
							return ['TABLE', 'PRE', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE'].includes(t);
						});
						if (!hasBlockChildren) {
							blocks.push(new Paragraph({ alignment: AlignmentType.LEFT, children: await inlineContainerToDocxRunsAsync(node, {}, docx), spacing: { after: 120 } }));
						} else {
							await walkChildren(node);
						}
						continue;
					}

					if (tag === 'PRE') {
						const code = (node.innerText || node.textContent || '').replace(/^\\n+|\\n+$/g, '');
						if (code) {
							blocks.push(new Table({
								width: { size: 100, type: WidthType.PERCENTAGE },
								layout: TableLayoutType.FIXED,
								rows: [new TableRow({ children: [new TableCell({
									width: { size: 100, type: WidthType.PERCENTAGE },
									shading: { fill: '0F172A' },
									borders: {
										top: { style: BorderStyle.SINGLE, size: 1, color: '1E293B' },
										bottom: { style: BorderStyle.SINGLE, size: 1, color: '1E293B' },
										left: { style: BorderStyle.SINGLE, size: 1, color: '1E293B' },
										right: { style: BorderStyle.SINGLE, size: 1, color: '1E293B' }
									},
									children: [new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 40 }, children: splitTextToRuns(code, { font: 'Courier New', color: 'E2E8F0' }, docx) })]
								})] })]
							}));
							blocks.push(new Paragraph({ text: '' }));
						}
						continue;
					}

					if (tag === 'UL' || tag === 'OL') {
						const isOrdered = tag === 'OL';
						const items = Array.from(node.children || []).filter(c => (c.tagName || '').toUpperCase() === 'LI');
						let idx = 1;
						for (const li of items) {
							const hasText = (li.innerText || li.textContent || '').trim();
							if (!hasText) continue;
							const prefixRuns = isOrdered ? [new TextRun({ text: idx++ + '. ' })] : [];
							blocks.push(new Paragraph({
								children: [...prefixRuns, ...await inlineContainerToDocxRunsAsync(li, {}, docx)],
								bullet: isOrdered ? undefined : { level: 0 },
								alignment: AlignmentType.LEFT,
								spacing: { after: 60 }
							}));
						}
						continue;
					}

					if (tag === 'IMG') {
						const src = node.getAttribute('src') || '';
						const imageData = await getImageData(src);
						if (imageData) {
							const widthAttr = parseInt(node.getAttribute('width') || '', 10);
							const heightAttr = parseInt(node.getAttribute('height') || '', 10);
							const naturalWidth = Number.isFinite(widthAttr) ? widthAttr : 480;
							const naturalHeight = Number.isFinite(heightAttr) ? heightAttr : 320;
							const maxW = 560;
							const ratio = naturalHeight > 0 ? naturalWidth / naturalHeight : 1.5;
							const targetWidth = Math.min(Math.max(naturalWidth, 60), maxW);
							const targetHeight = Math.round(targetWidth / ratio);
							blocks.push(new Paragraph({
								alignment: AlignmentType.CENTER,
								children: [new ImageRun({ data: imageData.bytes, transformation: { width: targetWidth, height: targetHeight }, type: imageData.type })],
								spacing: { after: 180 }
							}));
						}
						continue;
					}

					if (tag === 'TABLE') {
						const rows = [];
						const trEls = Array.from(node.querySelectorAll('tr'));
						const firstRowCells = trEls.length ? Array.from(trEls[0].children || []).filter(c => ['TD', 'TH'].includes((c.tagName || '').toUpperCase())) : [];
						const tableColCount = Math.max(firstRowCells.length, 1);
						const tableColWidth = Math.floor(9360 / tableColCount);
						const columnWidths = new Array(tableColCount).fill(tableColWidth);

						for (const tr of trEls) {
							const cellEls = Array.from(tr.children || []).filter(c => ['TD', 'TH'].includes((c.tagName || '').toUpperCase()));
							const normalizedCells = [];
							for (let i = 0; i < tableColCount; i++) {
								const cellEl = cellEls[i];
								const isHeader = cellEl ? (cellEl.tagName || '').toUpperCase() === 'TH' : false;
								const cellRuns = cellEl ? await inlineContainerToDocxRunsAsync(cellEl, isHeader ? { bold: true } : {}, docx) : [new TextRun({ text: '' })];
								normalizedCells.push(new TableCell({
									width: { size: columnWidths[i], type: WidthType.DXA },
									borders: {
										top: { style: BorderStyle.SINGLE, size: 1, color: '999999' },
										bottom: { style: BorderStyle.SINGLE, size: 1, color: '999999' },
										left: { style: BorderStyle.SINGLE, size: 1, color: '999999' },
										right: { style: BorderStyle.SINGLE, size: 1, color: '999999' }
									},
									children: [new Paragraph({ alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT, children: cellRuns, spacing: { after: 60 } })]
								}));
							}
							if (normalizedCells.length) rows.push(new TableRow({ children: normalizedCells }));
						}
						if (rows.length) {
							blocks.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED, columnWidths, rows }));
							blocks.push(new Paragraph({ text: '' }));
						}
						continue;
					}

					if (tag === 'BLOCKQUOTE') {
						blocks.push(new Paragraph({
							alignment: AlignmentType.LEFT,
							children: await inlineContainerToDocxRunsAsync(node, { italics: true }, docx),
							spacing: { after: 120 },
							border: { left: { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' } }
						}));
						continue;
					}

					await walkChildren(node);
				}
			};

			await walkChildren(rootEl);
			return blocks;
		}

		async function exportWord(event) {
			const button = event?.currentTarget || event?.target;
			setButtonFeedback(button, '加载中...');
			try {
				const preview = document.getElementById('md-preview');
				const fileBaseName = getDownloadBaseName();

				// Dynamic import docx from CDN
				const docx = await import('https://esm.sh/docx@8');

				const clone = preview.cloneNode(true);
				clone.querySelectorAll('svg').forEach((el) => el.remove());
				const blocks = await htmlElementToDocxBlocks(clone, docx);
				if (!blocks.length) {
					blocks.push(new docx.Paragraph({ text: getCurrentMarkdown() || fileBaseName }));
				}
				const doc = new docx.Document({
					sections: [{ properties: {}, children: blocks }]
				});
				const blob = await docx.Packer.toBlob(doc);
				saveAs(blob, fileBaseName + '.docx');
				setButtonFeedback(button, '已保存');
			} catch (e) {
				alert('Export failed: ' + (e?.message || String(e)));
				setButtonFeedback(button, '失败');
			}
		}

		renderMarkdown();
		scanAndStartUploads();
	</script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
