const { _electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
(async()=>{
  const artifacts=path.resolve(__dirname,'../artifacts');await fs.mkdir(artifacts,{recursive:true});
  const app=await _electron.launch({args:[path.resolve(__dirname,'..')],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,SIMPLETUBE_TEST_PROFILE:path.join(artifacts,'test-profile')},timeout:30000});
  try{
    const page=await app.firstWindow();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:path.join(artifacts,'01-empty.png')});
    assert.equal(await page.locator('#download').isDisabled(),true);
    assert.equal(await page.evaluate(()=>document.fonts.check('14px Montserrat')),true);
    const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollHeight,height:innerHeight}));
    assert.ok(dimensions.scroll<=dimensions.height,JSON.stringify(dimensions));
    await page.locator('#url').fill('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    await page.locator('#url').press('Enter');
    await page.waitForFunction(()=>!document.querySelector('#download').disabled,{},{timeout:100000});
    await page.screenshot({path:path.join(artifacts,'02-ready.png')});
    await page.locator('#start').fill('00:00:03');await page.locator('#end').fill('00:00:08');
    await page.locator('#playButton').click();
    await page.waitForFunction(()=>document.querySelector('#player').currentTime>3.2&&!document.querySelector('#player').paused,{},{timeout:40000});
    await page.screenshot({path:path.join(artifacts,'03-playing.png')});
    await page.waitForFunction(()=>document.querySelector('#player').paused&&document.querySelector('#player').currentTime>=7.8,{},{timeout:15000});
    console.log('Preview played selected 3–8 seconds and stopped at',await page.locator('#player').evaluate(v=>v.currentTime));
    await page.locator('#preview').hover();await page.locator('#stopPreview').click();
    await page.locator('#end').fill('00:00:01');assert.equal(await page.locator('#download').isDisabled(),true);
    await page.locator('#end').fill('00:00:08');
    const folder=path.join(artifacts,'ui-downloads');await fs.mkdir(folder,{recursive:true});await page.locator('#folder').fill(folder);
    await page.locator('#download').click();
    await page.waitForFunction(()=>document.querySelector('#download').classList.contains('success'),{},{timeout:120000});
    await page.screenshot({path:path.join(artifacts,'04-complete.png'),animations:'disabled'});
    assert.equal(await page.locator('#download').innerText(),'Open in folder');
    await page.locator('[data-mode="audio"]').click();
    assert.equal(await page.locator('#progressOverlay').isVisible(),false);
    assert.equal(await page.locator('#playButton').isVisible(),true);
    assert.equal(await page.locator('#download').innerText(),'Download');
    // Deterministic rendering check: show intermediate progress, then cancel.
    await app.evaluate(({ipcMain,BrowserWindow})=>{
      let finish;
      ipcMain.removeHandler('download');ipcMain.removeHandler('cancel');
      ipcMain.handle('download',()=>new Promise(resolve=>{
        finish=resolve;BrowserWindow.getAllWindows()[0].webContents.send('progress',{stage:'downloading',percent:66,speed:3*1048576,eta:12});
      }));
      ipcMain.handle('cancel',()=>{finish?.({ok:false,error:'Отменено'});return {ok:true};});
    });
    await page.locator('[data-mode="full"]').click();await page.locator('#download').click();
    await page.waitForFunction(()=>document.querySelector('#percent').textContent==='66%');
    await page.screenshot({path:path.join(artifacts,'05-progress.png'),animations:'disabled'});
    assert.equal(await page.locator('#url').isDisabled(),true);
    await page.locator('#cancel').click();
    await page.waitForFunction(()=>!document.querySelector('#download').disabled);
    assert.equal(await page.locator('#progressOverlay').isVisible(),false);
    assert.equal(await page.locator('#url').isDisabled(),false);
    assert.deepEqual(errors,[]);console.log('UI, font, range validation, real preview, real download: OK');
  }finally{await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
