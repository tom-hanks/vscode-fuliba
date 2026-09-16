import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { getPublicHtml } from './http';
import { isAllowedEmbed } from './discuz';
import Global from './global';

/**
 * 门户站（福利吧官网 fuliba2023.net）的抓取与解析。
 *
 * 和 discuz.ts 是两个站、两套东西：
 *  - 论坛：版块 / 帖子（tid），要登录，Cookie 必需
 *  - 门户：栏目 / 文章（aid），游客可读，不需要 Cookie
 *
 * 所以这里单独一个模块，不复用论坛那套 post/tid 的模型。唯一共用的只有
 * 「哪些域名允许内嵌」（EMBED_HOSTS）—— CSP 那份名单是全局的，必须一致。
 */

type CheerioAPI = ReturnType<typeof cheerio.load>;
type AnyElement = AnyNode;

/** 首页「最新福利」列表里的一条 */
export interface PortalArticle {
	/** 文章 id，出现在 data-aid 上。注意它和地址无关（地址是 slug，如 /cum-st.html） */
	aid: number;
	title: string;
	/** 标题里嵌的副标题（模板用 span.article-subtitle 塞在标题里） */
	subtitle?: string;
	/** 文章地址，已补全域名，且已去掉分页后缀 */
	url: string;
	/** 列表缩略图。走搜狗缩略图服务，单张最大能到 2 MB 以上 */
	thumb?: string;
	summary?: string;
	/** 形如 2026-09-16 */
	date: string;
	category?: string;
	categoryUrl?: string;
	views: number;
	comments: number;
	likes: number;
}

/** 一页「最新福利」列表 */
export interface PortalListPage {
	articles: PortalArticle[];
	pageNow: number;
	pageTotal: number;
	/** 「最新福利」标题右边那排传送门，原样取回来 */
	portals: PortalLink[];
}

/** 首页标题边上那个外链（福利吧 APP / 导航 / 论坛 / 地址发布） */
export interface PortalLink {
	name: string;
	url: string;
}

/**
 * 一条评论。
 *
 * 楼中楼（对某条顶层评论的回复）放在 replies 里 —— 门户最多两层，
 * 但解析写成递归的，万一以后开了深一层也不会丢。
 */
export interface PortalComment {
	/** 评论 id，来自 li#comment-204139 */
	cid: number;
	/** 楼层号，只有顶层有（#1 / #2）；楼中楼没有 */
	floor?: string;
	author: string;
	avatar?: string;
	/**
	 * 绝对时间。
	 *
	 * 新评论在页面上显示的是「10 分钟前」，绝对时间只存在于 span[title] 属性里。
	 * 相对时间过一会儿就过期了（昨天看的「10 分钟前」今天还在），所以优先取 title。
	 */
	time: string;
	/** 正文 HTML，已做安全过滤 */
	content: string;
	likes: number;
	/** 楼中楼里回复的对象（@某人），只有 replies 里有 */
	replyTo?: string;
	/**
	 * 原始嵌套层级，只有 replies 里有值（1 = 直接回复顶层评论）。
	 *
	 * replies 本身是**摊平**的（见 parseComments），层级信息只留在这里。
	 * 面板现在按一层缩进渲染，depth 留着是为了将来想改成逐级缩进时有数据可用。
	 */
	depth?: number;
	/** 楼中楼。摊平后的所有后代，按出现顺序排列 */
	replies: PortalComment[];
}

/** 一篇文章的详情（单页） */
export interface PortalArticleDetail {
	title: string;
	/** 文章首页地址，已补全域名 */
	url: string;
	date: string;
	category?: string;
	categoryUrl?: string;
	views: number;
	/** 门户自己标的评论总数 */
	comments: number;
	likes: number;
	tags: string[];
	/** 正文 HTML，已做安全过滤、图片转占位块、链接绝对化 */
	content: string;
	pageNow: number;
	pageTotal: number;
	/** 评论区。没有分页，一次全在页面里 */
	commentList: PortalComment[];
}

