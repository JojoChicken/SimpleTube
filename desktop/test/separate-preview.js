const {_electron}=require('playwright');
const path=require('node:path');
const assert=require('node:assert/strict');
const {run,commonArgs,previewFormats}=require('../engine');
(async()=>{
  const tools=path.resolve(__dirname,'../../tools');
  const url='https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const raw=JSON.parse(await run(path.join(tools,'yt-dlp.exe'),[...commonArgs(tools),'--skip-download','-J','--',url],{timeout:90000}));
  const preview=previewFormats({formats:raw.formats.filter(f=>f.vcodec==='none'||f.acodec==='none')});
  assert.ok(preview.video&&preview.audio);
  const app=await _electron.launch({args:[path.resolve(__dirname,'..')],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,SIMPLETUBE_TEST_PROFILE:path.resolve(__dirname,'../artifacts/test-profile')}});
  try{
    const page=await app.firstWindow();
    await app.evaluate(({ipcMain},info)=>{ipcMain.removeHandler('inspect');ipcMain.handle('inspect',()=>({ok:true,value:info}));},{url,title:raw.title,duration:raw.duration,thumbnail:null,preview});
    await page.locator('#url').fill(url);await page.locator('#url').press('Enter');
    await page.waitForFunction(()=>!document.querySelector('#download').disabled);
    await page.locator('#start').fill('00:00:03');await page.locator('#end').fill('00:00:09');
    await page.locator('#playButton').click();
    await page.waitForFunction(()=>document.querySelector('#player').currentTime>4&&!document.querySelector('#audio').paused,{},{timeout:40000});
    const times=await page.evaluate(()=>({v:document.querySelector('#player').currentTime,a:document.querySelector('#audio').currentTime}));
    assert.ok(Math.abs(times.v-times.a)<.4,JSON.stringify(times));
    await page.locator('#preview').hover();await page.locator('#togglePlay').click();
    assert.ok(await page.locator('#audio').evaluate(a=>a.paused));
    await page.locator('#togglePlay').click();
    await page.waitForFunction(()=>document.querySelector('#player').paused&&document.querySelector('#player').currentTime>=8.8,{},{timeout:15000});
    assert.ok(await page.locator('#audio').evaluate(a=>a.paused));
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(526,680));
    const fits=await page.evaluate(()=>document.querySelector('.actions').getBoundingClientRect().bottom<=innerHeight);assert.ok(fits);
    console.log('Separate audio/video streams: playback, sync, pause, end boundary; compact window: OK');
  }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
