import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { getHtml, postHtml, absoluteUrl } from './http';
import { Forum, ForumGroup, Thread, ThreadListPage, Post, ThreadDetail, ThreadSort } from './models';
import { NotFoundError } from './error';
import Global from './global';
import { cachedFixPath, findFfmpeg, isFixableVideo } from './audioFix';
import { fetchThreadSupport } from './threadSupport';

type CheerioAPI = ReturnType<typeof cheerio.load>;
/** cheerio v1 不再导出 Element，节点类型统一来自 domhandler */
type AnyElement = AnyNode;

/** 从链接里取出 tid，兼容 thread-123-1-1.html 与 forum.php?mod=viewthread&tid=123 */
export function extractTid(href: string): number | undefined {
	const staticMatch = href.match(/thread-(\d+)/);
	if (staticMatch) {
		return parseInt(staticMatch[1], 10);
	}
	const queryMatch = href.match(/[?&]tid=(\d+)/);
	return queryMatch ? parseInt(queryMatch[1], 10) : undefined;
}

/** 从链接里取出 fid，兼容 forum-12-1.html 与 forum.php?mod=forumdisplay&fid=12 */
export function extractFid(href: string): number | undefined {
	const staticMatch = href.match(/forum-(\d+)/);
	if (staticMatch) {
		return parseInt(staticMatch[1], 10);
	}
	const queryMatch = href.match(/[?&]fid=(\d+)/);
	return queryMatch ? parseInt(queryMatch[1], 10) : undefined;
}

/** 取页面里的 formhash，Discuz 所有表单提交都要带上它 */
function extractFormhash($: CheerioAPI): string {
	return $('input[name="formhash"]').first().attr('value') || '';
}

/** 把 "1234" / "1.2万" 这类计数转成数字 */
function parseCount(text: string | undefined): number {
	if (!text) {
		return 0;
	}
	const cleaned = text.replace(/[^\d.万亿]/g, '').trim();
	if (!cleaned) {
		return 0;
	}
	if (cleaned.includes('万')) {
		return Math.round(parseFloat(cleaned) * 10000);
	}
	if (cleaned.includes('亿')) {
		return Math.round(parseFloat(cleaned) * 100000000);
	}
	return parseInt(cleaned, 10) || 0;
}

/** 取元素的直接文本，压缩空白 */
function textOf($: CheerioAPI, el: AnyElement | undefined): string {
	if (!el) {
		return '';
	}
	return $(el).text().replace(/\s+/g, ' ').trim();
}

/**
 * 取时间文本。
 * 页面上显示的是「3 分钟前」这类相对时间，绝对时间在 title 属性里，优先用后者。
 */
function timeOf($: CheerioAPI, el: AnyElement | undefined): string {
	if (!el) {
		return '';
	}
	const $el = $(el);
	const title = $el.find('[title]').first().attr('title') || $el.attr('title');
	return (title || $el.text()).replace(/[\s ]+/g, ' ').trim();
}

/**
 * 允许内嵌的播放器域名。
 * 白名单之外一律不嵌，避免把任意第三方页面拉进 webview 执行。
 * 论坛的 [media] 标签以 B 站为主，其余几个是常见备选。
 *
 * music.163.com 是门户文章用的：福利吧的文章开头十有八九挂一个网易云 BGM 播放器
 *（`//music.163.com/outchain/player?type=2&id=...`）。实测它不带 X-Frame-Options
 * 也没有 frame-ancestors 限制，可以嵌；而且放的是 mp3，VS Code 内核解得动 —— 是少数
 * 「在编辑器里点开就真有声音」的媒体。（CSP 的 frame-src 由这份名单生成，两边共用。）
 */
export const EMBED_HOSTS = [
	'player.bilibili.com',
	'www.bilibili.com',
	'player.youku.com',
	'v.qq.com',
	'www.youtube.com',
	'player.vimeo.com',
	'music.163.com',
];

/**
 * 表情图。只是用来给占位块换个文案，让人知道点开的是表情而不是内容图。
 * 只认 smiley 目录，别把 common 下面那些占位图也当成表情。
 */
const SMILEY_RE = /static\/image\/smiley\//i;

/**
 * 论坛皮肤自带的界面图标：占位图 none.gif、附件类型图标、帖子右侧的装饰箭头。
 * 它们挂在 static/image/ 下，不是帖子内容图，别拿去做「点击加载」占位块。
 * 注意别把 smiley 圈进来 —— 表情是故意留的占位。
 */
