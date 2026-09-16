import * as vscode from 'vscode';
import { EOL } from 'os';
import Global from './global';
import ForumProvider from './providers/ForumProvider';
import { NODE, TreeNode } from './providers/BaseProvider';
import openThread, { disposeAllPanels } from './commands/topicItemClick';
import setCookie, { clearCookie } from './commands/cookie';
import { searchThreads, extractTid, getForumGroupsCached } from './discuz';
import { LoginRequiredError } from './error';
import { SORT_DETAILS, SORT_LABELS, ThreadSort } from './models';
import { disposeMediaServer } from './mediaServer';

interface SearchPick extends vscode.QuickPickItem {
	tid: number;
}

/** 「选择显示的版块」里的一条 */
interface ForumPick extends vscode.QuickPickItem {
	fid: number;
}

/** 排序方式的候选顺序，和菜单里的展示顺序一致 */
const SORT_ORDER: ThreadSort[] = ['dateline', 'lastpost', 'heats'];

/** 从用户输入里解析出 tid：支持纯数字、静态链接、query 链接 */
function parseTidInput(input: string): number | undefined {
	const trimmed = input.trim();
	if (/^\d+$/.test(trimmed)) {
		return parseInt(trimmed, 10);
	}
	return extractTid(trimmed);
}

/** 统一的错误提示 */
function reportError(err: unknown, fallback: string): void {
	if (err instanceof LoginRequiredError) {
		void vscode.window
			.showErrorMessage(`福利吧：${err.message}`, '导入 Cookie')
			.then((action) => {
				if (action === '导入 Cookie') {
					void vscode.commands.executeCommand('fuliba.setCookie');
				}
			});
		return;
	}
	const message = err instanceof Error ? err.message : fallback;
	void vscode.window.showErrorMessage(`福利吧：${message}`);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	await Global.init(context);

	const provider = new ForumProvider();
	const treeView = vscode.window.createTreeView('fuliba-forums', {
		treeDataProvider: provider,
		showCollapseAll: true,
	});

	/**
	 * 把「当前排序 / 是否屏蔽置顶 / 版块范围」显示在侧边栏标题旁边。
	 * 这几个开关都藏在命令或设置里，不给点提示的话用户看不出生效没有。
	 */
	const updateViewDescription = (): void => {
		const parts: string[] = [SORT_LABELS[Global.getThreadSort()]];
		if (Global.getHideStickyThreads()) {
			parts.push('已屏蔽置顶');
		}
		const visible = Global.getVisibleFids();
		if (visible) {
			parts.push(`仅 ${visible.length} 个版块`);
		}
		treeView.description = parts.join(' · ');
	};
	updateViewDescription();

	context.subscriptions.push(
		treeView,

		// ---------- Cookie ----------
		vscode.commands.registerCommand('fuliba.setCookie', async () => {
			const ok = await setCookie();
			if (ok) {
				await provider.refreshAll();
				updateViewDescription();
			}
		}),

		vscode.commands.registerCommand('fuliba.clearCookie', async () => {
			await clearCookie();
			await provider.refreshAll();
			updateViewDescription();
		}),

		// ---------- 刷新 ----------
		vscode.commands.registerCommand('fuliba.refreshForums', async () => {
			await provider.refreshAll();
			updateViewDescription();
		}),

		vscode.commands.registerCommand('fuliba.refreshNode', (node: TreeNode) => {
			if (!node) {
				return;
			}
			// 分组的子节点是预建好的，只能整棵树重来
			if (node.contextValue === NODE.group) {
				void provider.refreshAll();
				return;
			}
			provider.refreshNode(node);
		}),

		// ---------- 排序方式 ----------
		vscode.commands.registerCommand('fuliba.chooseSort', async () => {
			const current = Global.getThreadSort();
			const picked = await vscode.window.showQuickPick(
				SORT_ORDER.map((sort) => ({
					label: SORT_LABELS[sort],
					detail: SORT_DETAILS[sort],
					// 让用户一眼看到当前用的是哪个
					description: sort === current ? '当前' : undefined,
					sort,
				})),
				{ title: '帖子排序方式', placeHolder: '选择版块内帖子的排列顺序' }
			);
			if (!picked || picked.sort === current) {
				return;
			}
			await Global.setThreadSort(picked.sort);
			// 版块结构没变，只重画即可；展开着的版块会按新排序重新拉取
			provider.repaint();
			updateViewDescription();
		}),

		// ---------- 屏蔽置顶帖 ----------
		vscode.commands.registerCommand('fuliba.toggleSticky', async () => {
			const next = !Global.getHideStickyThreads();
			await Global.setHideStickyThreads(next);
			provider.repaint();
			updateViewDescription();
			void vscode.window.showInformationMessage(
				next ? '福利吧：已屏蔽置顶帖' : '福利吧：已恢复显示置顶帖'
			);
		}),

		// ---------- 选择显示的版块 ----------
		vscode.commands.registerCommand('fuliba.selectForums', async () => {
			let groups = provider.getForumGroups();
			if (!groups.length) {
				try {
					groups = await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: '正在获取版块列表…' },
						() => getForumGroupsCached()
					);
				} catch (err) {
					reportError(err, '获取版块列表失败');
					return;
				}
			}
			if (!groups.length) {
				void vscode.window.showInformationMessage('没有取到版块列表，请先刷新');
				return;
			}

			const visible = Global.getVisibleFids();
			const items: ForumPick[] = [];
			for (const group of groups) {
				for (const forum of group.forums) {
					items.push({
						label: forum.name,
						// 版块可能重名，分组名放描述里帮助区分
						description: group.name,
						detail: forum.isSub ? '子版块' : undefined,
						fid: forum.fid,
						picked: !visible || visible.includes(forum.fid),
					});
				}
			}

			const picked = await vscode.window.showQuickPick<ForumPick>(items, {
				title: `选择要显示的版块（共 ${items.length} 个）`,
				placeHolder: '勾选要显示的版块；全选表示显示全部',
				canPickMany: true,
				ignoreFocusOut: true,
			});
			// 按 Esc 取消时返回 undefined，此时什么都别动
			if (picked === undefined) {
				return;
			}

			if (!picked.length) {
				await Global.setVisibleFids(undefined);
				void vscode.window.showInformationMessage('未勾选任何版块，已恢复为显示全部');
			} else if (picked.length === items.length) {
				// 全勾等于没限制，存成 undefined 而不是一长串 fid，
				// 这样论坛以后新增版块也能自动出现
				await Global.setVisibleFids(undefined);
			} else {
				await Global.setVisibleFids(picked.map((item) => item.fid));
			}

			await provider.refreshAll();
			updateViewDescription();
		}),

		// ---------- 打开帖子 ----------
		// 两种入口：树上点击帖子会带节点参数进来；命令面板调用时没有参数，改弹输入框
		vscode.commands.registerCommand('fuliba.openThread', async (node?: TreeNode) => {
			if (node && typeof node.tid === 'number') {
				await openThread(node.tid, typeof node.label === 'string' ? node.label : undefined);
				// 打开即视为已读，让「已读」标记立刻反映到树上
				provider.refreshNode(node);
				return;
			}
			const input = await vscode.window.showInputBox({
				title: '打开帖子',
				prompt: '输入帖子 id 或完整链接',
				placeHolder: '例如 264469 或 https://www.wnflb2023.com/thread-264469-1-1.html',
				ignoreFocusOut: true,
			});
			if (!input) {
				return;
			}
			const tid = parseTidInput(input);
			if (!tid) {
				void vscode.window.showErrorMessage('没能从输入里识别出帖子 id');
				return;
			}
			void openThread(tid);
		}),

		// ---------- 搜索 ----------
		vscode.commands.registerCommand('fuliba.search', async () => {
			const keyword = await vscode.window.showInputBox({
				title: '搜索福利吧',
				prompt: '输入关键词',
				ignoreFocusOut: true,
			});
			if (!keyword || !keyword.trim()) {
				return;
			}
			try {
				const results = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `正在搜索「${keyword.trim()}」…`,
					},
					() => searchThreads(keyword.trim())
				);

				if (!results.length) {
					void vscode.window.showInformationMessage('没有找到相关帖子');
					return;
				}

				const picked = await vscode.window.showQuickPick<SearchPick>(
					results.map((thread) => ({
						label: thread.title,
						// 搜索是跨版块的，版块名要放在最前面
						description: [
							thread.forumName,
							thread.replyCount ? `${thread.replyCount} 回复` : undefined,
							`${thread.viewCount} 查看`,
						]
							.filter(Boolean)
							.join(' · '),
						detail: thread.summary
							? thread.summary.slice(0, 120)
							: `${thread.author} · ${thread.lastReplyAt ?? ''}`,
						tid: thread.tid,
					})),
					{ title: `搜索结果（${results.length} 条）`, placeHolder: '选择要打开的帖子' }
				);
				if (picked) {
					void openThread(picked.tid, picked.label);
				}
			} catch (err) {
				reportError(err, '搜索失败');
			}
		}),

		// ---------- 版块内翻页 ----------
		vscode.commands.registerCommand('fuliba.prevPage', (node: TreeNode) => {
			if (!node || node.fid === undefined) {
				return;
			}
			if (node.pageNow <= 1) {
				void vscode.window.showInformationMessage('已经是第一页');
				return;
			}
			node.pageNow -= 1;
			provider.refreshNode(node);
		}),

		vscode.commands.registerCommand('fuliba.nextPage', (node: TreeNode) => {
			if (!node || node.fid === undefined) {
				return;
			}
			if (node.pageNow >= node.pageTotal) {
				void vscode.window.showInformationMessage('已经是最后一页');
				return;
			}
			node.pageNow += 1;
			provider.refreshNode(node);
		}),

		vscode.commands.registerCommand('fuliba.jumpFirst', (node: TreeNode) => {
			if (!node || node.fid === undefined || node.pageNow === 1) {
				return;
			}
			node.pageNow = 1;
			provider.refreshNode(node);
		}),

		// ---------- 帖子节点右键 ----------
		vscode.commands.registerCommand('fuliba.copyLink', (node: TreeNode) => {
			if (node?.link) {
				void vscode.env.clipboard.writeText(node.link);
				void vscode.window.showInformationMessage('链接已复制');
			}
		}),

		vscode.commands.registerCommand('fuliba.copyTitleLink', (node: TreeNode) => {
			if (node?.link) {
				void vscode.env.clipboard.writeText(`${node.label as string}${EOL}${node.link}`);
				void vscode.window.showInformationMessage('标题和链接已复制');
			}
		}),

		vscode.commands.registerCommand('fuliba.openInBrowser', (node: TreeNode) => {
			if (node?.link) {
				void vscode.env.openExternal(vscode.Uri.parse(node.link));
			}
		}),

		vscode.commands.registerCommand('fuliba.markRead', async (node: TreeNode) => {
			if (node?.tid) {
				await Global.addReadTid(node.tid);
				provider.refreshNode(node);
			}
		}),

		// ---------- 设置 ----------
		vscode.commands.registerCommand('fuliba.settings', () => {
			void vscode.commands.executeCommand('workbench.action.openSettings', 'fuliba');
		})
	);
}

export function deactivate(): void {
	disposeAllPanels();
	disposeMediaServer();
	Global.context = undefined;
}
