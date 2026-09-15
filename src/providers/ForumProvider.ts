import * as vscode from 'vscode';
import { BaseProvider, TreeNode } from './BaseProvider';
import { fetchForumGroups, fetchThreadList } from '../discuz';
import { LoginRequiredError } from '../error';
import { Thread } from '../models';
import Global from '../global';

/**
 * 侧边栏版块树。
 *
 * 三层结构：分组 → 版块 → 帖子
 * 版块节点展开时才去请求帖子列表（懒加载），避免一次性打爆论坛。
 */
export default class ForumProvider extends BaseProvider {
	private roots: TreeNode[] = [];
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

	/** 重新加载某个节点下的内容 */
	refreshNode(node: TreeNode): void {
		this._onDidChangeTreeData.fire(node);
	}

	private async loadForums(): Promise<void> {
		// 没有 Cookie 时保持空树，让 package.json 里的 viewsWelcome 引导用户导入
		if (!(await Global.hasCookie())) {
			this.roots = [];
			return;
		}

		try {
			const groups = await fetchForumGroups();
			this.roots = groups.map((group) => {
				const groupNode = new TreeNode(group.name, true);
				// 分组只做归类，不参与翻页，所以 contextValue 与版块分开
				groupNode.contextValue = 'group';
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
			const page = await fetchThreadList(forumNode.fid as number, forumNode.pageNow);
			forumNode.nodeName = page.forumName;
			forumNode.pageNow = page.pageNow;
			forumNode.pageTotal = page.pageTotal;
			// 页码挂在版块节点上，翻页后一眼能看出在哪一页
			forumNode.description = `第 ${page.pageNow} / ${page.pageTotal} 页`;

			let threads: Thread[] = page.threads;
			if (Global.getHideReadThreads()) {
				threads = threads.filter((thread) => !Global.isRead(thread.tid));
			}

			if (!threads.length) {
				const empty = new TreeNode('（本页没有帖子）', false);
				empty.contextValue = 'hint';
				empty.iconPath = new vscode.ThemeIcon('info');
				return [empty];
			}
			return threads.map((thread) => ForumProvider.threadNode(thread));
		} catch (err) {
			return [ForumProvider.errorNode(err)];
		}
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

	private static errorNode(err: unknown): TreeNode {
		const node = new TreeNode(ForumProvider.messageOf(err), false);
		node.contextValue = 'error';
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
