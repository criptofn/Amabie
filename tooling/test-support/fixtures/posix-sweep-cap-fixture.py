import json
import os
import sys

count = 201
read_fd, write_fd = os.pipe()
children = []
with open(sys.argv[1], 'w', encoding='utf-8', buffering=1) as registry:
    registry.write(str(os.getpid()) + '\n')
    for _ in range(count):
        pid = os.fork()
        if pid == 0:
            os.close(read_fd)
            os.setpgid(0, 0)  # Retain the original session; do NOT call setsid.
            with open('/dev/null', 'r+b', buffering=0) as sink:
                for descriptor in (0, 1, 2):
                    os.dup2(sink.fileno(), descriptor)
            os.write(write_fd, b'1')
            os.close(write_fd)
            os.execl('/usr/bin/sleep', 'sleep', '15')  # Automatic safety expiry.
        children.append(pid)
        registry.write(str(pid) + '\n')
    os.close(write_fd)
    ready = b''
    while len(ready) < count:
        chunk = os.read(read_fd, count - len(ready))
        if not chunk:
            raise RuntimeError('A fixture child failed before its group was ready')
        ready += chunk
    os.close(read_fd)
    print(json.dumps({'root': os.getpid(), 'children': children}), flush=True)
os._exit(0)
