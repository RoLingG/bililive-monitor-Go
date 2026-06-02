import './style.css';

import {StartListening, StopListening, GetVideoInfo} from '../wailsjs/go/main/App';
import {EventsOn, EventsOffAll} from '../wailsjs/runtime/runtime';

// 模式管理
let currentMode = 'normal';
const MAX_ITEMS = 200;

// 两套独立数据存储（始终保留，不清空）
const normalScData  = [];
const vodScData     = [];
const guardData     = [];
const giftData      = [];

// BV 号匹配正则
const bvRegex = /bv[a-z0-9]+/i;
const avRegex = /av[a-z0-9]+/i;

// 视频信息缓存（key: bvid, value: {title, cover, tags}）
const videoInfoCache = {};

// 从消息中提取 BV/AV 号
function extractBvId(message) {
    const m = (message || '').match(bvRegex) || (message || '').match(avRegex);
    return m ? m[0] : null;
}

// 获取视频信息（带前端缓存）
async function fetchVideoInfo(bvid) {
    if (videoInfoCache[bvid]) return videoInfoCache[bvid];
    try {
        const info = await GetVideoInfo(bvid);
        if (info && !info.error) {
            videoInfoCache[bvid] = info;
            return info;
        }
    } catch (e) {
        console.error('获取视频信息失败:', e);
    }
    return null;
}

function switchMode(mode) {
    if (currentMode === mode) return;
    currentMode = mode;

    // 更新两个界面的按钮状态
    document.querySelectorAll('.mode-btn, .mode-btn-sm').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    document.getElementById('modeHint').style.display = mode === 'vod' ? 'block' : 'none';

    // 如果已在监听面板，实时切换显示
    if (document.getElementById('monitorScreen').classList.contains('active')) {
        renderCurrentMode();
    }
}

window.switchMode = switchMode;

// 屏幕切换
function showMonitor() {
    document.getElementById('setupScreen').classList.remove('active');
    document.getElementById('monitorScreen').classList.add('active');

    const layout = document.querySelector('.monitor-layout');
    if (currentMode === 'vod') {
        layout.classList.add('vod-mode');
    }

    // 用已有数据渲染当前模式
    renderCurrentMode();
}

// 启动按钮
async function handleStart() {
    const roomId = document.getElementById('inputRoomId').value.trim();
    const cookie = document.getElementById('inputCookie').value.trim();
    const errEl  = document.getElementById('setupError');
    const btn    = document.getElementById('btnStart');

    if (!roomId) { showError(errEl, '请输入直播间号'); return; }
    if (!/^\d+$/.test(roomId)) { showError(errEl, '直播间号只能包含数字'); return; }
    if (!cookie) { showError(errEl, '请输入 Cookie'); return; }

    errEl.classList.remove('show');
    btn.disabled = true;
    btn.textContent = '建 立 连 接 ...';

    try {
        await StartListening(roomId, cookie);
        showMonitor();
    } catch (e) {
        errEl.textContent = e || '连接失败，请检查输入';
        errEl.classList.add('show');
        btn.disabled = false;
        btn.textContent = '启 动 监 听';
    }
}

function showError(el, msg) {
    el.textContent = msg;
    el.classList.add('show');
}

// 回车触发启动
document.getElementById('inputRoomId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleStart();
});

// 暴露到 window 供 onclick="handleStart()" 使用
window.handleStart = handleStart;

// 断开连接，回到配置页
async function handleDisconnect() {
    await StopListening();
    // 重置数据
    normalScData.length = 0;
    vodScData.length = 0;
    guardData.length = 0;
    giftData.length = 0;
    // 回到配置页
    document.getElementById('monitorScreen').classList.remove('active');
    document.getElementById('setupScreen').classList.add('active');
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStart').textContent = '启 动 监 听';
    // 重置模式
    currentMode = 'normal';
    document.querySelectorAll('.mode-btn, .mode-btn-sm').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === 'normal');
    });
    document.getElementById('modeHint').style.display = 'none';
    document.querySelector('.monitor-layout').classList.remove('vod-mode');
}
window.handleDisconnect = handleDisconnect;