const UI_IMAGE_RE = /static\/image\/(?:common|filetype|attach|imagelist)\//i;

/** 把 URL 放回 HTML 属性前做转义。裸 & 要补成实体，已是实体的保持原样 */
function escapeAttr(value: string): string {
	return value.replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, '&amp;').replace(/"/g, '&quot;');
}

/** src 是否指向白名单里的播放器（门户的正文清洗也复用这份判断） */
export function isAllowedEmbed(raw: string): boolean {
	// 论坛里常见协议相对写法 //player.bilibili.com/xxx，补上协议才能解析
	const src = raw.startsWith('//') ? `https:${raw}` : raw;
	try {
		const url = new URL(src);
		return url.protocol === 'https:' && EMBED_HOSTS.includes(url.hostname);
	} catch {
		return false;
	}
}

/**
 * 播放器下面那条说明。
 *
 * 「有画面没声音、音量键还是灰的」不是解析漏了，是 VS Code 内核解不了 AAC：
 * webview 跑在 Electron 自带的 Chromium 上，那份构建不含 AAC 解码器，而 H.264 画面
 * 走 macOS 的 VideoToolbox 平台解码器照常能放 —— 于是画面正常、声音全无；
 * 音量键显示成灰的也是同一个原因（拿不到可播放音轨，控件就不给它接事件）。
 *
 * 这一条是实测出来的（隔离的 VS Code 1.137 实例，详见 audioFix.ts 的注释）：
 * decodeAudioData 对 AAC 直接抛 EncodingError，对 MP3 正常；静音起播 800ms 再取消静音，
 * AAC 解出 0 字节且播放卡住，MP3 音轨解出五万多字节。同一窗口里 FLAC 解得动，
 * 所以不是测法的问题。给 iframe 加 allow="autoplay" 也救不了 —— 那是权限，不是编解码。
 *
 * 能救的（论坛直传的 mp4）给一个「换 MP3 音轨」的按钮；救不了的（B 站 iframe，
 * 音频在人家播放器里拿不到）就只留一条去浏览器的路。
 */
interface NoteOptions {
	/** 可以走「换 MP3 音轨」的源地址（本机有 ffmpeg 时才给） */
	fixUrl?: string;
	/** 本来救得回来，只是本机没装 ffmpeg */
	ffmpegMissing?: boolean;
}

function mediaNote(href: string, options: NoteOptions = {}): string {
	const actions = options.fixUrl
		? `<a href="#" class="fix-audio" data-src="${escapeAttr(options.fixUrl)}">换 MP3 音轨（修声音）</a>` +
			'<span class="fix-state"></span>'
		: options.ffmpegMissing
			? '<span class="fix-hint" title="没检测到 ffmpeg。装好并重启 VS Code（或在设置里填 fuliba.ffmpegPath）之后，这里会出现「换 MP3 音轨」按钮">装了 ffmpeg 就能在编辑器里听</span>'
			: '';
	return (
		'<figcaption class="media-note">音轨格式（多为 AAC）VS Code 内核解不了，所以没声音、音量键也点不动。' +
		actions +
		`<a href="${escapeAttr(href)}" target="_blank">在浏览器里听</a></figcaption>`
	);
}

/** B 站把 bvid 放在查询串里，换成普通视频页链接，方便点出去看原始清晰度 */
function embedWatchUrl(src: string): string {
	const bv = src.match(/[?&]bv(?:id)?=([A-Za-z0-9]+)/i);
	return bv ? `https://www.bilibili.com/video/${bv[1]}` : src;
}

/**
 * 播放器统一收口。
 *
 * 论坛正文里的播放器有三种形态，来源各不相同：
 *   1. `[media]` 标签 → `<script>document.write("<iframe …>")</script>`（要先把 script 拆了才看得见）
 *   2. 论坛自己发的 `<video>` 标签（发现之门的小视频基本都是这种，还带一串行内样式）
 *   3. `detectPlayer(id, "mp4", url, w, h)` —— 只给一个空容器，靠页面 JS 渲染，我们拿不到那个容器
 *
 * 这里把它们收成同一个形状：`figure.media-embed > div.media-stage > 播放器 + 拖动块`，
 * 再挂一条音轨说明。stage 的宽高只认 CSS 变量，所以拖一个等于拖全部。
 */
