const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

require('dotenv').config();

const PORT = process.env.PORT || 14484;
const PASSWORD = process.env.PASSWORD || 'mysecret.#';
const cfToken = process.env.CF_TOKEN || '';

// 优先使用环境变量 HOME，其次 os.homedir()，最后兜底 /tmp
const WORK_DIR = process.env.HOME || os.homedir() || '/tmp';
const BINARIES = ['caddy', 'xray', 'cloudflared'];

// 确保可写工作目录存在
if (!fs.existsSync(WORK_DIR)) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
}

// 1. 创建 HTTP 服务，托管基于 xterm.js 的网页终端界面
const server = http.createServer((req, res) => {
    // 专门给 UptimeRobot 用的防缓存监控接口
    if (req.url === '/ping') {
        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end('active:' + Date.now());
        return;
    }

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

                    function sendMsg(obj) {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify(obj));
                        }
                    }

                    function syncSize() {
                        fitAddon.fit();
                        sendMsg({ type: 'resize', cols: term.cols, rows: term.rows });
                    }

                    let pingTimer = null;

                    ws.onopen = () => {
                        syncSize();
                        pingTimer = setInterval(() => sendMsg({ type: 'ping' }), 20000);
                    };

                    ws.onmessage = (event) => {
                        if (event.data !== '\\x00') {
                            term.write(event.data);
                        }
                    };

                    ws.onclose = () => {
                        if (pingTimer) clearInterval(pingTimer);
                        term.write('\\r\\n\\x1b[31m[Connection closed]\\x1b[0m\\r\\n');
                    };

                    term.onData((data) => {
                        sendMsg({ type: 'input', data });
                    });

                    let resizeTimer = null;
                    window.addEventListener('resize', () => {
                        clearTimeout(resizeTimer);
                        resizeTimer = setTimeout(syncSize, 100);
                    });
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
    let shell = null;
    let termSize = { cols: 80, rows: 30 };

    const heartbeatInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            ws.ping();
            ws.send('\x00');
        } else {
            clearInterval(heartbeatInterval);
        }
    }, 20000);

    ws.send('Password: ');

    ws.on('message', (rawMessage) => {
        let msg;
        try {
            msg = JSON.parse(rawMessage.toString());
        } catch {
            // 兼容非 JSON 的纯文本客户端
            msg = { type: 'input', data: rawMessage.toString() };
        }

        if (msg.type === 'ping') return;

        if (msg.type === 'resize') {
            const cols = Math.max(1, parseInt(msg.cols, 10) || 80);
            const rows = Math.max(1, parseInt(msg.rows, 10) || 30);
            termSize = { cols, rows };
            if (shell) {
                try { shell.resize(cols, rows); } catch (_) {}
            }
            return;
        }

        if (msg.type !== 'input' || typeof msg.data !== 'string') return;
        const input = msg.data;

        // 未认证阶段：处理密码输入
        if (!authenticated) {
            if (input.includes('\r') || input.includes('\n')) {
                if (passBuffer === PASSWORD) {
                    authenticated = true;
                    passBuffer = '';
                    ws.send('\r\nAccess Granted. Welcome to the container shell!\r\n\r\n');

                    shell = pty.spawn('/bin/sh', ['-l'], {
                        name: 'xterm-256color',
                        cols: termSize.cols,
                        rows: termSize.rows,
                        cwd: WORK_DIR,
                        env: { ...process.env, HOME: WORK_DIR, TERM: 'xterm-256color' }
                    });

                    shell.onData((data) => {
                        if (ws.readyState === ws.OPEN) {
                            ws.send(data);
                        }
                    });

                    shell.onExit(() => {
                        if (ws.readyState === ws.OPEN) {
                            ws.close();
                        }
                    });
                } else {
                    ws.send('\r\nAccess denied.\r\nPassword: ');
                    passBuffer = '';
                }
            } else if (input === '\b' || input === '\x7f') {
                if (passBuffer.length > 0) {
                    passBuffer = passBuffer.slice(0, -1);
                    ws.send('\b \b');
                }
            } else if (input >= ' ') {
                passBuffer += input;
                ws.send('*'.repeat(input.length));
            }
            return;
        }

        // 已认证阶段：转发输入给 PTY
        if (shell) {
            shell.write(input === '\b' ? '\x7f' : input);
        }
    });

    ws.on('close', () => {
        clearInterval(heartbeatInterval);
        if (shell) {
            shell.kill();
            shell = null;
        }
    });
});