// 语音播报设置
const voiceSettings = {
    sc: true,
    guard: true,
    readMsg: true,
};

// 从 localStorage 恢复语音设置
function restoreVoiceSettings() {
    const saved = localStorage.getItem('bili_voice');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            Object.assign(voiceSettings, parsed);
        } catch {}
    }
    updateVoiceButtons();
}

function saveVoiceSettings() {
    localStorage.setItem('bili_voice', JSON.stringify(voiceSettings));
}

function updateVoiceButtons() {
    const scBtn = document.getElementById('toggleScVoice');
    const guardBtn = document.getElementById('toggleGuardVoice');
    const readMsgBtn = document.getElementById('toggleReadMsg');
    if (scBtn) scBtn.classList.toggle('active', voiceSettings.sc);
    if (guardBtn) guardBtn.classList.toggle('active', voiceSettings.guard);
    if (readMsgBtn) readMsgBtn.classList.toggle('active', voiceSettings.readMsg);
}

function toggleVoice(type) {
    voiceSettings[type] = !voiceSettings[type];
    saveVoiceSettings();
    updateVoiceButtons();
}
window.toggleVoice = toggleVoice;

// TTS 语音播报
function speak(text) {
    if (!text) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 1.0;
    u.volume = 0.6;
    speechSynthesis.speak(u);
}

// 构建 SC 播报文案
function buildScText(sc) {
    const parts = [`感谢${sc.uname || '未知用户'}发送了${sc.price}元醒目留言`];
    if (voiceSettings.readMsg && sc.message) {
        parts.push(`${sc.message}`);
    }
    return parts.join('，');
}

// 构建上舰播报文案
function buildGuardText(guard) {
    const label = guardLabel(guard.guardLevel);
    return `感谢${guard.username || '未知用户'}上的${label}`;
}

restoreVoiceSettings();

// 本地存储：记住上次输入的 roomId 和 Cookie
function restoreSavedInputs() {
    const savedRoom = localStorage.getItem('bili_roomId');
    const savedCookie = localStorage.getItem('bili_cookie');
    if (savedRoom) document.getElementById('inputRoomId').value = savedRoom;
    if (savedCookie) document.getElementById('inputCookie').value = savedCookie;
}

function saveInputs() {
    localStorage.setItem('bili_roomId', document.getElementById('inputRoomId').value);
    localStorage.setItem('bili_cookie', document.getElementById('inputCookie').value);
}

document.getElementById('inputRoomId').addEventListener('input', saveInputs);
document.getElementById('inputCookie').addEventListener('input', saveInputs);
restoreSavedInputs();

// 事件监听（先 Off 再 On，防止 HMR 重复注册）
EventsOffAll(); // 清除所有旧监听器，防止 HMR 导致重复注册

EventsOn('superchat', (data) => {
    try {
        const sc = JSON.parse(data);
        const isBv = bvRegex.test(sc.message || '');
        const isAv = avRegex.test(sc.message || '');

        // 语音播报
        if (voiceSettings.sc) {
            speak(buildScText(sc));
        }

        // 始终存入正常模式数据
        normalScData.unshift(sc);
        if (normalScData.length > MAX_ITEMS) normalScData.pop();

        // 如果含 BV 号，同时存入点播模式数据
        if (isBv) {
            vodScData.unshift(sc);
            if (vodScData.length > MAX_ITEMS) vodScData.pop();
        } else if (isAv) {
            vodScData.unshift(sc);
            if (vodScData.length > MAX_ITEMS) vodScData.pop();
        }

        // 根据当前模式决定是否渲染到 DOM
        if (currentMode === 'normal') {
            appendScCard(sc);
        } else if (isBv || isAv) {
            appendScCard(sc);
            // 异步获取视频信息，获取后更新卡片
            const bvid = extractBvId(sc.message);
            if (bvid) {
                fetchVideoInfo(bvid).then(info => {
                    if (info) {
                        sc.videoInfo = info;
                        // 重新渲染点播列表以显示视频信息
                        if (currentMode === 'vod') {
                            renderScList(vodScData);
                        }
                    }
                });
            }
        }

    } catch (e) {
        console.error('解析 SC 数据失败:', e);
    }
});

