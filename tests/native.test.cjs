const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../test-results');
fs.mkdirSync(output, {recursive:true});
const server = http.createServer((req,res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<html><head><title>BWI测试 ${req.url}</title></head><body>BWI isolated fixture ${req.url}</body></html>`);
});
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const profile = fs.mkdtempSync(path.join(output,'native-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath:process.env.BWI_CHROME_PATH || chromium.executablePath(), headless:true,
    args:['--enable-unsafe-extension-debugging'], ignoreDefaultArgs:['--disable-extensions'],
    viewport:{width:390,height:850}
  });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const version = await cdp.send('Browser.getVersion');
    const {id} = await cdp.send('Extensions.loadUnpacked',{path:path.resolve(__dirname,'../extension')});
    const base = `http://127.0.0.1:${server.address().port}`;
    const first = await context.newPage(); await first.goto(base+'/first');
    const second = await context.newPage(); await second.goto(base+'/second');
    const popup = await context.newPage();
    const errors = []; popup.on('pageerror',e=>errors.push(e.message));
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const ready = () => popup.waitForFunction(()=>!document.getElementById('save').disabled);
    const data = () => popup.evaluate(()=>chrome.storage.local.get(null));
    await ready();
    assert.equal(await popup.evaluate(()=>chrome.runtime.getManifest().version),'0.2.0');
    const results = ['真实扩展成功加载，版本为0.2.0'];
    await popup.locator('#save').click(); await ready();
    assert.match(await popup.locator('#status').innerText(),/请输入工作区名称/);
    results.push('真实扩展弹窗页面拦截空名称');
    await popup.locator('#workspaceName').fill('实习求职');
    await popup.locator('#save').click(); await ready();
    let saved = await data();
    assert.deepEqual(saved.workspaces[0].tabs.map(t=>t.url),[base+'/first',base+'/second']);
    results.push('真实tabs.query保存当前窗口普通网页，保留顺序');
    const third = await context.newPage(); await third.goto(base+'/third');
    await popup.bringToFront();
    await popup.locator('#workspaceName').fill('课程学习'); await popup.locator('#save').click(); await ready();
    saved = await data(); assert.equal(saved.workspaces.length,2);
    assert.deepEqual(saved.workspaces[1].tabs.map(t=>t.url),[base+'/first',base+'/second',base+'/third']);
    results.push('真实storage.local保存两个不同工作区，内容互不覆盖');
    await popup.locator('#workspaceName').fill('实习求职'); await popup.locator('#save').click(); await ready();
    assert.match(await popup.locator('#status').innerText(),/同名/); assert.equal((await data()).workspaces.length,2);
    results.push('同名保存不会覆盖已有记录');
    const original = await popup.evaluate(()=>chrome.windows.getCurrent({populate:true}));
    for (const [index,name] of ['实习求职','课程学习'].entries()) {
      const before = await popup.evaluate(()=>chrome.windows.getAll({populate:true}));
      await popup.getByRole('button',{name:`恢复工作区：${name}`,exact:true}).click(); await ready();
      const after = await popup.evaluate(()=>chrome.windows.getAll({populate:true}));
      assert.equal(after.length,before.length+1);
      const created = after.find(w=>!before.some(old=>old.id===w.id));
      assert.deepEqual(created.tabs.map(t=>t.url),saved.workspaces[index].tabs.map(t=>t.url));
      const preserved = after.find(w=>w.id===original.id);
      assert.deepEqual(preserved.tabs.map(t=>t.id),original.tabs.map(t=>t.id));
      results.push(`真实windows.create恢复「${name}」顺序正确，原窗口及标签页保留`);
    }
    await popup.bringToFront();
    await popup.screenshot({path:path.join(output,'BWI-V0.2-preview.png')});
    await popup.getByRole('button',{name:'删除工作区：实习求职',exact:true}).click(); await ready();
    assert.deepEqual((await data()).workspaces,[saved.workspaces[1]]);
    await popup.reload(); await ready(); assert.equal(await popup.locator('.workspace').count(),1);
    results.push('真实存储删除单项，重新打开后其他工作区仍保留');
    await popup.evaluate(async url=>{
      await chrome.storage.local.clear();
      await chrome.storage.local.set({savedWorkspace:{name:'V0.1旧工作区',savedAt:'2026-10-17',tabs:[{title:'旧网页',url}]}});
    },base+'/legacy');
    await popup.reload(); await ready();
    const migrated = await data(); assert.equal(migrated.workspaces.length,1); assert.equal(migrated.savedWorkspace,undefined);
    assert.equal(migrated.workspaces[0].name,'V0.1旧工作区'); assert.equal(migrated.bwiLegacyMigrated,true);
    await popup.reload(); await ready(); assert.equal((await data()).workspaces.length,1);
    results.push('真实旧键迁移成功，重新打开不重复导入');
    await popup.getByRole('button',{name:'删除工作区：V0.1旧工作区',exact:true}).click(); await ready();
    await popup.reload(); await ready(); assert.equal((await data()).workspaces.length,0);
    results.push('迁移记录删除后不再出现');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'BWI-V0.2-native-test-results.json'),JSON.stringify({passed:results.length,browser:version.product,tests:results,environment:'Real unpacked extension in isolated temporary Chrome profile, real extension storage/tabs/windows APIs. Opened popup.html as an extension page; toolbar popup reload in the user profile remains manual.'},null,2));
    for (const result of results) console.log('PASS '+result);
    console.log(`ALL ${results.length} NATIVE CHECKS PASSED`);
  } finally {await context.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
