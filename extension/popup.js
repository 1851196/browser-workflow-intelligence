const KEY = "workspaces";
const LEGACY_KEY = "savedWorkspace";
const MIGRATION_KEY = "bwiLegacyMigrated";
const MAX_TABS = 30;

const nameInput = document.getElementById("workspaceName");
const saveButton = document.getElementById("save");
const retryButton = document.getElementById("retry");
const preview = document.getElementById("preview");
const status = document.getElementById("status");
let busy = false;

function showMessage(message) {
  status.textContent = message;
}

function isWebUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

// 数据损坏时停止操作，不能把读取失败误当作空列表再覆盖。
function validateWorkspaces(workspaces) {
  if (!Array.isArray(workspaces)) {
    throw new Error("工作区数据格式异常，原数据未被覆盖");
  }
  const ids = new Set();
  for (const workspace of workspaces) {
    if (!workspace || typeof workspace.id !== "string" || !workspace.id ||
        ids.has(workspace.id) || typeof workspace.name !== "string" ||
        !workspace.name.trim() || !Array.isArray(workspace.tabs) ||
        workspace.tabs.some(tab => !tab || typeof tab.url !== "string")) {
      throw new Error("工作区数据格式异常，原数据未被覆盖");
    }
    ids.add(workspace.id);
  }
}

// 调用者持有同一把锁，使多个弹窗的“读、改、写”依次执行。
async function readWorkspaces() {
  const data = await chrome.storage.local.get([KEY, LEGACY_KEY, MIGRATION_KEY]);
  const workspaces = data[KEY] === undefined ? [] : data[KEY];
  validateWorkspaces(workspaces);

  if (data[LEGACY_KEY] !== undefined) {
    if (data[MIGRATION_KEY] !== true) {
      const legacy = data[LEGACY_KEY];
      if (!legacy || !Array.isArray(legacy.tabs) ||
          legacy.tabs.some(tab => !tab || typeof tab.url !== "string")) {
        throw new Error("旧工作区数据格式异常，已保留原数据");
      }
      const baseName = typeof legacy.name === "string" && legacy.name.trim()
        ? legacy.name.trim().slice(0, 40) : "我的工作区";
      let name = baseName;
      let suffix = 2;
      while (workspaces.some(workspace => workspace.name === name)) {
        const ending = ` (${suffix++})`;
        name = baseName.slice(0, 40 - ending.length) + ending;
      }
      workspaces.push({
        id: crypto.randomUUID(),
        name,
        savedAt: typeof legacy.savedAt === "string" ? legacy.savedAt : "",
        tabs: legacy.tabs.map(tab => ({
          title: typeof tab.title === "string" ? tab.title : "",
          url: tab.url
        }))
      });
      // 先写入新格式和迁移标记，再删除旧键。失败重试也不会重复导入。
      await chrome.storage.local.set({ [KEY]: workspaces, [MIGRATION_KEY]: true });
    }
    await chrome.storage.local.remove(LEGACY_KEY);
  }
  return workspaces;
}

function setBusy(value) {
  busy = value;
  nameInput.disabled = value;
  for (const button of document.querySelectorAll("button")) {
    button.disabled = value;
  }
  preview.setAttribute("aria-busy", String(value));
}

async function runAction(label, action) {
  if (busy) return;
  setBusy(true);
  try {
    await navigator.locks.request("bwi-workspaces", action);
  } catch (error) {
    showMessage(`${label}失败：${error.message || "未知错误，请重试"}`);
  } finally {
    setBusy(false);
  }
}