EventsOn('guard', (data) => {
    try {
        const guard = JSON.parse(data);
        guardData.unshift(guard);
        if (guardData.length > MAX_ITEMS) guardData.pop();

        // 语音播报
        if (voiceSettings.guard) {
            speak(buildGuardText(guard));
        }

        if (currentMode === 'normal') {
            appendGuardCard(guard);
        }
    } catch (e) {
        console.error('解析上舰数据失败:', e);
    }
});

EventsOn('gift', (data) => {
    try {
        const gift = JSON.parse(data);
        giftData.unshift(gift);
        if (giftData.length > MAX_ITEMS) giftData.pop();

        if (currentMode === 'normal') {
            appendGiftCard(gift);
        }
    } catch (e) {
        console.error('解析礼物数据失败:', e);
    }
});

EventsOn('gift-combo-update', (data) => {
    try {
        updateGiftCombo(JSON.parse(data));
    } catch (e) {
        console.error('解析连击数据失败:', e);
    }
});

EventsOn('connection-status', (data) => {
    try {
        updateConnectionStatus(data);
    } catch (e) {
        console.error('连接状态更新失败:', e);
    }
});

EventsOn('live-status', (data) => {
    try {
        updateLiveStatus(data.live);
    } catch (e) {
        console.error('开播状态更新失败:', e);
    }
});

EventsOn('room-info', (data) => {
    try {
        updateRoomInfo(data.roomId);
    } catch (e) {
        console.error('房间信息更新失败:', e);
    }
});

// 模式渲染：切换模式时重新渲染整个列表（带淡入淡出）
function renderCurrentMode() {
    const layout = document.querySelector('.monitor-layout');
    const lists = [
        document.getElementById('scList'),
        document.getElementById('guardList'),
        document.getElementById('giftList'),
    ];

    // 淡出
    lists.forEach(el => el.classList.add('list-fade-out'));

    setTimeout(() => {
        if (currentMode === 'vod') {
            layout.classList.add('vod-mode');
            renderScList(vodScData);
        } else {
            layout.classList.remove('vod-mode');
            renderScList(normalScData);
            renderGuardList();
            renderGiftList();
        }

        // 淡入
        lists.forEach(el => el.classList.remove('list-fade-out'));
    }, 260);
}

function renderScList(data) {
    const list = document.getElementById('scList');
    list.innerHTML = '';
    const filtered = searchQuery
        ? data.filter(sc => (sc.uname || '').toLowerCase().includes(searchQuery) || (sc.message || '').toLowerCase().includes(searchQuery))
        : data;
    if (filtered.length === 0) {
        list.innerHTML = searchQuery
            ? '<div class="empty"><div class="empty-symbol">⊘</div><div class="empty-text">无匹配结果…</div></div>'
            : '<div class="empty"><div class="empty-symbol">⊕</div><div class="empty-text">等待醒目留言…</div></div>';
        return;
    }
    for (const sc of filtered) {
        const card = createScCard(sc);
        card.classList.add('no-anim');
        list.appendChild(card);
    }
}

function renderGuardList() {
    const list = document.getElementById('guardList');
    list.innerHTML = '';
    if (guardData.length === 0) {
        list.innerHTML = '<div class="empty"><div class="empty-symbol">⚓</div><div class="empty-text">等待上舰…</div></div>';
        return;
    }
    for (const guard of guardData) {
        list.appendChild(createGuardCard(guard));
    }
}

