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

/**
 * 会被重试的网络错误。
 *
 * 论坛侧会不定时地把连接直接掐掉（客户端表现为 "socket hang up" / ECONNRESET），
 * 实测同一个帖子页连发 8 次能失败 5 次，而失败后立刻重试基本都能成功——
 * 说明是瞬时故障，不是帖子或地址有问题，重试就是最对症的解法。
 * 只重试「根本没拿到响应」的情况，HTTP 状态码错误照旧直接抛出。
 */
const RETRYABLE_CODES = new Set([
	'ECONNRESET',
	'ECONNABORTED',
	'EPIPE',
	'ETIMEDOUT',
	'ECONNREFUSED',
	'EAI_AGAIN',
	'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/** 最多尝试几次（含首次） */
const MAX_ATTEMPTS = 3;
/** 每次重试前的等待，第 n 次重试取 RETRY_DELAYS[n-1] */
const RETRY_DELAYS = [500, 1500];

/**
 * 文案兜底匹配。
 *
 * 必须留这一层：论坛掐连接时，Node 抛出来的错误往往只有一句 "aborted"
 *（流被中断），既没有 code 也不是标准文案，只靠 code 判断会漏掉——实测漏掉后
 * 重试完全不触发，24 次里照样失败 7 次。
 */
const RETRYABLE_TEXT = /socket hang up|ECONNRESET|aborted|premature close/i;

function isRetryable(err: unknown): boolean {
	const e = err as { code?: string; message?: string; response?: { status?: number } };

	// 别用「有没有 response」来判断。响应头回来了、包体被中途掐断时，axios 抛的错
	// 仍然带着 response 且 status 是 200（实测形态：
	//   { code: 'ECONNRESET', message: 'aborted', response: { status: 200 } }），
	// 这种情况是拿到了半个包，必须重试，否则打开帖子会随机只显示一部分内容。
	// 真正不该重试的只有 HTTP 错误状态；而 Discuz 提示页 / 未登录 / 无权限那些
	// 是由 readHtml 抛出的领域错误，压根不带 response。
	const status = e?.response?.status;
	if (typeof status === 'number' && status >= 400) {
		return false;
	}

	if (e?.code && RETRYABLE_CODES.has(e.code)) {
		return true;
	}
	return RETRYABLE_TEXT.test(e?.message ?? '');
}

function isCompressionError(err: unknown): boolean {
	return /content encoding|decompress|incorrect header check|invalid.*brotli/i.test(
		(err as { message?: string })?.message ?? ''
	);
}

/**
 * 按次数重试一个请求。
 *
 * 重试时把 Accept-Encoding 降为 identity：实测带压缩的响应更容易被掐断
 *（压缩组 24 次失败 6 次，不压缩组 24 次只失败 1 次），
 * 这个降级只在重试路径上生效，正常请求照旧吃压缩省流量。
 */
async function withRetry<T>(
	label: string,
	run: (headers: Record<string, string>) => Promise<T>
): Promise<T> {
	let lastErr: unknown;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		// 首次正常请求；之后一律要未压缩内容，避开压缩响应被掐断的那个坑
		const headers: Record<string, string> = attempt === 1 ? {} : { 'Accept-Encoding': 'identity' };
		try {
			return await run(headers);
		} catch (err) {
			lastErr = err;
			// 领域错误（未登录 / 无权限 / 帖子不存在 / Discuz 提示页）不重试，
			// 而且必须原样抛出，上层要靠错误类型决定提示什么
			if (!(isRetryable(err) || isCompressionError(err))) {
				throw err;
			}
			if (attempt === MAX_ATTEMPTS) {
				break;
			}
			await sleep(RETRY_DELAYS[attempt - 1] ?? 1500);
		}
	}

	const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
	throw new Error(`${label}失败（已重试 ${MAX_ATTEMPTS - 1} 次）：${reason}`);
}

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
	const target = absoluteUrl(urlOrPath);

	return withRetry(`请求 ${urlOrPath}`, async (extra) => {
		await throttle();
		const response = await client.get<string>(target, {
			params,
			headers: { Cookie: cookie, ...extra },
			validateStatus: () => true,
		});
		return readHtml(response);
	});
}

/**
 * 不带 Cookie 的 GET。
 *
 * 门户站（福利吧官网）游客就能读全：首页、「最新福利」列表、文章正文都是 200，
 * 正文里没有回复可见 / 积分购买那类门槛。所以走门户这条路不需要 Cookie ——
 * 而且也不该带：门户和论坛是两个域，论坛那份 Cookie 拿过去只会是一串无效字段。
 *
 * 其余行为（限速、重试、Discuz 提示页识别）与 getHtml 完全一致。
 */
export async function getPublicHtml(url: string): Promise<string> {
	return withRetry(`请求 ${url}`, async (extra) => {
		await throttle();
		const response = await client.get<string>(url, {
			headers: { ...extra },
			validateStatus: () => true,
		});
		return readHtml(response);
	});
}

/**
 * 发起一次 POST 请求并返回 HTML 文本。
 * Discuz 的搜索等表单必须带 formhash 走 POST，GET 只会返回空表单页。
 */
export async function postHtml(urlOrPath: string, data: Record<string, string>): Promise<string> {
	const cookie = await requireCookie();
	const target = absoluteUrl(urlOrPath);
	const body = new URLSearchParams(data).toString();

	return withRetry(`提交 ${urlOrPath}`, async (extra) => {
		await throttle();
		const response = await client.post<string>(target, body, {
			headers: {
				Cookie: cookie,
				'Content-Type': 'application/x-www-form-urlencoded',
				// Discuz 会校验来源页，缺 Referer 时搜索会被判为非法请求
				Referer: target,
				...extra,
			},
			validateStatus: () => true,
		});
		return readHtml(response);
	});
}

/** 下载二进制内容（图片等），带上 Cookie 和 Referer 以绕过防盗链 */
export async function getBinary(urlOrPath: string): Promise<Buffer> {
	const cookie = await Global.getCookie();
	const target = absoluteUrl(urlOrPath);

	return withRetry(`下载 ${urlOrPath}`, async (extra) => {
		await throttle();
		const response = await client.get<ArrayBuffer>(target, {
			responseType: 'arraybuffer',
			headers: {
				...(cookie ? { Cookie: cookie } : {}),
				Referer: Global.getSiteUrl() + '/',
				...extra,
			},
			validateStatus: () => true,
		});

		if (response.status >= 400) {
			throw new Error(`下载失败：HTTP ${response.status}`);
		}
		return Buffer.from(response.data);
	});
}
