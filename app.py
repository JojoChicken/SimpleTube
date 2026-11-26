"""Minimal, portable Windows frontend for yt-dlp."""
import ctypes
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from urllib.parse import urlsplit

BASE = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).parent
TOOLS = BASE / 'tools'
CONFIG = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'SimpleTube' / 'settings.json'
MODES = {'Видео + звук': 'bv+ba/b', 'Только видео': 'bv', 'Только аудио': 'ba'}


def validate_url(value):
    value = value.strip()
    if '://' not in value:
        value = 'https://' + value
    parts = urlsplit(value)
    host = (parts.hostname or '').lower()
    if parts.scheme not in ('http', 'https') or not (host in ('youtu.be', 'youtube.com') or host.endswith('.youtube.com')):
        raise ValueError('Вставьте ссылку на видео YouTube.')
    if parts.username or parts.password or not parts.path.strip('/'):
        raise ValueError('Нужна ссылка на конкретное видео.')
    if parts.path == '/playlist':
        raise ValueError('Вставьте ссылку на одно видео, а не на плейлист.')
    return value


def command(url, folder, mode):
    args = [str(TOOLS / 'yt-dlp.exe'), '--ignore-config', '--no-playlist', '--newline', '--no-color',
            '--encoding', 'utf-8', '--windows-filenames', '--trim-filenames', '160', '--no-overwrites',
            '--socket-timeout', '20', '--retries', '3', '--ffmpeg-location', str(TOOLS),
            '--js-runtimes', 'node:' + str(TOOLS / 'node.exe'),
            '-f', MODES[mode], '-P', str(folder),
            '-o', '%(title)s [%(id)s].' + {'Видео + звук': 'full', 'Только видео': 'video', 'Только аудио': 'audio'}[mode] + '.%(ext)s',
            '--progress-template', 'download:PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
            '--print', 'after_move:FILE:%(filepath)s']
    if mode == 'Видео + звук':
        args += ['--merge-output-format', 'mkv', '--remux-video', 'mkv']
    elif mode == 'Только аудио':
        args += ['-x', '--audio-format', 'best']
    return args + ['--', url]


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('SimpleTube')
        self.geometry('710x485')
        self.minsize(650, 485)
        self.configure(bg='#f5f6f8')
        self.events = queue.Queue()
        self.cancel_event = threading.Event()
        self.process = None
        self.busy = False
        self.closing = False
        self.last_file = None
        self.log = []
        try:
            settings = json.loads(CONFIG.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            settings = {}
        self.url = tk.StringVar()
        self.folder = tk.StringVar(value=settings.get('folder', str(Path.home() / 'Downloads')))
        self.mode = tk.StringVar(value='Видео + звук')
        self.status = tk.StringVar(value='Вставьте ссылку, выберите папку и нажмите «Скачать».')
        style = ttk.Style(self)
        style.theme_use('clam')
        style.configure('.', font=('Segoe UI', 10), background='#f5f6f8')
        style.configure('TButton', padding=(12, 8))
        style.configure('TEntry', padding=8, fieldbackground='white')
        style.configure('Accent.TButton', background='#2463eb', foreground='white')
        style.map('Accent.TButton', background=[('active', '#1d4ed8'), ('disabled', '#9ca3af')])
        outer = ttk.Frame(self, padding=26)
        outer.pack(fill='both', expand=True)
        ttk.Label(outer, text='SimpleTube', font=('Segoe UI Semibold', 23)).pack(anchor='w')
        ttk.Label(outer, text='Видео и музыка. Без лишнего.', foreground='#666c78').pack(anchor='w', pady=(2, 22))
        ttk.Label(outer, text='Ссылка на YouTube').pack(anchor='w')
        row = ttk.Frame(outer)
        row.pack(fill='x', pady=(6, 14))
        self.url_entry = ttk.Entry(row, textvariable=self.url)
        self.url_entry.pack(side='left', fill='x', expand=True)
        paste = ttk.Button(row, text='Вставить', command=self.paste)
        paste.pack(side='right', padx=(8, 0))
        ttk.Label(outer, text='Куда сохранить').pack(anchor='w')
        row = ttk.Frame(outer)
        row.pack(fill='x', pady=(6, 18))
        folder_entry = ttk.Entry(row, textvariable=self.folder)
        folder_entry.pack(side='left', fill='x', expand=True)
        browse = ttk.Button(row, text='Выбрать…', command=self.browse)
        browse.pack(side='right', padx=(8, 0))
        row = ttk.Frame(outer)
        row.pack(fill='x')
        self.inputs = [self.url_entry, folder_entry, paste, browse]
        for name in MODES:
            radio = ttk.Radiobutton(row, text=name, variable=self.mode, value=name)
            radio.pack(side='left', padx=(0, 23))
            self.inputs.append(radio)
        ttk.Label(outer, text='Лучшее доступное качество • без повторного сжатия', foreground='#666c78').pack(anchor='w', pady=(12, 16))
        self.progress = ttk.Progressbar(outer, maximum=100)
        self.progress.pack(fill='x')
        ttk.Label(outer, textvariable=self.status, wraplength=640).pack(anchor='w', pady=(8, 12))
        row = ttk.Frame(outer)
        row.pack(fill='x', side='bottom')
        self.start_button = ttk.Button(row, text='Скачать', style='Accent.TButton', command=self.start)
        self.start_button.pack(side='left')
        self.stop_button = ttk.Button(row, text='Отмена', command=self.cancel, state='disabled')
        self.stop_button.pack(side='left', padx=8)
        ttk.Button(row, text='Открыть папку', command=self.open_folder).pack(side='right')
        self.protocol('WM_DELETE_WINDOW', self.close)
        self.update_idletasks()
        width = max(710, outer.winfo_reqwidth() + 20)
        height = max(485, outer.winfo_reqheight() + 20)
        self.minsize(width, height)
        self.geometry(f'{width}x{height}')
        self.after(100, self.poll)
        self.url_entry.focus_set()

    def paste(self):
        try:
            self.url.set(self.clipboard_get().strip())
        except tk.TclError:
            pass

    def browse(self):
        selected = filedialog.askdirectory(initialdir=self.folder.get(), title='Куда сохранить видео')
        if selected:
            self.folder.set(selected)

    def open_folder(self):
        folder = self.last_file.parent if self.last_file else Path(self.folder.get()).expanduser()
        if folder.is_dir():
            os.startfile(str(folder))

    def set_busy(self, value):
        self.busy = value
        for widget in self.inputs + [self.start_button]:
            widget.configure(state='disabled' if value else 'normal')
        self.stop_button.configure(state='normal' if value else 'disabled')

    def start(self):
        try:
            url = validate_url(self.url.get())
            if not self.folder.get().strip():
                raise ValueError('Выберите папку сохранения.')
            folder = Path(self.folder.get()).expanduser().resolve()
            folder.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryFile(dir=folder):
                pass
            for name in ('yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'node.exe'):
                if not (TOOLS / name).is_file():
                    raise ValueError('Не найден tools/' + name + '. Сохраните папку программы целиком.')
        except (ValueError, OSError) as error:
            messagebox.showerror('Не удалось начать', str(error))
            return
        try:
            CONFIG.parent.mkdir(parents=True, exist_ok=True)
            CONFIG.write_text(json.dumps({'folder': str(folder)}, ensure_ascii=False), encoding='utf-8')
        except OSError:
            pass
        self.log = []
        self.last_file = None
        self.cancel_event.clear()
        self.progress.configure(mode='indeterminate')
        self.progress.start(12)
        self.status.set('Получаю информацию о видео…')
        self.set_busy(True)
        threading.Thread(target=self.worker, args=(command(url, folder, self.mode.get()),), daemon=True).start()

    def worker(self, args):
        try:
            with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                  encoding='utf-8', errors='replace', creationflags=subprocess.CREATE_NO_WINDOW) as process:
                self.process = process
                if self.cancel_event.is_set():
                    self.kill_process()
                for line in process.stdout:
                    self.events.put(('line', line.strip()))
                code = process.wait()
            self.events.put(('done', code))
        except Exception as error:
            self.events.put(('line', 'ERROR: ' + str(error)))
            self.events.put(('done', 1))
        finally:
            self.process = None

    def kill_process(self):
        process = self.process
        if process and process.poll() is None:
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                           capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)

    def cancel(self):
        self.cancel_event.set()
        self.stop_button.configure(state='disabled')
        self.status.set('Отменяю…')
        threading.Thread(target=self.kill_process, daemon=True).start()

    def close(self):
        if self.busy:
            self.closing = True
            self.cancel()
        else:
            self.destroy()

    def poll(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == 'line':
                    self.log.append(value)
                    self.log = self.log[-150:]
                    if value.startswith('PROGRESS:') and not self.cancel_event.is_set():
                        parts = value[9:].split('|')
                        try:
                            percent = float(parts[0].strip().rstrip('%'))
                            self.progress.stop()
                            self.progress.configure(mode='determinate', value=percent)
                            self.status.set(f'Скачивание дорожки: {percent:.1f}% • {parts[1].strip()} • осталось {parts[2].strip()}')
                        except (ValueError, IndexError):
                            pass
                    elif value.startswith('FILE:'):
                        self.last_file = Path(value[5:])
                    elif value.startswith(('[Merger]', '[VideoRemuxer]', '[ExtractAudio]')):
                        self.status.set('Подготавливаю готовый файл…')
                        self.progress.configure(mode='indeterminate')
                        self.progress.start(12)
                else:
                    self.progress.stop()
                    self.progress.configure(mode='determinate', value=0)
                    self.set_busy(False)
                    if self.closing:
                        self.destroy()
                        return
                    if self.cancel_event.is_set():
                        self.status.set('Отменено. При повторном запуске загрузка продолжится, если это возможно.')
                    elif value == 0 and self.last_file and self.last_file.is_file():
                        self.progress['value'] = 100
                        self.status.set('Готово! Файл сохранён в выбранную папку.')
                    else:
                        self.status.set('Не удалось скачать видео.')
                        errors = [line for line in self.log if 'ERROR:' in line]
                        detail = '\n'.join(errors[-3:] or self.log[-5:])
                        messagebox.showerror('Ошибка скачивания', 'Проверьте ссылку и подключение. Видео может быть недоступно или требовать входа.\n\n' + detail)
        except queue.Empty:
            pass
        self.after(100, self.poll)


if __name__ == '__main__':
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (AttributeError, OSError):
        pass
    App().mainloop()
