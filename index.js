const net = require('net');
const { spawn, execSync } = require('child_process');
const path = require('path');

const PORT = process.env.SERVER_PORT || 16895;
const PASSWORD = 'mysecret.#';

const server = net.createServer((socket) => {
    let authenticated = false;
    let passBuffer = ''; // 用于暂存逐字输入的密码

    socket.setKeepAlive(true, 30000);

    // 定义一个复位并要求输入密码的函数
    function promptPassword() {
        authenticated = false;
        socket.write("Password:");
    }

    // 初次连接，显示提示
    promptPassword();

    // 提取密码验证逻辑为独立函数，方便循环使用
    function handleAuth(data) {
      if (!authenticated) {
        const input = data.toString();
        if (input.includes('\r') || input.includes('\n')) {
            socket.write('\r\n'); // 在终端里换行
            if ( passBuffer === PASSWORD) {
                authenticated = true;
                socket.write("Access Granted. Welcome to the container shell!\r\n");
                
                // 召唤 Python PTY 伪终端
                const sh = spawn('python3', ['-c', 'import pty; pty.spawn("/bin/bash")']);
                
                sh.stdout.pipe(socket);
                sh.stderr.pipe(socket);
                
                // 移除密码监听，将你的后续键盘输入交给 bash
                socket.removeListener('data', handleAuth);
                socket.pipe(sh.stdin);

                // 当你在终端里输入 exit 退出时
                sh.on('exit', () => {
                    // 1. 解除数据流绑定
                    socket.unpipe(sh.stdin);
                    // 2. 重新挂载密码验证监听器
                    socket.on('data', handleAuth);
                    // 3. 再次弹出密码提示
                    promptPassword();
                });
            } else {
                // 密码错误时不直接断开，而是继续要求输入
                
                socket.write("Access denied.\r\nPassword:");
                
                passBuffer = ''; // 密码错误，清空缓存以便重新输入
            }
          
        }// 处理退格键 (Backspace)，支持输错时删除
        else if (input === '\b' || input === '\x7f') {
            if (passBuffer.length > 0) {
                passBuffer = passBuffer.slice(0, -1);
                // 在终端上实现退格视觉效果：光标左移，打空格覆盖星号，再左移
                socket.write('\b \b');
            }
        } 
        // 正常的字母输入
        else {
            passBuffer += input;
            // 回显一个星号保护隐私，并且让你知道自己按下了按键
            socket.write('*'); 
        }
        
      }    
    }

    // 为这个连接绑定初始的密码监听
    socket.on('data', handleAuth);
    
    // 捕获可能出现的意外网络断开错误，防止程序崩溃
    socket.on('error', () => {});
});

server.listen(PORT, () => {
    console.log(`Shell server running on port ${PORT}`);
    // 主服务启动后，拉起三个后台服务
    initBackgroundServices();
});
// ====== 后台服务守护启动逻辑 ======
function startDaemon(name, command, args) {
    console.log(`[Daemon] Starting ${name}...`);
    
    const proc = spawn(command, args, {
        // 关键：强制将子进程的工作目录锁定为 index.js 所在的目录
        cwd: __dirname,
        // 如果不想在面板控制台看到大量日志刷屏，可以改为 stdio: 'ignore'
        stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.on('data', (data) => {
        // 如需查看具体输出，可取消下面这行的注释
        // console.log(`[${name}] ${data.toString().trim()}`);
    });

    proc.stderr.on('data', (data) => {
        // Xray 和 Cloudflared 的常规运行日志有时也会输出到 stderr
        // console.error(`[${name} LOG] ${data.toString().trim()}`);
    });

    proc.on('error', (err) => {
        console.error(`[Daemon] Failed to start ${name}: ${err.message}`);
    });

    // 进程意外退出时，等待 5 秒后自动重启
    proc.on('close', (code) => {
        console.log(`[Daemon] ${name} exited with code ${code}. Restarting in 5s...`);
        setTimeout(() => startDaemon(name, command, args), 5000);
    });
}

function initBackgroundServices() {
    // 使用 path.join(__dirname, '文件名') 转换成绝对路径，100% 指向 index.js 同级目录
    const xrayBin = path.join(__dirname, 'xray');
    const cfBin = path.join(__dirname, 'cloudflared');
    const caddyBin = path.join(__dirname, 'caddy');
    
    const caddyConfig = path.join(__dirname, 'Caddyfile');
    const xrayConfig = path.join(__dirname, 'config.json');

    // 1. 确保三个二进制文件拥有可执行权限（防止 Permission denied 报错）
    try {
        execSync(`chmod +x "${xrayBin}" "${cfBin}" "${caddyBin}"`);
    } catch (e) {
        console.warn('[Daemon] chmod warning (ignore if paths differ):', e.message);
    }

    // 2. 启动 Caddy (假设你的配置文件叫 Caddyfile 且在当前目录)
    startDaemon('Caddy', caddyBin , ['run', '--config', caddyConfig ]);

    // 3. 启动 Xray (假设你的配置文件叫 config.json 且在当前目录)
    startDaemon('Xray', xrayBin , ['run', '-c', xrayConfig ]);

    // 4. 启动 Cloudflared 
    // 【重要】结合你上一个问题：Wispbyte 容器不支持 IPv6，而 cloudflared 默认可能会尝试用 IPv6 或 QUIC 连接边缘节点导致报错。
    // 因此强烈建议加上 '--edge-ip-version', '4' 和 '--protocol', 'http2' 参数！
    const cfToken = 'eyJhIjoiNmJkNTYxZTQ3YzQ5ZGZlZDI4MDJkMjA2NTcxMjFiYjQiLCJ0IjoiYmE5NTEyOTItYWE4MC00MTUzLTkyYmMtNjkyNTI0ODg2MmNlIiwicyI6Ik1tVmtObUl5TW1RdE0yWmlaUzAwTjJFekxUZzNZV0V0Tm1SaU1ESTFPVFkyTkdSaiJ9';
    startDaemon('Cloudflared', cfBin , [
        'tunnel', 
        '--no-autoupdate', 
        '--edge-ip-version', '4', 
        '--protocol', 'http2',
        'run', 
        '--token', cfToken
    ]);
}
// ====== 内部网络心跳保活机制（加在这里最合适） ======
setInterval(() => {
    const http = require('http');
    
    // 向外部可靠的轻量地址发起一次 HTTP 请求
    http.get('http://cp.cloudflare.com/generate_204', (res) => {
        // 收到响应后直接丢弃数据，仅产生网络流量
        res.on('data', () => {});
    }).on('error', () => {
        // 忽略所有网络波动错误，防止主程序崩溃
    });

}, 4 * 60 * 1000); // 设定为每 4 分钟执行一次