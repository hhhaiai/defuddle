import { describe, expect, test } from 'vitest';
import { Defuddle } from '../website-free/src/defuddle';
import { parseLinkedomHTML } from '../website-free/src/utils/linkedom-compat';

const TARGET_URL = 'https://x.com/kfk_ai/status/2068516795464732994';

const FXTWITTER_ARTICLE_RESPONSE = {
	code: 200,
	tweet: {
		text: '',
		author: {
			name: 'Kafka',
			screen_name: 'kfk_ai',
		},
		created_at: '2026-06-21T02:10:09.000Z',
		article: {
			title: 'IPv4 与 IPv6：从日常上网到科学上网，它们有什么不同？',
			preview_text: '你每天打开手机刷视频、连 Wi-Fi、访问网站，背后都离不开一个东西——IP 地址。',
			created_at: '2026-06-21T02:10:09.000Z',
			cover_media: {
				media_info: {
					original_img_url: 'https://pbs.twimg.com/media/HLTY2xLaIAA6YLI.jpg',
				},
			},
			content: {
				blocks: [
					{
						key: 'intro',
						text: '你每天打开手机刷视频、连 Wi-Fi、访问网站，背后都离不开一个东西——IP 地址。',
						type: 'unstyled',
						inlineStyleRanges: [],
						entityRanges: [],
						data: {},
					},
					{
						key: 'h2',
						text: '先搞懂基础：IPv4 和 IPv6 到底是什么？',
						type: 'header-two',
						inlineStyleRanges: [],
						entityRanges: [],
						data: {},
					},
				],
				entityMap: [],
			},
			media_entities: [],
		},
	},
};

function mockFetch(input: RequestInfo | URL): Promise<Response> {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
	if (url.includes('api.fxtwitter.com')) {
		return Promise.resolve(new Response(JSON.stringify(FXTWITTER_ARTICLE_RESPONSE), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}));
	}
	return Promise.reject(new Error(`unexpected fetch: ${url}`));
}

describe('website-free X article extraction', () => {
	test('prefers FxTwitter article extraction even when X status HTML has a non-empty card preview', async () => {
		const html = `<!DOCTYPE html>
			<html lang="zh-cn">
			<head>
				<title>Kafka (@kfk_ai) on X</title>
				<meta property="og:title" content="Kafka (@kfk_ai) on X">
				<meta property="og:description" content="https://t.co/7B168kwAs7">
			</head>
			<body>
				<main>
					<p>Article</p>
					<a href="https://x.com/i/article/2068242746150998016">
						<h2>IPv4 与 IPv6：从日常上网到科学上网，它们有什么不同？</h2>
						<p>你每天打开手机刷视频、连 Wi-Fi、访问网站，背后都离不开一个东西——IP 地址。但这里只是卡片预览，不是完整文章。</p>
					</a>
				</main>
			</body>
			</html>`;

		const doc = parseLinkedomHTML(html, TARGET_URL);
		const result = await new Defuddle(doc, { url: TARGET_URL, fetch: mockFetch }).parseAsync();

		expect(result.title).toBe(FXTWITTER_ARTICLE_RESPONSE.tweet.article.title);
		expect(result.author).toBe('@kfk_ai');
		expect(result.description).toBe(FXTWITTER_ARTICLE_RESPONSE.tweet.article.preview_text);
		expect(result.content).toContain('先搞懂基础：IPv4 和 IPv6 到底是什么？');
		expect(result.content).toContain('https://pbs.twimg.com/media/HLTY2xLaIAA6YLI.jpg');
	});
});
