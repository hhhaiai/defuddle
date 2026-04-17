export function getEditorPage(markdown: string, sourceUrl: string, title: string): string {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title || '编辑')} - Defuddle</title>
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
  <style>
    :root {
      --bg: #f5f7fb;
      --panel: #ffffff;
      --text: #1f2937;
      --muted: #64748b;
      --line: #dbe2ea;
      --primary: #0f172a;
      --primary-soft: #e2e8f0;
      --success: #0f766e;
      --warning: #b45309;
      --danger: #b91c1c;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--text);
      background: var(--bg);
      display: flex;
      flex-direction: column;
    }
    .header {
      min-height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,0.92);
      backdrop-filter: blur(10px);
      position: sticky;
      top: 0;
      z-index: 30;
      gap: 12px;
    }
    .header-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .header-actions {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }
    button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 8px;
      cursor: pointer;
      padding: 7px 12px;
      font-size: 13px;
      transition: all 0.15s;
    }
    button:hover { background: #f8fafc; border-color: #cbd5e1; }
    button:active { transform: translateY(1px); }
    button.primary { background: var(--primary); color: #fff; border-color: var(--primary); }
    button.primary:hover { background: #1e293b; }
    button.success { background: var(--success); color: #fff; border-color: var(--success); }
    button.success:hover { background: #0d6b62; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .main-area {
      flex: 1;
      display: flex;
      min-height: 0;
    }
    .editor-pane, .preview-pane {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .editor-pane { border-right: 1px solid var(--line); }
    .pane-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
      background: #fafbfc;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
    }
    .pane-header .badge {
      font-size: 11px;
      padding: 2px 6px;
      background: var(--primary-soft);
      border-radius: 4px;
      color: var(--primary);
    }
    #code {
      flex: 1;
      width: 100%;
      border: none;
      outline: none;
      resize: none;
      padding: 16px;
      background: #fff;
      color: #0f172a;
      font-family: "SF Mono", Consolas, "Liberation Mono", monospace;
      font-size: 14px;
      line-height: 1.6;
      tab-size: 2;
    }
    #preview {
      flex: 1;
      overflow: auto;
      padding: 16px 20px;
      background: #fff;
    }
    .markdown-body { max-width: 800px; margin: 0 auto; }
    .markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4 { margin: 1em 0 0.5em; }
    .markdown-body p { margin: 0.8em 0; line-height: 1.7; }
    .markdown-body pre { background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: 10px; overflow: auto; }
    .markdown-body code { background: rgba(15,23,42,0.06); padding: 0.15em 0.4em; border-radius: 4px; font-family: inherit; }
    .markdown-body pre code { background: transparent; padding: 0; }
    .markdown-body blockquote { border-left: 3px solid #cbd5e1; padding-left: 14px; color: #475569; margin: 1em 0; }
    .markdown-body img { max-width: 100%; border-radius: 8px; }
    .markdown-body table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    .markdown-body th,.markdown-body td { border: 1px solid #dbe2ea; padding: 8px 12px; text-align: left; }
    .markdown-body th { background: #f8fafc; font-weight: 600; }
    .toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #0f172a;
      color: #fff;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 13px;
      opacity: 0;
      transition: opacity 0.3s;
      z-index: 100;
    }
    .toast.show { opacity: 1; }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid #fff;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 768px) {
      .main-area { flex-direction: column; }
      .editor-pane { flex: 1; border-right: none; border-bottom: 1px solid var(--line); }
      .preview-pane { flex: 1; }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-title" title="${escapeHtml(sourceUrl)}">${escapeHtml(title || sourceUrl)}</div>
    <div class="header-actions">
      <button id="btn-copy" onclick="copyMarkdown()">复制 Markdown</button>
      <button id="btn-export" class="primary" onclick="exportDocx()">导出 DOCX</button>
    </div>
  </header>

  <div class="main-area">
    <section class="editor-pane">
      <div class="pane-header">
        <span>Markdown</span>
        <span class="badge" id="char-count">0 字符</span>
      </div>
      <textarea id="code" placeholder="输入 Markdown..." spellcheck="false"></textarea>
    </section>

    <section class="preview-pane">
      <div class="pane-header">
        <span>预览</span>
        <span class="badge" id="upload-status"></span>
      </div>
      <div id="preview" class="markdown-body"></div>
    </section>
  </div>

  <div id="toast" class="toast"></div>

  <script src="https://cdn.jsdelivr.net/npm/markdown-it@13.0.2/dist/markdown-it.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/core.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/javascript.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/python.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/languages/bash.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js"></script>

  <script>
    const sourceUrl = ${JSON.stringify(sourceUrl)};
    const initialMarkdown = ${JSON.stringify(markdown)};

    const md = window.markdownit({
      html: true,
      linkify: true,
      typographer: true,
      highlight: function (str, lang) {
        if (lang && window.hljs.getLanguage(lang)) {
          try {
            return '<pre class="hljs"><code>' + window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + '</code></pre>';
          } catch (e) {}
        }
        return '<pre class="hljs"><code>' + escapeHtml(str) + '</code></pre>';
      }
    });

    const code = document.getElementById('code');
    const preview = document.getElementById('preview');
    const charCount = document.getElementById('char-count');
    const toast = document.getElementById('toast');
    const uploadStatus = document.getElementById('upload-status');

    let renderTimer = null;
    let uploadingImages = false;

    function escapeHtml(str) {
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function showToast(msg, duration = 2000) {
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), duration);
    }

    function render() {
      const src = code.value;
      preview.innerHTML = md.render(src);
      charCount.textContent = src.length + ' 字符';

      // Render math with KaTeX
      if (window.renderMathInElement) {
        window.renderMathInElement(preview, {
          delimiters: [
            {left: '$$', right: '$$', display: true},
            {left: '$', right: '$', display: false},
            {left: '\\\\(', right: '\\\\)', display: false},
            {left: '\\\\[', right: '\\\\]', display: true}
          ],
          throwOnError: false
        });
      }

      // Highlight code blocks
      preview.querySelectorAll('pre code:not(.hljs)').forEach(block => {
        window.hljs.highlightElement(block);
      });
    }

    code.addEventListener('input', () => {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(render, 150);
    });

    async function copyMarkdown() {
      const btn = document.getElementById('btn-copy');
      const originalText = btn.textContent;
      try {
        btn.disabled = true;
        btn.textContent = '上传图片中...';

        // Upload images to Baidu first
        await uploadAllImages();

        // Re-render to get updated content
        render();
        await new Promise(r => setTimeout(r, 100));

        await navigator.clipboard.writeText(code.value);
        btn.textContent = '已复制!';
        setTimeout(() => btn.textContent = '复制 Markdown', 1500);
      } catch (e) {
        showToast('复制失败: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    }

    async function uploadImageToBaidu(imageUrl) {
      try {
        // Fetch image as blob
        const imgResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
        if (!imgResponse.ok) throw new Error('Failed to fetch image');
        const blob = await imgResponse.blob();

        // Convert to base64 (binary string approach for safe btoa)
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
        const picInfo = 'data:' + contentType + ';base64,' + base64;

        // Generate token using browser's md5 (via inline implementation)
        const timestamp = Date.now().toString();
        const md5_1 = await md5(picInfo);
        const combined = md5_1 + 'pic_edit' + timestamp;
        const md5_2 = await md5(combined);
        const token = md5_2.slice(0, 5);

        // Upload to Baidu with exact same format as shell script
        const uploadResponse = await fetch('https://image.baidu.com/aigc/pic_upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Origin': 'https://image.baidu.com',
            'Referer': 'https://image.baidu.com/'
          },
          body: 'token=' + encodeURIComponent(token) +
                '&scene=' + encodeURIComponent('pic_edit') +
                '&picInfo=' + encodeURIComponent(picInfo) +
                '&timestamp=' + encodeURIComponent(timestamp)
        });

        if (!uploadResponse.ok) throw new Error('Upload failed');
        const result = await uploadResponse.json();
        if (result?.data?.url) return result.data.url;
        throw new Error('No URL in response');
      } catch (e) {
        console.error('Image upload failed:', e);
        return null;
      }
    }

    // Browser-side MD5 implementation
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

      const toHex = n => { const h = n.toString(16); return h.length === 8 ? h : '0' + h; };
      return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
    }

    async function uploadAllImages() {
      if (uploadingImages) return;
      const imgTags = preview.querySelectorAll('img[src^="http"]');
      if (imgTags.length === 0) return;

      uploadingImages = true;
      uploadStatus.textContent = '上传图片中...';

      let uploaded = 0;
      for (const img of imgTags) {
        const originalUrl = img.src;
        uploadStatus.textContent = \`上传图片 \${uploaded + 1}/\${imgTags.length}...\`;
        const baiduUrl = await uploadImageToBaidu(originalUrl);
        if (baiduUrl) {
          img.src = baiduUrl;
          // Update markdown source
          code.value = code.value.replace(
            new RegExp(escapeRegExp(originalUrl), 'g'),
            baiduUrl
          );
          uploaded++;
        }
      }

      uploadingImages = false;
      uploadStatus.textContent = uploaded > 0 ? \`已上传 \${uploaded} 张图片\` : '';
      if (uploaded > 0) showToast(\`已上传 \${uploaded} 张图片到百度图床\`);
    }

    function escapeRegExp(string) {
      return string.replace(/[.*+?^\$\{}().|[\]\\]/g, '\\$&');
    }

    async function exportDocx() {
      const btn = document.getElementById('btn-export');
      const originalText = btn.textContent;

      try {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>处理中...';

        // Upload images first
        await uploadAllImages();

        // Re-render to get updated content
        render();
        await new Promise(r => setTimeout(r, 100));

        const { Document, Paragraph, TextRun, HeadingLevel, Packer } = window.docx;
        const blocks = [];
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = preview.innerHTML;

        function processNode(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.replace(/\\r?\\n/g, ' ').trim();
            if (text) blocks.push(new Paragraph({ children: [new TextRun({ text })] }));
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;

          const tag = node.tagName.toUpperCase();
          if (tag === 'BR') { blocks.push(new Paragraph({ children: [] })); return; }
          if (/^H[1-6]$/.test(tag)) {
            const level = parseInt(tag[1]);
            const heading = {
              1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
              4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6
            }[level];
            const text = node.textContent.trim();
            if (text) blocks.push(new Paragraph({ children: [new TextRun({ text, bold: true })], heading }));
            return;
          }
          if (tag === 'P') {
            const text = node.textContent.trim();
            if (text) blocks.push(new Paragraph({ children: [new TextRun({ text })] }));
            return;
          }
          if (tag === 'PRE') {
            const text = node.innerText.trim();
            if (text) blocks.push(new Paragraph({
              children: [new TextRun({ text: text, font: 'Courier New', color: '333333' })],
              shading: { fill: 'F5F5F5' }
            }));
            return;
          }
          if (tag === 'IMG') {
            blocks.push(new Paragraph({
              children: [new TextRun({ text: '[图片: ' + (node.alt || 'image') + ']', color: '666666', italics: true })]
            }));
            return;
          }
          if (tag === 'LI') {
            const text = node.textContent.trim();
            if (text) blocks.push(new Paragraph({ children: [new TextRun({ text: '• ' + text })] }));
            return;
          }

          Array.from(node.childNodes).forEach(processNode);
        }

        Array.from(tempDiv.childNodes).forEach(processNode);
        if (blocks.length === 0) blocks.push(new Paragraph({ children: [new TextRun({ text: '' })] }));

        const doc = new Document({ sections: [{ properties: {}, children: blocks }] });
        const blob = await Packer.toBlob(doc);
        saveAs(blob, 'markdown.docx');
        showToast('DOCX 导出成功');
      } catch (e) {
        showToast('导出失败: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }

    // Initialize
    code.value = initialMarkdown;
    render();
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
