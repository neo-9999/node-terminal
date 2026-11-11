const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');
const { WebSocketServer } = require('ws');
//for download files.
const fs = require('fs');
const pty = require('node-pty');

require('dotenv').config();
const PORT = process.env.PORT || 14484;
const PASSWORD = process.env.PASSWORD ||'mysecret.#';
const cfToken = process.env.CF_TOKEN || '' ;


// 1. 创建 HTTP 服务，托管基于 xterm.js 的网页终端界面
const server = http.createServer((req, res) => {
// 新增：专门给 UptimeRobot 用的防缓存监控接口
    if (req.url === '/ping') {
        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        // 返回带有当前时间戳的动态内容，确保每次响应都不一样
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

                    // 自动适配 HTTPS 对应的 wss:// 协议
                    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const ws = new WebSocket(\`\${protocol}//\${location.host}\`);
                    
//                    ws.onopen = () => {
//                        setInterval(() => {
//                            if (ws.readyState === 1) { // 1 代表 WebSocket.OPEN
//                                ws.send('\\x00'); 
//                            }
//                        }, 20000);
//                    };
                    
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
    
    const heartbeatInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            ws.ping();       // 照顾标准 WebSocket 协议
            ws.send('\x00'); // 照顾霸道的 CDN 缓存
        } else {
            clearInterval(heartbeatInterval);
        }
    }, 20000);
    
    ws.send("Password:");

    ws.on('message', (message) => {
        const input = message.toString();
        if (input === '\x00') return;  //ignore keep alive msg
        
        if (!authenticated) {
            if (input.includes('\r') || input.includes('\n')) {
                if (passBuffer === PASSWORD) {
                    authenticated = true;
                    ws.send("\r\nAccess Granted. Welcome to the container shell!\r\n\r\n");
                    
                  
                    // 使用系统自带的 /bin/sh（Alpine 默认自带，绝对不需要安装 Python）
                  
                    shell = pty.spawn('/bin/sh', ['-l'], {
                        name: 'xterm-color',
                        cols: 80,
                        rows: 30,
                        cwd: __dirname ,
                        env: process.env
                    });

                    
                    // 实时将 shell 输出返回给网页
                    shell.onData((data) => {
                        ws.send(data);
                    });
                    
                    ws.on('message', (msg) => {
                        if ( shell ) {
                          let input = msg.toString();
                          if (input === '\x7f' || input === '\b') shell.write('\x7f');
                          else shell.write(msg);
                        }
                     });


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
        } 
    });

    ws.on('close', () => {
        if (heartbeatInterval ){
            clearInterval(heartbeatInterval);
        }
        if (shell) {
            shell.kill();
        }
    });
});

server.listen(PORT, () => {
    console.log(`HTTPS/WS Terminal server running on port ${PORT}`);
    initAndExtractBinaries();
    initBackgroundServices();
});

function initAndExtractBinaries() {
    const binDir = __dirname;
    const markerFile = path.join(binDir, '.extracted'); // 用一个标记文件防止每次重启重复下载


    const profilePath = path.join( __dirname, '.profile');
    try {
        fs.writeFileSync(profilePath, 'alias ls="ls --color"\n' , 'utf8');
        console.log('[Init] Successed to prepare .profile ');
    } catch (err) {
        console.error('[Init] Failed to prepare .profile:', err.message);
    }
    
    // 如果已经解压过了，直接跳过
    if (fs.existsSync(markerFile)) {
        console.log('[Init] Binaries already extracted.');
        return;
    }

    const archivePath = path.join(binDir, 'binaries.tar.gz');
    const downloadUrl = 'https://w0.cone.pp.ua/binary_x64.tar.gz';
    
    let downloader = 'none';
    try {
       downloader = execSync(
            'command -v curl >/dev/null 2>&1 && echo "curl" || (command -v wget >/dev/null 2>&1 && echo "wget" || echo "none")'
        ).toString().trim();
        console.log(`[Init] Detected downloader tool: ${downloader}`);
    } catch (err) {
        console.error('[Init] Failed to detect downloader:', err.message);
    }
    
    try {
        console.log('[Init] Downloading binaries archive...');
        if (downloader === 'curl') {
            console.log( `curl -o "${archivePath}" "${downloadUrl}` );
            execSync(`curl -o "${archivePath}" "${downloadUrl}"`, { stdio: 'inherit' });
        }
        else if (downloader === 'wget') {
            console.log( `wget -O "${archivePath}" "${downloadUrl}"` );
            execSync(`wget -O "${archivePath}" "${downloadUrl}"`, { stdio: 'inherit' });
        }
        
        
        if (fs.existsSync(archivePath)) {
            console.log('[Init] Extracting archive...');
              // 2. 用系统自带的 tar 解压到当前目录
            execSync(`tar -xzf "${archivePath}" -C "${binDir}"`, { stdio: 'inherit' });

            console.log('[Init] Setting executable permissions...');
            // 3. 赋予所有二进制文件可执行权限
            execSync(`chmod +x "${path.join(binDir, 'caddy')}" "${path.join(binDir, 'xray')}" "${path.join(binDir, 'cloudflared')}"`);

            // 4. 清理掉压缩包以节省容器空间
            console.log('[Init] Flush downloaded file ...');
            fs.unlinkSync(archivePath);

            // 5. 创建标记文件
            fs.writeFileSync(markerFile, 'done');
            console.log('[Init] Binaries ready!');
         }
         else {
            console.error('[Init] Failed to setup binaries: Can not find archived binary files');
         } 

    } catch (err) {
        console.error('[Init] Failed to setup binaries:', err.message);
    }
}

// ====== Background Services ======
function startDaemon(name, command, args) {
    console.log(`[Daemon] Starting ${name}...`);
    let proc;
    try {
        proc = spawn(command, args, {
          cwd: __dirname,
          stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (err) {
        console.error(`[Daemon] Failed to start ${name} synchronously: ${err.message}. Restarting in 5s...`);
        //setTimeout(() => startDaemon(name, command, args), 5000);
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
        console.log(`[Daemon] ${name} exited with code ${code}. Restarting in 5s...`);
        //setTimeout(() => startDaemon(name, command, args), 5000);
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

    
    
    startDaemon('Cloudflared', cfBin, [
        'tunnel', '--no-autoupdate', '--edge-ip-version', '4', '--loglevel' , 'error' , '--protocol', 'http2', 'run', '--token', cfToken
    ]);
}

setInterval(() => {
    const http = require('http');
    http.get('http://cp.cloudflare.com/generate_204', (res) => {
        res.on('data', () => {});
    }).on('error', () => {});
}, 4 * 60 * 1000);

