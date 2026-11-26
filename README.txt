SimpleTube — простой загрузчик YouTube для Windows

Запуск: release\SimpleTube\SimpleTube.exe.
Переносить нужно всю папку release\SimpleTube: рядом с EXE нужны _internal и tools.
Установка Python, FFmpeg или Node.js не требуется.

1. Вставьте ссылку на одно видео.
2. Выберите папку сохранения.
3. Выберите режим и нажмите «Скачать».

Видео + звук: один MKV с лучшими доступными видео- и аудиодорожками.
Только видео: лучшая видеодорожка без звука, в исходном контейнере.
Только аудио: лучшая аудиодорожка без повторного сжатия (обычно Opus или M4A).
Качество определяется исходником: приложение не увеличивает разрешение искусственно.
Дорожки загружаются по очереди, поэтому процент может начинаться заново.
Последняя папка запоминается в %LOCALAPPDATA%\SimpleTube\settings.json.
Отмена оставляет частичные файлы для возможного продолжения загрузки.
Режимы имеют разные суффиксы файлов; существующие файлы не перезаписываются.

Закрытые видео, ролики с требованием входа и ограничения YouTube могут мешать загрузке.
Вход через браузер, плейлисты и обход ограничений в этой версии не предусмотрены.
Скачивайте материалы, которые вам разрешено сохранять.

Обновление движка: в папке tools выполнить .\yt-dlp.exe -U.
Источник yt-dlp: https://github.com/yt-dlp/yt-dlp
JavaScript runtime: https://nodejs.org/
FFmpeg: https://www.gyan.dev/ffmpeg/builds/ (https://ffmpeg.org/)

Исходный код: app.py. Проверки: python -m unittest test_app.py.
Проверка трех режимов на коротком публичном ролике: python test_app.py --integration.
Сборка: .venv\Scripts\python.exe -m PyInstaller --noconfirm --windowed --onedir --name SimpleTube --distpath release --workpath build app.py
После сборки скопировать tools и README.txt в release\SimpleTube.