function renderGiftList() {
    const list = document.getElementById('giftList');
    list.innerHTML = '';
    if (giftData.length === 0) {
        list.innerHTML = '<div class="empty"><div class="empty-symbol">🎁</div><div class="empty-text">等待礼物…</div></div>';
        return;
    }
    for (const gift of giftData) {
        list.appendChild(createGiftCard(gift));
    }
}

// 辅助函数
function formatPrice(price) {
    if (price == null) return '—';
    if (price >= 10000) return (price / 10000).toFixed(2) + ' 万';
    if (price % 1 !== 0) return price.toFixed(1);
    return price + '';
}

function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 将文本中的 BV/AV 号转为可点击链接
function linkifyBv(text) {
    return text.replace(bvRegex, (match) => {
        const href = 'https://www.bilibili.com/video/' + match;
        return `<a href="${href}" target="_blank" rel="noopener" style="color:var(--teal);text-decoration:underline;cursor:pointer;">${match}</a>`;
    }).replace(avRegex, (match) => {
        const href = 'https://www.bilibili.com/video/' + match;
        return `<a href="${href}" target="_blank" rel="noopener" style="color:var(--teal);text-decoration:underline;cursor:pointer;">${match}</a>`;
    });
}

function guardLabel(level) {
    if (level === 1) return '总督';
    if (level === 2) return '提督';
    if (level === 3) return '舰长';
    return '';
}

// SC 档位背景色
function priceTier(price) {
    if (price >= 2000) return '#7a1515';
    if (price >= 1000) return '#cc2020';
    if (price >= 500)  return '#b07a18';
    if (price >= 100)  return '#8a6d1a';
    if (price >= 50)   return '#2a4a60';
    return '#1a2e4a';
}

// 渲染 SC 卡片
function createScCard(sc) {
    const card = document.createElement('div');
    card.className = 'sc-card';

    const tierColor = priceTier(sc.price);

    if (sc.backgroundImage) {
        card.classList.add('has-bg');
        card.style.backgroundImage = `url(${sc.backgroundImage})`;
        card.style.backgroundColor = tierColor;
    } else {
        card.style.backgroundColor = tierColor;
    }

    const nofaceUrl = 'https://i0.hdslb.com/bfs/face/member/noface.jpg';
    const faceUrl = sc.face || nofaceUrl;
    const priceText = formatPrice(sc.price);
    const unameHtml = escapeHtml(sc.uname || '未知用户');
    const guardText = guardLabel(sc.guardLevel);
    const guardHtml = guardText ? `<span class="sc-guard guard-${sc.guardLevel}">${guardText}</span>` : '';
    const medalHtml = (sc.medalName && sc.medalLevel != null)
        ? `<span class="sc-medal">${escapeHtml(sc.medalName)} Lv.${sc.medalLevel}</span>` : '';

    // 点播模式：视频信息区域
    let videoHtml = '';
    if (currentMode === 'vod' && sc.videoInfo) {
        const vi = sc.videoInfo;
        const vTitle = escapeHtml(vi.title || '');
        const vDesc = escapeHtml(vi.desc|| '');
        const vCover = vi.cover ? `/cover?url=${encodeURIComponent(vi.cover)}` : '';
        const vLink = extractBvId(sc.message);
        const vLinkHref = vLink ? `https://www.bilibili.com/video/${vLink}` : '';
        let tagsHtml = '';
        if (vi.tags && vi.tags.length > 0) {
            tagsHtml = `<div class="vod-tags">${vi.tags.slice(0, 6).map(t => `<span class="vod-tag">${escapeHtml(t)}</span>`).join('')}</div>`;
        }
        videoHtml = `
            <div class="vod-video-info">
                ${vCover ? `<img class="vod-cover" src="${vCover}" onerror="this.style.display='none'" />` : ''}
                <div class="vod-detail">
                    ${vTitle ? `<a class="vod-title" href="${vLinkHref}" target="_blank" rel="noopener">${vTitle}</a>` : ''}
                    ${vDesc ? `<div class="vod-desc">${vDesc}</div>` : ''}
                    ${tagsHtml}
                </div>
            </div>
        `;
    }

    card.innerHTML = `
        <div class="sc-content">
            <div class="sc-header">
                <img class="sc-avatar"
                     src="/avatar?url=${encodeURIComponent(faceUrl)}"
                     onerror="this.onerror=null;this.src='/avatar?url=${encodeURIComponent('https://i0.hdslb.com/bfs/face/member/noface.jpg')}'" />
                <div class="sc-user-meta">
                    <div class="sc-uname-row">
                        <span class="sc-uname">${unameHtml}</span>
                        ${guardHtml}
                    </div>
                    ${medalHtml}
                </div>
                <span class="sc-price" style="color:#c9a227">¥${priceText}</span>
            </div>
            ${videoHtml}
            <div class="sc-divider">◇ ◆ ◇</div>
            <div class="sc-message">${currentMode === 'vod' ? linkifyBv(escapeHtml(sc.message || '')) : escapeHtml(sc.message || '')}</div>
            <div class="sc-footer">${formatTime(sc.startTime)}</div>
        </div>
    `;
    return card;
}

