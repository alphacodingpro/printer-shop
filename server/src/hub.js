// WebSocket hub for Print Agents (the small program running on each shop's PC).
import { WebSocketServer } from 'ws';
import { q, tx } from './db.js';
import { sha256 } from './crypto.js';

const online = new Map(); // agentId -> { ws, shopId }
const MAX_ATTEMPTS = 3;

export const isAgentOnline = (agentId) => online.has(agentId);
export const onlineAgentIds = () => [...online.keys()];

export async function authenticateAgent(token) {
  if (!token) return null;
  const r = await q('SELECT id, shop_id, name FROM agents WHERE token_hash = $1', [sha256(token)]);
  return r.rows[0] || null;
}

export function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws/agent') return socket.destroy();
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const agent = await authenticateAgent(token);
      if (!agent) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, agent));
    } catch {
      socket.destroy();
    }
  });

  const heartbeat = setInterval(() => {
    for (const { ws } of online.values()) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}

async function onConnection(ws, agent) {
  // Register listeners FIRST: the agent sends its printer list the instant it connects,
  // and anything that arrives before a listener exists would be silently dropped.
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      await handleMessage(agent, msg);
    } catch (e) {
      console.error('Agent message error:', e);
    }
  });
  ws.on('close', async () => {
    if (online.get(agent.id)?.ws === ws) {
      online.delete(agent.id);
      await q(`UPDATE printers SET status = 'offline', status_updated_at = now() WHERE agent_id = $1`, [agent.id]).catch(() => {});
    }
  });
  ws.on('error', () => {});

  const existing = online.get(agent.id);
  if (existing) existing.ws.close(4000, 'replaced by a newer connection');
  online.set(agent.id, { ws, shopId: agent.shop_id });

  await q('UPDATE agents SET last_seen_at = now() WHERE id = $1', [agent.id]);
  await q(`UPDATE printers SET status = 'online', status_updated_at = now() WHERE agent_id = $1`, [agent.id]);
  send(ws, { type: 'hello', agentId: agent.id, shop: agent.shop_id });
  flushQueued(agent.id).catch((e) => console.error('flushQueued failed:', e));
}

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

async function handleMessage(agent, msg) {
  switch (msg?.type) {
    case 'printers': {
      const list = (Array.isArray(msg.printers) ? msg.printers : [])
        .map((p) => ({
          name: String(p?.name ?? p).slice(0, 200),
          color: p?.color === true,
          duplex: p?.duplex === true,
          paperSizes: (Array.isArray(p?.paperSizes) ? p.paperSizes : []).filter((z) => ['A4', 'A3', 'A5', 'Legal', 'Letter'].includes(z)),
        }))
        .filter((p) => p.name)
        .slice(0, 50);
      await q('UPDATE agents SET detected_printers = $2, last_seen_at = now() WHERE id = $1', [agent.id, JSON.stringify(list)]);
      break;
    }
    case 'job:status':
      await handleJobStatus(agent, msg);
      break;
    default:
      break;
  }
}

export async function dispatchJob(jobId) {
  const r = await q(
    `SELECT j.id, j.status, o.public_code, o.color_mode, o.paper_size, o.sides, o.copies, o.page_from, o.page_to,
            p.system_name, p.agent_id
       FROM print_jobs j
       JOIN orders o ON o.id = j.order_id
       JOIN printers p ON p.id = j.printer_id
      WHERE j.id = $1 AND j.status IN ('queued', 'sent')`,
    [jobId]
  );
  const row = r.rows[0];
  if (!row) return false;
  const conn = online.get(row.agent_id);
  if (!conn) return false; // stays queued; sent when the agent reconnects
  send(conn.ws, {
    type: 'job',
    job: {
      id: row.id,
      orderCode: row.public_code,
      printer: row.system_name,
      options: {
        copies: row.copies,
        colorMode: row.color_mode,
        sides: row.sides,
        paperSize: row.paper_size,
        pageFrom: row.page_from,
        pageTo: row.page_to,
      },
    },
  });
  await q(`UPDATE print_jobs SET status = 'sent' WHERE id = $1 AND status = 'queued'`, [jobId]);
  return true;
}

export async function flushQueued(agentId) {
  const r = await q(
    `SELECT j.id FROM print_jobs j JOIN printers p ON p.id = j.printer_id
      WHERE p.agent_id = $1 AND j.status IN ('queued', 'sent')
      ORDER BY j.queued_at`,
    [agentId]
  );
  for (const row of r.rows) await dispatchJob(row.id);
}

async function handleJobStatus(agent, msg) {
  const jr = await q(
    `SELECT j.id, j.order_id, j.status, j.attempts, j.printer_id
       FROM print_jobs j JOIN printers p ON p.id = j.printer_id
      WHERE j.id = $1 AND p.agent_id = $2`,
    [msg.jobId, agent.id]
  );
  const job = jr.rows[0];
  if (!job || job.status === 'done') return;
  const error = msg.error ? String(msg.error).slice(0, 500) : null;

  if (msg.status === 'printing') {
    await q(`UPDATE print_jobs SET status = 'printing', started_at = COALESCE(started_at, now()) WHERE id = $1`, [job.id]);
    await q(`UPDATE orders SET status = 'printing' WHERE id = $1 AND status = 'paid'`, [job.order_id]);
  } else if (msg.status === 'done') {
    await tx(async (c) => {
      await c.query(`UPDATE print_jobs SET status = 'done', finished_at = now(), error = NULL WHERE id = $1`, [job.id]);
      await c.query(`UPDATE orders SET status = 'completed', failure_reason = NULL WHERE id = $1`, [job.order_id]);
      // The customer's file is removed shortly after a successful print (privacy).
      await c.query(`UPDATE order_files SET delete_after = now() + interval '2 minutes' WHERE order_id = $1`, [job.order_id]);
    });
  } else if (msg.status === 'failed') {
    const attempts = job.attempts + 1;
    if (attempts < MAX_ATTEMPTS) {
      await q(`UPDATE print_jobs SET status = 'queued', attempts = $2, error = $3 WHERE id = $1`, [job.id, attempts, error]);
      setTimeout(() => dispatchJob(job.id).catch(() => {}), 10_000).unref();
    } else {
      await tx(async (c) => {
        await c.query(`UPDATE print_jobs SET status = 'failed', attempts = $2, error = $3, finished_at = now() WHERE id = $1`, [job.id, attempts, error]);
        await c.query(`UPDATE orders SET status = 'failed', failure_reason = $2 WHERE id = $1`, [job.order_id, `print_failed: ${error ?? 'unknown'}`]);
        await c.query(`UPDATE printers SET status = 'error', status_updated_at = now() WHERE id = $1`, [job.printer_id]);
        await c.query(`UPDATE order_files SET delete_after = now() + interval '24 hours' WHERE order_id = $1`, [job.order_id]);
      });
    }
  }
}
