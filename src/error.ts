/**
 * 扩展内统一的错误类型。
 * 抓取层抛出这些错误，上层据此决定是提示重新导入 Cookie 还是普通报错。
 */

/** Cookie 缺失或已失效，需要用户重新导入 */
export class LoginRequiredError extends Error {
	constructor(message = '登录状态已失效，请在浏览器重新登录后导入新的 Cookie') {
		super(message);
		this.name = 'LoginRequiredError';
	}
}

/** 触发了论坛的访问限制（权限不足 / 需要特定用户组 / 被限流） */
export class AccessDeniedError extends Error {
	constructor(message = '没有权限访问该内容') {
		super(message);
		this.name = 'AccessDeniedError';
	}
}

/** 帖子或版块不存在 */
export class NotFoundError extends Error {
	constructor(message = '内容不存在或已被删除') {
		super(message);
		this.name = 'NotFoundError';
	}
}
