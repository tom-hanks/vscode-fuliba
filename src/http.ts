import axios, { AxiosInstance, AxiosResponse } from 'axios';
import Global from './global';
import { LoginRequiredError, AccessDeniedError, NotFoundError } from './error';

const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 上一次请求发出的时间戳，用于节流 */
let lastRequestAt = 0;
/** 请求串行队列，保证节流在多处并发调用时也成立 */
let queue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把请求排进队列，保证两次请求之间至少间隔 requestInterval 毫秒。
 * 论坛对短时间高频访问比较敏感，这里做主动限速。
 */
function throttle(): Promise<void> {
	const interval = Global.getRequestInterval();
	queue = queue.then(async () => {
		const wait = lastRequestAt + interval - Date.now();
		if (wait > 0) {
			await sleep(wait);
		}
		lastRequestAt = Date.now();
	});
	return queue;
}

const client: AxiosInstance = axios.create({
	timeout: 20000,
	maxRedirects: 5,
	responseType: 'text',
	headers: {
		'User-Agent': UA,
		Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
		'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
	},
});

/** 拼成完整的请求地址 */
export function absoluteUrl(urlOrPath: string): string {
	if (/^https?:\/\//i.test(urlOrPath)) {
		return urlOrPath;
	}
	return `${Global.getSiteUrl()}/${urlOrPath.replace(/^\/+/, '')}`;
}

/**
 * 检查响应是不是 Discuz 的「提示信息」页。
 * 这类页面统一用 <div id="messagetext"> 承载错误文案，HTTP 状态码仍是 200，
 * 所以只能从内容判断。
 */
function checkNoticePage(html: string): void {
	const match = html.match(/<div[^>]*id=["']?messagetext["']?[^>]*>([\s\S]*?)<\/div>/i);
	if (!match) {
		return;
	}
	// 去掉标签、脚本样式，取出纯文案
	const text = match[1]
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.trim();

	if (!text) {
		return;
	}
	if (/尚未登录|请先登录|需要登录|登录后才能/.test(text)) {
		throw new LoginRequiredError(text);
	}
	if (/没有权限|权限不足|需要满足以下条件|特定用户|用户组|等级/.test(text)) {
		throw new AccessDeniedError(text);
	}
	if (/不存在|已被删除|已删除|正在审核|审核中|已被关闭/.test(text)) {
		throw new NotFoundError(text);
	}
}

/**
 * 校验响应状态与 Discuz 提示页，返回 HTML 文本。
 * GET / POST 共用同一套判定：论坛出错时状态码仍是 200，只能从内容识别。
 */
function readHtml(response: AxiosResponse<string>): string {
	if (response.status === 403) {
		throw new AccessDeniedError('论坛拒绝了这次请求（403），可能触发了风控，请稍后再试');
	}
	if (response.status === 404) {
		throw new NotFoundError();
	}
	if (response.status >= 400) {
		throw new Error(`请求失败：HTTP ${response.status}`);
	}

	const html = typeof response.data === 'string' ? response.data : String(response.data);
	checkNoticePage(html);
	return html;
}

/** 取 Cookie，没有就提前报错，不浪费一次请求 */
async function requireCookie(): Promise<string> {
	const cookie = await Global.getCookie();
	if (!cookie) {
		throw new LoginRequiredError('尚未导入 Cookie，请先执行「福利吧: 导入 Cookie」');
	}
	return cookie;
}

/** 发起一次 GET 请求并返回 HTML 文本 */
export async function getHtml(urlOrPath: string, params?: Record<string, unknown>): Promise<string> {
	const cookie = await requireCookie();
	await throttle();

	const response = await client.get<string>(absoluteUrl(urlOrPath), {
		params,
		headers: { Cookie: cookie },
		validateStatus: () => true,
	});
	return readHtml(response);
}

/**
 * 发起一次 POST 请求并返回 HTML 文本。
 * Discuz 的搜索等表单必须带 formhash 走 POST，GET 只会返回空表单页。
 */
export async function postHtml(urlOrPath: string, data: Record<string, string>): Promise<string> {
	const cookie = await requireCookie();
	const target = absoluteUrl(urlOrPath);

	await throttle();

	const response = await client.post<string>(target, new URLSearchParams(data).toString(), {
		headers: {
			Cookie: cookie,
			'Content-Type': 'application/x-www-form-urlencoded',
			// Discuz 会校验来源页，缺 Referer 时搜索会被判为非法请求
			Referer: target,
		},
		validateStatus: () => true,
	});
	return readHtml(response);
}

/** 下载二进制内容（图片等），带上 Cookie 和 Referer 以绕过防盗链 */
export async function getBinary(urlOrPath: string): Promise<Buffer> {
	const cookie = await Global.getCookie();
	await throttle();

	const response = await client.get<ArrayBuffer>(absoluteUrl(urlOrPath), {
		responseType: 'arraybuffer',
		headers: {
			...(cookie ? { Cookie: cookie } : {}),
			Referer: Global.getSiteUrl() + '/',
		},
		validateStatus: () => true,
	});

	if (response.status >= 400) {
		throw new Error(`下载失败：HTTP ${response.status}`);
	}
	return Buffer.from(response.data);
}
