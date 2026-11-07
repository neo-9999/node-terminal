const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.SERVER_PORT || 16895;
const PASSWORD = 'mysecret.#';

// 1. 创建 HTTP 服务器托管网页端
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Container Terminal</title>
                <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
                <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
                <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
                <style>
                    body, html { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
                    #terminal { width: 100%; height: 100%; }
                </style>
            </head>
            <body>
                <div id="terminal"></div>
                <script>
                    const term = new Terminal({ cursorBlink: true, fontSize: 14 });
                    const fitAddon = new FitAddon.FitAddon();
                    term.loadAddon(fitAddon);
                    term.open(document.getElementById('terminal'));
                    fitAddon.fit();

                    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const ws = new WebSocket(\`\${protocol}//\${location.host}\`);

                    ws.onmessage = (event) => {
                        term.write(event.data);
                    };

                    // 修复：确保回车键能正确发送 \r
                    term.onKey(({ key, domEvent }) => {
                        let ev = domEvent;
                        let printable = !ev.altKey && !ev.ctrlKey && !ev.metaKey;
                        if (ev.keyCode === 13) {
                            ws.send('\\r');
                        } else if (ev.keyCode === 8) {
                            // Backspace
                            ws.send('\\b');
                        } else if (printable) {
                            ws.send(key);
                        }
                    });

                    window.addEventListener('resize', () => fitAddon.fit());
                </script>
            </body>
            </html>
        `);
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// 2. 挂载 WebSocket 服务
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    let authenticated = false;
    let passBuffer = '';
    let sh = null;

    ws.send("Password:");

    ws.on('message', (message) => {
        const input = message.toString();

        if (!authenticated) {
            if (input === '\r' || input === '\n') {
                if (passBuffer === PASSWORD) {
                    authenticated = true;
                    ws.send("\r\nAccess Granted. Welcome to the container shell!\r\n");
                    
                    // 认证成功后，启动 Python PTY 伪终端
                    sh = spawn('python3', ['-c', 'import pty; pty.spawn("/bin/bash")']);

                    // 实时将终端输出返回给网页
                    sh.stdout.on('data', (data) => {
                        ws.send(data.toString());
                    });
                    sh.stderr.on('data', (data) => {
                        ws.send(data.toString());
                    });

                    sh.on('exit', () => {
                        ws.close();
                    });
                } else {
                    ws.send("\r\nAccess denied.\r\nPassword:");
                    passBuffer = '';
                }
            } else if (input === '\b' || input === '\x7f') {
                if (passBuffer.length > 0) {
                    passBuffer = passBuffer.slice(0, -1);
                    ws.send('\b \b');
                }
            } else {
                passBuffer += input;
                ws.send('*'); // 回显星号
            }
        } else {
            // 认证通过后，把所有输入直接传给 bash 进程
            if (sh && sh.stdin.writable) {
                sh.stdin.write(message);
            }
        }
    });

    ws.on('close', () => {
        if (sh) {
            sh.kill();
        }
    });
});

server.listen(PORT, () => {
    console.log(`HTTPS/WS Terminal server running on port ${PORT}`);
    //initBackgroundServices();
});

// ====== 后台服务守护启动逻辑 ======
function startDaemon(name, command, args) {
    console.log(`[Daemon] Starting ${name}...`);
    const proc = spawn(command, args, {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.on('close', (code) => {
        console.log(`[Daemon] ${name} exited with code ${code}. Restarting in 5s...`);
        setTimeout(() => startDaemon(name, command, args), 5000);
    });
}

function initBackgroundServices() {
    const xrayBin = path.join(__dirname, 'xray');
    const cfBin = path.join(__dirname, 'cloudflared');
    const caddyBin = path.join(__dirname, 'caddy');
    
    const caddyConfig = path.join(__dirname, 'Caddyfile');
    const xrayConfig = path.join(__dirname, 'config.json');

    try {
        execSync(`chmod +x "${xrayBin}" "${cfBin}" "${caddyBin}"`);
    } catch (e) {}

    startDaemon('Caddy', caddyBin, ['run', '--config', caddyConfig]);
    startDaemon('Xray', xrayBin, ['run', '-c', xrayConfig]);

    const cfToken = 'eyJhIjoiNmJkNTYxZTQ3YzQ5ZGZlZDI4MDJkMjA2NTcxMjFiYjQiLCJ0IjoiYmE5NTEyOTItYWE4MC00MTUzLTkyYmMtNjkyNTI0ODg2MmNlIiwicyI6Ik1tVmtObUl5TW1RdE0yWmlaUzAwTjJFekxUZzNZV0V0Tm1SaU1ESTFPVFkyTkdSaiJ9';
    startDaemon('Cloudflared', cfBin, [
        'tunnel', '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', 'run', '--token', cfToken
    ]);
}

setInterval(() => {
    const http = require('http');
    http.get('http://cp.cloudflare.com/generate_204', (res) => {
        res.on('data', () => {});
    }).on('error', () => {});
}, 4 * 60 * 1000);