/** 把门户地址补全成绝对地址（保留 // 协议相对写法） */
function portalAbsolute(href: string): string {
	if (!href) {
		return '';
	}
	if (/^https?:\/\//i.test(href)) {
		return href;
	}
	if (href.startsWith('//')) {
		return `https:${href}`;
	}
	return `${Global.getPortalUrl()}/${href.replace(/^\/+/, '')}`;
}

/**
 * 列表页地址。
 * 门户的伪静态是「第 1 页 = 根目录，第 N 页 = /page/N」，没有 /page/1 这种写法。
 */
export function portalListUrl(page: number): string {
	return page <= 1 ? `${Global.getPortalUrl()}/` : `${Global.getPortalUrl()}/page/${page}`;
}

/** 把 /2026130.html/2 这类分页地址收拢回文章首页地址 */
export function articleBaseUrl(url: string): string {
	return url
		.split('#')[0]
		.split('?')[0]
		.replace(/\/\d+\/?$/, '')
		.replace(/\/+$/, '');
}

/**
 * 文章分页地址（第 1 页就是文章首页地址）。
 *
 * 实测门户文章可以翻页：/2026130.html 是第 1 页，/2026130.html/2 是第 2 页，
 * 而且 /2026130.html/1 和首页内容一致 —— 和列表页「第 1 页没有后缀」是同一套规矩。
 */
export function portalArticleUrl(base: string, page: number): string {
	return page <= 1 ? base : `${base}/${page}`;
}

/**
 * 正文里的链接要不要用面板自己打开。
 *
 * 只认门户自己的文章页：伪静态 .html、不带查询串、不是列表分页。
 * 像 /flhz/（分类）、/app.php（APP 落地页）、/tag/xxx 这些一律交给浏览器 ——
 * 那些要么是列表页、要么根本不是内容页，塞进面板只会让人以为插件解析坏了。
 *
 * 认出 /xxx.html/2 这种带分页的文章地址时，把页码一起返回，面板可以直接翻过去。
 */
export function parsePortalArticleLink(url: string): { base: string; page: number } | undefined {
	const clean = url.split('#')[0].split('?')[0];
	if (!/^https?:\/\//i.test(clean) || !clean.startsWith(Global.getPortalUrl())) {
		return undefined;
	}
	if (/\/page\/\d+$/.test(clean)) {
		return undefined;
	}
	const pageMatch = clean.match(/\/(\d+)\/?$/);
	if (!/\.html$/i.test(clean) && !pageMatch) {
		return undefined;
	}
	if (pageMatch) {
		const base = articleBaseUrl(clean);
		return /\.html$/i.test(base) ? { base, page: parseInt(pageMatch[1], 10) } : undefined;
	}
	return { base: articleBaseUrl(clean), page: 1 };
}

/** 「阅读(7838)」→ 7838 */
function parseCount(text: string | undefined): number {
	const match = (text || '').match(/([\d.]+)/);
	return match ? Math.round(parseFloat(match[1])) : 0;
}

/** 取元素文本并压缩空白 */
function textOf($: CheerioAPI, el: AnyElement | undefined): string {
	if (!el) {
		return '';
	}
	return $(el).text().replace(ICON_FONT_RE, '').replace(/\s+/g, ' ').trim();
}

/**
 * 图标字体留下的私有区字符。
 *
 * DUX 模板的分类链接是 `<a class="cat"><i class="tbfa">&#xe60e;</i>福利汇总</a>` ——
 * 那个 <i> 里是一个私有区（U+E000–U+F8FF）码点，靠主题自带的图标字体才能画出小图标。
 * 我们不引那份字体，text() 取出来就成了豆腐块「□福利汇总」。所以取分类名时先把 <i> 摘掉，
 * 再兜一道正则：万一以后换成别的写法，也不至于把方块带出来。
 */
