const $ = id => document.getElementById(id);
const api = window.tube;
let info = null, mode = 'full', busy = false, inspecting = false, completed = false, revision = 0, debounce;
let playing = false, playIntent = false, previewRevision = 0, muted = false;
const video = $('player'), audio = $('audio');
const fmt = n => [Math.floor(n/3600), Math.floor(n/60)%60, Math.floor(n)%60].map(v=>String(v).padStart(2,'0')).join(':');
const shortTime = n => n >= 3600 ? fmt(n) : fmt(n).slice(3);
async function call(method, ...args) { const result = await api[method](...args); if (!result.ok) throw Error(result.error); return result.value; }
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function setLoading(value, label = 'Ищем ваш момент…') { $('loading').hidden = !value; $('loadingLabel').textContent = label; }
function time(text) {
  if (!/^\d{1,3}:\d{2}(?::\d{2})?$/.test(text)) throw Error('Введите тайминг как 00:02:30.');
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some(v=>v>59)) throw Error('Минуты и секунды: от 00 до 59.');
  return parts.reduce((sum, v)=>sum*60+v,0);
}
function range() {
  const start = time($('start').value.trim()), end = time($('end').value.trim());
  if (end <= start) throw Error('Конец фрагмента должен быть позже начала.');
  if (!info || end > Math.ceil(info.duration)) throw Error('Фрагмент выходит за длительность видео.');
  return { start, end: Math.min(end, info.duration), partial: start > 0 || end < info.duration - .1 };
}
function clearSuccess() {
  if(completed){$('progressOverlay').hidden=true;$('playButton').hidden=false;$('durationBadge').hidden=!info;$('previewTag').hidden=false;$('posterColor').style.clipPath='';status('Готово к скачиванию.');}
  completed = false; $('download').classList.remove('success');
  $('download').querySelector('span').textContent = 'Download';
  $('download').querySelector('use').setAttribute('href','#i-download');
}
function updateControls() {
  for (const id of ['url','folder','paste','chooseFolder']) $(id).disabled = busy;
  for (const id of ['start','end']) $(id).disabled = busy || !info;
  document.querySelectorAll('.mode').forEach(button=>button.disabled=busy);
  $('download').disabled = busy || inspecting || !info;
  $('cancel').disabled = !busy && !inspecting;
  $('resetRange').disabled = busy;
  $('playButton').disabled = busy || inspecting;
}
function updateRange() {
  stopPreview(); clearSuccess();
  try {
    const r = range();
    $('start').classList.remove('invalid'); $('end').classList.remove('invalid');
    $('rangeSummary').textContent = r.partial ? `Фрагмент · ${shortTime(r.end-r.start)} · точная обрезка` : `Весь ролик · ${shortTime(info.duration)}`;
    $('resetRange').hidden = !r.partial;
    $('footerNote').textContent = r.partial ? 'ТОЧНЫЙ ФРАГМЕНТ · ВЫСОКОЕ КАЧЕСТВО' : 'ЛУЧШЕЕ КАЧЕСТВО · БЕЗ ПЕРЕСЖАТИЯ';
    status(r.partial ? 'Play — проверить выбранный фрагмент.' : 'Готово к скачиванию. Или выберите свой фрагмент.');
    $('download').disabled = busy || inspecting;
  } catch(error) { $('end').classList.add('invalid'); status(error.message,true); $('download').disabled = true; }
}
function clearPreviewSources() { video.removeAttribute('src'); video.load(); audio.removeAttribute('src'); audio.load(); }
function stopPreview() {
  ++previewRevision; playIntent = false; playing = false; video.pause(); audio.pause();
  video.hidden = true; $('playerControls').hidden = true; $('playButton').hidden = busy || inspecting;
  $('preview').classList.remove('playing','paused');
  if (!busy && !inspecting) setLoading(false);
}
function resetMedia() {
  info = null; clearSuccess(); stopPreview(); clearPreviewSources();
  $('posterGray').hidden = $('posterColor').hidden = true;
  $('posterGray').removeAttribute('src'); $('posterColor').removeAttribute('src');
  $('posterColor').style.clipPath = ''; $('emptyArt').hidden = false;
  $('preview').classList.remove('has-video'); $('previewTag').hidden = false;
  $('previewTag').innerHTML = '<span class="tiny-dot"></span> YOUR NEXT FAVOURITE';
  $('durationBadge').hidden = true; $('progressOverlay').hidden = true;
  $('videoTitle').textContent = 'Сохраните то, что хочется пересмотреть.';
  $('videoTitle').title = ''; $('start').value='00:00:00'; $('end').value='';
  $('start').classList.remove('invalid'); $('end').classList.remove('invalid');
  $('rangeSummary').textContent = 'Весь ролик или только любимый фрагмент'; $('resetRange').hidden=true;
  $('footerNote').textContent='MADE FOR YOUR FAVOURITES';
}
async function inspectLink() {
  clearTimeout(debounce);
  const url = $('url').value.trim(); if (!url || busy) return;
  const token = ++revision; resetMedia(); inspecting = true; updateControls();
  $('playButton').hidden = true; setLoading(true); status('Получаем обложку и длительность…');
  try {
    const result = await call('inspect', url);
    if (token !== revision) return;
    info = result;
    if (info.thumbnail) {
      for (const id of ['posterGray','posterColor']) { $(id).src=info.thumbnail; $(id).hidden=false; }
      $('emptyArt').hidden=true;
    }
    $('preview').classList.add('has-video');
    $('videoTitle').textContent=info.title; $('videoTitle').title=info.title;
    $('previewTag').textContent = 'READY WHEN YOU ARE';
    $('durationBadge').hidden=false; $('durationBadge').textContent=shortTime(info.duration);
    $('start').value='00:00:00'; $('end').value=fmt(Math.ceil(info.duration));
    $('playButton').title='Предпросмотр выбранного фрагмента';
    inspecting = false; setLoading(false); updateControls(); updateRange();
  } catch(error) {
    if (token !== revision) return;
    inspecting=false; setLoading(false); $('playButton').hidden=false; updateControls();
    status(error.message === 'Отменено' ? 'Получение информации отменено.' : 'Не удалось открыть видео. ' + error.message,true);
  }
}
$('url').addEventListener('input', () => {
  ++revision; inspecting=false; resetMedia(); updateControls();
  call('invalidate').catch(()=>{}); clearTimeout(debounce);
  status('Вставьте ссылку на видео YouTube.');
  if ($('url').value.trim()) debounce=setTimeout(inspectLink,850);
});
$('url').addEventListener('keydown',event=>{if(event.key==='Enter')inspectLink();});
$('paste').onclick=async()=>{try{$('url').value=await call('paste');await inspectLink();}catch(e){status(e.message,true);}};
$('chooseFolder').onclick=async()=>{try{const folder=await call('folder');if(folder){$('folder').value=folder;$('folder').title=folder;clearSuccess();}}catch(e){status(e.message,true);}};
$('folder').oninput=()=>{clearSuccess();$('folder').title=$('folder').value;};
for(const id of ['start','end']) { $(id).oninput=updateRange; $(id).onblur=()=>{try{$(id).value=fmt(time($(id).value));}catch{}}; }
$('resetRange').onclick=()=>{if(info){$('start').value='00:00:00';$('end').value=fmt(Math.ceil(info.duration));updateRange();}};
function selectMode(button) {
  if(busy)return; mode=button.dataset.mode; clearSuccess();
  document.querySelectorAll('.mode').forEach(item=>{const selected=item===button;item.classList.toggle('selected',selected);item.setAttribute('aria-checked',selected);item.tabIndex=selected?0:-1;});
}
document.querySelectorAll('.mode').forEach((button,index)=>{
  button.onclick=()=>selectMode(button);
  button.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const buttons=[...document.querySelectorAll('.mode')];const next=buttons[(index+(event.key==='ArrowRight'?1:2))%3];selectMode(next);next.focus();}};
});

