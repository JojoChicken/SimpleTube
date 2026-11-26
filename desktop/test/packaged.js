const {_electron}=require('playwright');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
  const app=await _electron.launch({executablePath:path.resolve(__dirname,'../../release-v2/SimpleTube-win32-x64/SimpleTube.exe'),args:[],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  try{
    const page=await app.firstWindow();await page.evaluate(()=>document.fonts.ready);
    assert.ok(await page.evaluate(()=>document.fonts.check('14px Montserrat')));
    assert.equal(await page.locator('#download').isDisabled(),true);
    await page.screenshot({path:path.resolve(__dirname,'../artifacts/SimpleTube.png'),scale:'css',animations:'disabled'});
    const results=await app.evaluate(async({app})=>({packaged:app.isPackaged,version:app.getVersion()}));
    assert.ok(results.packaged);console.log('Packaged app:',JSON.stringify(results),'font and UI OK');
  }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
