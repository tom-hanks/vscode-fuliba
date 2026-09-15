import * as vscode from 'vscode';
import * as path from 'path';
import { renderPage } from '../render';
import { fetchThreadDetail, extractTid } from '../discuz';
import { LoginRequiredError, AccessDeniedError } from '../error';
import { ThreadDetail } from '../models';
import Global from '../global';
import { ensureAudioFixed, cachedFixPath, FfmpegMissingError } from '../audioFix';

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
	// 转好的音轨落在 globalStorage 里，也得放进 resourceRoots，
	// 否则 asWebviewUri 出来的地址会被 webview 的资源服务挡掉
	const roots = [vscode.Uri.file(path.join(Global.context!.extensionPath, 'html'))];
	const storage = Global.context?.globalStorageUri;
	if (storage) {
		roots.push(storage);
	}

	const panel = vscode.window.createWebviewPanel('fulibaThread', shortTitle(label), vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true,
		enableFindWidget: true,
		localResourceRoots: roots,
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
 * 页面打开时会问一次「哪些视频已经有转好的音轨了」。
 * 命中就直接换源 —— 同一个视频只该让用户点一次按钮。
 */
function replyAudioFixes(panel: vscode.WebviewPanel, urls: string[]): void {
	const map: Record<string, string> = {};
	for (const url of urls) {
		const file = cachedFixPath(url);
		if (file) {
			map[url] = panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
		}
	}
	if (Object.keys(map).length) {
		void panel.webview.postMessage({ command: 'audioFixes', map });
	}
}

/**
 * 把视频音轨换成 MP3 并重新封装，再把新地址发回页面。
 * 画面轨是 copy 过去的，耗时几乎全在下载上，所以进度就按下载百分比报。
 */
async function fixAudio(panel: vscode.WebviewPanel, url: string | undefined): Promise<void> {
	if (!url) {
		return;
	}
	try {
		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: '福利吧：正在把音轨换成 MP3…',
				cancellable: false,
			},
			async (progress) =>
				ensureAudioFixed(url, ({ received, total }) => {
					progress.report({
						message:
							total > 0
								? `${Math.round((received / total) * 100)}%`
								: `${(received / 1024 / 1024).toFixed(1)} MB`,
					});
				})
		);

		const src = panel.webview.asWebviewUri(vscode.Uri.file(result.file)).toString();
		void panel.webview.postMessage({ command: 'audioFixed', url, src });
	} catch (err) {
		const needsFfmpeg = err instanceof FfmpegMissingError;
		void panel.webview.postMessage({
			command: 'audioFixFailed',
			url,
			needsFfmpeg,
			message: err instanceof Error ? err.message : '未知错误',
		});

		if (needsFfmpeg) {
			const pick = await vscode.window.showWarningMessage(
				'没找到 ffmpeg，无法重新封装音轨。装上并重启 VS Code 之后就好了。',
				'去看安装说明'
			);
			if (pick) {
				void vscode.env.openExternal(vscode.Uri.parse('https://ffmpeg.org/download.html'));
			}
			return;
		}
		void vscode.window.showErrorMessage(`修复声音失败：${err instanceof Error ? err.message : err}`);
	}
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
		(message: {
			command: string;
			page?: number;
			url?: string;
			width?: number;
			height?: number;
			urls?: string[];
		}) => {
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
				case 'fixAudio':
					void fixAudio(panel, message.url);
					break;
				case 'audioFixes':
					replyAudioFixes(panel, Array.isArray(message.urls) ? message.urls : []);
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