function renderWorkspaces(workspaces) {
  preview.replaceChildren();
  if (workspaces.length === 0) {
    preview.textContent = "还没有保存工作区";
    return;
  }
  for (const workspace of workspaces) {
    const card = document.createElement("section");
    card.className = "workspace";
    const heading = document.createElement("h3");
    heading.textContent = workspace.name;
    const info = document.createElement("p");
    const validCount = workspace.tabs.filter(tab => isWebUrl(tab.url)).length;
    info.textContent = `${workspace.tabs.length} 个标签页`;
    if (validCount !== workspace.tabs.length) {
      info.textContent += `（恢复时将跳过 ${workspace.tabs.length - validCount} 个无效地址）`;
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    const restore = document.createElement("button");
    restore.textContent = "恢复到新窗口";
    restore.setAttribute("aria-label", `恢复工作区：${workspace.name}`);
    restore.addEventListener("click", () => restoreWorkspace(workspace.id));
    const remove = document.createElement("button");
    remove.textContent = "删除";
    remove.className = "delete";
    remove.setAttribute("aria-label", `删除工作区：${workspace.name}`);
    remove.addEventListener("click", () => deleteWorkspace(workspace.id));
    actions.append(restore, remove);

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "查看标签页";
    const list = document.createElement("ol");
    for (const tab of workspace.tabs) {
      const item = document.createElement("li");
      item.textContent = tab.title || tab.url;
      list.append(item);
    }
    details.append(summary, list);
    card.append(heading, info, actions, details);
    preview.append(card);
  }
}

async function refresh() {
  return runAction("读取", async () => {
    renderWorkspaces(await readWorkspaces());
    showMessage("");
  });
}

async function saveWorkspace() {
  return runAction("保存", async () => {
    const name = nameInput.value.trim();
    if (!name || name.length > 40) {
      throw new Error(!name ? "请输入工作区名称" : "名称最多40个字符");
    }
    const workspaces = await readWorkspaces();
    if (workspaces.some(workspace => workspace.name === name)) {
      throw new Error("已有同名工作区，请换一个名称，已有记录未被覆盖");
    }
    // 只有点击保存（或在名称框按回车）才读取当前窗口标签页。
    const tabs = await chrome.tabs.query({ currentWindow: true });
    if (tabs.some(tab => tab.incognito)) throw new Error("不保存无痕窗口");
    const savedTabs = tabs
      .filter(tab => isWebUrl(tab.url))
      .sort((a, b) => a.index - b.index)
      .map(tab => ({ title: tab.title || "", url: tab.url }));
    if (savedTabs.length === 0) throw new Error("当前窗口没有可保存的网页");
    if (savedTabs.length > MAX_TABS) throw new Error(`每个工作区最多保存${MAX_TABS}个标签页`);

    workspaces.push({
      id: crypto.randomUUID(), name,
      savedAt: new Date().toISOString(), tabs: savedTabs
    });
    await chrome.storage.local.set({ [KEY]: workspaces });
    renderWorkspaces(workspaces);
    nameInput.value = "";
    showMessage(`已保存「${name}」：${savedTabs.length} 个网页`);
  }).then(() => {
    if (!nameInput.value.trim()) nameInput.focus();
  });
}

async function restoreWorkspace(id) {
  return runAction("恢复", async () => {
    const workspaces = await readWorkspaces();
    renderWorkspaces(workspaces);
    const workspace = workspaces.find(item => item.id === id);
    if (!workspace) throw new Error("此工作区已被删除，请选择其他工作区");
    const urls = workspace.tabs.map(tab => tab.url).filter(isWebUrl);
    if (!urls.length) throw new Error("没有可恢复的有效网页");
    if (urls.length > MAX_TABS) throw new Error(`工作区超过${MAX_TABS}个标签页`);
    await chrome.windows.create({ url: urls, focused: true });
    const skipped = workspace.tabs.length - urls.length;
    showMessage(`已在新窗口恢复「${workspace.name}」` +
      (skipped ? `，跳过 ${skipped} 个无效地址` : ""));
  });
}

async function deleteWorkspace(id) {
  return runAction("删除", async () => {
    const workspaces = await readWorkspaces();
    const workspace = workspaces.find(item => item.id === id);
    if (!workspace) {
      renderWorkspaces(workspaces);
      throw new Error("此工作区已被删除");
    }
    const remaining = workspaces.filter(item => item.id !== id);
    await chrome.storage.local.set({ [KEY]: remaining });
    renderWorkspaces(remaining);
    showMessage(`已删除「${workspace.name}」，其他工作区保持不变`);
  });
}

saveButton.addEventListener("click", saveWorkspace);
retryButton.addEventListener("click", refresh);
nameInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    saveWorkspace();
  }
});
refresh();