function appendScCard(sc) {
    const list = document.getElementById('scList');
    if (list.children.length === 1 && list.children[0].querySelector('.empty')) {
        list.innerHTML = '';
    }
    list.insertBefore(createScCard(sc), list.firstChild);
    while (list.children.length > MAX_ITEMS) {
        list.removeChild(list.lastChild);
    }
}

// 渲染上舰卡片
function createGuardCard(guard) {
    const card = document.createElement('div');
    card.className = 'guard-card';

    const unameHtml = escapeHtml(guard.username || '未知用户');
    const label     = guardLabel(guard.guardLevel);
    const priceText = formatPrice(guard.price / 1000);

    card.innerHTML = `
        <div class="guard-content">
            <span class="guard-label guard-${guard.guardLevel}">${label}</span>
            <span class="guard-user">${unameHtml}</span>
            <span class="guard-price">¥${priceText}</span>
        </div>
    `;
    return card;
}

function appendGuardCard(guard) {
    const list = document.getElementById('guardList');
    if (list.children.length === 1 && list.children[0].querySelector('.empty')) {
        list.innerHTML = '';
    }
    list.insertBefore(createGuardCard(guard), list.firstChild);
    while (list.children.length > MAX_ITEMS) {
        list.removeChild(list.lastChild);
    }
}

