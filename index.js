const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.SERVER_PORT || 14484;
const PASSWORD = 'mysecret.#';

// 1. 创建 HTTP 服务，托管基于 xterm.js 的网页终端界面
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

                    // 自动适配 HTTPS 对应的 wss:// 协议
                    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const ws = new WebSocket(\`\${protocol}//\${location.host}\`);

                    ws.onmessage = (event) => {
                        term.write(event.data);
                    };

                    term.onKey(({ key, domEvent }) => {
                        let ev = domEvent;
                        let printable = !ev.altKey && !ev.ctrlKey && !ev.metaKey;
                        if (ev.keyCode === 13) {
                            ws.send('\\r');
                        } else if (ev.keyCode === 8) {
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
    let cmdBuffer = '';
    let shell = null;
    let heartbeatInterval = null ;

    ws.send("Password:");

    ws.on('message', (message) => {
        const input = message.toString();

        if (!authenticated) {
            if (input.includes('\r') || input.includes('\n')) {
                if (passBuffer === PASSWORD) {
                    authenticated = true;
                    ws.send("\r\nAccess Granted. Welcome to the container shell!\r\n\r\n");

                    const heartbeatInterval = setInterval(() => {
                        if (ws.readyState === ws.OPEN) {
                            ws.ping(); // 发送底层 ping 帧保活
                        } else {
                            clearInterval(heartbeatInterval);
                        }
                    }, 30000);
                    // 使用系统自带的 /bin/sh（Alpine 默认自带，绝对不需要安装 Python）
                    shell = spawn('/bin/sh', [], {
                        cwd: __dirname,
                        env: process.env ,
                        stdio: ['pipe', 'pipe', 'pipe']
                    });

                    // 实时将 shell 输出返回给网页
                    shell.stdout.on('data', (data) => {
                        let text = data.toString().replace(/\r?\n/g, '\r\n');
                        ws.send( text );
                    });


                    shell.stderr.on('data', (data) => {
                        let text = data.toString().replace(/\r?\n/g, '\r\n');
                        ws.send( text );
                     });


                    shell.stdin.write('alias ls="ls --color"; echo -n "# "\n');


                    shell.on('exit', () => {
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
                ws.send('*');
            }
        } else {
            // 认证通过后，将用户输入交个标准 shell
            if (shell && shell.stdin.writable) {
                if (input.includes('\r') || input.includes('\n')) {
                    shell.stdin.write( cmdBuffer + '\n' );
                    ws.send('\r\n');  //local echo
                    cmdBuffer = '';
                    setTimeout(() => {
                      ws.send("# ");
                    }, 100);
                } else if (input === '\b' || input === '\x7f') {
                    if (cmdBuffer.length > 0) {
                      cmdBuffer = cmdBuffer.slice(0, -1);
                      ws.send('\b \b');
                    }
                }else {
                    ws.send( input );  //local echo
                    cmdBuffer += input;
                }
            }
        }
    });

    ws.on('close', () => {
        if ( heartbeatInterval ) {
            clearInterval(heartbeatInterval);
        }
        if (shell) {
            shell.kill();
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
