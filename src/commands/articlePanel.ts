import * as vscode from 'vscode';
import * as path from 'path';
import { renderPage } from '../render';
import { fetchPortalArticle, parsePortalArticleLink, articleBaseUrl } from '../portal';
import Global from '../global';

/**
 * 门户文章面板。
 *
 * 文章列表在侧边栏的「最新福利」节点里（和版块树同一棵树），这里只负责读正文。
 *
 * 面板是**单例**：正文里点另一篇文章就在同一个面板里换过去，不会越开越多 ——
 * 门户文章本来就是一条时间线，开一堆面板只会让人忘了自己在读哪篇。
 * 帖子面板（topicItemClick）刻意不是单例，那个要能并排对比着看，语义不一样。
 */

/** 当前在看的文章。url 是**首页**地址（不带分页后缀），page 是文章自己的分页 */
let current: vscode.WebviewPanel | undefined;
let view = { url: '', page: 1 };

/**
 * 当前这次渲染的序号。
 * 每换一篇 +1，异步返回时对不上就丢掉 —— 快速连点几篇文章时，
 * 先发的请求可能后回来，不拦的话会把已经切走的页面盖回去。
 */
let token = 0;

function shortTitle(title: string): string {
	return title.length <= 18 ? title : `${title.slice(0, 18)}…`;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : '未知错误';
}

/** 当前视图「在浏览器打开 / 复制链接」应该指向哪一页 */
function currentUrl(): string {
	if (!view.url) {
		return Global.getPortalUrl();
	}
	return view.page <= 1 ? view.url : `${view.url}/${view.page}`;
}

function paint(panel: vscode.WebviewPanel, data: Record<string, unknown>): void {
	panel.webview.html = renderPage(panel.webview, 'article.html', {
		// 模板里会直接访问 article.xxx，art-template 碰到 undefined 会直接抛，
		// 所以永远给一个字段齐全的空壳兜住（出错时也要能渲染出错误框）
		article: { tags: [], commentList: [], pageNow: 1, pageTotal: 1 },
		error: '',
		...data,
	});
}

/** 画一篇文章（page 是文章自己的分页，从 1 开始） */
async function showArticle(panel: vscode.WebviewPanel, url: string, page: number): Promise<void> {
	const mine = ++token;
	view = { url, page };
	panel.title = '文章';
	panel.webview.html = renderPage(panel.webview, 'loading.html', {});

	try {
		const article = await fetchPortalArticle(url, page);
		if (mine !== token) {
			return;
		}
		panel.title = shortTitle(article.title);
		paint(panel, { article });
	} catch (err) {
		if (mine !== token) {
			return;
		}
		console.error('福利吧：加载门户文章失败', err);
		paint(panel, { error: messageOf(err) });
	}
}

function openExternal(url: string): void {
	void vscode.env.openExternal(vscode.Uri.parse(url));
}

/** 正文里点的链接：门户文章留在面板里读，别的都交给系统浏览器 */
function routeOpen(url: string | undefined): void {
	if (!url) {
		return;
	}
	const target = parsePortalArticleLink(url);
	if (target && current) {
		void showArticle(current, target.base, target.page);
		return;
	}
	openExternal(url);
}

function handleMessage(message: { command: string; page?: number; url?: string }): void {
	const panel = current;
	if (!panel) {
		return;
	}

	switch (message.command) {
		case 'refresh':
			if (view.url) {
				void showArticle(panel, view.url, view.page);
			}
			break;
		case 'articlePage':
			if (view.url) {
				void showArticle(panel, view.url, Number(message.page) || 1);
			}
			break;
		case 'openUrl':
			routeOpen(message.url);
			break;
		case 'openInBrowser':
			openExternal(message.url || currentUrl());
			break;
		case 'copyLink':
			void vscode.env.clipboard.writeText(message.url || currentUrl()).then(() => {
				void vscode.window.showInformationMessage('链接已复制');
			});
			break;
		default:
			break;
	}
}

function createPanel(): vscode.WebviewPanel {
	const panel = vscode.window.createWebviewPanel('fulibaArticle', '文章', vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true,
		enableFindWidget: true,
		// 正文里的图片一律是「点击加载」，页面侧不直接读扩展目录以外的文件，
		// 所以只需要 html 这一个根
		localResourceRoots: [vscode.Uri.file(path.join(Global.context!.extensionPath, 'html'))],
	});
	panel.iconPath = vscode.Uri.file(path.join(Global.context!.extensionPath, 'resources', 'icon.png'));
	panel.webview.onDidReceiveMessage(handleMessage);
	panel.onDidDispose(() => {
		if (current === panel) {
			current = undefined;
			view = { url: '', page: 1 };
			token += 1;
		}
	});
	return panel;
}

/**
 * 打开（或复用）文章面板。
 *
 * url 允许带分页后缀（比如 /xxx.html/2），解析层会自己收拢回首页。
 */
export default async function openArticle(url: string, page = 1): Promise<void> {
	const panel = current ?? (current = createPanel());
	panel.reveal();
	await showArticle(panel, articleBaseUrl(url), page);
}

/** 关闭文章面板，扩展停用时调用 */
export function disposeArticlePanel(): void {
	current?.dispose();
	current = undefined;
}
