import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { getHtml, postHtml, absoluteUrl } from './http';
import { Forum, ForumGroup, Thread, ThreadListPage, Post, ThreadDetail } from './models';
import { NotFoundError } from './error';
import Global from './global';

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
 */
export const EMBED_HOSTS = [
	'player.bilibili.com',
	'www.bilibili.com',
	'player.youku.com',
	'v.qq.com',
	'www.youtube.com',
	'player.vimeo.com',
];

/**
 * 表情图。只是用来给占位块换个文案，让人知道点开的是表情而不是内容图。
 * 只认 smiley 目录，别把 common 下面那些占位图也当成表情。
 */
const SMILEY_RE = /static\/image\/smiley\//i;

/** 把 URL 放回 HTML 属性前做转义。裸 & 要补成实体，已是实体的保持原样 */
function escapeAttr(value: string): string {
	return value.replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, '&amp;').replace(/"/g, '&quot;');
}

/** src 是否指向白名单里的播放器 */
function isAllowedEmbed(raw: string): boolean {
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
 * 抢救藏在 <script> 里的播放器。
 *
 * Discuz 的 [media] 标签不直接输出标签，而是
 * <script>document.write("<iframe src='...'></iframe>")</script>。
 * 清洗时删 script 会把视频一起删掉，所以先在这里把播放器捞出来落成真实 DOM。
 * 只按白名单重建，原有属性一概丢弃，避免把注入内容带进来。
 */
function rescueMedia($: CheerioAPI, $content: cheerio.Cheerio<AnyElement>): void {
	$content.find('script').each((_, el) => {
		const code = $(el).text();
		if (!/<(?:iframe|video)\b/i.test(code)) {
			return;
		}

		const nodes: string[] = [];

		// 第三方播放器：<iframe src='https://player.bilibili.com/player.html?bvid=xxx'>
		const iframeRe = /<iframe[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*>/gi;
		let match: RegExpExecArray | null;
		while ((match = iframeRe.exec(code)) !== null) {
			const src = match[1].startsWith('//') ? `https:${match[1]}` : match[1];
			if (isAllowedEmbed(src)) {
				nodes.push(`<iframe class="embed" src="${escapeAttr(src)}" allowfullscreen></iframe>`);
			}
		}

		// 直链视频：<video src="https://.../x.mp4" poster="...">
		const videoRe = /<video[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*>/gi;
		while ((match = videoRe.exec(code)) !== null) {
			const poster = match[0].match(/poster\s*=\s*['"]([^'"]+)['"]/i);
			const posterAttr = poster ? ` poster="${escapeAttr(absoluteUrl(poster[1]))}"` : '';
			nodes.push(
				`<video class="media" src="${escapeAttr(absoluteUrl(match[1]))}"${posterAttr}` +
					` controls preload="metadata" playsinline></video>`
			);
		}

		if (nodes.length) {
			$(el).replaceWith(nodes.join(''));
		}
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
		if (!real || /none\.gif|common\/none|static\/image\/common\/none/i.test(real)) {
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
	return groups;
}

/** 抓取某个版块的帖子列表 */
export async function fetchThreadList(fid: number, page: number): Promise<ThreadListPage> {
	const html = await getHtml(`forum-${fid}-${page}.html`);
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
	return { fid, forumName, threads, pageNow, pageTotal };
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

	// 面包屑里 5 个链接，只有指向 forum-N-1.html 的才是当前版块，取最后一个
	const forumName = textOf($, $('#pt .z a[href*="forum-"]').last().get(0));

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
	return { tid, title, forumName, url: absoluteUrl(`thread-${tid}-${page}-1.html`), posts, pageNow, pageTotal };
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
