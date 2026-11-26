import json
from pathlib import Path
import subprocess
import unittest
from app import App, command, validate_url, TOOLS


class Tests(unittest.TestCase):
    def test_urls(self):
        self.assertEqual(validate_url(' youtu.be/example '), 'https://youtu.be/example')
        for url in ('https://youtube.com.evil.org/watch?v=x', 'file:///tmp/a', 'https://youtube.com/playlist?list=x', ''):
            with self.assertRaises(ValueError):
                validate_url(url)

    def test_commands(self):
        for mode, selector in [('Видео + звук', 'bv+ba/b'), ('Только видео', 'bv'), ('Только аудио', 'ba')]:
            args = command('https://youtu.be/example', Path('C:/Video files'), mode)
            self.assertEqual(args[args.index('-f') + 1], selector)
            self.assertEqual(args[-2], '--')
            self.assertIn('--no-playlist', args)
            self.assertIn('--no-overwrites', args)

    def test_ui(self):
        app = App()
        app.withdraw()
        app.update()
        self.assertEqual(app.mode.get(), 'Видео + звук')
        app.set_busy(True)
        self.assertEqual(str(app.start_button['state']), 'disabled')
        app.set_busy(False)
        app.destroy()


def integration():
    folder = Path(__file__).parent / 'test-output'
    folder.mkdir(exist_ok=True)
    for mode in ('Видео + звук', 'Только видео', 'Только аудио'):
        result = subprocess.run(command('https://www.youtube.com/watch?v=jNQXAC9IVRw', folder, mode),
                                capture_output=True, text=True, encoding='utf-8', errors='replace')
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        files = [Path(line[5:]) for line in result.stdout.splitlines() if line.startswith('FILE:')]
        assert files and files[-1].is_file(), result.stdout
        probe = subprocess.check_output([str(TOOLS / 'ffprobe.exe'), '-v', 'error', '-show_streams', '-of', 'json', str(files[-1])])
        kinds = {stream['codec_type'] for stream in json.loads(probe)['streams']}
        expected = {'Видео + звук': {'video', 'audio'}, 'Только видео': {'video'}, 'Только аудио': {'audio'}}[mode]
        assert kinds == expected, (mode, kinds)
        print(mode, 'OK', files[-1].suffix, kinds)


if __name__ == '__main__':
    import sys
    if '--integration' in sys.argv:
        integration()
    else:
        unittest.main()
