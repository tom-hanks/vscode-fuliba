import * as vscode from 'vscode';
import { BaseProvider, TreeNode } from './BaseProvider';
import { fetchForumGroups, fetchThreadList } from '../discuz';
import { LoginRequiredError } from '../error';
import { ForumGroup, Thread } from '../models';
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
		// 没有 Cookie 时保持空树，让 package.json 里的 viewsWelcome 引导用户导入
		if (!(await Global.hasCookie())) {
			this.roots = [];
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

			this.roots = filtered.map((group) => {
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
		} catch (err) {
			this.roots = [ForumProvider.errorNode(err)];
		}
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
