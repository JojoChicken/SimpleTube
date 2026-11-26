// Runs after electron-packager: trims what the portable build doesn't need and adds the user README.
const fs = require('node:fs');
const path = require('node:path');

const build = path.resolve(__dirname, '../../release-v2/SimpleTube-win32-x64');
if (!fs.existsSync(path.join(build, 'SimpleTube.exe'))) throw Error('Build not found: ' + build);

// Chromium ships UI strings for ~55 languages; the app is English-only, so one is enough.
const locales = path.join(build, 'locales');
let removed = 0;
for (const file of fs.readdirSync(locales)) {
  if (file !== 'en-US.pak') { fs.rmSync(path.join(locales, file)); removed++; }
}

fs.copyFileSync(path.resolve(__dirname, '../README.txt'), path.join(build, 'README.txt'));
console.log(`Removed ${removed} unused locales, added README.txt`);
