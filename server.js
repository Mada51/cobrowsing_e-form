// server.js
// npm i playwright ws express
// npm i playwright ws express dotenv
// node server.js
//   - 고객:   http://localhost:3000/
//   - 상담사: http://localhost:3000/agent
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { chromium } = require('playwright');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 고객용 — 디폴트 정적 라우트
app.use(express.static('public'));

// 상담사용 — 명시적 라우트
app.get('/agent', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'agent.html'));
});

const PROFILES = {
  pc: {
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    userAgent: undefined,
    isMobile: false,
    hasTouch: false,
  },
  mobile: {
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  }
};

const TICK_MS = 100;
const JPEG_QUALITY = 80;
//const INITIAL_URL = 'https://www.eformsign.com/eform/document/m_external_view_service.html?company_id=30ec999b3d6b4f9986c65c5073c7ef50&outsider_token_id=cd84469b15bf4303b34da6f9da4e0e78&isMobileAuth=false&document_id=45d15e2b2a53448b88c7bae922b49cdd&country_code=kr&viewerLang=ko';
const INITIAL_URL = process.env.INITIAL_URL || 'https://example.com/replace-with-your-form-url';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--force-device-scale-factor=2',
      '--high-dpi-support=1',
    ]
  });

  const session = {
    context: null, page: null, cdp: null,
    profileName: null, profile: null,
    latestFrame: null, lastSessionId: null,
    customerJoined: false,         // 첫 고객 합류 여부
    customerDevice: null,          // 합류한 고객의 device 기록
  };

  async function applyProfile(profileName) {
    const profile = PROFILES[profileName];
    if (!profile) throw new Error('unknown profile: ' + profileName);
    console.log(`[profile] switching to "${profileName}"`);

    if (session.cdp) {
      try { await session.cdp.send('Page.stopScreencast'); } catch (e) {}
      try { await session.cdp.detach(); } catch (e) {}
    }
    if (session.context) {
      try { await session.context.close(); } catch (e) {}
    }

    const context = await browser.newContext({
      viewport: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
      userAgent: profile.userAgent,
      isMobile: profile.isMobile,
      hasTouch: profile.hasTouch,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });

    const page = await context.newPage();
    await page.goto(INITIAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch((e) => console.error('initial nav error:', e.message));

    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');
    session.latestFrame = null;
    session.lastSessionId = null;
    cdp.on('Page.screencastFrame', (params) => {
      session.latestFrame = params.data;
      session.lastSessionId = params.sessionId;
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: JPEG_QUALITY, everyNthFrame: 1,
    });

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        broadcast({ type: 'url', url: frame.url() });
      }
    });

    session.context = context;
    session.page = page;
    session.cdp = cdp;
    session.profileName = profileName;
    session.profile = profile;

    broadcast({
      type: 'profile', name: profileName,
      viewportWidth: profile.viewport.width,
      viewportHeight: profile.viewport.height,
      bitmapWidth: profile.viewport.width * profile.deviceScaleFactor,
      bitmapHeight: profile.viewport.height * profile.deviceScaleFactor,
    });
  }

  function broadcast(obj) {
    const msg = JSON.stringify(obj);
    wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    });
  }

  // 초기 — viewer 대기용 PC 컨텍스트
  await applyProfile('pc');

  wss.on('connection', (ws) => {
    console.log(`client connected (total: ${wss.clients.size})`);

    if (session.profile) {
      ws.send(JSON.stringify({
        type: 'profile', name: session.profileName,
        viewportWidth: session.profile.viewport.width,
        viewportHeight: session.profile.viewport.height,
        bitmapWidth: session.profile.viewport.width * session.profile.deviceScaleFactor,
        bitmapHeight: session.profile.viewport.height * session.profile.deviceScaleFactor,
      }));
    }
    if (session.page) {
      ws.send(JSON.stringify({ type: 'url', url: session.page.url() }));
    }

    const timer = setInterval(async () => {
      if (!session.profile || ws.readyState !== WebSocket.OPEN) return;
      const p = session.profile;
      if (session.latestFrame) {
        ws.send(JSON.stringify({
          type: 'frame', data: session.latestFrame,
          width: p.viewport.width * p.deviceScaleFactor,
          height: p.viewport.height * p.deviceScaleFactor,
          viewportWidth: p.viewport.width,
          viewportHeight: p.viewport.height,
        }));
        if (session.lastSessionId !== null && session.cdp) {
          try {
            await session.cdp.send('Page.screencastFrameAck', { sessionId: session.lastSessionId });
          } catch (e) {}
        }
      }
    }, TICK_MS);

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const page = session.page;

        switch (msg.type) {
          case 'hello': {
            const role = msg.role === 'agent' ? 'agent' : 'customer';
            const device = msg.device === 'mobile' ? 'mobile' : 'pc';
            ws.role = role;
            ws.device = device;

            console.log(`[hello] role=${role}, device=${device}, w=${msg.innerWidth}, current=${session.profileName}, customerJoined=${session.customerJoined}`);

            if (role === 'customer') {
              if (!session.customerJoined) {
                // 첫 고객 합류 — 컨텍스트 결정
                session.customerJoined = true;
                session.customerDevice = device;
                if (device !== session.profileName) {
                  await applyProfile(device);
                } else {
                  console.log('[hello] customer joined, profile already matches');
                }
              } else if (device !== session.customerDevice) {
                // 고객 device 불일치 — 경고만, 컨텍스트는 보존
                console.warn(`[hello] customer device mismatch (was ${session.customerDevice}, now ${device}) - keeping existing session`);
                ws.send(JSON.stringify({
                  type: 'warning',
                  message: `이미 ${session.customerDevice} 디바이스로 시작된 세션입니다.`,
                }));
              } else {
                // 같은 고객 재연결 — 정상
                console.log('[hello] customer reconnected, profile preserved');
              }
            } else {
              // agent — 컨텍스트 안 건드림
              console.log('[hello] agent joined as viewer');
            }
            break;
          }
          case 'navigate':
            if (!page) break;
            try {
              const url = msg.url.startsWith('http') ? msg.url : `https://${msg.url}`;
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch (e) {
              ws.send(JSON.stringify({ type: 'error', message: e.message }));
            }
            break;
          case 'click':    if (page) await page.mouse.click(msg.x, msg.y); break;
          case 'mousemove':if (page) await page.mouse.move(msg.x, msg.y); break;
          case 'scroll':   if (page) await page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0); break;
          case 'key':      if (page) await page.keyboard.press(msg.key); break;
          case 'type':     if (page) await page.keyboard.type(msg.text, { delay: 10 }); break;
          case 'back':     if (page) await page.goBack(); break;
          case 'forward':  if (page) await page.goForward(); break;
          case 'reload':   if (page) await page.reload(); break;
        }
      } catch (err) {
        console.error('msg error:', err);
      }
    });

    ws.on('close', () => {
      clearInterval(timer);
      console.log(`client disconnected (role=${ws.role || 'unknown'}, total: ${wss.clients.size - 1})`);
    });
  });

  server.listen(3000, () => {
    console.log('Co-browsing server running:');
    console.log('  Customer: http://localhost:3000/');
    console.log('  Agent:    http://localhost:3000/agent');
  });
})();