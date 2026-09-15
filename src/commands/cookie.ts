import * as vscode from 'vscode';
import Global from '../global';
import { fetchForumGroups } from '../discuz';
import { LoginRequiredError } from '../error';

const HOW_TO =
	'获取方法：浏览器登录福利吧 → 按 F12 → 切到 Network（网络）→ 刷新页面 → 点左侧任意一个请求 → 在 Request Headers（请求标头）里找到 Cookie，整行值复制过来。';

/**
 * 导入 Cookie。
 * 流程：输入 → 规范化 → 暂存 → 用一次真实请求验证登录是否有效。
 * 验证不通过时不落库，避免把无效 Cookie 存进去之后到处报错。
 */
export default async function setCookie(): Promise<boolean> {
	const input = await vscode.window.showInputBox({
		title: '导入福利吧 Cookie',
		prompt: HOW_TO,
		placeHolder: 'S5r8_2132_saltkey=xxx; S5r8_2132_auth=yyy; S5r8_2132_sid=zzz; ...',
		ignoreFocusOut: true,
		validateInput: (value) => {
			if (!value.trim()) {
				return '不能为空';
			}
			if (!value.includes('=')) {
				return '看起来不是 Cookie，Cookie 由「名=值」对组成，用分号隔开';
			}
			if (!/_[0-9]+_/.test(value)) {
				return '没找到 Discuz 的 Cookie 特征（形如 xxx_2132_），请确认复制的是福利吧站点的 Cookie';
			}
			return undefined;
		},
	});

	if (input === undefined) {
		return false;
	}

	const previous = await Global.getCookie();
	await Global.setCookie(input);

	try {
		const groups = await fetchForumGroups();
		const count = groups.reduce((sum, group) => sum + group.forums.length, 0);
		vscode.window.showInformationMessage(`福利吧：Cookie 导入成功，已识别 ${count} 个版块`);
		return true;
	} catch (err) {
		// 验证失败，回滚到导入前的状态
		if (previous) {
			await Global.setCookie(previous);
		} else {
			await Global.clearCookie();
		}

		const reason =
			err instanceof LoginRequiredError
				? '这个 Cookie 无法通过登录校验，可能已经过期，或者复制时漏了一部分'
				: err instanceof Error
					? err.message
					: '未知错误';

		const action = await vscode.window.showErrorMessage(`福利吧：Cookie 导入失败 —— ${reason}`, '重新导入');
		if (action === '重新导入') {
			return setCookie();
		}
		return false;
	}
}

/** 清除已保存的 Cookie */
export async function clearCookie(): Promise<void> {
	const confirmed = await vscode.window.showWarningMessage(
		'确定要清除已保存的福利吧 Cookie 吗？',
		{ modal: true },
		'清除'
	);
	if (confirmed !== '清除') {
		return;
	}
	await Global.clearCookie();
	vscode.window.showInformationMessage('福利吧：Cookie 已清除');
}