// 3. 初始化并解压二进制文件到可写目录
function initAndExtractBinaries() {
    const markerFile = path.join(WORK_DIR, '.extracted');
    const profilePath = path.join(WORK_DIR, '.profile');

    try {
        if (!fs.existsSync(profilePath)) {
            fs.writeFileSync(profilePath, 'alias ls="ls --color"\n', 'utf8');
            console.log('[Init] Prepared .profile in', WORK_DIR);
        }
    } catch (err) {
        console.error('[Init] Failed to prepare .profile:', err.message);
    }

    if (fs.existsSync(markerFile)) {
        console.log('[Init] Binaries already extracted in', WORK_DIR);
        return;
    }

    const archivePath = path.join(WORK_DIR, 'binaries.tar.gz');
    const downloadUrl = 'https://w0.cone.pp.ua/binary_x64.tar.gz';

    let downloader = 'none';
    try {
        downloader = execSync(
            'command -v curl >/dev/null 2>&1 && echo "curl" || (command -v wget >/dev/null 2>&1 && echo "wget" || echo "none")'
        ).toString().trim();
        console.log(`[Init] Detected downloader: ${downloader}`);
    } catch (err) {
        console.error('[Init] Failed to detect downloader:', err.message);
        return;
    }

    if (downloader === 'none') {
        console.error('[Init] Neither curl nor wget is available.');
        return;
    }

    try {
        console.log('[Init] Downloading binaries archive...');
        const downloadCmd = downloader === 'curl'
            ? `curl -fsSL -o "${archivePath}" "${downloadUrl}"`
            : `wget -q -O "${archivePath}" "${downloadUrl}"`;

        execSync(downloadCmd, { stdio: 'inherit' });

        console.log('[Init] Extracting archive to', WORK_DIR);
        execSync(`tar -xzf "${archivePath}" -C "${WORK_DIR}"`, { stdio: 'inherit' });

        console.log('[Init] Setting executable permissions...');
        for (const name of BINARIES) {
            const binPath = path.join(WORK_DIR, name);
            if (fs.existsSync(binPath)) {
                fs.chmodSync(binPath, 0o755);
            }
        }

        fs.writeFileSync(markerFile, 'done');
        console.log('[Init] Binaries ready!');
    } catch (err) {
        console.error('[Init] Failed to setup binaries:', err.message);
    } finally {
        if (fs.existsSync(archivePath)) {
            try { fs.unlinkSync(archivePath); } catch (_) {}
        }
    }
}

// 4. 后台守护服务
function startDaemon(name, command, args, extraEnv = {}) {
    if (!fs.existsSync(command)) {
        console.error(`[Daemon] Binary not found for ${name}: ${command}`);
        return;
    }

    console.log(`[Daemon] Starting ${name}...`);
    let proc;
    try {
        proc = spawn(command, args, {
            cwd: WORK_DIR,
            // 确保 Caddy/Xray 等进程的数据和缓存目录都落在可写的 WORK_DIR
            env: {
                ...process.env,
                HOME: WORK_DIR,
                XDG_DATA_HOME: path.join(WORK_DIR, '.local', 'share'),
                XDG_CONFIG_HOME: path.join(WORK_DIR, '.config'),
                ...extraEnv
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (err) {
        console.error(`[Daemon] Failed to start ${name}: ${err.message}`);
        return;
    }

    proc.on('error', (err) => {
        console.error(`[Daemon] Process error for ${name}: ${err.message}`);
    });

    if (proc.stderr) {
        proc.stderr.on('data', (data) => {
            console.error(`[${name} Error] ${data.toString().trim()}`);
        });
    }

    proc.on('close', (code) => {
        console.log(`[Daemon] ${name} exited with code ${code}.`);
    });
}

function initBackgroundServices() {
    const caddyBin = path.join(WORK_DIR, 'caddy');
    const xrayBin = path.join(WORK_DIR, 'xray');
    const cfBin = path.join(WORK_DIR, 'cloudflared');

    // 直接指向 /app（即 __dirname）下从 GitHub 同步的只读配置
    const caddyConfig = path.join(__dirname, 'Caddyfile');
    const xrayConfig = path.join(__dirname, 'config.json');

    startDaemon('Caddy', caddyBin, ['run', '--config', caddyConfig]);
    startDaemon('Xray', xrayBin, ['run', '-c', xrayConfig]);

    if (cfToken) {
        // 通过 TUNNEL_TOKEN 环境变量传递，命令行不再暴露明文
        startDaemon(
            'Cloudflared',
            cfBin,
            [
                'tunnel', '--no-autoupdate', '--edge-ip-version', '4',
                '--loglevel', 'error', '--protocol', 'http2', 'run'
            ],
            { TUNNEL_TOKEN: cfToken }
        );
    } else {
        console.log('[Daemon] CF_TOKEN is empty, skipping Cloudflared.');
    }
}

// 5. 启动服务与定时保活
server.listen(PORT, () => {
    console.log(`HTTPS/WS Terminal server running on port ${PORT} (WORK_DIR: ${WORK_DIR})`);
    initAndExtractBinaries();
    initBackgroundServices();
});

setInterval(() => {
    http.get('http://cp.cloudflare.com/generate_204', (res) => {
        res.on('data', () => {});
    }).on('error', () => {});
}, 4 * 60 * 1000);
