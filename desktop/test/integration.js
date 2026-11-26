const { Engine, rangeFor } = require('../engine');
const path = require('node:path');
const fs = require('node:fs/promises');
(async()=>{
  const engine=new Engine(path.resolve(__dirname,'../../tools'));
  const folder=path.resolve(__dirname,'../artifacts/downloads');await fs.mkdir(folder,{recursive:true});
  const url='https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const info=await engine.inspect(url);
  console.log('Metadata:',info.title,info.duration,'preview video:',Boolean(info.preview.video),'separate audio:',Boolean(info.preview.audio));
  for(const mode of ['full','video','audio']){
    const result=await engine.download({url,folder,mode,range:rangeFor(3,8,info.duration)},()=>{});
    console.log(mode,JSON.stringify(result));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
