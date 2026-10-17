# Browser Workflow Intelligence — V0.2

本地浏览器工作区管理扩展。V0.2 在 V0.1 的基础上增加多个命名工作区。

## 在现有 Chrome 中启用

1. 打开 `chrome://extensions`。
2. 找到已有的 **BWI Workspace Manager**，点击重新加载按钮。
3. 确认版本为 **0.2.0**，再次打开扩展，标题显示 **V0.2**。
4. 继续使用原来加载的 `BWI/extension` 目录，无需移除扩展或重新安装。

## 功能与规则

- 输入名称，保存当前窗口的 HTTP(S) 网页。名称去除两端空白，不能为空，最多40个字符。
- 同名保存会提示换名，不覆盖旧工作区。名称按去除两端空白后的文本精确比较，英文字母大小写不同视为不同名称。
- 每个工作区最多30个普通网页，保留标签页顺序；过滤浏览器设置页等非 HTTP(S) 地址；不保存无痕窗口。
- 列表按保存顺序显示，每项可以查看标签页、恢复到新窗口或单独删除。
- 恢复保留原窗口；失效或非 HTTP(S) 格式的地址会跳过并提示数量。如果网址格式正确但网站不可访问，仍由浏览器显示其加载结果。
- 读取或写入失败会显示错误。读取失败时不会将已有数据当作空数组覆盖；可点击“刷新列表”重试。
- 无浏览历史读取、网页按键记录、表单记录或自动上传；仅在主动保存时读取当前窗口的网页标题和 URL，存储在本机。

## V0.1 兼容迁移

打开 V0.2 弹窗时，自动读取旧 `savedWorkspace`，转换成列表中的一项。若与现有名称冲突，会附加 `(2)` 等编号。

先写入新数组和 `bwiLegacyMigrated` 标记，成功后才删除旧键。迁移中写入失败会保留旧键；清理旧键失败时，重试不会重复导入。成功清理后，删除工作区不会因遗留旧数据而重新出现。

## 代码导读

`manifest.json`：版本改为 `0.2.0`；权限仍为 `tabs` 和 `storage`。

`popup.html`：名称输入框、保存按钮、工作区卡片列表、状态提示，以及列表刷新按钮。

`popup.js`：数据存取、迁移、校验、列表渲染和操作逻辑。存储结构示例：

```js
{
  workspaces: [
    {
      id: "随机唯一标识",
      name: "实习求职",
      savedAt: "2026-10-17T00:00:00.000Z",
      tabs: [
        { title: "岗位页面", url: "https://example.com" }
      ]
    }
  ],
  bwiLegacyMigrated: true // 曾经成功迁移旧记录时写入
}
```

数组保存多个工作区；每个工作区对象拥有名称和有序的标签页数组。名称用于显示与重复检查，`id` 用于定位需要恢复或删除的那一项。

推荐阅读顺序：

1. `saveWorkspace()`：校验名称 → 读取列表 → 检查重名 → 读取当前窗口 → 过滤和排序 → `push()` 新对象 → 写回数组。
2. `renderWorkspaces()`：遍历数组，为每项生成卡片；使用 `textContent` 展示名称和标题。
3. `restoreWorkspace(id)`：用 `find()` 定位对象，将有效 URL 数组传给新窗口。
4. `deleteWorkspace(id)`：用 `filter()` 生成不包含该对象的新数组，再写回。
5. `readWorkspaces()`：读取、检查格式并迁移旧数据。
6. `runAction()`：处理错误和操作期间的按钮状态；通过 Web Locks 将多个弹窗的读取、修改和写入依次执行，避免并发覆盖。

接口参考：[Chrome Storage](https://developer.chrome.com/docs/extensions/reference/api/storage)、[Chrome Tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[Chrome Windows](https://developer.chrome.com/docs/extensions/reference/api/windows)、[Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)。

## 验收步骤

1. 在一个窗口打开两三个普通网页，按希望的顺序排列，保存为“实习求职”。
2. 更换当前窗口的网页，保存为“课程学习”。确认列表同时显示两项。
3. 分别点击两项的“恢复到新窗口”，确认各自内容和顺序正确，原有窗口仍存在。
4. 再次用“实习求职”保存，确认提示同名且原记录未被覆盖；留空或仅输入空格也应被拒绝。
5. 删除“课程学习”，确认“实习求职”仍可恢复；关闭并重开扩展后结果相同。
6. 若此前有 V0.1 保存记录，首次打开 V0.2 时应在列表看到它，重新打开不应重复出现。

## 已完成验证

2026-10-17：25项界面与错误场景检查通过，其中 Chrome 存储、标签页及窗口接口采用模拟方式测试，DOM 和 Web Locks 使用真实浏览器。

另有10项真实扩展集成检查通过：在独立临时 Chrome 配置中加载原项目，使用真实 `chrome.storage.local`、`chrome.tabs.query` 和 `chrome.windows.create`，验证版本、空名称、两个工作区保存、重名保护、分别恢复和保留原窗口、单项删除与持久化、旧数据迁移及删除后不复活。测试使用本机测试网页，未读取日常 Chrome 的标签页或扩展数据。

集成测试以扩展页面方式打开 `popup.html`。日常 Chrome 的工具栏弹窗仍需按上述步骤重新加载并验收。

## V0.1 保留

`backups/v0.1-20261017-132315` 保留初始三个文件；`backups/pre-v0.2-20261017-134230` 保留升级前、含名称输入与空名称检查的版本。备份均校验文件一致。原项目此前没有 Git 仓库。

这些备份保存代码，不包含 Chrome 中的工作区数据。旧版代码只认识旧存储键，恢复旧代码不能直接读取 V0.2 的新数组。