function buildEmbed(inner: string, note: string, mediaSrc?: string): string {
	// data-media-src 是给「修声音」用的：页面拿到后据此找回对应的播放器换源
	return (
		'<figure class="media-embed"' +
		(mediaSrc ? ` data-media-src="${escapeAttr(mediaSrc)}"` : '') +
		'>' +
		'<div class="media-stage">' +
		inner +
		'<span class="media-grip" title="拖动调整播放器大小（所有帖子通用）"></span>' +
		'</div>' +
		note +
		'</figure>'
	);
}

/** detectPlayer 的 type 参数 → 我们真的能播的格式。解不了的（flv/swf/rm）留着兜底链接 */
const PLAYABLE_VIDEO_TYPES = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);
const PLAYABLE_AUDIO_TYPES = new Set(['mp3', 'ogg', 'wav', 'flac']);

/** script 里的文本不走 HTML 实体解码，&amp; 要自己还原回 &，否则查询串会带个假参数 */
function decodeAmp(value: string): string {
	return value.replace(/&amp;/gi, '&');
}

/**
 * 抢救藏在 <script> 里的播放器。
 * 清洗时会删掉全部 script，不先在这里把播放器落成真实 DOM，视频会跟着一起消失。
 * 只按白名单重建，原有属性一概丢弃，避免把注入内容带进来。
 */