// 渲染礼物卡片
function createGiftCard(gift) {
    const card = document.createElement('div');
    card.className = 'gift-card';
    card.dataset.comboId = gift.comboId;

    const unameHtml = escapeHtml(gift.uname || '未知用户');
    const faceUrl = (gift.face || '').replace(/^http:\/\//, 'https://');

    card.innerHTML = `
        <div class="gift-content">
            <img class="gift-avatar"
                 src="/avatar?url=${encodeURIComponent(faceUrl)}"
                 onerror="this.onerror=null;this.src='/avatar?url=${encodeURIComponent('https://i0.hdslb.com/bfs/face/member/noface.jpg')}'" />
            <span class="gift-uname">${unameHtml}</span>
            <span class="gift-detail">
                <span class="gift-name">${escapeHtml(gift.giftName)}</span>
                <span class="gift-count">×${gift.num}</span>
            </span>
            <span class="gift-price">¥${formatPrice(gift.totalCoin / 1000)}</span>
        </div>
    `;
    return card;
}

function appendGiftCard(gift) {
    const list = document.getElementById('giftList');
    if (list.children.length === 1 && list.children[0].querySelector('.empty')) {
        list.innerHTML = '';
    }
    list.insertBefore(createGiftCard(gift), list.firstChild);
    while (list.children.length > MAX_ITEMS) {
        list.removeChild(list.lastChild);
    }
}

// 礼物连击更新（同用户同礼物递增）
function updateGiftCombo(comboData) {
    const list = document.getElementById('giftList');
    const card = list.querySelector(`.gift-card[data-combo-id="${comboData.comboId}"]`);
    if (!card) return;

    const countEl = card.querySelector('.gift-count');
    if (countEl) {
        countEl.textContent = '×' + comboData.num;
        countEl.classList.remove('combo-bump');
        void countEl.offsetWidth;
        countEl.classList.add('combo-bump');
    }
}

// 连接状态更新
function updateConnectionStatus(info) {
    const el = document.getElementById('connectionStatus');
    if (!el) return;

    el.classList.remove('status-connected', 'status-error', 'status-disconnected', 'status-reconnecting');
    if (info.status === 'connected') {
        el.textContent = '● 已连接';
        el.classList.add('status-connected');
    } else if (info.status === 'error') {
        el.textContent = '● 连接失败';
        el.classList.add('status-error');
    } else if (info.status === 'reconnecting') {
        el.textContent = '● 重连中…';
        el.classList.add('status-reconnecting');
    } else {
        el.textContent = '● 未连接';
        el.classList.add('status-disconnected');
    }
}

// 开播状态更新
function updateLiveStatus(isLive) {
    const el = document.getElementById('scCount');
    if (!el) return;

    el.classList.remove('status-live', 'status-offline');
    if (isLive) {
        el.textContent = 'LIVE';
        el.classList.add('status-live');
    } else {
        el.textContent = 'OFFLINE';
        el.classList.add('status-offline');
    }
}

// 房间信息更新
function updateRoomInfo(roomId) {
    const el = document.getElementById('roomInfo');
    if (!el) return;
    el.textContent = '房间 ' + roomId;
}

// 数据导出
function exportData(type) {
    let data, filename;
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    if (type === 'sc') {
        data = normalScData.map(sc => ({
            time: formatTime(sc.startTime),
            user: sc.uname,
            price: sc.price,
            message: sc.message,
            face: sc.face || '',
            medal: sc.medalName ? sc.medalName + ' Lv.' + sc.medalLevel : '',
        }));
        filename = `sc-${ts}.json`;
    } else if (type === 'guard') {
        data = guardData.map(g => ({
            time: formatTime(g.startTime),
            user: g.username,
            level: guardLabel(g.guardLevel),
            price: g.price / 100,
            gift: g.giftName,
        }));
        filename = `guard-${ts}.json`;
    } else if (type === 'gift') {
        data = giftData.map(g => ({
            user: g.uname,
            gift: g.giftName,
            num: g.num,
            price: g.totalCoin / 1000,
            comboId: g.comboId,
            face: g.face || '',
        }));
        filename = `gift-${ts}.json`;
    }
    if (!data || data.length === 0) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
window.exportData = exportData;

// 数据导入
function importData(type) {
    const input = document.getElementById('import' + type.charAt(0).toUpperCase() + type.slice(1));
    if (input) input.click();
}
window.importData = importData;

function handleImportFile(type) {
    const input = document.getElementById('import' + type.charAt(0).toUpperCase() + type.slice(1));
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const data = JSON.parse(String(e.target.result));
            if (!Array.isArray(data) || data.length === 0) return;

            let added = 0;

            if (type === 'sc') {
                for (const item of data) {
                    const isDup = normalScData.some(sc =>
                        (sc.uname || sc.user) === item.user
                        && sc.message === item.message
                        && sc.price === item.price
                        && formatTime(sc.startTime) === item.time
                    );
                    if (isDup) continue;

                    const sc = {
                        price: item.price,
                        uname: item.user,
                        message: item.message,
                        startTime: 0,
                        face: item.face || '',
                        guardLevel: 0,
                        medalName: item.medal ? item.medal.split(' Lv.')[0] : '',
                        medalLevel: item.medal ? parseInt(item.medal.split(' Lv.')[1]) || 0 : 0,
                    };
                    normalScData.unshift(sc);
                    if (normalScData.length > MAX_ITEMS) normalScData.pop();

                    const isBv = bvRegex.test(sc.message || '');
                    const isAv = avRegex.test(sc.message || '');
                    if (isBv || isAv) {
                        vodScData.unshift(sc);
                        if (vodScData.length > MAX_ITEMS) vodScData.pop();
                    }
                    added++;
                }
            } else if (type === 'guard') {
                for (const item of data) {
                    const isDup = guardData.some(g =>
                        g.username === item.user
                        && g.giftName === item.gift
                        && g.price / 100 === item.price
                        && formatTime(g.startTime) === item.time
                    );
                    if (isDup) continue;

                    guardData.unshift({
                        username: item.user,
                        guardLevel: item.level === '总督' ? 1 : item.level === '提督' ? 2 : 3,
                        price: item.price * 100,
                        giftName: item.gift,
                        startTime: 0,
                    });
                    if (guardData.length > MAX_ITEMS) guardData.pop();
                    added++;
                }
            } else if (type === 'gift') {
                for (const item of data) {
                    const isDup = giftData.some(g =>
                        g.uname === item.user
                        && g.giftName === item.gift
                        && g.num === item.num
                        && g.totalCoin / 1000 === item.price
                    );
                    if (isDup) continue;

                    giftData.unshift({
                        comboId: item.comboId || '',
                        uname: item.user,
                        giftName: item.gift,
                        num: item.num,
                        totalCoin: item.price * 1000,
                        face: item.face || '',
                    });
                    if (giftData.length > MAX_ITEMS) giftData.pop();
                    added++;
                }
            }

            renderCurrentMode();
            if (added > 0) {
                alert('导入成功，新增 ' + added + ' 条记录');
            } else {
                alert('没有新数据（可能已全部导入过）');
            }
        } catch (err) {
            alert('导入失败：文件格式不正确');
        }
    };
    reader.readAsText(file);
    input.value = '';
}
window.handleImportFile = handleImportFile;

