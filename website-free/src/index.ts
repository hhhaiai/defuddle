import './polyfill';
import { parseLinkedomHTML } from './utils/linkedom-compat';
import { Defuddle } from './defuddle';
import { toMarkdown } from './markdown';
import { countWords } from './utils';
import type { DefuddleResponse } from './types';

const PRIMARY_HOSTS = ['defuddle.md', 'simitalk.de5.net', 'github.io'];
const BLOCKED_HOSTS = [...PRIMARY_HOSTS, 'defuddle.dev', 'localhost'];

const STATIC_PAGES = new Set(['/', '', '/favicon.ico']);
const CACHE_TTL = 300; // 5 minutes

type Env = {
	// No external dependencies needed for free version
};

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

// --- Main request handler ---

async function handleRequest(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const path = url.pathname;

	// --- Landing page ---
	if (path === '/' || path === '') {
		return htmlResponse(getLandingPage());
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

	if (url.search) {
		targetUrl += url.search;
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

	// Build cache key
	const cacheUrl = new URL(targetUrl, 'https://defuddle.md');
	if (htmlMode) cacheUrl.searchParams.set('_fmt', 'html');
	if (language) cacheUrl.searchParams.set('_lang', language);
	const cacheKey = new Request(cacheUrl.toString());

	// Check cache
	const cachedResponse = await caches.default.match(cacheKey);
	if (cachedResponse) {
		return cachedResponse;
	}

	try {
		const result = await convertUrl(targetUrl, language);
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

async function convertUrl(targetUrl: string, language?: string): Promise<DefuddleResponse> {
	// Check for YouTube URL
	if (isYouTubeUrl(targetUrl)) {
		return fetchYouTubeContent(targetUrl, language);
	}

	// Fetch the page
	const html = await fetchPage(targetUrl, language);
	const doc = parseLinkedomHTML(html, targetUrl);
	const defuddle = new Defuddle(doc, { url: targetUrl, language });
	const result = await defuddle.parseAsync();

	// Convert to markdown if not HTML mode
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

function formatResponse(result: DefuddleResponse, sourceUrl: string): string {
	const frontmatter: string[] = ['---'];
	if (result.title) frontmatter.push(`title: "${result.title.replace(/"/g, '\\"')}"`);
	if (result.author) frontmatter.push(`author: "${result.author.replace(/"/g, '\\"')}"`);
	if (result.site) frontmatter.push(`site: "${result.site}"`);
	if (result.published) frontmatter.push(`published: ${result.published}`);
	frontmatter.push(`source: ${sourceUrl}`);
	if (result.domain) frontmatter.push(`domain: ${result.domain}`);
	if (result.language) frontmatter.push(`language: ${result.language}`);
	if (result.description) frontmatter.push(`description: "${result.description.replace(/"/g, '\\"')}"`);
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