function waitMedia(media,event,ready,token) {
  if(ready())return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const done=()=>{cleanup();token===previewRevision?resolve():reject(Error('Отменено'));};
    const fail=()=>{cleanup();reject(Error('Поток предпросмотра недоступен. Скачивание можно продолжить.'));};
    const timer=setTimeout(fail,25000);
    function cleanup(){clearTimeout(timer);media.removeEventListener(event,done);media.removeEventListener('error',fail);}
    media.addEventListener(event,done,{once:true});media.addEventListener('error',fail,{once:true});
  });
}
async function startPreview() {
  if(!info){$('url').focus();status('Сначала вставьте ссылку на видео.');return;}
  let r;try{r=range();}catch(e){status(e.message,true);return;}
  if(!info.preview.video){status('Для этого видео предпросмотр недоступен. Можно скачать выбранный фрагмент.',true);return;}
  stopPreview(); const token=++previewRevision;
  $('playButton').hidden=true;setLoading(true,'Подключаем предпросмотр…');
  try {
    const sources=[[video,info.preview.video],...(info.preview.audio?[[audio,info.preview.audio]]:[])];
    for(const [media,url]of sources){if(media.src!==url){media.src=url;media.load();}}
    await Promise.all(sources.map(([media])=>waitMedia(media,'loadedmetadata',()=>media.readyState>=1,token)));
    if(token!==previewRevision)return;
    await Promise.all(sources.map(async([media])=>{media.currentTime=r.start;await waitMedia(media,'seeked',()=>!media.seeking,token);}));
    if(token!==previewRevision)return;
    video.muted=Boolean(info.preview.audio)||muted;audio.muted=muted;
    video.hidden=false;playing=true;playIntent=true;$('playerControls').hidden=false;
    $('togglePlay').querySelector('use').setAttribute('href','#i-pause');$('togglePlay').setAttribute('aria-label','Пауза');
    $('preview').classList.add('playing');$('seek').min=r.start;$('seek').max=r.end;$('seek').value=r.start;
    await Promise.all(sources.map(([media])=>media.play()));
    if(token!==previewRevision){video.pause();audio.pause();return;}
    setLoading(false);status('Предпросмотр выбранного фрагмента · скачивание в лучшем качестве.');
  } catch(error) {if(token===previewRevision){stopPreview();status(error.message,true);}}
}
function pausePlayback(){playIntent=false;video.pause();audio.pause();$('preview').classList.add('paused');$('togglePlay').querySelector('use').setAttribute('href','#i-play');$('togglePlay').setAttribute('aria-label','Продолжить');}
async function resumePlayback(){
  try{const r=range();if(video.currentTime>=r.end-.15){video.currentTime=r.start;if(info.preview.audio)audio.currentTime=r.start;}
    playIntent=true;await video.play();if(info.preview.audio){audio.currentTime=video.currentTime;await audio.play();}
    $('preview').classList.remove('paused');$('togglePlay').querySelector('use').setAttribute('href','#i-pause');$('togglePlay').setAttribute('aria-label','Пауза');
  }catch{stopPreview();status('Не удалось продолжить предпросмотр. Нажмите Play ещё раз.',true);}
}
$('playButton').onclick=startPreview;
$('togglePlay').onclick=()=>video.paused?resumePlayback():pausePlayback();
video.onclick=()=>video.paused?resumePlayback():pausePlayback();
$('stopPreview').onclick=stopPreview;
$('seek').oninput=()=>{video.currentTime=Number($('seek').value);if(info?.preview.audio)audio.currentTime=video.currentTime;};
$('mute').onclick=()=>{muted=!muted;video.muted=Boolean(info?.preview.audio)||muted;audio.muted=muted;$('mute').querySelector('use').setAttribute('href',muted?'#i-muted':'#i-sound');$('mute').setAttribute('aria-label',muted?'Включить звук':'Выключить звук');};
video.addEventListener('timeupdate',()=>{if(!playing||!info)return;let r;try{r=range();}catch{return;}$('seek').value=video.currentTime;$('playTime').textContent=shortTime(video.currentTime);if(video.currentTime>=r.end-.08){pausePlayback();status('Конец выбранного фрагмента.');}});
video.addEventListener('waiting',()=>{if(playing&&playIntent){audio.pause();setLoading(true,'Буферизация…');}});
video.addEventListener('playing',()=>{if(playing&&playIntent){setLoading(false);if(info?.preview.audio){audio.currentTime=video.currentTime;audio.play().catch(()=>{});}}});
video.addEventListener('seeking',()=>{if(playing)audio.pause();});
video.addEventListener('seeked',()=>{if(playing&&playIntent&&info?.preview.audio){audio.currentTime=video.currentTime;audio.play().catch(()=>{});}});
video.addEventListener('ended',()=>{if(playing)pausePlayback();});
for(const media of [video,audio])media.addEventListener('error',()=>{if(playing){stopPreview();status('Поток предпросмотра недоступен. Можно скачать выбранный фрагмент.',true);}});
setInterval(()=>{if(playing&&playIntent&&!video.paused&&info?.preview.audio&&audio.readyState>=3&&Math.abs(video.currentTime-audio.currentTime)>.25)audio.currentTime=video.currentTime;},500);

