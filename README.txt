SimpleTube — простой загрузчик YouTube для Windows, для личного пользования.

Приложение — в папке desktop (Electron + yt-dlp + FFmpeg), подробности в desktop\README.txt.
Переносная сборка: release-v2\SimpleTube-win32-x64\SimpleTube.exe.
Утилиты лежат в tools и копируются в сборку: yt-dlp.exe и FFmpeg 9.1 (сборка gyan.dev full shared:
ffmpeg.exe, ffprobe.exe и общие av*.dll / sw*.dll). Отдельный node.exe не нужен:
yt-dlp использует Node.js, встроенный в Electron (ELECTRON_RUN_AS_NODE).

Старая версия на Python/Tk удалена; она осталась в истории git (коммит 08f9dcb).

Лицензия: MIT (файл LICENSE) — только на собственный код SimpleTube.
В архивах релизов также лежат сторонние программы со своими лицензиями:
Electron (MIT), yt-dlp (Unlicense), FFmpeg (GPLv3, resources/tools/FFmpeg-LICENSE.txt), шрифт Montserrat (SIL OFL 1.1).
