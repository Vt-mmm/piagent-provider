# Drives an interactive program through a pty: types each command, presses
# Enter, and prints what the screen showed. argv[1] is JSON {cmd, cwd, env}.
import json, os, pty, re, select, sys, time

spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec['cwd'])
    os.execvpe(spec['cmd'][0], spec['cmd'], dict(spec['env'], COLUMNS='120', LINES='40'))
ANSI = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07')

def pump(seconds):
    chunks, end = [], time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try: chunks.append(os.read(fd, 65536))
            except OSError: break
    return b''.join(chunks)

def screen(raw): return ANSI.sub(b'', raw).decode('utf8', 'replace')

print('== initial'); print(screen(pump(6)))
for command in sys.argv[2:]:
    if command.startswith('^'):  # a control key, e.g. ^P is Ctrl+P
        os.write(fd, bytes([ord(command[1]) - 64])); print('== key', command); print(screen(pump(1.5))); continue
    os.write(fd, command.encode()); pump(1.5)
    os.write(fd, b'\r'); shown = pump(1.5)
    os.write(fd, b'\r'); shown += pump(1.5)
    print('== sent', command); print(screen(shown))
os.write(fd, b'\x03'); pump(0.5); os.write(fd, b'\x03'); pump(1)
