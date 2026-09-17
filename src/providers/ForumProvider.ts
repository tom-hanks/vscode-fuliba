import * as vscode from 'vscode';
import { BaseProvider, NODE, TreeNode } from './BaseProvider';
import { fetchForumGroups, fetchThreadList } from '../discuz';
import { fetchLatestArticles } from '../portal';
import type { PortalArticle } from '../portal';
import { LoginRequiredError } from '../error';
import { ForumGroup, SORT_LABELS, Thread } from '../models';
import Global from '../global';

/**
 * 侧边栏版块树。
 *
 * 三层结构：分组 → 版块 → 帖子
 * 版块节点展开时才去请求帖子列表（懒加载），避免一次性打爆论坛。
 */
export default class ForumProvider extends BaseProvider {
	private roots: TreeNode[] = [];
	/** 原始版块分组（未经显示范围过滤），用于「选择显示的版块」 */
	private groups: ForumGroup[] = [];
	/** 是否已经尝试过加载根节点，避免 getChildren 被反复调用时重复请求 */
	private loaded = false;

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!element) {
			if (!this.loaded) {
				this.loaded = true;
				await this.loadForums();
			}
			return this.roots;
		}

		if (!element.isDir) {
			return [];
		}

		// 「最新福利」根节点：展开时去门户抓文章列表（不用登录，游客就能读）
		if (element.contextValue === NODE.portal) {
			return this.loadPortalArticles(element);
		}

		// 版块节点：展开时加载帖子列表。不缓存失败结果，这样折叠再展开就能重试
		if (element.fid !== undefined) {
			return this.loadThreads(element);
		}

		// 分组节点：直接返回预建好的子节点
		return element.children ?? [];
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		// 帖子节点的「已读」标记会随用户点开而变，不能在建节点时定死，
		// 每次渲染都重算一遍，这样 refreshNode 之后标记能立刻更新
		if (element.tid !== undefined) {
			ForumProvider.decorateThread(element);
		}
		// 排序提示节点同理：改完排序只 repaint 不重建树，文案在渲染时刷新
		if (element.contextValue === NODE.sortHint) {
			ForumProvider.applySortLabel(element);
		}
		return element;
	}

	/** 重新加载整个版块树 */
	async refreshAll(): Promise<void> {
		this.roots = [];
		this.loaded = false;
		this._onDidChangeTreeData.fire(undefined);
	}

	/**
	 * 只重画、不重新请求版块列表。
	 * 改排序方式、切置顶开关时用这个——版块结构没变，没必要再打一次首页。
	 */
	repaint(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	/** 重新加载某个节点下的内容 */
	refreshNode(node: TreeNode): void {
		this._onDidChangeTreeData.fire(node);
	}

	/** 未经过滤的版块分组，供选择界面列出所有版块 */
	getForumGroups(): ForumGroup[] {
		return this.groups;
	}

	private async loadForums(): Promise<void> {
		const roots: TreeNode[] = [];

		if (!(await Global.hasCookie())) {
			// 没有 Cookie 时论坛那边什么都拉不出来，但门户游客就能读。
			// 所以这里不再留一棵空树 —— 至少让「最新福利」能用，后面跟一条导入引导。
			this.roots = [ForumProvider.portalRoot(), ForumProvider.cookieHint()];
			return;
		}

		try {
			const groups = await fetchForumGroups();
			this.groups = groups;

			// 用户在「选择显示的版块」里勾过就只留勾中的，没勾过（undefined）表示全都要
			const visible = Global.getVisibleFids();
			const keep = (fid: number): boolean => !visible || visible.includes(fid);

			const filtered = groups
				.map((group) => ({ name: group.name, forums: group.forums.filter((f) => keep(f.fid)) }))
				// 分组里一个都没剩就整组不显示，免得留一堆空壳
				.filter((group) => group.forums.length);

			const groupNodes = filtered.map((group) => {
				const groupNode = new TreeNode(group.name, true);
				// 分组只做归类，不参与翻页，所以和版块用不同的节点类型
				groupNode.setKind('group');
				groupNode.iconPath = new vscode.ThemeIcon('folder');
				groupNode.children = group.forums.map((forum) => {
					const forumNode = new TreeNode(forum.name, true);
					forumNode.fid = forum.fid;
					forumNode.nodeName = forum.name;
					forumNode.link = forum.url;
					forumNode.tooltip = forum.description
						? `${forum.name}\n${forum.description}`
						: forum.name;
					forumNode.iconPath = new vscode.ThemeIcon('book');
					return forumNode;
				});
				return groupNode;
			});
			roots.push(...groupNodes);
		} catch (err) {
			roots.push(ForumProvider.errorNode(err));
		}

		// 「最新福利」挂在最后：它是另一个站（门户），和上面的版块不在同一个体系里
		roots.push(ForumProvider.portalRoot());
		// 当前排序挂在树顶：藏在标题栏小字里太不显眼，直接摆进树里点一下就能改
		roots.unshift(ForumProvider.sortHint());
		this.roots = roots;
	}

	private async loadThreads(forumNode: TreeNode): Promise<TreeNode[]> {
		try {
			const page = await fetchThreadList(
				forumNode.fid as number,
				forumNode.pageNow,
				Global.getThreadSort()
			);
			forumNode.nodeName = page.forumName;
			forumNode.pageNow = page.pageNow;
			forumNode.pageTotal = page.pageTotal;
			// 页码挂在版块节点上，翻页后一眼能看出在哪一页
			forumNode.description = `第 ${page.pageNow} / ${page.pageTotal} 页`;

			let threads: Thread[] = page.threads;
			if (Global.getHideStickyThreads()) {
				threads = threads.filter((thread) => !thread.isSticky);
			}
			if (Global.getHideReadThreads()) {
				threads = threads.filter((thread) => !Global.isRead(thread.tid));
			}

			if (!threads.length) {
				return [ForumProvider.hintNode(ForumProvider.emptyHint(page.threads.length))];
			}
			return threads.map((thread) => ForumProvider.threadNode(thread));
		} catch (err) {
			return [ForumProvider.errorNode(err)];
		}
	}

	/**
	 * 展开「最新福利」时去门户抓一页文章。
	 *
	 * 和论坛那边不一样：门户游客就能读，所以这里不需要 Cookie。
	 * 失败不缓存，折叠再展开就能重试。
	 */
	private async loadPortalArticles(node: TreeNode): Promise<TreeNode[]> {
		try {
			const page = await fetchLatestArticles(node.pageNow);
			node.pageNow = page.pageNow;
			node.pageTotal = page.pageTotal;
			// 页码挂在节点上，翻页后一眼能看出在哪一页（和版块节点一致）
			node.description = `第 ${page.pageNow} / ${page.pageTotal} 页`;

			if (!page.articles.length) {
				return [ForumProvider.hintNode('（本页没有文章）')];
			}
			return page.articles.map((article) => ForumProvider.articleNode(article));
		} catch (err) {
			return [ForumProvider.errorNode(err)];
		}
	}

	/** 空列表的原因不同，提示也不同，免得让人以为版块里真没帖 */
	private static emptyHint(totalBeforeFilter: number): string {
		if (totalBeforeFilter > 0) {
			const reasons: string[] = [];
			if (Global.getHideStickyThreads()) {
				reasons.push('已屏蔽置顶帖');
			}
			if (Global.getHideReadThreads()) {
				reasons.push('已隐藏已读');
			}
			return reasons.length ? `（本页帖子都被过滤了：${reasons.join('、')}）` : '（本页没有帖子）';
		}
		return '（本页没有帖子）';
	}

	// ---------- 静态构造 ----------

	/**
	 * 门户「最新福利」根节点。
	 *
	 * 和版块节点长得像，但语义完全不同：它不属于任何分组、没有 fid、
	 * 展开出来的也不是帖子。所以用单独的类型，免得被版块那套逻辑顺手带走。
	 */
	private static portalRoot(): TreeNode {
		const node = new TreeNode('最新福利', true);
		node.setKind('portal');
		node.nodeName = '最新福利';
		node.link = Global.getPortalUrl();
		node.iconPath = new vscode.ThemeIcon('globe');
		node.tooltip = '福利吧官网的最新文章\n门户站游客就能读，不需要登录';
		return node;
	}

	/** 没导 Cookie 时的引导节点。点一下直接进导入流程 */
	private static cookieHint(): TreeNode {
		const node = new TreeNode('导入 Cookie 后可浏览版块', false);
		node.setKind('hint');
		node.iconPath = new vscode.ThemeIcon('key');
		node.tooltip = '论坛的版块和帖子需要登录才能看';
		node.command = { command: 'fuliba.setCookie', title: '导入 Cookie' };
		return node;
	}

	/**
	 * 树顶的「当前排序」节点。
	 *
	 * 排序方式原来只显示在视图标题旁的小字里，几乎没人看得见；
	 * 现在直接摆成树的第一个节点，label 就是当前排序，点一下打开排序菜单。
	 * 文案不在建节点时定死 —— 改排序只 repaint，渲染时经 applySortLabel 刷新。
	 */
	private static sortHint(): TreeNode {
		const node = new TreeNode('', false);
		node.setKind('sortHint');
		node.iconPath = new vscode.ThemeIcon('list-ordered');
		node.command = { command: 'fuliba.chooseSort', title: '更改排序方式' };
		ForumProvider.applySortLabel(node);
		return node;
	}

	/** 把当前排序写进提示节点的 label 和 tooltip */
	private static applySortLabel(node: TreeNode): void {
		const sort = Global.getThreadSort();
		node.label = `排序：${SORT_LABELS[sort]}`;
		node.description = '点击修改';
		node.tooltip = [
			`版块内帖子当前按「${SORT_LABELS[sort]}」排列`,
			'点击这一行可以换一种排法',
		].join('\n');
	}

	/**
	 * 门户文章节点。
	 *
	 * 标题是 label，右边一行 description 放日期 / 阅读 / 评论 ——
	 * 缩略图和摘要树里放不下，摘要挪进 tooltip。
	 */
	private static articleNode(article: PortalArticle): TreeNode {
		const node = new TreeNode(article.title, false);
		node.setKind('article');
		node.aid = article.aid;
		node.link = article.url;
		node.iconPath = new vscode.ThemeIcon('file-text');
		node.description = ForumProvider.articleMeta(article);
		node.tooltip = ForumProvider.articleTooltip(article);
		node.command = { command: 'fuliba.openArticle', title: '阅读文章', arguments: [node] };
		return node;
	}

	/** 文章节点右侧那一行 */
	private static articleMeta(article: PortalArticle): string {
		const bits: string[] = [];
		if (article.date) {
			bits.push(ForumProvider.shortDate(article.date));
		}
		if (article.views > 0) {
			bits.push(`${article.views} 阅`);
		}
		if (article.comments > 0) {
			bits.push(`${article.comments} 评论`);
		}
		return bits.join(' · ');
	}

	/** 今年的日期省掉年份 —— 树里横向空间紧张 */
	private static shortDate(date: string): string {
		const m = date.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
		if (!m) {
			return date;
		}
		const short = `${Number(m[2])}-${Number(m[3])}`;
		return Number(m[1]) === new Date().getFullYear() ? short : `${m[1]}-${short}`;
	}

	/** 文章节点的悬浮详情：树里省下的字段都在这儿放全 */
	private static articleTooltip(article: PortalArticle): string {
		const lines: string[] = [article.title];
		if (article.subtitle) {
			lines.push(article.subtitle);
		}
		const meta: string[] = [];
		if (article.date) {
			meta.push(`日期：${article.date}`);
		}
		if (article.category) {
			meta.push(`分类：${article.category}`);
		}
		if (article.views > 0) {
			meta.push(`浏览：${article.views}`);
		}
		if (article.comments > 0) {
			meta.push(`评论：${article.comments}`);
		}
		if (article.likes > 0) {
			meta.push(`赞：${article.likes}`);
		}
		if (meta.length) {
			lines.push(meta.join('　'));
		}
		if (article.summary) {
			lines.push(article.summary);
		}
		lines.push(article.url);
		return lines.join('\n');
	}

	private static threadNode(thread: Thread): TreeNode {
		const node = new TreeNode(thread.title, false);
		node.tid = thread.tid;
		node.link = thread.url;
		node.isSticky = thread.isSticky === true;
		node.isDigest = thread.isDigest === true;
		node.replyCount = thread.replyCount;
		// 叶子节点不挂 command 时，点击只会选中，不会有任何反应
		node.command = { command: 'fuliba.openThread', title: '打开帖子', arguments: [node] };

		node.tooltip = [
			thread.title,
			`作者：${thread.author}`,
			`回复：${thread.replyCount}　查看：${thread.viewCount}`,
			thread.lastReplyAt ? `最后回复：${thread.lastReplyUser ?? '-'}（${thread.lastReplyAt}）` : undefined,
		]
			.filter(Boolean)
			.join('\n');

		ForumProvider.decorateThread(node);
		return node;
	}

	/** 重算帖子节点的回复数、已读标记与图标。已读状态随时会变，所以单独抽出来 */
	private static decorateThread(node: TreeNode): void {
		const read = node.tid !== undefined && Global.isRead(node.tid);

		const marks: string[] = [];
		if (node.isSticky) {
			marks.push('置顶');
		}
		if (node.isDigest) {
			marks.push('精华');
		}
		// 「已读」排在回复数前面，扫一眼就能分清哪些看过
		if (read) {
			marks.push('已读');
		}
		marks.push(node.replyCount > 0 ? `${node.replyCount} 回复` : '无人回复');
		node.description = marks.join(' · ');

		if (node.isSticky) {
			node.iconPath = new vscode.ThemeIcon('pin');
		} else if (read) {
			node.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('disabledForeground'));
		} else {
			node.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
		}
	}

	private static hintNode(text: string): TreeNode {
		const node = new TreeNode(text, false);
		node.setKind('hint');
		node.iconPath = new vscode.ThemeIcon('info');
		return node;
	}

	private static errorNode(err: unknown): TreeNode {
		const node = new TreeNode(ForumProvider.messageOf(err), false);
		node.setKind('error');
		node.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
		return node;
	}

	private static messageOf(err: unknown): string {
		if (err instanceof LoginRequiredError) {
			return 'Cookie 已失效，请重新导入';
		}
		return err instanceof Error ? err.message : '未知错误';
	}
}
