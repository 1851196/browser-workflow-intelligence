const { chromium } = require('playwright');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const project = path.resolve(__dirname, '../extension');
const output = path.resolve(__dirname, '../test-results');
fs.mkdirSync(output, {recursive: true});
let storage = {}, tabs = [], windows = [], queryCount = 0, writeCount = 0;
let failGet = false, failSet = false, failRemove = false, failWindow = false, failQuery = false;
const results = [];
const clone = value => structuredClone(value);
const tab = (url, index = 0) => ({url, index, title: `页面 ${index + 1}`, incognito: false});
const ws = (id, name, urls) => ({id, name, savedAt: '', tabs: urls.map(url => ({url, title: url}))});
const server = http.createServer((req, res) => {
  const file = req.url === '/popup.js' ? 'popup.js' : 'popup.html';
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(project, file)));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({executablePath: process.env.BWI_CHROME_PATH || chromium.executablePath(), headless: true});
  try {
    const context = await browser.newContext({viewport: {width: 390, height: 850}, deviceScaleFactor: 1});
    await context.exposeBinding('storageGet', async () => {
      if (failGet) throw new Error('模拟读取错误');
      return clone(storage);
    });
    await context.exposeBinding('storageSet', async (_, data) => {
      if (failSet) throw new Error('模拟存储空间不足');
      writeCount++;
      Object.assign(storage, clone(data));
    });
    await context.exposeBinding('storageRemove', async (_, key) => {
      if (failRemove) throw new Error('模拟旧键清理失败');
      delete storage[key];
    });
    await context.exposeBinding('queryTabs', async (_, query) => {
      queryCount++;
      assert.deepEqual(query, {currentWindow: true});
      if (failQuery) throw new Error('模拟标签页读取失败');
      return clone(tabs);
    });
    await context.exposeBinding('createWindow', async (_, options) => {
      if (failWindow) throw new Error('模拟窗口创建失败');
      windows.push(clone(options));
      return {id: windows.length};
    });
    await context.addInitScript(() => {
      window.chrome = {
        storage: {local: {get: (...args) => window.storageGet(...args), set: data => window.storageSet(data), remove: key => window.storageRemove(key)}},
        tabs: {query: query => window.queryTabs(query)},
        windows: {create: options => window.createWindow(options)}
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}/popup.html`;
    async function ready(p = page) { await p.waitForFunction(() => !document.getElementById('save').disabled); }
    async function reload() { await page.goto(url); await ready(); }
    async function save(name, p = page) {
      await p.locator('#workspaceName').fill(name);
      await p.locator('#save').click();
      await ready(p);
    }
    async function message(pattern) { assert.match(await page.locator('#status').innerText(), pattern); }
    async function check(name, fn) { await fn(); results.push(name); console.log('PASS ' + name); }
    await check('启动不采集标签页；空列表正常', async () => {
      await reload(); assert.equal(queryCount, 0); assert.equal(writeCount, 0);
      assert.equal(await page.locator('#preview').innerText(), '还没有保存工作区');
    });
    await check('空名称和纯空格均阻止保存', async () => {
      for (const name of ['', '   ']) { await save(name); await message(/请输入工作区名称/); }
      assert.equal(queryCount, 0); assert.equal(writeCount, 0);
    });
    await check('过滤无效地址，保留原标签顺序，去除名称两端空白', async () => {
      tabs = [tab('https://example.com/second', 2), tab('chrome://extensions', 1), tab('https://example.com/first', 0), tab('javascript:alert(1)', 3)];
      await save('  实习求职  ');
      assert.equal(storage.workspaces[0].name, '实习求职');
      assert.deepEqual(storage.workspaces[0].tabs.map(t => t.url), ['https://example.com/first', 'https://example.com/second']);
    });
    await check('两个命名工作区互不覆盖并显示列表', async () => {
      tabs = [tab('https://example.org/study')];
      await save('课程学习');
      assert.equal(storage.workspaces.length, 2);
      assert.equal(await page.locator('.workspace').count(), 2);
      assert.equal(storage.workspaces[0].tabs.length, 2);
    });
    await check('同名拒绝覆盖，也不采集标签页', async () => {
      const before = clone(storage), queries = queryCount;
      await save(' 实习求职 '); await message(/同名/);
      assert.deepEqual(storage, before); assert.equal(queryCount, queries);
    });
    await check('分别恢复所选工作区，顺序正确且仅创建新窗口', async () => {
      for (const [index, name] of ['实习求职', '课程学习'].entries()) {
        await page.getByRole('button', {name: `恢复工作区：${name}`, exact: true}).click(); await ready();
        assert.deepEqual(windows.at(-1), {url: storage.workspaces[index].tabs.map(t => t.url), focused: true});
      }
      assert.equal(windows.length, 2);
    });
    await check('界面截图与重新打开后持久化', async () => {
      await reload(); assert.equal(await page.locator('.workspace').count(), 2);
      await page.screenshot({path: path.join(output, 'BWI-V0.2.1-preview.png')});
      assert.ok(await page.locator('#save').isVisible());
    });
    await check('删除单项后另一项完整保留', async () => {
      const other = clone(storage.workspaces[1]);
      await page.getByRole('button', {name: '删除工作区：实习求职', exact: true}).click(); await ready();
      await page.getByRole('button', {name: '确认删除工作区：实习求职', exact: true}).click(); await ready();
      assert.deepEqual(storage.workspaces, [other]);
      await reload(); assert.equal(await page.locator('.workspace').count(), 1);
    });
    await check('旧数据自动迁移一次，名称冲突自动编号', async () => {
      storage = {workspaces: [ws('existing', '我的工作区', ['https://existing.example'])], savedWorkspace: {name: '我的工作区', savedAt: '2026-10-17', tabs: [{title:'旧页面', url:'https://old.example'}]}};
      await reload(); assert.equal(storage.workspaces.length, 2);
      assert.equal(storage.workspaces[1].name, '我的工作区 (2)');
      assert.equal(storage.savedWorkspace, undefined); assert.equal(storage.bwiLegacyMigrated, true);
      await reload(); assert.equal(storage.workspaces.length, 2);
    });
    await check('删除迁移后的全部记录不会复活旧数据', async () => {
      for (const item of [...storage.workspaces]) {
        await page.getByRole('button', {name:`删除工作区：${item.name}`, exact:true}).click(); await ready();
        await page.getByRole('button', {name:`确认删除工作区：${item.name}`, exact:true}).click(); await ready();
      }
      await reload(); assert.equal(storage.workspaces.length, 0);
    });
    await check('迁移写入失败保留旧数据，可重试', async () => {
      storage = {savedWorkspace: {name:'旧工作区', tabs:[{url:'https://old.example'}]}};
      const before = clone(storage); failSet = true;
      await reload(); await message(/读取失败/); assert.deepEqual(storage, before);
      failSet = false; await page.locator('#retry').click(); await ready();
      assert.equal(storage.workspaces.length, 1); assert.equal(storage.savedWorkspace, undefined);
    });
    await check('迁移清理失败后重试不重复导入', async () => {
      storage = {savedWorkspace: {name:'旧工作区', tabs:[{url:'https://old.example'}]}};
      failRemove = true; await reload(); await message(/旧键清理失败/);
      assert.equal(storage.workspaces.length, 1); assert.ok(storage.savedWorkspace);
      failRemove = false; await page.locator('#retry').click(); await ready();
      assert.equal(storage.workspaces.length, 1); assert.equal(storage.savedWorkspace, undefined);
    });
    await check('读取失败显示错误，保存不覆盖，刷新可恢复', async () => {
      const before = clone(storage); failGet = true;
      await reload(); await message(/读取失败/);
      await save('读取失败测试'); await message(/保存失败/); assert.deepEqual(storage, before);
      failGet = false; await page.locator('#retry').click(); await ready();
      assert.equal(await page.locator('.workspace').count(), 1);
    });
    await check('保存和删除写入失败均保留已有数据', async () => {
      const before = clone(storage); failSet = true; tabs = [tab('https://new.example')];
      await save('新工作区'); await message(/保存失败/); assert.deepEqual(storage, before);
      await page.getByRole('button', {name:'删除工作区：旧工作区', exact:true}).click(); await ready();
      await page.getByRole('button', {name:'确认删除工作区：旧工作区', exact:true}).click(); await ready();
      await message(/删除失败/); assert.deepEqual(storage, before); failSet = false;
    });
    await check('恢复跳过无效地址且保留有效地址顺序', async () => {
      storage = {workspaces:[ws('mixed', '混合地址', ['https://one.example','chrome://settings','not a url','javascript:alert(1)','http://two.example'])]};
      await reload(); await page.getByRole('button', {name:'恢复工作区：混合地址', exact:true}).click(); await ready();
      assert.deepEqual(windows.at(-1).url, ['https://one.example','http://two.example']); await message(/跳过 3/);
    });
    await check('没有有效地址时不创建窗口', async () => {
      storage = {workspaces:[ws('invalid', '无效地址', ['chrome://settings'])]};
      await reload(); const count = windows.length;
      await page.getByRole('button', {name:'恢复工作区：无效地址', exact:true}).click(); await ready();
      await message(/没有可恢复/); assert.equal(windows.length, count);
    });
    await check('无痕窗口、无网页窗口、超过30页均阻止保存', async () => {
      storage = {}; await reload();
      for (const [values, pattern] of [ [[{...tab('https://private.example'), incognito:true}], /无痕/], [[tab('chrome://newtab')], /没有可保存/], [Array.from({length:31}, (_, i) => tab(`https://example.com/${i}`, i)), /最多保存30/] ]) {
        tabs = values; await save('边界测试'); await message(pattern); assert.equal(storage.workspaces, undefined);
      }
    });
    await check('数据格式损坏时停止写入，保留原始数据', async () => {
      for (const broken of [{workspaces:{}}, {workspaces:[ws('x','A',[]),ws('x','B',[])]}, {savedWorkspace:{tabs:'broken'}}]) {
        storage = clone(broken); await reload(); await message(/格式异常/);
        await save('不能覆盖'); assert.deepEqual(storage, broken);
      }
    });
    await check('名称按纯文本显示，不能注入HTML', async () => {
      storage = {}; tabs = [tab('https://safe.example')]; await reload();
      await save('<img src=x onerror=alert(1)>');
      assert.equal(await page.locator('.workspace img').count(), 0);
      assert.equal(await page.locator('.workspace h3').innerText(), '<img src=x onerror=alert(1)>');
    });
    await check('窗口创建失败有提示，存储不变', async () => {
      const before = clone(storage); failWindow = true;
      await page.locator('.workspace button').first().click(); await ready();
      await message(/恢复失败/); assert.deepEqual(storage, before); failWindow = false;
    });
    await check('标签页读取失败有提示，存储不变', async () => {
      const before = clone(storage); failQuery = true;
      await save('查询失败'); await message(/标签页读取失败/); assert.deepEqual(storage, before); failQuery = false;
    });
    await check('两个弹窗并发保存不丢失记录，原生Web Locks串行化', async () => {
      storage = {}; tabs = [tab('https://parallel.example')]; await reload();
      const second = await context.newPage(); await second.goto(url); await ready(second);
      await Promise.all([save('并发A'), save('并发B', second)]);
      assert.deepEqual(storage.workspaces.map(w => w.name).sort(), ['并发A','并发B']);
      await second.close();
    });
    await check('两个弹窗并发保存同名时仅保存一个', async () => {
      storage = {}; await reload();
      const second = await context.newPage(); await second.goto(url); await ready(second);
      await Promise.all([save('同名并发'), save('同名并发', second)]);
      assert.equal(storage.workspaces.length, 1); await second.close();
    });
    await check('过期列表删除不会误删其他工作区', async () => {
      storage = {workspaces:[ws('a','A',['https://a.example']),ws('b','B',['https://b.example'])]}; await reload();
      storage.workspaces = storage.workspaces.filter(w => w.id !== 'a');
      await page.getByRole('button', {name:'删除工作区：A', exact:true}).click(); await ready();
      await page.getByRole('button', {name:'确认删除工作区：A', exact:true}).click(); await ready();
      await message(/已被删除/); assert.equal(storage.workspaces[0].name,'B');
    });
    async function rename(name, replacement) {
      await page.getByRole('button', {name:`重命名工作区：${name}`, exact:true}).click();
      await page.getByRole('textbox', {name:`新名称：${name}`, exact:true}).fill(replacement);
      await page.getByRole('button', {name:'保存名称', exact:true}).click(); await ready();
    }
    await check('重命名只修改名称，保留ID、时间、网页及另一工作区', async () => {
      storage = {workspaces:[{...ws('a','求职',['https://a.example']), savedAt:'2026-10-17T01:00:00.000Z'}, ws('b','学习',['https://b.example'])]};
      await reload(); const before = clone(storage);
      await rename('求职', '  实习求职  ');
      assert.deepEqual(storage.workspaces[0], {...before.workspaces[0],name:'实习求职'});
      assert.deepEqual(storage.workspaces[1], before.workspaces[1]);
      await reload(); assert.equal(await page.locator('.workspace h3').first().innerText(),'实习求职');
      await page.getByRole('button',{name:'恢复工作区：实习求职',exact:true}).click(); await ready();
      assert.deepEqual(windows.at(-1).url,['https://a.example']);
    });
    await check('重命名拒绝空白和同名，允许保留自身原名', async () => {
      const before = clone(storage), writes = writeCount;
      for (const [replacement, pattern] of [['   ',/请输入/],['学习',/同名/],['实习求职',/未改变/]]) {
        await rename('实习求职',replacement); await message(pattern); assert.deepEqual(storage,before);
      }
      assert.equal(writeCount,writes);
    });
    await check('取消重命名不写入，写入失败可以重试', async () => {
      const before = clone(storage);
      await page.getByRole('button',{name:'重命名工作区：实习求职',exact:true}).click();
      await page.getByRole('textbox',{name:'新名称：实习求职',exact:true}).fill('未保存');
      await page.getByRole('button',{name:'取消重命名',exact:true}).click();
      assert.deepEqual(storage,before);
      failSet = true; await rename('实习求职','新名称'); await message(/重命名失败/); assert.deepEqual(storage,before);
      failSet = false; await page.getByRole('button',{name:'保存名称',exact:true}).click(); await ready();
      assert.equal(storage.workspaces[0].name,'新名称');
    });
    await check('重命名读取失败不覆盖数据', async () => {
      const before = clone(storage); failGet = true;
      await rename('新名称','读取错误'); await message(/重命名失败/); assert.deepEqual(storage,before);
      failGet = false; await reload();
    });
    await check('保存时间正常显示，旧数据缺失或无效时显示未知', async () => {
      assert.match(await page.locator('.saved-time').first().innerText(),/2026/);
      assert.match(await page.locator('.saved-time').nth(1).innerText(),/时间未知/);
      storage.workspaces[1].savedAt = 'broken'; await reload();
      assert.match(await page.locator('.saved-time').nth(1).innerText(),/时间未知/);
    });
    await check('删除第一次点击及取消均不写入，只有确认才删除', async () => {
      const before = clone(storage), writes = writeCount;
      await page.getByRole('button',{name:'删除工作区：新名称',exact:true}).click();
      assert.equal(await page.getByRole('button',{name:'取消删除',exact:true}).evaluate(el=>el===document.activeElement),true);
      assert.deepEqual(storage,before); assert.equal(writeCount,writes);
      await page.getByRole('button',{name:'取消删除',exact:true}).click(); assert.deepEqual(storage,before);
      await page.getByRole('button',{name:'删除工作区：新名称',exact:true}).click();
      await page.getByRole('button',{name:'确认删除工作区：新名称',exact:true}).click(); await ready();
      assert.deepEqual(storage.workspaces,[before.workspaces[1]]);
    });
    await check('确认期间其他页面重命名时阻止旧名称删除', async () => {
      await page.getByRole('button',{name:'删除工作区：学习',exact:true}).click();
      storage.workspaces[0].name = '已改名';
      await page.getByRole('button',{name:'确认删除工作区：学习',exact:true}).click(); await ready();
      await message(/重新确认/); assert.equal(storage.workspaces[0].name,'已改名');
    });
    await check('两个页面并发重命名为同一名称时仅成功一项', async () => {
      storage = {workspaces:[ws('a','A',[]),ws('b','B',[])]}; await reload();
      const second = await context.newPage(); await second.goto(url); await ready(second);
      await Promise.all([page.evaluate(()=>renameWorkspace('a','目标')),second.evaluate(()=>renameWorkspace('b','目标'))]);
      assert.equal(storage.workspaces.filter(w=>w.name==='目标').length,1); await second.close();
    });
    await check('名称过长或工作区已删除时拒绝重命名', async () => {
      const before = clone(storage);
      await page.evaluate(()=>renameWorkspace('a','x'.repeat(41))); await ready(); await message(/最多40/);
      assert.deepEqual(storage,before);
      await page.evaluate(()=>renameWorkspace('missing','不存在')); await ready(); await message(/已被删除/);
      assert.deepEqual(storage,before);
    });
    assert.deepEqual(errors, []);
    const manifest = JSON.parse(fs.readFileSync(path.join(project,'manifest.json'),'utf8'));
    assert.equal(manifest.version,'0.2.1');
    assert.deepEqual(manifest.permissions,['tabs','storage']);
    assert.ok(!manifest.content_scripts && !manifest.background && !manifest.host_permissions);
    results.push('清单版本和权限校验；无未捕获脚本错误');
    fs.writeFileSync(path.join(output, 'BWI-V0.2.1-test-results.json'), JSON.stringify({passed:results.length, tests:results, environment:'Installed Chrome headless; real DOM and Web Locks; mocked chrome.storage/tabs/windows APIs. Existing user Chrome profile and extension storage were not accessed.'},null,2));
    console.log(`ALL ${results.length} CHECKS PASSED`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