const ICON_FONT_RE = /[\uE000-\uF8FF]/g;

/** 取分类名（去掉图标字体的 <i> 与私有区字符） */
function categoryName($: CheerioAPI, $a: cheerio.Cheerio<AnyElement>): string {
	const $clone = $a.clone();
	$clone.find('i').remove();
	return $clone
		.text()
		.replace(ICON_FONT_RE, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** 往 HTML 属性里写地址前转义。裸 & 补成实体，已是实体的不动 */
export function escapeAttr(value: string): string {
	return value.replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * 标题去副标题。
 * 门户把副标题当成标题的兄弟节点塞在同一个 <a> 里
 *（`<a>淘宝京东优惠商品汇总…<span class="article-subtitle">购物领券</span></a>`），
 * 直接取 text() 会让两句话粘成一串，所以先把副标题摘掉再取。
 */
function titleWithoutSubtitle($: CheerioAPI, $a: cheerio.Cheerio<AnyElement>): string {
	const $clone = $a.clone();
	$clone.find('.article-subtitle').remove();
	return $clone.text().replace(/\s+/g, ' ').trim();
}

/**
 * 抓「最新福利」列表。
 *
 * 页面结构（DUX 模板的门户首页）：
 *   div.content
 *     ├ div.title.excerpts-title > h3 「最新福利」 + div.more > a × 4（传送门）
 *     ├ article.excerpt × 20
 *     │   ├ a.focus[href] > img.thumb
 *     │   ├ header > h2 > a              标题（可能含 span.article-subtitle）
 *     │   ├ p.note                        摘要
 *     │   └ div.meta
 *     │        a.post-like[data-aid]      赞
 *     │        time                       日期
 *     │        a.cat                      分类
 *     │        a.pc.views                 阅读
 *     │        a.pc[href$="#comments"]    评论
 *     └ div.pagination                    共 N 页
 *
 * 只取「最新福利」那一块：区块标题和 20 条 article 是同一个 div.content 的直接子节点，
 * 所以先定位标题、再取它的父容器。这样门户以后加别的区块也不会被一起捞进来。
 */
export async function fetchLatestArticles(page = 1): Promise<PortalListPage> {
	const html = await getPublicHtml(portalListUrl(page));
	const $ = cheerio.load(html);

	// 定位「最新福利」区块。认不出标题就退回整页（模板改版时不至于整页空白）
	const $title = $('div.excerpts-title')
		.filter((_i, el) => /最新/.test(textOf($, el)))
		.first();
	const $scope = $title.length ? $title.parent() : $('body');

	const articles: PortalArticle[] = [];
	const seen = new Set<string>();

	$scope.find('article.excerpt').each((_, el) => {
		const $item = $(el);
		const href = $item.find('a.focus[href]').first().attr('href') || '';
		const url = articleBaseUrl(portalAbsolute(href));
		if (!url || seen.has(url)) {
			return;
		}

		const $titleA = $item.find('header h2 a[href]').first();
		const title = titleWithoutSubtitle($, $titleA);
		if (!title) {
			return;
		}
		seen.add(url);

		const $cat = $item.find('a.cat[href]').first();
		const thumb = $item.find('img.thumb').first().attr('src') || '';

		articles.push({
			aid: parseInt($item.find('[data-aid]').first().attr('data-aid') || '', 10) || 0,
			title,
			subtitle: textOf($, $item.find('.article-subtitle').first().get(0)) || undefined,
			url,
			thumb: thumb ? portalAbsolute(thumb) : undefined,
			summary: textOf($, $item.find('p.note').first().get(0)) || undefined,
			date: textOf($, $item.find('time').first().get(0)),
			category: categoryName($, $cat) || undefined,
			categoryUrl: $cat.attr('href') ? portalAbsolute($cat.attr('href')!) : undefined,
			views: parseCount(textOf($, $item.find('a.views').first().get(0))),
			comments: parseCount(textOf($, $item.find('a[href*="#comments"]').first().get(0))),
			likes: parseCount($item.find('[data-aid]').first().text()),
		});
	});

	if (!articles.length) {
		throw new Error('未能从门户首页解析出「最新福利」列表，模板可能已改版');
	}

	// 分页：li.active 是当前页，li 里那句「共 368 页」是总数
	let pageNow = page;
	let pageTotal = 1;
	const $pg = $scope.find('div.pagination').first();
	if ($pg.length) {
		const current = parseInt($pg.find('li.active').first().text().trim(), 10);
		if (current) {
			pageNow = current;
		}
		const totalMatch = $pg.text().match(/共\s*(\d+)\s*页/);
		if (totalMatch) {
			pageTotal = parseInt(totalMatch[1], 10);
		} else {
			let max = pageNow;
			$pg.find('a[href]').each((_, el) => {
				const m = ($(el).attr('href') || '').match(/\/page\/(\d+)/);
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

	const portals: PortalLink[] = [];
	$title.find('div.more a[href]').each((_, el) => {
		const name = textOf($, el);
		const url = portalAbsolute($(el).attr('href') || '');
		if (name && url) {
			portals.push({ name, url });
		}
	});

	return { articles, pageNow, pageTotal, portals };
}

/**
 * 清洗文章正文。
 *
 * 比论坛那边简单：门户正文是编辑器产出的，标签干净（实测一篇 2 万字的文章只有
 * p / h4 / blockquote / strong / a / img / iframe / br），没有 Discuz 的
 * `ignore_js_op`、附件浮层那些外壳。要做的是四件事：
 *   1. 只留下白名单内的播放器 iframe（其余第三方页面一律不嵌）
 *   2. 图片换成「点击加载」占位块 —— 实测单张最大 6.8 MB，一篇 54 张，
 *      打开就全量加载会直接拉几十 MB，这条不是优化而是必须
 *   3. 链接补成绝对地址（webview 里相对地址解析不到门户域名上）
 *   4. 去掉一切可执行内容
 */
function sanitizePortalContent($: CheerioAPI, $content: cheerio.Cheerio<AnyElement>): void {
	$content.find('script,style,link,object,embed,meta,noscript').remove();

	// 播放器：白名单内的留着，顺带补上能力声明（全屏、画中画），套一层外框统一尺寸
	$content.find('iframe').each((_, el) => {
		const $f = $(el);
		const raw = ($f.attr('src') || '').trim();
		if (!raw || !isAllowedEmbed(raw)) {
			$f.remove();
			return;
		}
		const absolute = raw.startsWith('//') ? `https:${raw}` : raw;
		// 门户把播放器尺寸写死在 width/height 上（BGM 播放器是 330×86），
		// 留着会和外框 CSS 打架，摘掉交给 CSS 管
		$f.removeAttr('width');
		$f.removeAttr('height');
		$f.removeAttr('style');
		$f.attr({
			class: 'embed',
			src: absolute,
			allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture',
			allowfullscreen: '',
		});
		const host = (() => {
			try {
				return new URL(absolute).hostname;
			} catch {
				return '';
			}
		})();
		const note =
			host === 'music.163.com'
				? `BGM 播放器（网易云音乐）· <a href="${escapeAttr(absolute)}" target="_blank">在浏览器里打开</a>`
				: `<a href="${escapeAttr(absolute)}" target="_blank">在浏览器里打开播放器</a>`;
		$f.replaceWith(
			'<figure class="media-embed"><div class="media-stage">' +
				$.html($f) +
				`</div><figcaption class="media-note">${note}</figcaption></figure>`
		);
	});

	// 去掉 on* 事件属性与 javascript: 协议
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

	// 图片 → 占位块。带上原始尺寸，占位块就能按比例撑出该有的大小，
	// 展开时页面不会跳一下。
	$content.find('img').each((_, el) => {
		const $img = $(el);
		const src = ($img.attr('src') || '').trim();
		if (!src) {
			$img.remove();
			return;
		}
		const width = parseInt($img.attr('data-width') || $img.attr('width') || '', 10) || 0;
		const height = parseInt($img.attr('data-height') || '', 10) || 0;
		const label = width && height ? `[图片 ${width}×${height}] 点击加载` : '[图片] 点击加载';
		$img.replaceWith(
			`<span class="img-slot" data-src="${escapeAttr(portalAbsolute(src))}"` +
				(width ? ` data-w="${width}"` : '') +
				(height ? ` data-h="${height}"` : '') +
				`>${label}</span>`
		);
	});

	// javascript: 空链接拆掉外壳，只留文字
	$content.find('a').each((_, el) => {
		const $a = $(el);
		const href = ($a.attr('href') || '').trim();
		if (!href || /^javascript:/i.test(href)) {
			$a.replaceWith($a.contents());
			return;
		}
		$a.attr('href', portalAbsolute(href));
		$a.attr('rel', 'noreferrer');
		$a.removeAttr('target');
	});

	// Discuz 的编辑器换行标记，浏览器不认，换成真换行
	$content.find('ignore_js_op').each((_, el) => {
		$(el).replaceWith($(el).contents());
	});
}

/**
 * 评论正文清洗。
 *
 * 和正文不一样：评论里的小图基本都是表情（/static/image/smiley/...），不能像正文那样
 * 换成「点击加载」占位块 —— 一行字配个表情，中间塞个灰方块反而看不懂。
 * 所以这里只做三件事：去掉能执行的东西、把相对地址补全、图片改成懒加载。
 */
function sanitizeCommentContent($: CheerioAPI, $content: cheerio.Cheerio<AnyElement>): void {
	$content.find('script, style, iframe, form, input, button, textarea').remove();

	// 评论是别人写的内容，on* 事件属性与 javascript: 协议一律摘掉
	$content.find('*').each((_, el) => {
		if (!('attribs' in el)) {
			return;
		}
		const attribs = el.attribs ?? {};
		Object.keys(attribs).forEach((name) => {
			const lower = name.toLowerCase();
			if (lower.startsWith('on') || lower === 'style' || lower === 'id') {
				$(el).removeAttr(name);
			}
			if ((lower === 'href' || lower === 'src') && /^\s*javascript:/i.test(attribs[name] || '')) {
				$(el).removeAttr(name);
			}
		});
	});

	// javascript: 空链接拆掉外壳，只留文字
	$content.find('a').each((_, el) => {
		const $a = $(el);
		const href = ($a.attr('href') || '').trim();
		if (!href) {
			$a.replaceWith($a.contents());
			return;
		}
		$a.attr('href', portalAbsolute(href));
		$a.attr('rel', 'noreferrer');
		$a.removeAttr('target');
	});

	$content.find('img').each((_, el) => {
		const $img = $(el);
		const src = ($img.attr('src') || $img.attr('data-src') || '').trim();
		if (!src) {
			$img.remove();
			return;
		}
		$img.attr('src', portalAbsolute(src));
		// 表情是小图，滚到评论区再加载就够了
		$img.attr('loading', 'lazy');
		$img.attr('referrerpolicy', 'no-referrer');
		$img.removeAttr('srcset');
		$img.removeAttr('data-src');
	});
}

/**
 * 评论时间。
 *
 * 新评论在页面上写的是「10 分钟前」，绝对时间只藏在 span[title] 属性里；
 * 老评论没有 title，span 的文本本身就是「2026-8-5 08:56」。
 * 相对时间会过期（同一份 HTML 过一天再看还是「10 分钟前」），所以优先取 title。
 */
function commentTimeOf($: CheerioAPI, $meta: cheerio.Cheerio<AnyElement>): string {
	let absolute = '';
	$meta.find('span[title]').each((_, el) => {
		const t = ($(el).attr('title') || '').trim();
		if (/^\d{4}-\d{1,2}-\d{1,2}/.test(t)) {
			absolute = t;
		}
	});
	if (absolute) {
		return absolute;
	}

	let text = '';
	$meta.find('span').each((_, el) => {
		const t = $(el).text().replace(/\s+/g, ' ').trim();
		if (/^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}$/.test(t)) {
			text = t;
		}
	});
	return text;
}

/** 解析一条评论。顶层和楼中楼结构一样，只有楼层号与「回复 @某人」的差别 */
function parseCommentItem(
	$: CheerioAPI,
	$li: cheerio.Cheerio<AnyElement>
): PortalComment | undefined {
	const $body = $li.children('div.comt-main').first();
	const $scope = $body.length ? $body : $li;

	const $content = $scope.children('p').first();
	if (!$content.length) {
		return undefined;
	}
	sanitizeCommentContent($, $content);

	const $meta = $scope.children('div.comt-meta').first();
	const $avatar = $li.children('div.comt-avatar').find('img').first();
	const avatar = ($avatar.attr('src') || '').trim();

	// 楼中楼的 meta 里有个 <b>@昵称</b>，表示在回复谁
	const replyTo = $meta.find('b').first().text().replace(/^@/, '').trim();

	return {
		cid: parseInt(($li.attr('id') || '').replace(/^comment-/, ''), 10) || 0,
		floor: textOf($, $li.children('span.comt-f').first().get(0)) || undefined,
		author: textOf($, $meta.find('.comt-author').first().get(0)) || '匿名',
		avatar: avatar ? portalAbsolute(avatar) : undefined,
		time: commentTimeOf($, $meta),
		content: $content.html() || '',
		likes: parseCount($meta.find('.comt-like-num').first().text()),
		replyTo: replyTo || undefined,
		replies: [],
	};
}

/**
 * 评论区。
 *
 * 结构（DUX 门户文章页）：
 *   div.title#comments > h3 > b                          评论总数
 *   div#postcomments > ol.commentlist
 *     └ li.comment.depth-1                                顶层
 *         ├ span.comt-f                                   #1
 *         ├ div.comt-avatar > img                         头像
 *         ├ div.comt-main
 *         │   ├ p                                         正文
 *         │   └ div.comt-meta
 *         │       ├ span.comt-author                      作者
 *         │       ├ span.muted                            时间
 *         │       └ a.comt-like-btn > span.comt-like-num   赞
 *         └ ul.children > li.comment.depth-2              楼中楼
 *
 * 没有分页：实测 31 条的页面也是一次全渲染出来的。而且文章正文翻页时，
 * 每一页都带着同一份评论，所以在哪一页都能读到全部。
 *
 * ⚠️ 楼中楼是**多层嵌套**的，不是一层：
 *    /mdsjxsf.html 实测 31 条 = 顶层 13 + depth-2 9 + depth-3 3 + depth-4 5 + depth-5 1，
 *    每一条回复都挂在上一条回复的 ul.children 里，越挂越深。
 * 所以这里把整棵树**摊平**进顶层评论的 replies，而不是原样保留嵌套：
 *   · 面板里照着嵌套渲染的话，第 3 层往后会被挤成一条竖缝，没法读；
 *   · 「在回复谁」的信息由 replyTo 带着，摊平不会丢；
 *   · 原始层级记在 depth 上，将来想改成逐级缩进随时有数据。
 */
function parseComments($: CheerioAPI): PortalComment[] {
	const list: PortalComment[] = [];

	/** 把 $li 底下的楼中楼全部收进 host.replies（深度优先，保持出现顺序） */
	const flatten = ($li: cheerio.Cheerio<AnyElement>, host: PortalComment, depth: number): void => {
		$li.children('ul.children')
			.children('li.comment')
			.each((_, child) => {
				const $child = $(child);
				const item = parseCommentItem($, $child);
				if (!item) {
					return;
				}
				item.depth = depth;
				host.replies.push(item);
				flatten($child, host, depth + 1);
			});
	};

	$('div#postcomments ol.commentlist')
		.first()
		.children('li.comment')
		.each((_, el) => {
			const $li = $(el);
			const item = parseCommentItem($, $li);
			if (!item) {
				return;
			}
			list.push(item);
			flatten($li, item, 1);
		});

	return list;
}

/**
 * 抓一篇文章。
 *
 * 结构：
 *   header > h1.article-title > a     标题
 *   div.article-meta > span.item      日期 / 分类 / 评论(N) / 浏览(N)
 *   article.article-content           正文
 *   div.article-paging                分页（a/span.post-page-numbers）
 *   div.article-tags > a              标签
 *   #dux-like-count                   赞数
 */
export async function fetchPortalArticle(url: string, page = 1): Promise<PortalArticleDetail> {
	const base = articleBaseUrl(url);
	if (!base) {
		throw new Error('文章地址为空');
	}
	const html = await getPublicHtml(portalArticleUrl(base, page));
	const $ = cheerio.load(html);

	const $content = $('article.article-content').first();
	if (!$content.length) {
		throw new Error('未能解析出文章正文，门户模板可能已改版');
	}

	const $titleA = $('h1.article-title a').first();
	const title =
		titleWithoutSubtitle($, $titleA) ||
		textOf($, $('h1.article-title').first().get(0)) ||
		textOf($, $('title').first().get(0)).replace(/[-_]\s*福利吧\s*$/, '').trim() ||
		'文章';

	// meta 里是四个 span.item，靠前缀文字区分，别按位置取 —— 有的文章没有分类
	let date = '';
	let category: string | undefined;
	let categoryUrl: string | undefined;
	let views = 0;
	let comments = 0;
	$('div.article-meta span.item').each((_, el) => {
		const $item = $(el);
		const text = textOf($, el);
		const cmp = text.match(/评论\s*[（(](\d+)[)）]/);
		const vw = text.match(/浏览\s*[（(](\d+)[)）]/);
		const cat = text.match(/^分类[：:]\s*(.*)$/);
		if (cmp) {
			comments = parseInt(cmp[1], 10);
		} else if (vw) {
			views = parseInt(vw[1], 10);
		} else if (cat) {
			const $catA = $item.find('a[href]').first();
			category = cat[1] || textOf($, $catA.get(0));
			categoryUrl = $catA.attr('href') ? portalAbsolute($catA.attr('href')!) : undefined;
		} else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(text)) {
			date = text;
		}
	});

	sanitizePortalContent($, $content);

	// 文章分页：当前页是 span.post-page-numbers.current，最大页码就是总页数
	let pageNow = page;
	let pageTotal = 1;
	const $paging = $('div.article-paging').first();
	if ($paging.length) {
		const current = parseInt($paging.find('.post-page-numbers.current').first().text().trim(), 10);
		if (current) {
			pageNow = current;
		}
		let max = pageNow;
		$paging.find('.post-page-numbers').each((_, el) => {
			const n = parseInt($(el).text().trim(), 10);
			if (n) {
				max = Math.max(max, n);
			}
		});
		pageTotal = max;
	}

	const tags: string[] = [];
	$('div.article-tags a').each((_, el) => {
		const name = textOf($, el);
		if (name && !tags.includes(name)) {
			tags.push(name);
		}
	});

	// 评论区。meta 里的「评论(N)」是门户自己标的数，解析出来的是实际渲染在页面上的，
	// 两边对不上时取大的那个：前者可能没算楼中楼，后者可能被主题截断。
	const commentList = parseComments($);

	return {
		title,
		url: base,
		date,
		category,
		categoryUrl,
		views,
		comments: Math.max(comments, commentList.length),
		// 赞数在正文下方那个按钮里（#dux-like-count），取不到就是 0
		likes: parseCount($('#dux-like-count').first().text()),
		tags,
		content: $content.html() || '',
		pageNow,
		pageTotal,
		commentList,
	};
}