// SC 搜索
let searchQuery = '';
function handleSearch(e) {
    searchQuery = e.target.value.trim().toLowerCase();
    renderScList(currentMode === 'vod' ? vodScData : normalScData);
}
window.handleSearch = handleSearch;

// 临时测试：模拟含 BV 号的 SC，测试点播模式视频信息展示
// 使用前先切换到点播模式，再调用 testVodSc()
window.testVodSc = async function () {
    const list = document.getElementById('scList');
    list.innerHTML = '';
    vodScData.length = 0;

    const tests = [
        { price: 30,  uname: '测试用户A', message: '大家帮忙点播 BV1NMLH6GEBd 感谢！', face: '' },
        { price: 100, uname: '测试用户B', message: '这首好听 BV1BM9fB8Eds 送给大家', face: '' },
        { price: 500, uname: '测试用户C', message: '点歌 BV1oPdABkEw8 谢谢主播！', face: '' },
        { price: 30, uname: '测试用户D', message: '点歌 BV1q7Gd6HEuD 谢谢主播！', face: '' },
    ];

    for (const t of tests) {
        const sc = {
            price: t.price,
            uname: t.uname,
            message: t.message,
            face: t.face,
            startTime: Math.floor(Date.now() / 1000),
            guardLevel: 0,
            medalName: '',
            medalLevel: 0,
            backgroundImage: '',
            backgroundColor: '',
            messageFontColor: '',
        };
        vodScData.unshift(sc);

        // 异步获取视频信息
        const bvid = extractBvId(sc.message);
        if (bvid) {
            fetchVideoInfo(bvid).then(info => {
                if (info) sc.videoInfo = info;
                renderScList(vodScData);
            });
        }
    }

    // 先渲染一次（无视频信息），等 fetch 回来后会自动重新渲染
    renderScList(vodScData);
};