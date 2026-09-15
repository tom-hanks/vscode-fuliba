import * as vscode from 'vscode';

const SECRET_COOKIE_KEY = 'fuliba.cookie';
const STATE_READ_TIDS = 'fuliba.readTids';
const STATE_FORUM_CACHE = 'fuliba.forumCache';

/** 已读记录最多保留多少条，避免 state 无限膨胀 */
const READ_TID_LIMIT = 3000;

/**
 * 全局状态。集中管理 Cookie（存 SecretStorage 加密）、已读记录、版块缓存。
 */
export default class Global {
	public static context: vscode.ExtensionContext | undefined;

	/** Cookie 的内存缓存，避免每次请求都去读加密存储 */
	private static cookieCache: string | undefined;
	private static cookieLoaded = false;

	public static async init(context: vscode.ExtensionContext): Promise<void> {
		Global.context = context;
		await Global.getCookie();
	}

	/** 站点根地址，去掉结尾斜杠 */
	public static getSiteUrl(): string {
		const raw =
			vscode.workspace.getConfiguration('fuliba').get<string>('siteUrl') ||
			'https://www.wnflb2023.com';
		return raw.replace(/\/+$/, '');
	}

	/** 两次请求之间的最小间隔（毫秒） */
	public static getRequestInterval(): number {
		const value = vscode.workspace.getConfiguration('fuliba').get<number>('requestInterval');
		return typeof value === 'number' && value >= 0 ? value : 800;
	}

	public static getHideReadThreads(): boolean {
		return vscode.workspace.getConfiguration('fuliba').get<boolean>('hideReadThreads') === true;
	}

	/** 帖子详情里是否显示头像。默认关，每层一张头像会明显拖慢加载 */
	public static getShowAvatar(): boolean {
		return vscode.workspace.getConfiguration('fuliba').get<boolean>('showAvatar') === true;
	}

	public static async getCookie(): Promise<string | undefined> {
		if (!Global.cookieLoaded) {
			Global.cookieCache = await Global.context?.secrets.get(SECRET_COOKIE_KEY);
			Global.cookieLoaded = true;
		}
		return Global.cookieCache;
	}

	public static async hasCookie(): Promise<boolean> {
		return !!(await Global.getCookie());
	}

	public static async setCookie(raw: string): Promise<void> {
		const normalized = Global.normalizeCookie(raw);
		Global.cookieCache = normalized;
		Global.cookieLoaded = true;
		await Global.context?.secrets.store(SECRET_COOKIE_KEY, normalized);
	}

	public static async clearCookie(): Promise<void> {
		Global.cookieCache = undefined;
		Global.cookieLoaded = true;
		await Global.context?.secrets.delete(SECRET_COOKIE_KEY);
	}

	/**
	 * 规范化用户粘贴的 Cookie 字符串。
	 * 兼容几种常见粘贴方式：整段请求头、"Cookie: xxx"、按行分隔、mid-string 换行。
	 */
	public static normalizeCookie(raw: string): string {
		return raw
			.replace(/^\s*cookie\s*:\s*/i, '')
			.replace(/\r?\n/g, '; ')
			.replace(/\s*;\s*/g, '; ')
			.replace(/;\s*$/, '')
			.trim();
	}

	/** 从 Cookie 里取出 Discuz 的 authkey 前缀，形如 S5r8_2132_ */
	public static getCookiePrefix(cookie: string): string | undefined {
		const match = cookie.match(/([A-Za-z0-9]+_2132_)/);
		return match ? match[1] : undefined;
	}

	// ---------- 已读记录 ----------

	public static getReadTids(): number[] {
		return Global.context?.globalState.get<number[]>(STATE_READ_TIDS) ?? [];
	}

	public static isRead(tid: number): boolean {
		return Global.getReadTids().includes(tid);
	}

	public static async addReadTid(tid: number): Promise<void> {
		const list = Global.getReadTids();
		if (list.includes(tid)) {
			return;
		}
		const next = [...list, tid];
		// 超出上限时丢掉最早的一半，保持数组不会无限增长
		const trimmed = next.length > READ_TID_LIMIT ? next.slice(-Math.floor(READ_TID_LIMIT / 2)) : next;
		await Global.context?.globalState.update(STATE_READ_TIDS, trimmed);
	}

	// ---------- 版块缓存 ----------

	public static getForumCache<T>(): T | undefined {
		return Global.context?.globalState.get<T>(STATE_FORUM_CACHE);
	}

	public static async setForumCache(value: unknown): Promise<void> {
		await Global.context?.globalState.update(STATE_FORUM_CACHE, value);
	}
}