$('download').onclick=async()=>{
  if(completed){try{await call('reveal');}catch(e){status(e.message,true);}return;}
  let r;try{r=range();}catch(e){status(e.message,true);return;}
  busy=true;stopPreview();clearPreviewSources();clearSuccess();updateControls();$('previewTag').hidden=true;$('durationBadge').hidden=true;
  $('progressOverlay').hidden=false;$('posterColor').style.clipPath='inset(0 100% 0 0)';$('percent').innerHTML='0<span>%</span>';$('progressEdge').style.left='0%';
  $('download').querySelector('span').textContent='Downloading';status('Подготавливаем загрузку…');
  try{
    await call('download',{url:$('url').value,folder:$('folder').value,mode,start:r.start,end:r.end});
    busy=false;completed=true;updateControls();$('download').classList.add('success');$('download').querySelector('span').textContent='Open in folder';$('download').querySelector('use').setAttribute('href','#i-folder');
    $('posterColor').style.clipPath='inset(0 0% 0 0)';$('progressEdge').style.left='100%';$('percent').innerHTML='100<span>%</span>';$('progressStage').textContent='SAVED TO YOUR FAVOURITES';
    status('Готово. Ваш момент сохранён.');$('playButton').hidden=true;
  }catch(error){busy=false;updateControls();clearSuccess();$('progressOverlay').hidden=true;$('posterColor').style.clipPath='';$('playButton').hidden=false;$('durationBadge').hidden=false;
    status(error.message==='Отменено'?'Загрузка отменена. Можно попробовать снова.':error.message,error.message!=='Отменено');}
};
api.onProgress(data=>{
  if(!busy)return;const percent=Math.max(0,Math.min(99,Number(data.percent)||0));
  $('posterColor').style.clipPath=`inset(0 ${100-percent}% 0 0)`;$('progressEdge').style.left=percent+'%';$('percent').innerHTML=Math.floor(percent)+'<span>%</span>';
  $('progressStage').textContent=data.stage==='processing'?'FINISHING UP':data.stage==='preparing'?'GETTING READY':'DOWNLOADING';
  if(data.stage==='processing')status('Подготавливаем и проверяем готовый файл…');
  else if(data.speed)status(`${(data.speed/1048576).toFixed(1)} МБ/с${data.eta?' · осталось '+shortTime(data.eta):''}`);
  else status(data.stage==='preparing'?'Подключаемся к видео…':'Сохраняем выбранный момент…');
});
$('cancel').onclick=async()=>{if(inspecting){++revision;inspecting=false;setLoading(false);$('playButton').hidden=false;updateControls();}status('Отменяем…');$('cancel').disabled=true;try{await call('cancel');if(!busy)status('Отменено.');}catch(e){status(e.message,true);}};
$('minimize').onclick=()=>call('minimize');$('close').onclick=()=>call('close');
call('settings').then(settings=>{$('folder').value=settings.folder;$('folder').title=settings.folder;}).catch(e=>status(e.message,true));
