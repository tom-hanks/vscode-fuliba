import * as vscode from 'vscode';
import * as path from 'path';
import { renderPage } from '../render';
import { fetchThreadDetail, extractTid } from '../discuz';
import { LoginRequiredError, AccessDeniedError } from '../error';
import { ThreadDetail } from '../models';
import Global from '../global';

/** 已打开的帖子面板，key 为 tid */
const panels = new Map<number, vscode.WebviewPanel>();

/**
 * 正文里的链接点击后走这里。
 * 站内帖子链接用插件自己打开，其余一律交给系统浏览器。
 */
function handleOpenUrl(url: string | undefined): void {
	if (!url) {
		return;
	}
	const tid = extractTid(url);
	if (tid && /thread-|mod=viewthread/.test(url)) {
		void openThread(tid);
		return;
	}
	if (/^https?:/i.test(url)) {
		void vscode.env.openExternal(vscode.Uri.parse(url));
		return;
	}
	void vscode.env.openExternal(vscode.Uri.parse(`${Global.getSiteUrl()}/${url.replace(/^\/+/, '')}`));
}

function shortTitle(title: string): string {
	return title.length <= 18 ? title : `${title.slice(0, 18)}…`;
}

function createPanel(tid: number, label: string): vscode.WebviewPanel {
	const panel = vscode.window.createWebviewPanel('fulibaThread', shortTitle(label), vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true,
		enableFindWidget: true,
		localResourceRoots: [vscode.Uri.file(path.join(Global.context!.extensionPath, 'html'))],
	});
	panel.iconPath = vscode.Uri.file(path.join(Global.context!.extensionPath, 'resources', 'icon.png'));
	panels.set(tid, panel);
	panel.onDidDispose(() => panels.delete(tid));
	return panel;
}

function renderError(panel: vscode.WebviewPanel, err: unknown): void {
	const isLogin = err instanceof LoginRequiredError;
	const isDenied = err instanceof AccessDeniedError;
	panel.webview.html = renderPage(panel.webview, 'error.html', {
		message: err instanceof Error ? err.message : '未知错误',
		showLogin: isLogin,
		showRefresh: !isDenied,
	});
}

function renderDetail(panel: vscode.WebviewPanel, detail: ThreadDetail): void {
	panel.title = shortTitle(detail.title);
	panel.webview.html = renderPage(panel.webview, 'thread.html', {
		thread: detail,
		pageNow: detail.pageNow,
		pageTotal: detail.pageTotal,
		siteUrl: Global.getSiteUrl(),
		showAvatar: Global.getShowAvatar(),
		player: Global.getPlayerSize(),
	});
}

async function loadThread(panel: vscode.WebviewPanel, tid: number, page: number): Promise<void> {
	panel.webview.html = renderPage(panel.webview, 'loading.html', {});
	try {
		const detail = await fetchThreadDetail(tid, page);
		// 面板可能在请求期间被关掉了
		if (panels.get(tid) !== panel) {
			return;
		}
		renderDetail(panel, detail);
	} catch (err) {
		if (panels.get(tid) !== panel) {
			return;
		}
		console.error('福利吧：加载帖子失败', err);
		renderError(panel, err);
	}
}

/**
 * 播放器尺寸是全局一份（存设置里），所以拖动之后要把新尺寸推给其它已打开的帖子面板，
 * 否则几个面板会各显示各的大小，看起来像没生效。
 */
async function savePlayerSize(origin: vscode.WebviewPanel, width: number, height: number): Promise<void> {
	if (!width || !height) {
		return;
	}
	await Global.setPlayerSize({ width, height });
	const size = Global.getPlayerSize();
	panels.forEach((panel) => {
		if (panel !== origin) {
			void panel.webview.postMessage({ command: 'playerSize', width: size.width, height: size.height });
		}
	});
}

/**
 * 打开（或激活已打开的）帖子详情面板。
 * 返回的 Promise 在「已读」记录写入后 resolve，调用方可以据此刷新树上的已读标记。
 */
export default async function openThread(tid: number, label = `帖子 ${tid}`): Promise<void> {
	const existing = panels.get(tid);
	if (existing) {
		existing.reveal();
		return;
	}

	const panel = createPanel(tid, label);

	panel.webview.onDidReceiveMessage(
		(message: { command: string; page?: number; url?: string; width?: number; height?: number }) => {
			switch (message.command) {
				case 'pageTurning':
					void loadThread(panel, tid, Number(message.page) || 1);
					break;
				case 'refresh':
					void loadThread(panel, tid, Number(message.page) || 1);
					break;
				case 'playerSize':
					void savePlayerSize(panel, Number(message.width) || 0, Number(message.height) || 0);
					break;
				case 'login':
					void vscode.commands.executeCommand('fuliba.setCookie');
					break;
				case 'openUrl':
					handleOpenUrl(message.url);
					break;
				case 'openInBrowser':
					void vscode.env.openExternal(
						vscode.Uri.parse(`${Global.getSiteUrl()}/thread-${tid}-${Number(message.page) || 1}-1.html`)
					);
					break;
				case 'copyLink':
					void vscode.env.clipboard.writeText(
						`${Global.getSiteUrl()}/thread-${tid}-${Number(message.page) || 1}-1.html`
					);
					void vscode.window.showInformationMessage('链接已复制');
					break;
				default:
					break;
			}
		}
	);

	// 先发起请求，写入已读记录与它并行，不额外拖慢首屏
	void loadThread(panel, tid, 1);
	await Global.addReadTid(tid);
}

/** 关闭全部帖子面板，扩展停用时调用 */
export function disposeAllPanels(): void {
	panels.forEach((panel) => panel.dispose());
	panels.clear();
}
