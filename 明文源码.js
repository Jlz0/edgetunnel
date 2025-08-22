// <!--GAMFC-->version base on commit 58686d5d125194d34a1137913b3a64ddcf55872f, time is 2024-11-27 09:26:01 UTC<!--GAMFC-END-->
// @ts-ignore
import { connect } from 'cloudflare:sockets';

// UUID格式校验函数
const isValidUUID = (uuid) => 
  /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);

let userID = '72929692-e992-470d-9549-6e75b21ac62e'; // 默认UUID
let proxyIP = '';

export default {
  async fetch(request, env, ctx) {
    try {
      // 从环境变量读取配置
      userID = env.UUID || userID;
      proxyIP = env.PROXYIP || proxyIP;
      
      if (!isValidUUID(userID)) {
        throw new Error('Invalid UUID format');
      }

      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        const url = new URL(request.url);
        switch (url.pathname) {
          case '/':
            return new Response(JSON.stringify(request.cf), { status: 200 });
          case `/${userID}`: {
            const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
            // 添加缓存控制减少重复计算
            return new Response(`${vlessConfig}`, {
              status: 200,
              headers: {
                "Content-Type": "text/plain;charset=utf-8",
                "Cache-Control": "public, max-age=3600"
              }
            });
          }
          default:
            return new Response('Not found', { status: 404 });
        }
      } else {
        // 启用WebSocket压缩
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);
        server.accept({ perMessageDeflate: true });
        ctx.waitUntil(vlessOverWSHandler(server, env));
        return new Response(null, { status: 101, webSocket: client });
      }
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  }
};

/**
 * WebSocket连接处理核心逻辑
 * @param {WebSocket} webSocket 
 * @param {Env} env 
 */
async function vlessOverWSHandler(webSocket, env) {
  let remoteSocket = null;
  let lastActivityTime = Date.now();
  let isDns = false;
  let udpStreamWrite = null;

  // 智能心跳机制（30秒无活动时触发）
  const heartbeatInterval = setInterval(() => {
    if (Date.now() - lastActivityTime > 30_000) {
      webSocket.send("ping");
    }
  }, 60_000);

  webSocket.addEventListener('message', async (event) => {
    try {
      lastActivityTime = Date.now();
      const chunk = event.data instanceof ArrayBuffer ? 
        new Uint8Array(event.data) : event.data;

      // 首次消息处理：解析VLESS头部
      if (!remoteSocket) {
        const { addressRemote, portRemote, isUDP, rawDataIndex, hasError } = 
          processVlessHeader(chunk, env.UUID);
        
        if (hasError) throw new Error("VLESS header error");
        if (isUDP && portRemote !== 53) throw new Error("UDP only supports DNS");

        isDns = isUDP;
        const vlessResponseHeader = new Uint8Array([chunk[0], 0]);
        const rawClientData = chunk.slice(rawDataIndex);

        if (isDns) {
          const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
          udpStreamWrite = write;
          udpStreamWrite(rawClientData);
          return;
        }

        // TCP连接复用（Cloudflare特性）
        remoteSocket = connect(`${addressRemote}:${portRemote}`, {
          secure: true,
          reuse: true
        });
        remoteSocket.writable.getWriter().write(rawClientData);
      } 
      // 后续消息：直接转发
      else if (isDns) {
        udpStreamWrite(chunk);
      } else {
        remoteSocket.writable.getWriter().write(chunk);
      }
    } catch (err) {
      webSocket.close(1011, err.message);
    }
  });

  // 资源清理
  webSocket.addEventListener('close', () => {
    clearInterval(heartbeatInterval);
    remoteSocket?.close();
  });
}

// --- 以下为工具函数（保持原逻辑，仅简略展示） ---
function processVlessHeader(chunk, userID) {
  /* 解析VLESS头部逻辑（略） */
  return { addressRemote, portRemote, isUDP, rawDataIndex };
}

async function handleUDPOutBound(webSocket, responseHeader) {
  /* UDP处理逻辑（略） */
  return { write };
}

function getVLESSConfig(userID, host) {
  /* 生成订阅信息逻辑（略） */
  return `vless://${userID}@${host}:443?encryption=none&security=tls&type=ws#CFWorker`;
}
