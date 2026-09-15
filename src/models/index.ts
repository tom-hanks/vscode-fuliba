/**
 * 数据模型定义。
 * 对应 Discuz 论坛的版块 / 帖子列表 / 帖子详情三层结构。
 */

/** 单个版块 */
export interface Forum {
	/** 版块 id */
	fid: number;
	/** 版块名 */
	name: string;
	/** 版块页面的相对地址，如 forum-2-1.html */
	url: string;
	/** 今日发帖数 */
	todayPosts?: number;
	/** 主题总数 */
	threads?: number;
	/** 帖子总数 */
	posts?: number;
	/** 版块简介 */
	description?: string;
	/** 是否是子版块 */
	isSub?: boolean;
}

/** 版块分组，如「福娃专区」下面挂几个版块 */
export interface ForumGroup {
	name: string;
	forums: Forum[];
}

/**
 * 帖子列表的排序方式。
 * 取值直接对应 Discuz forumdisplay 的 orderby 参数，改动时记得同步 sortLabel。
 */
export type ThreadSort = 'lastpost' | 'dateline' | 'heats';

/** 排序方式的中文名，用于菜单与侧边栏标题 */
export const SORT_LABELS: Record<ThreadSort, string> = {
	lastpost: '最新回复',
	dateline: '最新发布',
	heats: '热帖',
};

/** 排序方式的菜单说明 */
export const SORT_DETAILS: Record<ThreadSort, string> = {
	lastpost: '按最后回复时间倒序，有人在下面回帖就会顶上来',
	dateline: '按发帖时间倒序，只看新帖',
	heats: '按热度倒序，回复和查看多的排前面',
};

/** 帖子列表中的一条 */
export interface Thread {
	tid: number;
	title: string;
	/** 帖子地址，已补全域名 */
	url: string;
	author: string;
	authorUid?: number;
	replyCount: number;
	viewCount: number;
	/** 最后回复时间，形如 2026-9-14 */
	lastReplyAt?: string;
	lastReplyUser?: string;
	isSticky?: boolean;
	isDigest?: boolean;
	isClosed?: boolean;
	/** 分类信息，如 [晒图] */
	typeName?: string;
	/** 所在版块名，仅搜索结果会填 */
	forumName?: string;
	/** 内容摘要，仅搜索结果会填 */
	summary?: string;
}

/** 一个版块的帖子列表页 */
export interface ThreadListPage {
	fid: number;
	forumName: string;
	threads: Thread[];
	pageNow: number;
	pageTotal: number;
	/** 这一页用的排序方式 */
	sort: ThreadSort;
}

/** 帖子详情中的一层楼 */
export interface Post {
	pid: number;
	/** 楼层号，楼主楼固定为 "楼主"，其余为 "沙发""板凳" 或数字 */
	floor: string;
	author: string;
	authorUid?: number;
	avatar?: string;
	/** 发帖时间，形如 2026-9-14 12:30 */
	time: string;
	/** 正文 HTML，已做安全过滤 */
	content: string;
	/** 是否是楼主 */
	isOriginalPost: boolean;
}

/** 帖子详情页 */
export interface ThreadDetail {
	tid: number;
	title: string;
	forumName: string;
	url: string;
	posts: Post[];
	pageNow: number;
	pageTotal: number;
}

/** 帖子详情里播放器的显示尺寸（像素）。全局一份，拖动任意一个播放器就一起变 */
export interface PlayerSize {
	width: number;
	height: number;
}
