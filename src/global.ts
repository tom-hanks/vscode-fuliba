import * as vscode from 'vscode';
import { ForumGroup, PlayerSize, ThreadSort } from './models';

const SECRET_COOKIE_KEY = 'fuliba.cookie';
const STATE_READ_TIDS = 'fuliba.readTids';
const STATE_FORUM_CACHE = 'fuliba.forumCache';
/** 上一次解析出的版块分组，用于「选择显示的版块」时不必再打一次论坛 */
const STATE_FORUM_GROUPS = 'fuliba.forumGroups';
/** 用户勾选要显示的版块。没存过（undefined）代表「全部显示」 */
const STATE_VISIBLE_FIDS = 'fuliba.visibleFids';

/** 已读记录最多保留多少条，避免 state 无限膨胀 */
const READ_TID_LIMIT = 3000;

const VALID_SORTS: ThreadSort[] = ['lastpost', 'dateline', 'heats'];

/** 播放器默认尺寸。480×270 在侧边栏和普通编辑器宽度下都还看得清 */
const DEFAULT_PLAYER_SIZE: PlayerSize = { width: 480, height: 270 };
/** 拖动的上下限：比这更小就只剩个黑框，更大则一屏放不下 */
const PLAYER_MIN = { width: 200, height: 120 };
const PLAYER_MAX = { width: 1600, height: 1200 };

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.min(max, Math.max(min, Math.round(value)));
}

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

	/**
	 * 帖子列表排序方式。
	 * 配置可能被手改坏，这里做一次白名单校验，落到 'dateline' 保证总有合法值。
	 */
	public static getThreadSort(): ThreadSort {
		const raw = vscode.workspace.getConfiguration('fuliba').get<string>('threadSort');
		return VALID_SORTS.includes(raw as ThreadSort) ? (raw as ThreadSort) : 'dateline';
	}

	public static async setThreadSort(sort: ThreadSort): Promise<void> {
		await vscode.workspace
			.getConfiguration('fuliba')
			.update('threadSort', sort, vscode.ConfigurationTarget.Global);
	}

	/** 是否在帖子里屏蔽置顶帖 */
	public static getHideStickyThreads(): boolean {
		return vscode.workspace.getConfiguration('fuliba').get<boolean>('hideStickyThreads') === true;
	}

	public static async setHideStickyThreads(value: boolean): Promise<void> {
		await vscode.workspace
			.getConfiguration('fuliba')
			.update('hideStickyThreads', value, vscode.ConfigurationTarget.Global);
	}

	// ---------- 版块显示范围 ----------

	/** 勾选要显示的 fid 列表；返回 undefined 表示「全部显示」 */
	public static getVisibleFids(): number[] | undefined {
		const list = Global.context?.globalState.get<number[]>(STATE_VISIBLE_FIDS);
		return Array.isArray(list) && list.length ? list : undefined;
	}

	/** 传 undefined 或空数组表示恢复「全部显示」 */
	public static async setVisibleFids(fids: number[] | undefined): Promise<void> {
		const value = fids && fids.length ? fids : undefined;
		await Global.context?.globalState.update(STATE_VISIBLE_FIDS, value);
	}

	/** 缓存版块分组，供选择界面复用 */
	public static async setForumGroups(groups: ForumGroup[]): Promise<void> {
		await Global.context?.globalState.update(STATE_FORUM_GROUPS, groups);
	}

	public static getForumGroups(): ForumGroup[] | undefined {
		const groups = Global.context?.globalState.get<ForumGroup[]>(STATE_FORUM_GROUPS);
		return Array.isArray(groups) && groups.length ? groups : undefined;
	}

	/** 帖子详情里是否显示头像。默认关，每层一张头像会明显拖慢加载 */
	public static getShowAvatar(): boolean {
		return vscode.workspace.getConfiguration('fuliba').get<boolean>('showAvatar') === true;
	}

	/**
	 * 打开帖子时是否自动修音轨。默认开。
	 *
	 * 默认开是因为「能播但没声」最容易被当成插件坏了 —— 让人先点一下按钮才知道要修，
	 * 等于把解释成本推给用户。自动修只在直链 mp4 上发生，且结果按视频缓存，
	 * 同一个视频一辈子只转一次。
	 */
	public static getAutoFixAudio(): boolean {
		return vscode.workspace.getConfiguration('fuliba').get<boolean>('autoFixAudio') !== false;
	}

	// ---------- 播放器尺寸 ----------

	/**
	 * 播放器尺寸。存成 "480x270" 这种字符串，方便在设置里手改、也好一眼看懂。
	 * 解析不出来或超范围就回落到默认值 —— 设置文件被手改坏不该让详情页打不开。
	 */
	public static getPlayerSize(): PlayerSize {
		const raw = vscode.workspace.getConfiguration('fuliba').get<string>('playerSize');
		const match = typeof raw === 'string' ? raw.match(/^\s*(\d{2,4})\s*[x×*]\s*(\d{2,4})\s*$/i) : null;
		if (!match) {
			return { ...DEFAULT_PLAYER_SIZE };
		}
		return {
			width: clamp(Number(match[1]), PLAYER_MIN.width, PLAYER_MAX.width),
			height: clamp(Number(match[2]), PLAYER_MIN.height, PLAYER_MAX.height),
		};
	}

	/** 拖动播放器后落盘。所有帖子、所有窗口共用这一份，所以是「改一次、到处生效」 */
	public static async setPlayerSize(size: PlayerSize): Promise<void> {
		const width = clamp(size.width, PLAYER_MIN.width, PLAYER_MAX.width);
		const height = clamp(size.height, PLAYER_MIN.height, PLAYER_MAX.height);
		if (width === Global.getPlayerSize().width && height === Global.getPlayerSize().height) {
			return;
		}
		await vscode.workspace
			.getConfiguration('fuliba')
			.update('playerSize', `${width}x${height}`, vscode.ConfigurationTarget.Global);
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
