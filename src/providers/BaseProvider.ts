import {
	TreeDataProvider,
	Event,
	EventEmitter,
	TreeItem,
	TreeItemCollapsibleState,
	ProviderResult,
} from 'vscode';

/**
 * 树节点的类型，决定右键菜单里出现哪些命令。
 *
 * 这里的值一律带 `fuliba.` 前缀，是因为 VS Code 的 viewItem 条件是全局的：
 * 别的扩展可以用裸 `viewItem == item` 而不写 `view ==` 限定，那样它的菜单会挂到
 * 任何 contextValue 为 "item" 的树上。早期版本我们用的就是裸 "item"，结果
 * DarrenB.nga-mofish 的四条右键菜单（复制链接 / 复制标题和链接 / 在浏览器中打开 /
 * 标为已读）也出现在福利吧的树上，和我们的四条标题完全同名，
 * 于是右键菜单每个选项都出现两次，且排在前面的那条属于对方、点了没有正确结果。
 * 加上命名空间后，这类通用条件就匹配不到我们了。
 */
export const NODE = {
	group: 'fuliba.group',
	forum: 'fuliba.forum',
	thread: 'fuliba.thread',
	hint: 'fuliba.hint',
	error: 'fuliba.error',
} as const;

export type NodeKind = keyof typeof NODE;

export abstract class BaseProvider implements TreeDataProvider<TreeNode> {
	protected _onDidChangeTreeData: EventEmitter<TreeNode | undefined> = new EventEmitter<
		TreeNode | undefined
	>();
	readonly onDidChangeTreeData?: Event<TreeNode | undefined | null | void> =
		this._onDidChangeTreeData.event;

	abstract getTreeItem(element: TreeNode): TreeItem | Thenable<TreeItem>;
	abstract getChildren(element?: TreeNode): ProviderResult<TreeNode[]>;
}

export class TreeNode extends TreeItem {
	/** 是否是目录节点（可展开） */
	public isDir: boolean;

	/** 根节点属性：节点名称（版块名） */
	public nodeName: string | undefined;
	/** 根节点属性：子节点 */
	public children: TreeNode[] | undefined;

	/** 子节点属性：链接地址 */
	public link: string = '';

	/** 版块 id，仅版块节点有 */
	public fid: number | undefined;
	/** 帖子 id，仅帖子节点有 */
	public tid: number | undefined;
	/** 是否置顶，仅帖子节点有 */
	public isSticky: boolean = false;
	/** 是否精华，仅帖子节点有 */
	public isDigest: boolean = false;
	/** 回复数，仅帖子节点有 */
	public replyCount: number = 0;
	/** 当前页码，仅目录节点有 */
	public pageNow: number = 1;
	/** 总页数，仅目录节点有 */
	public pageTotal: number = 1;

	constructor(label: string, isDir: boolean) {
		super(label, isDir ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);
		this.isDir = isDir;
		// 目录默认当「版块」，叶子默认当「帖子」，其余类型用 setKind 覆盖
		this.contextValue = isDir ? NODE.forum : NODE.thread;
	}

	/** 设置节点类型，决定右键菜单项 */
	public setKind(kind: NodeKind): this {
		this.contextValue = NODE[kind];
		return this;
	}
}
