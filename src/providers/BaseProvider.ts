import {
	TreeDataProvider,
	Event,
	EventEmitter,
	TreeItem,
	TreeItemCollapsibleState,
	ProviderResult,
} from 'vscode';

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
		// contextValue 对应 package.json 里 view/item/context 的 viewItem
		this.contextValue = isDir ? 'dir' : 'item';
	}
}
