"""Project-local Blender Python bridge; loopback only, separate factory scene.

Launch with Blender --background --factory-startup --python this_file.py.
Commands are JSON lines; generated artifacts stay under the caller's project.
"""
import contextlib
import io
import json
import socket
import traceback
import bpy

HOST, PORT = '127.0.0.1', 9878

def handle(request):
    command = request.get('type')
    if command == 'get_scene_info':
        return {'connected': True, 'version': bpy.app.version_string, 'port': PORT,
                'file': bpy.data.filepath, 'objects': [{'name': obj.name, 'type': obj.type} for obj in bpy.context.scene.objects]}
    if command == 'execute_code':
        output = io.StringIO()
        namespace = {'bpy': bpy, '__name__': '__blender_bridge__'}
        with contextlib.redirect_stdout(output):
            exec(compile(request['code'], '<project-bridge>', 'exec'), namespace)
        return {'output': output.getvalue(), 'result': namespace.get('result')}
    raise ValueError('Unknown command type')

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
    server.bind((HOST, PORT)); server.listen(3)
    print(f'CHOKETMON_BLENDER_READY {HOST}:{PORT} Blender {bpy.app.version_string}', flush=True)
    while True:
        connection, _ = server.accept()
        with connection:
            connection.settimeout(30)
            try:
                raw = bytearray()
                while b'\n' not in raw:
                    block = connection.recv(65536)
                    if not block: raise ValueError('Incomplete command')
                    raw.extend(block)
                    if len(raw) > 4_000_000: raise ValueError('Command too large')
                request = json.loads(bytes(raw).split(b'\n', 1)[0])
                response = {'status': 'success', 'result': handle(request)}
            except Exception as error:
                response = {'status': 'error', 'message': str(error), 'traceback': traceback.format_exc()}
            connection.sendall((json.dumps(response, ensure_ascii=False) + '\n').encode('utf-8'))
