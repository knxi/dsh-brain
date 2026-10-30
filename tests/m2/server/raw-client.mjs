// @ts-check
/**
 * 裸 socket HTTP 客户端（攻击回归专用）。
 *
 * 为什么不直接用 `fetch`：浏览器/undici 会替我们规范化 Host、拒绝伪造的
 * `Content-Length`、把跨站 Origin 换成它认为合理的值。§22.4 第 6 类要测的恰恰是
 * 「攻击者能在原始 HTTP 上做到什么」，所以这里手写 HTTP/1.1 请求。
 *
 * 本文件不是测试（`.mjs` 而非 `.test.mjs`），`node --test "tests/**\/*.test.mjs"` 不会跑它。
 *
 * 设计要点：
 * - 支持三种请求体发送方式：Content-Length 自报 / **chunked**（不自报长度）/
 *   显式谎报 Content-Length（测 HTTP 层会不会被绕过）；
 * - `stopAfterBytes`：chunked 模式下只发到指定字节数就停（不发终止块）。用来测
 *   「服务端读到超限立刻拒绝」，而不是等客户端把 body 发完；
 * - 服务端提前拒绝并关闭连接时，客户端继续写会得到 EPIPE/ECONNRESET ——
 *   这不是测试失败，是**预期现象**，统一记进 `writeError` 而不是 reject；
 * - `timedOut` 明确区分「被拒」和「挂住」：超时挂住才是真问题。
 */

import net from 'node:net';

/**
 * @typedef {Object} RawResponse
 * @property {number} status HTTP 状态码（解析失败为 0）
 * @property {string} head 响应头原文
 * @property {string} body 响应体原文
 * @property {string} raw 完整响应原文
 * @property {boolean} timedOut 是否超时（true = 连接被挂住，测试应判失败）
 * @property {string|null} writeError 客户端写失败原因（EPIPE 等，属预期）
 * @property {'end'|'close'|'error'|'timeout'} endedBy 连接是怎么结束的
 */

/**
 * 发一个原始 HTTP/1.1 请求。
 *
 * @param {{
 *   port: number,
 *   pathname?: string,
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: string | Buffer,
 *   chunked?: boolean,
 *   chunkSize?: number,
 *   stopAfterBytes?: number,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<RawResponse>}
 */
export function rawRequest(opts) {
  const {
    port,
    pathname = '/',
    method = 'GET',
    headers = {},
    body = '',
    chunked = false,
    chunkSize = 8 * 1024,
    stopAfterBytes,
    timeoutMs = 5_000,
  } = opts;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  /** chunked 模式下实际发送的字节数（有 stopAfterBytes 时可能小于 payload 长度）。 */
  const sendBytes = chunked && typeof stopAfterBytes === 'number'
    ? Math.min(payload.length, Math.max(0, stopAfterBytes))
    : payload.length;

  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');

    let buffer = '';
    let settled = false;
    let timedOut = false;
    /** @type {string|null} */
    let writeError = null;

    /** @param {'end'|'close'|'error'|'timeout'} endedBy */
    const finish = (endedBy) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* 已断 */
      }
      const split = buffer.indexOf('\r\n\r\n');
      const head = split === -1 ? buffer : buffer.slice(0, split);
      const bodyText = split === -1 ? '' : buffer.slice(split + 4);
      const statusLine = head.split('\r\n')[0] ?? '';
      const status = Number(statusLine.split(' ')[1] ?? 0);
      resolve({
        status,
        head,
        body: bodyText,
        raw: buffer,
        timedOut,
        writeError,
        endedBy,
      });
    };

    socket.setTimeout(timeoutMs, () => {
      timedOut = true;
      finish('timeout');
    });

    socket.on('connect', () => {
      /** @type {Record<string, string>} 头名按大小写不敏感去重 */
      const merged = { Host: `127.0.0.1:${port}`, Connection: 'close', ...headers };
      const lowerKeys = new Set(Object.keys(merged).map((key) => key.toLowerCase()));
      if (chunked) {
        // 显式置 chunked：即使调用方给了 Content-Length 也以 TE 为准（真实攻击者会这么干）。
        for (const key of Object.keys(merged)) {
          if (key.toLowerCase() === 'content-length') delete merged[key];
        }
        merged['Transfer-Encoding'] = 'chunked';
      } else if (payload.length > 0 && !lowerKeys.has('content-length')) {
        merged['Content-Length'] = String(payload.length);
      }

      const lines = [`${method} ${pathname} HTTP/1.1`];
      for (const [key, value] of Object.entries(merged)) lines.push(`${key}: ${value}`);
      try {
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      } catch (error) {
        writeError = String(/** @type {any} */ (error)?.code ?? error);
        finish('error');
        return;
      }

      if (payload.length === 0) return;

      if (!chunked) {
        try {
          socket.write(payload);
        } catch (error) {
          writeError = String(/** @type {any} */ (error)?.code ?? error);
        }
        return;
      }

      // chunked：分块灌入，模拟流式上传（攻击者可以用它绕开 Content-Length 预检）。
      let offset = 0;
      const pump = () => {
        if (settled) return;
        if (offset >= sendBytes) {
          // 有 stopAfterBytes 时不发终止块：故意留一个半截请求，验证服务端
          // 靠「已读字节数」而不是「请求是否结束」来判断超限。
          if (sendBytes >= payload.length) {
            try {
              socket.write('0\r\n\r\n');
            } catch (error) {
              writeError = String(/** @type {any} */ (error)?.code ?? error);
            }
          }
          return;
        }
        const slice = payload.subarray(offset, Math.min(offset + chunkSize, sendBytes));
        offset += slice.length;
        try {
          socket.write(`${slice.length.toString(16)}\r\n`);
          socket.write(slice);
          socket.write('\r\n');
        } catch (error) {
          writeError = String(/** @type {any} */ (error)?.code ?? error);
          return;
        }
        setImmediate(pump);
      };
      pump();
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
    });
    socket.on('end', () => finish('end'));
    socket.on('close', () => finish('close'));
    socket.on('error', (error) => {
      // 服务端 413/500 之后主动断开 → 客户端还在写就 EPIPE。记录后收工。
      writeError = String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error);
      finish('error');
    });
  });
}