function rescueMedia($: CheerioAPI, $content: cheerio.Cheerio<AnyElement>): void {
	$content.find('script').each((_, el) => {
		const code = $(el).text();
		const nodes: string[] = [];

		if (/<(?:iframe|video)\b/i.test(code)) {
			// 第三方播放器：<iframe src='//player.bilibili.com/player.html?bvid=xxx'>
			const iframeRe = /<iframe[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*>/gi;
			let match: RegExpExecArray | null;
			while ((match = iframeRe.exec(code)) !== null) {
				const raw = decodeAmp(match[1]);
				const src = raw.startsWith('//') ? `https:${raw}` : raw;
				if (isAllowedEmbed(src)) {
					nodes.push(`<iframe class="embed" src="${escapeAttr(src)}"></iframe>`);
				}
			}

			// 直链视频：<video src="https://.../x.mp4" poster="...">
			const videoRe = /<video[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*>/gi;
			while ((match = videoRe.exec(code)) !== null) {
				const src = absoluteUrl(decodeAmp(match[1]));
				const poster = match[0].match(/poster\s*=\s*['"]([^'"]+)['"]/i);
				const posterAttr = poster ? ` poster="${escapeAttr(absoluteUrl(decodeAmp(poster[1])))}"` : '';
				nodes.push(`<video class="media" src="${escapeAttr(src)}"${posterAttr}></video>`);
			}
		}

		// detectPlayer("mp4_ASt", "mp4", "https://…/x.mp4", "500", "375")
		// 前一个参数是容器 id、后面两个是尺寸，都没用 —— 我们自己造播放器，尺寸交给拖动。
		const dpRe = /detectPlayer\(\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/gi;
		let dp: RegExpExecArray | null;
		while ((dp = dpRe.exec(code)) !== null) {
			const kind = dp[1].toLowerCase();
			const url = absoluteUrl(decodeAmp(dp[2]));
			if (PLAYABLE_VIDEO_TYPES.has(kind)) {
				nodes.push(`<video class="media" src="${escapeAttr(url)}"></video>`);
			} else if (PLAYABLE_AUDIO_TYPES.has(kind)) {
				nodes.push(`<audio class="media-audio" src="${escapeAttr(url)}"></audio>`);
			}
		}

		if (nodes.length) {
			$(el).replaceWith(nodes.join(''));
		}
	});
}

/** 把正文里所有播放器补全属性、套上可拖动的外框、挂上音轨说明 */
function normalizePlayers($: CheerioAPI, $content: cheerio.Cheerio<AnyElement>): void {
	$content.find('video').each((_, el) => {
		const $v = $(el);
		// 论坛给 <video> 带了自己的行内样式，留着会跟外框尺寸打架，摘掉交给 CSS 统一管
		$v.removeAttr('style');
		/*
		 * muted / autoplay 必须摘掉。
		 *
		 * 论坛模板给视频挂 `muted autoplay`（为了绕过浏览器的自动播放拦截）是常见写法，
		 * 而 `muted` 是**属性级**的静音：它会同时写进 defaultMuted，之后即使我们把音轨
		 * 换成了解得动的 MP3，元素还是静音的 —— 表现就是「换完照样没声音、音量键还是那个状态」，
		 * 而换源那一步完全看不出问题，非常容易被误判成「方案不通」。
		 *
		 * autoplay 一并去掉：webview 里我们不想让一堆帖子同时开播，播放交给用户点。
		 * 需要自动播放的场景由页面侧在换源后显式调 play()，不依赖这个属性。
		 */
		$v.removeAttr('muted');
		$v.removeAttr('autoplay');
		$v.attr({ class: 'media', controls: '', preload: 'metadata', playsinline: '' });
		const src = absoluteUrl($v.attr('src') || '');
		if (src) {
			$v.attr('src', src);
		}
		const poster = $v.attr('poster');
		if (poster) {
			$v.attr('poster', absoluteUrl(poster));
		}
		if (!src) {
			$v.replaceWith(buildEmbed($.html($v), ''));
			return;
		}
		// 直链 mp4 才有得修。已经有转好的产物时，即使当前没 ffmpeg 也该给按钮 —— 换源不需要它
		const fixable = isFixableVideo(src);
		const fixReady = fixable && (!!findFfmpeg() || !!cachedFixPath(src));
		$v.replaceWith(
			buildEmbed(
				$.html($v),
				mediaNote(src, { fixUrl: fixReady ? src : undefined, ffmpegMissing: fixable && !fixReady }),
				src
			)
		);
	});

	$content.find('iframe.embed').each((_, el) => {
		const $f = $(el);
		// allow 不是「让它有声音」的开关（音轨是 AAC，解不了），而是把全屏、画中画、
		// 加密媒体这些能力显式授予子文档，否则播放器自己的按钮会是灰的。
		$f.attr({ allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture', allowfullscreen: '' });
		$f.replaceWith(buildEmbed($.html($f), mediaNote(embedWatchUrl($f.attr('src') || ''))));
	});

	$content.find('audio').each((_, el) => {
		const $a = $(el);
		$a.removeAttr('style');
		$a.attr({ class: 'media-audio', controls: '', preload: 'metadata' });
		const src = absoluteUrl($a.attr('src') || '');
		if (src) {
			$a.attr('src', src);
		}
		// 纯音频多是 mp3，VS Code 解得动，不用挂那条说明，也不参与尺寸拖动
		$a.replaceWith(`<figure class="media-embed media-audio-wrap">${$.html($a)}</figure>`);
	});
}

/**
 * 清洗帖子正文。
 * 做四件事：抢救播放器、去掉可执行内容、把 Discuz 的懒加载图片还原成真实地址、统一外链为绝对路径。
 */
function sanitizeContent($: CheerioAPI, $content: cheerio.Cheerio<AnyElement>): void {
	// 必须在删 script 之前做，否则视频会跟着 script 一起消失
	rescueMedia($, $content);

	$content.find('script,style,link,object,embed,meta').remove();
	// 只保留上面按白名单重建的播放器，原页面自带的 iframe 一律不要
	$content.find('iframe').not('.embed').remove();

	// 附件的悬浮浮层（div.tip.tip_4）：一串 javascript: 链接加两个旋转图标，
	// 平时藏在附件名下面，展开只有噪音，整块不要。
	$content.find('div.tip').remove();

	// 播放器统一收口：补属性、套外框、挂说明。必须在 script 清完之后做 ——
	// 抢救出来的播放器这时候才以真实节点存在，而正文里本就有的 <video> 也还没被别处动过。
	normalizePlayers($, $content);

	// Discuz 的自定义外壳标签，浏览器不认，拆掉外壳但保留内容
	$content.find('ignore_js_op').each((_, el) => {
		$(el).replaceWith($(el).contents());
	});

	// 去掉所有 on* 事件属性与 javascript: 协议链接
	$content.find('*').each((_, el) => {
		if (!('attribs' in el)) {
			return;
		}
		const attribs = el.attribs || {};
		Object.keys(attribs).forEach((name) => {
			const lower = name.toLowerCase();
			if (lower.startsWith('on')) {
				$(el).removeAttr(name);
			}
			if ((lower === 'href' || lower === 'src') && /^\s*javascript:/i.test(attribs[name])) {
				$(el).removeAttr(name);
			}
		});
	});

	// Discuz 的图片常在 file/zoomfile/data-original 里存真实地址，src 只是占位图
	$content.find('img').each((_, el) => {
		const $img = $(el);
		const real =
			$img.attr('zoomfile') || $img.attr('file') || $img.attr('data-original') || $img.attr('src') || '';
		// 没有地址、或者只是皮肤自带的小图标，直接丢掉，别做成占位块让人以为有内容
		if (!real || UI_IMAGE_RE.test(real) || /none\.gif/i.test(real)) {
			$img.remove();
			return;
		}
		const url = absoluteUrl(real);

		// 表情和内容图一律不加载，只在文案上区分点开的是什么。
		// webview 一设上 html 浏览器就会立刻去抓图，帖子图多时又慢又费流量，
		// 所以换成占位元素、把地址存进 data-src，由 thread.js 在悬停/点击时才插入真 <img>。
		// 用 span 而不是「去掉 src 的 img」——没有 src 的 img 在部分浏览器里仍会画出破图边框。
		const label = SMILEY_RE.test(url) ? '[表情包] 点击加载' : '[图片] 点击加载';
		$img.replaceWith(`<span class="img-slot" data-src="${escapeAttr(url)}">${label}</span>`);
	});

	// javascript: 空链接（附件图外层、论坛各种按钮都是这种）点了没反应，
	// 保留蓝色链接样式只会让人以为能点，拆掉外壳把文字/图片留下。
	$content.find('a').each((_, el) => {
		const $a = $(el);
		const href = ($a.attr('href') || '').trim();
		if (!href || /^javascript:/i.test(href)) {
			$a.replaceWith($a.contents());
		}
	});

	// 处理附件下载链接：Discuz 用 a[href^=forum.php?mod=attachment]
	$content.find('a').each((_, el) => {
		const $a = $(el);
		const href = $a.attr('href');
		if (href && /mod=attachment/i.test(href)) {
			$a.attr('href', absoluteUrl(href));
			$a.attr('target', '_blank');
		}
	});

	// 站内链接补全域名
	$content.find('a[href]').each((_, el) => {
		const $a = $(el);
		const href = $a.attr('href') || '';
		if (href && !/^(https?:|mailto:|#)/i.test(href)) {
			$a.attr('href', absoluteUrl(href));
		}
	});
}

/** 从分页控件里读出「当前页 / 总页数」 */
function parsePagination($: CheerioAPI): { pageNow: number; pageTotal: number } {
	let pageNow = 1;
	let pageTotal = 1;

	// Discuz 分页：<div class="pg"> 里 <strong>2</strong> 是当前页，<label> 里有 "共 N 页"
	const $pg = $('div.pg').last();
	if ($pg.length) {
		const current = textOf($, $pg.find('strong').get(0));
		if (current && /^\d+$/.test(current)) {
			pageNow = parseInt(current, 10);
		}
		const label = textOf($, $pg.find('label span').get(0)) || textOf($, $pg.find('label').get(0));
		const totalMatch = label.match(/共\s*(\d+)\s*页/);
		if (totalMatch) {
			pageTotal = parseInt(totalMatch[1], 10);
		} else {
			// 没有「共 N 页」时，从页码链接里取最大值
			let max = pageNow;
			$pg.find('a').each((_, el) => {
				const href = $(el).attr('href') || '';
				const m = href.match(/page=(\d+)/) || href.match(/forum-\d+-(\d+)\.html/) || href.match(/thread-\d+-(\d+)-/);
				if (m) {
					max = Math.max(max, parseInt(m[1], 10));
				}
			});
			pageTotal = max;
		}
	}
	if (pageTotal < pageNow) {
		pageTotal = pageNow;
	}
	return { pageNow, pageTotal };
}

/**
 * 抓取版块列表。
 *
 * 福利吧首页模板的真实结构：
 *   div.bm.bmw > div.bm_h h2                → 分组名
 *              > div#category_N.bm_c
 *                 > table.fl_tb > tr
 *                      td.fl_icn > a[href=forum-N-1.html]   版块图标
 *                      td        > h2 > a                   版块名
 *                                > p  > a                   子版块
 *                      td.fl_i                              今日 / 总帖数
 *                      td.fl_by                             最后回复
 *
 * 未登录时论坛只返回提示页，getHtml 会抛出 LoginRequiredError。
 */
export async function fetchForumGroups(): Promise<ForumGroup[]> {
	const html = await getHtml('forum.php');
	const $ = cheerio.load(html);

	// 缓存一份原始 HTML 便于排查解析问题
	await Global.setForumCache({ htmlLength: html.length, at: Date.now() });

	const groups: ForumGroup[] = [];
	// 同一个版块可能在多个分组里出现（比如既在收藏夹又在热门里），只保留第一次
	const seenFid = new Set<number>();

	$('table.fl_tb').each((_, tableEl) => {
		const $table = $(tableEl);
		const $wrap = $table.closest('div.bm');
		const groupName = textOf($, $wrap.find('div.bm_h h2').first().get(0)) || '版块';

		// 「我收藏的版块」是用户自己的收藏夹，会和下面的真实分组重复，跳过
		if (groupName.includes('收藏')) {
			return;
		}

		const forums: Forum[] = [];

		$table.find('tr').each((__, trEl) => {
			const $tr = $(trEl);
			const $a = $tr.find('td h2 a[href]').first();
			const href = $a.attr('href') || '';
			const fid = extractFid(href);
			const name = textOf($, $a.get(0));
			if (!fid || !name) {
				return;
			}

			if (!seenFid.has(fid)) {
				seenFid.add(fid);
				// 简介是第一个不是「子版块 / 版主」的 p
				const $desc = $tr
					.find('td p')
					.filter((_i, el) => !/^(子版块|版主)/.test(textOf($, el)))
					.first();
				forums.push({
					fid,
					name,
					url: href,
					description: textOf($, $desc.get(0)) || undefined,
				});
			}

			// 子版块和父版块在同一个 td 里，也做成可展开的节点
			$tr.find('td p a[href]').each((___, subEl) => {
				const $sub = $(subEl);
				const subHref = $sub.attr('href') || '';
				const subFid = extractFid(subHref);
				const subName = textOf($, subEl);
				if (!subFid || !subName || seenFid.has(subFid)) {
					return;
				}
				seenFid.add(subFid);
				forums.push({ fid: subFid, name: subName, url: subHref, isSub: true });
			});
		});

		if (forums.length) {
			groups.push({ name: groupName, forums });
		}
	});

	if (!groups.length) {
		throw new Error('未能解析出版块列表，论坛首页模板可能已改版');
	}
	// 存一份给「选择显示的版块」用，省得每次都重新抓首页
	await Global.setForumGroups(groups);
	return groups;
}

/**
 * 取版块分组，优先用缓存。
 * 用户点「选择显示的版块」时没必要为了列个清单再打一次论坛首页。
 */
export async function getForumGroupsCached(force = false): Promise<ForumGroup[]> {
	if (!force) {
		const cached = Global.getForumGroups();
		if (cached) {
			return cached;
		}
	}
	return fetchForumGroups();
}

/**
 * 把排序方式翻译成 Discuz forumdisplay 接受的查询参数。
 *
 * 三种取值都实测过：orderby 只改变排序，不会把结果缩成子集
 *（forum-2 三档都是 60 条普通帖 + 4 条置顶，页数一致）。
 * 注意不要用论坛界面上的 `filter=heat`——那个才是「只留热帖」的过滤，会漏帖。
 */
function sortParams(sort: ThreadSort): Record<string, string> {
	switch (sort) {
		case 'dateline':
			return { orderby: 'dateline', ascdesc: 'desc' };
		case 'heats':
			return { orderby: 'heats' };
		default:
			return { orderby: 'lastpost', ascdesc: 'desc' };
	}
}

/** 抓取某个版块的帖子列表 */
export async function fetchThreadList(
	fid: number,
	page: number,
	sort: ThreadSort = 'lastpost'
): Promise<ThreadListPage> {
	const html = await getHtml(`forum-${fid}-${page}.html`, sortParams(sort));
	const $ = cheerio.load(html);

	if (/<div[^>]*id=["']?messagetext/i.test(html)) {
		throw new NotFoundError('该版块不存在或无权访问');
	}

	const forumName =
		textOf($, $('h1.xs2 a').first().get(0)) ||
		textOf($, $('#pt .z a').last().get(0)) ||
		`版块 ${fid}`;

	const threads: Thread[] = [];
	const seen = new Set<number>();

	// Discuz 帖子列表：tbody[id^=normalthread_] 为普通帖，tbody[id^=stickthread_] 为置顶帖
	$('tbody[id^="normalthread_"], tbody[id^="stickthread_"]').each((_, el) => {
		const $row = $(el);
		const idAttr = $row.attr('id') || '';
		const isSticky = idAttr.startsWith('stickthread_');

		const $titleA = $row.find('th a.s.xst, th a.xst, a.s.xst').first();
		const href = $titleA.attr('href') || '';
		const tid = extractTid(href) || parseInt(idAttr.replace(/\D/g, ''), 10);
		if (!tid || seen.has(tid)) {
			return;
		}

		let title = textOf($, $titleA.get(0));
		// 标题可能带分类前缀 <em>[分类]</em>，单独取出来
		let typeName: string | undefined;
		const $em = $row.find('th em').first();
		if ($em.length) {
			const emText = textOf($, $em.get(0));
			const typeMatch = emText.match(/^\[(.+?)\]$/);
			if (typeMatch) {
				typeName = typeMatch[1];
			}
		}
		title = title.replace(/^\[[^\]]*\]\s*/, '').trim();
		if (!title) {
			return;
		}

		seen.add(tid);

		// 作者 / 最后回复：Discuz 用 td.by > cite > a
		const $byCells = $row.find('td.by');
		const $authorA = $byCells.eq(0).find('cite a').first();
		const $lastA = $byCells.eq($byCells.length - 1).find('cite a').first();
		const $lastEm = $byCells.eq($byCells.length - 1).find('cite em a, em a').last();
		const authorUidMatch = ($authorA.attr('href') || '').match(/uid=(\d+)/);

		// 回复数 / 查看数：同一个 td.num 里，a.xi2 是回复数，em 是查看数
		const $num = $row.find('td.num').first();
		const replyCount = parseCount($num.find('a').first().text());
		const viewCount = parseCount($num.find('em').first().text());

		threads.push({
			tid,
			title,
			url: absoluteUrl(href),
			author: textOf($, $authorA.get(0)) || '匿名',
			authorUid: authorUidMatch ? parseInt(authorUidMatch[1], 10) : undefined,
			replyCount,
			viewCount,
			lastReplyUser: textOf($, $lastA.get(0)) || undefined,
			lastReplyAt: timeOf($, $lastEm.get(0)) || undefined,
			isSticky,
			isDigest: $row.find('img[src*="digest"]').length > 0,
			// 锁定帖的图标是 folder_lock.gif
			isClosed: $row.find('td.icn img[src*="lock"]').length > 0,
			typeName,
		});
	});

	const { pageNow, pageTotal } = parsePagination($);
	return { fid, forumName, threads, pageNow, pageTotal, sort };
}

/** 抓取帖子详情 */
export async function fetchThreadDetail(tid: number, page: number): Promise<ThreadDetail> {
	const html = await getHtml(`thread-${tid}-${page}-1.html`);
	const $ = cheerio.load(html);

	if (/<div[^>]*id=["']?messagetext/i.test(html)) {
		throw new NotFoundError('该帖子不存在或无权访问');
	}

	const title =
		textOf($, $('#thread_subject').get(0)) ||
		textOf($, $('h1.ts a[href*="thread-"]').last().get(0)) ||
		textOf($, $('title').get(0)).split(/[_-]/)[0].trim() ||
		`帖子 ${tid}`;

	// 面包屑里 5 个链接，只有指向 forum-N-1.html 的才是当前版块，取最后一个。
	// href 顺手给出 fid —— 版块 id 是「支持楼主」接口的必填参数。
	const $board = $('#pt .z a[href*="forum-"]').last();
	const forumName = textOf($, $board.get(0));
	const fid = extractFid($board.attr('href') || '') || 0;

	const posts: Post[] = [];
	// 楼主帖没有 postnum 元素，靠位置判断：postlist 里第一个带正文的楼层就是楼主
	let index = 0;

	$('#postlist div[id^="post_"]').each((_, el) => {
		const $post = $(el);
		const pid = parseInt(($post.attr('id') || '').replace(/\D/g, ''), 10);
		if (!pid) {
			return;
		}
		const $content = $post.find('td.t_f').first();
		if (!$content.length) {
			return;
		}

		// 没插进正文的附件不在 td.t_f 里，它们渲染在同级的 div.t_fsz > div.pattl。
		// 之前只读 td.t_f，于是「帖子里明明传了图，详情里一张都看不到」。
		// Discuz 展示位置本来就在正文末尾，这里把它搬进正文尾部再一起清洗。
		const $attachments = $post.find('div.t_fsz').first().find('div.pattl').first();
		if ($attachments.length) {
			$content.append($attachments);
		}

		const isOriginalPost = index === 0;
		index += 1;

		// 作者与 uid：div.authi 里的 a.xw1 指向 space-uid-N.html
		const $authorA = $post.find('div.authi a.xw1').first();
		const uidMatch = ($authorA.attr('href') || '').match(/space-uid-(\d+)\.html/);

		// 楼层：em.pi 里的 <a id="postnumN">N</a>；被版主推荐的楼层这里是「推荐」
		const floorRaw = textOf($, $post.find('a[id^="postnum"]').first().get(0));
		const floor = isOriginalPost ? '楼主' : /^\d+$/.test(floorRaw) ? `${floorRaw}#` : floorRaw || '楼层';

		// 时间：em#authorpostonN 里的 span[title] 存的是绝对时间
		const time = timeOf($, $post.find('em[id^="authorposton"]').first().get(0)).replace(/^发表于\s*/, '');

		// 头像在 div.avatar > a.avtm > img。外层 div#favatar 里也有一张图，
		// 但那是「查看详细资料」图标，必须先匹配 div.avatar。
		// 去掉 dark=1：它只影响默认头像，浅色主题下会拿到深色占位图。
		const avatarSrc = $post.find('div.avatar a.avtm img, div.avatar img').first().attr('src') || '';
		const avatar = avatarSrc ? absoluteUrl(avatarSrc).replace(/[&?]dark=1/, '') : undefined;

		sanitizeContent($, $content);

		posts.push({
			pid,
			floor,
			author: textOf($, $authorA.get(0)) || '匿名',
			authorUid: uidMatch ? parseInt(uidMatch[1], 10) : undefined,
			avatar,
			time,
			content: $content.html() || '',
			isOriginalPost,
		});
	});

	if (!posts.length) {
		throw new Error('未能解析出帖子内容，论坛模板可能已改版');
	}

	const { pageNow, pageTotal } = parsePagination($);

	// 「支持楼主」只挂在楼主楼上，而且帖子 HTML 里那一块是空的（论坛用 AJAX 填），
	// 所以要单独请求一次插件接口。取不到就是 null，页面不显示这个按钮。
	const support = await fetchThreadSupport(tid, fid, posts[0].pid);

	return {
		tid,
		title,
		forumName,
		url: absoluteUrl(`thread-${tid}-${page}-1.html`),
		posts,
		pageNow,
		pageTotal,
		support,
	};
}

/** 搜索帖子 */
export async function searchThreads(keyword: string): Promise<Thread[]> {
	// Discuz 搜索必须两步：先 GET 搜索页拿 formhash，再带着它 POST 关键词
	const formHash = extractFormhash(cheerio.load(await getHtml('search.php', { mod: 'forum' })));
	if (!formHash) {
		throw new Error('未能获取搜索表单标识，Cookie 可能已失效');
	}

	const html = await postHtml('search.php?mod=forum', {
		formhash: formHash,
		srchtxt: keyword,
		searchsubmit: 'yes',
	});
	const $ = cheerio.load(html);

	const results: Thread[] = [];
	const seen = new Set<number>();

	// 结果条目：<li class="pbw" id="{tid}">，tid 除了链接里，也直接写在 id 上
	$('#threadlist li.pbw').each((_, el) => {
		const $item = $(el);
		const $a = $item.find('h3 a[href]').first();
		const href = $a.attr('href') || '';
		const tid = extractTid(href) || parseInt($item.attr('id') || '', 10);
		if (!tid || seen.has(tid)) {
			return;
		}
		seen.add(tid);

		// 「29 个回复 - 2341 次查看」
		const stats = textOf($, $item.find('p.xg1').first().get(0));
		const replyMatch = stats.match(/(\d+)\s*个回复/);
		const viewMatch = stats.match(/(\d+)\s*次查看/);

		// 末行是「时间 - 作者 - 版块」，靠 space-uid- 链接定位，避免和摘要行混淆
		const $meta = $item.find('p').filter((_i, p) => /space-uid-/.test($(p).html() || '')).last();
		const $authorA = $meta.find('a[href*="space-uid-"]').first();
		const uidMatch = ($authorA.attr('href') || '').match(/space-uid-(\d+)\.html/);

		// 摘要紧跟在那行统计后面，没有摘要时下一行就是 meta，用有无链接区分
		const $next = $item.find('p.xg1').first().next('p');

		results.push({
			tid,
			title: textOf($, $a.get(0)),
			// 统一成静态地址，和版块列表保持一致
			url: absoluteUrl(`thread-${tid}-1-1.html`),
			author: textOf($, $authorA.get(0)) || '匿名',
			authorUid: uidMatch ? parseInt(uidMatch[1], 10) : undefined,
			replyCount: replyMatch ? parseInt(replyMatch[1], 10) : 0,
			viewCount: viewMatch ? parseInt(viewMatch[1], 10) : 0,
			lastReplyAt: textOf($, $meta.find('span').first().get(0)) || undefined,
			summary: $next.find('a').length ? undefined : textOf($, $next.get(0)) || undefined,
			forumName: textOf($, $meta.find('a.xi1').first().get(0)) || undefined,
		});
	});

	return results;
}
