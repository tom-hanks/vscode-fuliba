import * as cheerio from 'cheerio';
import { getHtml, postHtml } from './http';
import { ThreadSupport } from './models';

/**
 * 论坛「支持楼主」。
 *
 * 这是论坛装的第三方插件 `she_btps`，不是插件自己造的功能。它建在 Discuz 原生
 * 评分（`forum.php?mod=misc&action=rate`）之上，所以整个流程都是 Discuz 的规矩：
 *
 *  1. 读模块：`plugin.php?id=she_btps:btps&action=btpsajax&fid&tid&pid`
 *     帖子 HTML 里那一块其实是空的，论坛前端用 AJAX 往里填，
 *     所以必须单独请求一次才拿得到 formhash 和评分项。
 *  2. 提交：POST `forum.php?mod=misc&action=rate&ratesubmit=yes&infloat=yes&inajax=1`
 *  3. 回执：成功了论坛前端还会调 `plugin.php?...&action=postajax&txts=a`，
 *     插件据此记下「这个人支持过了」。走 HTTP 就得自己补这一步。
 */

/** 插件入口，读模块和提交回执都挂在它下面 */
const PLUGIN = 'plugin.php?id=she_btps:btps';

/**
 * Discuz 的 AJAX 响应统一是 `<root><![CDATA[...]]></root>`，
 * 真正的内容（一段 HTML 或一段 script）在 CDATA 里。
 */
function unwrapXml(raw: string): string {
	const hit = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
	return hit ? hit[1] : raw;
}

/**
 * 读「支持楼主」模块，取回提交所需的一切。
 *
 * 取不到就返回 undefined，页面少显示一个按钮而已 —— 版块没装这个插件、
 * 帖子是匿名帖、账号没有评分权限、或者只是论坛抖了一下，都不该让帖子打不开。
 */
export async function fetchThreadSupport(
	tid: number,
	fid: number,
	pid: number
): Promise<ThreadSupport | undefined> {
	if (!fid || !pid) {
		return undefined;
	}

	let raw: string;
	try {
		raw = await getHtml(`${PLUGIN}&action=btpsajax`, { fid, tid, pid });
	} catch {
		return undefined;
	}

	const $ = cheerio.load(unwrapXml(raw));
	const $form = $('form[id^="rateform_"]').first();
	if (!$form.length) {
		return undefined;
	}

	const valueOf = (name: string): string => $form.find(`input[name="${name}"]`).attr('value') ?? '';

	// 评分项字段名形如 score2：后缀是评分项序号，value 是这次给的分值。
	// 都从服务端返回的表单里读，不自己猜 —— 论坛后台随时可能改。
	let scoreId = '';
	let score = '';
	$form.find('input[name^="score"]').each((_, el) => {
		const matched = ($(el).attr('name') || '').match(/^score(\d+)$/);
		if (matched && !scoreId) {
			scoreId = matched[1];
			score = $(el).attr('value') || '1';
		}
	});

	const formhash = valueOf('formhash');
	if (!scoreId || !formhash) {
		return undefined;
	}

	// 计数藏在柱子里的 <em>8</em>
	const count = parseInt($form.find('.atdtidc em').first().text().replace(/\D/g, ''), 10) || 0;

	return {
		pid,
		fid,
		count,
		formhash,
		scoreId,
		score,
		reason: valueOf('reason') || '感谢分享，福利吧因你而精彩',
		handlekey: valueOf('handlekey') || 'rate',
		formSuffix: ($form.attr('id') || '').replace(/^rateform_/, '') || 'a',
		allowed: true,
	};
}

export interface SupportOutcome {
	/** 服务端确认成功 */
	ok: boolean;
	/** 给用户看的文案 */
	message: string;
	/**
	 * 失败原因是「已经支持过了」。
	 * 这不是错误，是一种状态，界面应该照「已支持」显示，而不是弹个红字。
	 */
	alreadyDone?: boolean;
}

/**
 * 提交一次「支持楼主」。
 *
 * 三个必须踩对的点，任何一个错了都会被 Discuz 顶回来：
 *
 *  1. **URL 必须带 `inajax=1`**。服务端进这个分支第一件事就是
 *     `if(!$_G['inajax']) showmessage('undefined_action')`。这个参数不是表单字段，
 *     而是 Discuz 的 AJAX 框架在提交前追加到 `form.action` 上的
 *     （`action.replace(/\&inajax=1/g,'') + '&inajax=1'`），所以直接发 HTTP 时得自己带上。
 *  2. **`formhash` 必须与当前会话一致**，否则 `submitcheck` 直接判非法。
 *  3. **Referer 的域名必须是论坛自己的域名**，`submitcheck` 会比对；
 *     `postHtml` 已经把 Referer 设成目标地址，这里不用再管。
 *
 * 注意这里不判断「是不是自己的帖子」——那是服务端的事，它会返回
 * 「不能给自己评分」这类文案，我们照原样显示。
 */
export async function submitSupport(tid: number, support: ThreadSupport): Promise<SupportOutcome> {
	const html = await postHtml('forum.php?mod=misc&action=rate&ratesubmit=yes&infloat=yes&inajax=1', {
		formhash: support.formhash,
		handlekey: support.handlekey,
		tid: String(tid),
		pid: String(support.pid),
		referer: `forum.php?mod=viewthread&tid=${tid}#pid${support.pid}`,
		[`score${support.scoreId}`]: support.score,
		reason: support.reason,
		sendreasonpm: 'on',
		[`rateform_${support.formSuffix}`]: 'yes',
	});

	const body = unwrapXml(html);

	// 服务端的判定写在 dshowmessage 里：
	//   有 url_forward  → if(typeof succeedhandle_rate=='function'){succeedhandle_rate(...)}
	//   没有 url_forward → if(typeof errorhandle_rate=='function'){errorhandle_rate('文案', ...)}
	// 而 success 分支传的是 dreferer()，error 分支传的是 NULL，两者是互斥的，
	// 所以拿这两个函数名就能一刀切开。
	if (/succeedhandle_/.test(body)) {
		void notifyPlugin(tid, support);
		return { ok: true, message: '支持成功' };
	}

	const message = readError(body);
	return { ok: false, message, alreadyDone: /已经.*(评|评分|支持)|评过|重复/.test(message) };
}

/** 从失败响应里取出人能看懂的那句话 */
function readError(body: string): string {
	// errorhandle_rate('文案', {...})，文案里的单引号被服务端转义成了 \'
	const handled = body.match(/errorhandle_\w*\s*\(\s*'((?:[^'\\]|\\.)*)'/);
	if (handled) {
		return handled[1].replace(/\\'/g, "'").trim();
	}

	// 兜底：把提示区里的标签都扒掉
	const text = body
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return text || '支持失败，请稍后再试';
}

/**
 * 提交成功后补一次回执，插件才会把「已支持」记下来。
 * 这一步本来是论坛前端 `succeedhandle_rate()` 里做的。
 * 失败就算了 —— 支持本身已经生效，少一条插件自己的记录不影响。
 */
async function notifyPlugin(tid: number, support: ThreadSupport): Promise<void> {
	try {
		await getHtml(`${PLUGIN}&action=postajax`, {
			fid: support.fid,
			tid,
			pid: support.pid,
			formhash: support.formhash,
			txts: support.formSuffix,
		});
	} catch {
		/* 忽略 */
	}
}
