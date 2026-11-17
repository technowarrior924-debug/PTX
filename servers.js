const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const players = {};
let matchTimeLeft = 600; // 10 minutes in seconds

// 🌍 W.W.P — PERMANENT players list (naam, #ID, PFP, profile).
// Jis ne bhi ek dafa Google se login kiya, wo hamesha list me rahega —
// log out kare ya offline ho, naam nahi jayega. List servers.js ke
// saath wali players.json file me save hoti hai, taake server restart
// par bhi wapis aa jaye. (Render par redeploy se file reset ho jati hai —
// us ke liye database chahiye hota, file sirf localhost ke liye permanent hai.)
const PLAYERS_FILE = path.join(__dirname, 'players.json');
let registeredPlayers = {}; // key -> { key, name, playerId, pfp, email, isGoogle, uid, lastSeen }
function loadRegisteredPlayers() {
    try {
        if (fs.existsSync(PLAYERS_FILE)) {
            const raw = fs.readFileSync(PLAYERS_FILE, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            if (parsed && typeof parsed === 'object') registeredPlayers = parsed;
        }
    } catch (e) { registeredPlayers = {}; }
    console.log(`W.W.P: ${Object.keys(registeredPlayers).length} registered players loaded`);
}
function saveRegisteredPlayers() {
    try { fs.writeFileSync(PLAYERS_FILE, JSON.stringify(registeredPlayers, null, 2), 'utf8'); } catch (e) {}
}
loadRegisteredPlayers();
// Har player ki stable key — Google player ki uid se (naam/ID badle to bhi
// wahi entry), guest ki playerId se (guest ki koi uid nahi hoti).
function playerRegKey(profile, pid) {
    const uid = String((profile && profile.uid) || '').trim();
    if (uid) {
        const clean = uid.replace(/[^A-Za-z0-9_-]/g, '_').substring(0, 64);
        if (profile && profile.isGoogle) return 'g_' + clean;
        return 'guest_' + clean; // guest ka stable browser UID — alag pehchan.
    }
    return 'id_' + pid; // purana client (uid nahi bhejta) — fallback.
}
function isPlayerOnline(regKey) {
    return Object.keys(players).some((id) => players[id] && players[id].regKey === regKey);
}
function isPlayerInGame(regKey) {
    return Object.keys(players).some((id) => players[id] && players[id].regKey === regKey && players[id].inGame === true);
}
function isPlayerReady(regKey) {
    return Object.keys(players).some((id) => players[id] && players[id].regKey === regKey && players[id].ready === true);
}
function publicPlayerList() {
    return Object.keys(registeredPlayers).map((k) => {
        const p = registeredPlayers[k] || {};
        return {
            key: k,
            socketId: '',
            name: p.name || 'Player',
            playerId: p.playerId || '??????',
            pfp: p.pfp || '',
            email: p.email || '',
            isGoogle: !!p.isGoogle,
            online: isPlayerOnline(k),
            lastSeen: p.lastSeen || 0,
            status: p.status || 'active' // 👑 Admin: active | banned | disabled
        };
    });
}
function broadcastPlayersList() {
    io.emit('playersList', publicPlayerList());
}

// 👑 ADMIN (sirf technowarrior924@gmail.com) — W.W.P se Ban/Disable/Gift.
// Admin ki pehchan uske Google email se (client setPlayerProfile me bhejta hai).
const ADMIN_EMAIL = 'technowarrior924@gmail.com';
function isAdminSocket(socket) {
    const p = players[socket.id];
    return !!(p && p.email && String(p.email).trim().toLowerCase() === ADMIN_EMAIL);
}
function findSocketIdByRegKey(regKey) {
    return Object.keys(players).find((id) => players[id] && players[id].regKey === regKey) || null;
}
function kickPlayerSocket(regKey, eventName) {
    const sid = findSocketIdByRegKey(regKey);
    if (!sid) return false;
    try { io.to(sid).emit(eventName, {}); } catch (e) {}
    try {
        const s = io.sockets && io.sockets.sockets ? io.sockets.sockets.get(sid) : null;
        if (s && typeof s.disconnect === 'function') s.disconnect(true);
    } catch (e) {}
    return true;
}
function deliverGiftToPlayer(regKey, gift) {
    // Online ho to foran bhejo, offline ho to pending me save karo
    // (agli login par mil jayega).
    const sid = findSocketIdByRegKey(regKey);
    if (sid) {
        try { io.to(sid).emit('giftReceived', gift); } catch (e) {}
        return 'online';
    }
    const entry = registeredPlayers[regKey];
    if (!entry) return 'notfound';
    if (!Array.isArray(entry.pendingGifts)) entry.pendingGifts = [];
    entry.pendingGifts.push(gift);
    saveRegisteredPlayers();
    return 'pending';
}

// 👥 FRIENDS — player apne #ID se friend request bhejta hai (6 digits).
// Requests + friendships friends.json me save hoti hain (server restart par
// bhi rehti hain). Offline player ko request pending rehti hai — login par
// F.Req me dikh jati hai. Accept → dono friends; Decline → request khatam.
const FRIENDS_FILE = path.join(__dirname, 'friends.json');
let friendsData = { requests: [], friendships: {} }; // requests: [{fromKey,toKey,at}], friendships: {regKey:[regKey]}
function loadFriendsData() {
    try {
        if (fs.existsSync(FRIENDS_FILE)) {
            const raw = fs.readFileSync(FRIENDS_FILE, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            if (parsed && typeof parsed === 'object') {
                if (Array.isArray(parsed.requests)) friendsData.requests = parsed.requests;
                if (parsed.friendships && typeof parsed.friendships === 'object') friendsData.friendships = parsed.friendships;
            }
        }
    } catch (e) { friendsData = { requests: [], friendships: {} }; }
    console.log('Friends file: ' + FRIENDS_FILE);
    console.log(`Friends: ${friendsData.requests.length} pending requests, ${Object.keys(friendsData.friendships).length} players with friends loaded`);
}
function saveFriendsData() {
    // ⚠️ Save fail ho to chup mat raho — warna remove sirf memory me hota hai
    // aur server restart par friend wapas aa jata hai (friends.json purani rehti hai).
    try { fs.writeFileSync(FRIENDS_FILE, JSON.stringify(friendsData, null, 2), 'utf8'); return true; }
    catch (e) { console.error('Friends save FAILED (' + FRIENDS_FILE + '): ' + (e && e.message ? e.message : e)); return false; }
}
loadFriendsData();
function findRegKeyByPlayerId(pid) {
    const id = String(pid || '').replace(/[^0-9]/g, '').substring(0, 6);
    if (!/^[0-9]{6}$/.test(id)) return null;
    const k = Object.keys(registeredPlayers).find((key) => registeredPlayers[key] && registeredPlayers[key].playerId === id);
    return k || null;
}
function publicFriendProfile(regKey) {
    const p = registeredPlayers[regKey] || {};
    return { key: regKey, name: p.name || 'Player', playerId: p.playerId || '??????', pfp: p.pfp || '', online: isPlayerOnline(regKey), inGame: isPlayerInGame(regKey), ready: isPlayerReady(regKey) };
}
// 👥 SHARED LOBBY — ek player ki lobby me khade hone wale members.
// players[sid].lobbyWith = host ki regKey (null = apni khud ki lobby).
function publicLobbyMember(regKey) {
    const p = registeredPlayers[regKey] || {};
    const sid = findSocketIdByRegKey(regKey);
    const live = (sid && players[sid]) || {};
    return { key: regKey, name: p.name || 'Player', playerId: p.playerId || '??????', pfp: p.pfp || '', skin: (typeof live.skin === 'string' ? live.skin : ''), gun1: (live.gun1 === 'vita' ? 'vita' : 'ar9'), ready: (live.ready === true) };
}
function lobbyGroupKeys(hostKey) {
    const keys = [hostKey];
    Object.keys(players).forEach((id) => {
        const p = players[id];
        if (p && p.lobbyWith === hostKey && keys.indexOf(p.regKey) === -1) keys.push(p.regKey);
    });
    return keys;
}
function sendLobbyUpdate(hostKey) {
    // Har member ko uski view bhejo — khud ko chhor kar baaki members.
    const keys = lobbyGroupKeys(hostKey);
    const host = registeredPlayers[hostKey] || {};
    keys.forEach((k) => {
        const sid = findSocketIdByRegKey(k);
        if (!sid) return;
        const members = keys.filter((mk) => mk !== k).map(publicLobbyMember).filter((m) => registeredPlayers[m.key]);
        const youReady = !!(players[sid] && players[sid].ready === true);
        try { io.to(sid).emit('lobbyUpdate', { hostKey, hostName: host.name || 'Player', youAreHost: k === hostKey, youReady, members }); } catch (e) {}
    });
}
function sendEmptyLobbyUpdate(regKey) {
    // Tum akeli apni lobby me ho (group khatam).
    const sid = findSocketIdByRegKey(regKey);
    if (!sid) return;
    const youReady = !!(players[sid] && players[sid].ready === true);
    try { io.to(sid).emit('lobbyUpdate', { hostKey: regKey, hostName: (registeredPlayers[regKey] || {}).name || 'Player', youAreHost: true, youReady, members: [] }); } catch (e) {}
}
function leaveLobbyGroup(regKey) {
    // Player apni lobby group se nikal jaye; agar wo host tha to uski
    // lobby dissolve — baaki members apni khali lobby me wapas.
    const sid = findSocketIdByRegKey(regKey);
    const me = sid ? players[sid] : null;
    if (me) me.ready = false; // group se nikla — ready khatam.
    if (me && me.lobbyWith) {
        const hostKey = me.lobbyWith;
        me.lobbyWith = null;
        sendLobbyUpdate(hostKey);
    }
    const hosted = lobbyGroupKeys(regKey).filter((k) => k !== regKey);
    if (hosted.length) {
        hosted.forEach((k) => {
            const s = findSocketIdByRegKey(k);
            if (s && players[s]) { players[s].lobbyWith = null; players[s].ready = false; }
        });
        hosted.forEach((k) => sendEmptyLobbyUpdate(k));
    }
}
function areFriends(a, b) {
    return Array.isArray(friendsData.friendships[a]) && friendsData.friendships[a].indexOf(b) !== -1;
}
function hasPendingRequest(fromKey, toKey) {
    return friendsData.requests.some((r) => r && r.fromKey === fromKey && r.toKey === toKey);
}
function addFriendship(a, b) {
    if (!Array.isArray(friendsData.friendships[a])) friendsData.friendships[a] = [];
    if (!Array.isArray(friendsData.friendships[b])) friendsData.friendships[b] = [];
    if (friendsData.friendships[a].indexOf(b) === -1) friendsData.friendships[a].push(b);
    if (friendsData.friendships[b].indexOf(a) === -1) friendsData.friendships[b].push(a);
}
function removeFriendship(a, b) {
    if (Array.isArray(friendsData.friendships[a])) friendsData.friendships[a] = friendsData.friendships[a].filter((k) => k !== b);
    if (Array.isArray(friendsData.friendships[b])) friendsData.friendships[b] = friendsData.friendships[b].filter((k) => k !== a);
}
function sendFriendsUpdate(regKey) {
    const sid = findSocketIdByRegKey(regKey);
    if (!sid) return;
    const friends = (friendsData.friendships[regKey] || []).map(publicFriendProfile).filter((f) => registeredPlayers[f.key]);
    const requests = friendsData.requests.filter((r) => r && r.toKey === regKey).map((r) => publicFriendProfile(r.fromKey)).filter((f) => registeredPlayers[f.key]);
    try { io.to(sid).emit('friendsUpdate', { friends, requests }); } catch (e) {}
}
function notifyFriendsOf(regKey) {
    // Is player ke friends ko update bhejo (online/offline status ke liye).
    const list = friendsData.friendships[regKey] || [];
    list.forEach((fk) => sendFriendsUpdate(fk));
}

// 🏁 MATCH END — timer 0 hote hi 'matchEnded' (clients rewards save
// karen + apne stats bhejen), 1.5s baad leaderboard ('matchResults')
// broadcast + match stats reset (agle match ke liye).
let matchEnding = false;
function buildMatchLeaderboard() {
    return Object.keys(players)
        .filter((id) => {
            const p = players[id];
            if (!p) return false;
            // Sirf wohi jo match me the: kill/death ki, ya stats bheje.
            // (Lobby me baithe players 0/0 ke saath board me nahi aane chahiye.)
            return (p.matchKills || 0) > 0 || (p.matchDeaths || 0) > 0 || !!p.matchStatsReported;
        })
        .map((id) => {
            const p = players[id];
            const shots = p.matchShots || 0, hits = p.matchHits || 0;
            const reported = !!p.matchStatsReported;
            const coins = (p.matchCoins != null && p.matchCoins > 0)
                ? p.matchCoins
                : ((p.matchKills || 0) * 100 + (p.matchDeaths || 0) * 10);
            return {
                socketId: id,
                name: p.name || 'Player',
                playerId: p.playerId || '??????',
                pfp: p.pfp || '',
                kills: p.matchKills || 0,
                deaths: p.matchDeaths || 0,
                coins: coins,
                shots: shots,
                hits: hits,
                // Accuracy: sirf tab jab client ne stats bheje (warna '—').
                accuracy: reported ? (shots > 0 ? Math.round((hits / shots) * 100) : 0) : null
            };
        })
        .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || String(a.name).localeCompare(String(b.name)));
}
function startMatchEnd() {
    if (matchEnding) return;
    matchEnding = true;
    io.emit('matchEnded');
    setTimeout(() => {
        try { io.emit('matchResults', buildMatchLeaderboard()); } catch (e) {}
        Object.keys(players).forEach((id) => {
            if (players[id]) {
                players[id].matchKills = 0; players[id].matchDeaths = 0;
                players[id].matchShots = 0; players[id].matchHits = 0;
                players[id].matchCoins = 0; players[id].matchStatsReported = false;
            }
        });
        matchTimeLeft = 600;
        matchEnding = false;
        io.emit('timerUpdate', matchTimeLeft);
    }, 1500);
}

// Match Timer Interval
setInterval(() => {
    if (matchEnding) return; // match end ho raha hai — timer ruka hai.
    matchTimeLeft--;
    if (matchTimeLeft <= 0) {
        matchTimeLeft = 0;
        io.emit('timerUpdate', matchTimeLeft);
        startMatchEnd();
        return;
    }
    io.emit('timerUpdate', matchTimeLeft);
}, 1000);

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    players[socket.id] = {
        name: 'Player',
        x: 0,
        y: 1.62,
        z: 0,
        yaw: 0,
        pitch: 0,
        skin: '',
        isMoving: false,
        isCrouching: false,
        isDoingPushups: false, // 💪 Pushups (P) — client se aata hai, baaki players ko dikhta hai.
        ready: false, // ✅ Lobby READY — game start ke liye tayyar (party PLAY ke liye sab ready hone chahiye).
        gun1: 'ar9', // 🎒 Slot 1 gun — 'ar9' ya 'vita' (sniper). Client se aata hai, baaki players ko dikhta hai.
        // 🆔 Player ID (# + 5 chars, letters + numbers) + 🌍 W.W.P profile.
        playerId: '', // setPlayerProfile se aata hai (client ki per-account ID).
        pfp: '', // profile picture (data URL ya Google photoURL).
        email: '', // Google email (Google login par), guest par ''.
        isGoogle: false,
        regKey: '', // 🌍 W.W.P permanent registry ki key (setPlayerProfile se).
        health: 100,
        isDead: false,
        kills: 0,
        deaths: 0,
        // 🏁 Is match ke stats (results panel ke liye) — match end par reset.
        matchKills: 0,
        matchDeaths: 0,
        matchShots: 0, // client bhejta hai (accuracy ke liye)
        matchHits: 0, // client bhejta hai (accuracy ke liye)
        matchCoins: 0, // client bhejta hai (is match ke coins)
        matchStatsReported: false // client ne match end par stats bheje?
    };

    socket.emit('currentPlayers', players);
    socket.emit('playersList', publicPlayerList());
    socket.emit('timerUpdate', matchTimeLeft);

    socket.on('setPlayerName', (playerName) => {
        if (players[socket.id]) {
            players[socket.id].name = playerName || 'Player';
            socket.broadcast.emit('newPlayer', { id: socket.id, player: players[socket.id] });
            
            // 🌟 Screenshot ke mutabiq join notification (Green color text ke liye identifier)
            io.emit('playerJoinedNotif', players[socket.id].name);
            // 🌍 W.W.P — naam badla to permanent entry me bhi update karo.
            const rk = players[socket.id].regKey;
            if (rk && registeredPlayers[rk]) {
                registeredPlayers[rk].name = players[socket.id].name;
                registeredPlayers[rk].lastSeen = Date.now();
                saveRegisteredPlayers();
            }
            broadcastPlayersList();
        }
    });

    // 🆔 + 🌍 W.W.P — client apni profile bhejta hai (login par, PLAY par,
    // reconnect par): { id, name, pfp, email, isGoogle, uid }. Server use
    // PERMANENT registry (players.json) me save karta hai aur list sab ko
    // broadcast karta hai (admin ka W.W.P panel usi se bharta hai).
    socket.on('setPlayerProfile', (profile) => {
        if (!players[socket.id] || !profile || typeof profile !== 'object') return;
        const pid = String(profile.id || '').replace(/[^0-9]/g, '').substring(0, 6);
        if (!/^[0-9]{6}$/.test(pid)) return; // galat ID — ignore karo.
        const key = playerRegKey(profile, pid);
        // ID pehle se kisi AUR registered player ki to nahi? (takrao — client nayi ID banaye.)
        const taken = Object.keys(registeredPlayers).some((k) => k !== key && registeredPlayers[k] && registeredPlayers[k].playerId === pid);
        if (taken) { socket.emit('playerIdTaken'); return; }
        // 👑 BAN / DISABLE — admin ne block kiya ho to login hi nahi hone do.
        const prev = registeredPlayers[key] || {};
        const prevStatus = prev.status || 'active';
        if (prevStatus === 'banned') { try { socket.emit('youAreBanned', {}); } catch (e) {} try { socket.disconnect(true); } catch (e) {} return; }
        if (prevStatus === 'disabled') { try { socket.emit('youAreDisabled', {}); } catch (e) {} try { socket.disconnect(true); } catch (e) {} return; }
        // Permanent entry — ek dafa login to hamesha list me.
        // (status + pendingGifts bachao — ye admin actions se bante hain.)
        registeredPlayers[key] = {
            key: key,
            name: String(profile.name || players[socket.id].name || 'Player').substring(0, 30),
            playerId: pid,
            pfp: String(profile.pfp || '').substring(0, 40000),
            email: String(profile.email || '').substring(0, 100),
            isGoogle: !!profile.isGoogle,
            uid: String(profile.uid || '').substring(0, 100),
            lastSeen: Date.now(),
            status: prevStatus,
            pendingGifts: Array.isArray(prev.pendingGifts) ? prev.pendingGifts : []
        };
        players[socket.id].regKey = key;
        players[socket.id].playerId = pid;
        players[socket.id].name = registeredPlayers[key].name;
        players[socket.id].pfp = registeredPlayers[key].pfp;
        players[socket.id].email = registeredPlayers[key].email;
        players[socket.id].isGoogle = registeredPlayers[key].isGoogle;
        saveRegisteredPlayers();
        broadcastPlayersList();
        // ✅ Profile accept ho gayi (ban/disable nahi hai) — client apna
        // purana banned/disabled flag saaf kar le (PLAY wapas enable ho).
        try { socket.emit('profileAccepted', { status: 'active' }); } catch (e) {}
        // 🎁 Pending gifts (offline me admin ne bheje the) — ab de do.
        const pending = registeredPlayers[key].pendingGifts || [];
        if (pending.length > 0) {
            registeredPlayers[key].pendingGifts = [];
            saveRegisteredPlayers();
            pending.forEach((g, i) => {
                setTimeout(() => { try { socket.emit('giftReceived', g); } catch (e) {} }, 400 * (i + 1));
            });
        }
        // 👥 Friends — login par apni friends list + pending requests bhejo
        // (offline me aayi requests F.Req me dikh jayengi). Friends ko bhi
        // online status update bhejo.
        sendFriendsUpdate(key);
        notifyFriendsOf(key);
    });

    // 👑 ADMIN ACTIONS — Ban / Disable / Enable / Unban (sirf admin).
    socket.on('adminSetStatus', (data) => {
        if (!isAdminSocket(socket)) { try { socket.emit('adminActionFailed', { reason: 'not-admin' }); } catch (e) {} return; }
        if (!data || typeof data !== 'object') return;
        const key = String(data.key || '').trim();
        const status = String(data.status || '').trim();
        if (!key || !registeredPlayers[key]) { try { socket.emit('adminActionFailed', { reason: 'no-player' }); } catch (e) {} return; }
        if (status !== 'active' && status !== 'banned' && status !== 'disabled') return;
        // Admin khud ko ban/disable nahi kar sakta.
        if (players[socket.id] && players[socket.id].regKey === key) { try { socket.emit('adminActionFailed', { reason: 'self' }); } catch (e) {} return; }
        registeredPlayers[key].status = status;
        saveRegisteredPlayers();
        // Online ho to foran kick karo (banned/disabled).
        if (status === 'banned') kickPlayerSocket(key, 'youAreBanned');
        else if (status === 'disabled') kickPlayerSocket(key, 'youAreDisabled');
        broadcastPlayersList();
        try { socket.emit('adminActionDone', { key, status }); } catch (e) {}
    });

    // 👑 ADMIN GIFTS — Send Diamonds / Coins / Skins / Characters (sirf admin).
    // Currency admin ke apne balance se jati hai (client giftSent par kat-ta hai).
    socket.on('adminGift', (data) => {
        if (!isAdminSocket(socket)) { try { socket.emit('giftFailed', { reason: 'not-admin' }); } catch (e) {} return; }
        if (!data || typeof data !== 'object') return;
        const key = String(data.key || '').trim();
        const gift = (data.gift && typeof data.gift === 'object') ? data.gift : null;
        if (!key || !registeredPlayers[key] || !gift) { try { socket.emit('giftFailed', { reason: 'no-player' }); } catch (e) {} return; }
        const type = String(gift.type || '').trim();
        const fromName = (players[socket.id] && players[socket.id].name) || 'Admin';
        let clean = null;
        if (type === 'diamonds' || type === 'coins') {
            const amount = Math.floor(Number(gift.amount) || 0);
            if (amount <= 0 || amount > 100000) { try { socket.emit('giftFailed', { reason: 'bad-amount' }); } catch (e) {} return; }
            clean = { type, amount, from: fromName, at: Date.now() };
        } else if (type === 'skin' || type === 'character') {
            const code = (gift.skinCode === null) ? null : String(gift.skinCode || '').trim();
            if (code !== null && (!code.startsWith('PX1|') || code.length > 5000)) { try { socket.emit('giftFailed', { reason: 'bad-skin' }); } catch (e) {} return; }
            clean = { type, skinId: String(gift.skinId || 'custom').substring(0, 40), skinName: String(gift.skinName || 'Skin').substring(0, 40), skinCode: code, from: fromName, at: Date.now() };
        } else { try { socket.emit('giftFailed', { reason: 'bad-type' }); } catch (e) {} return; }
        const where = deliverGiftToPlayer(key, clean);
        if (where === 'notfound') { try { socket.emit('giftFailed', { reason: 'no-player' }); } catch (e) {} return; }
        try { socket.emit('giftSent', { key, gift: clean, where }); } catch (e) {}
    });

    // 👥 FRIEND REQUEST — client #ID bhejta hai (6 digits),
    // server us ID wala player dhoondta hai aur request bhejta hai.
    socket.on('sendFriendRequest', (data) => {
        if (!players[socket.id]) return;
        const myKey = players[socket.id].regKey;
        if (!myKey) return;
        const pid = String((data && data.playerId) || '').replace(/[^0-9]/g, '').substring(0, 6);
        if (!/^[0-9]{6}$/.test(pid)) { try { socket.emit('friendRequestResult', { ok: false, reason: 'bad-id' }); } catch (e) {} return; }
        const targetKey = findRegKeyByPlayerId(pid);
        if (!targetKey) { try { socket.emit('friendRequestResult', { ok: false, reason: 'not-found' }); } catch (e) {} return; }
        if (targetKey === myKey) { try { socket.emit('friendRequestResult', { ok: false, reason: 'self' }); } catch (e) {} return; }
        if (areFriends(myKey, targetKey)) { try { socket.emit('friendRequestResult', { ok: false, reason: 'already-friends' }); } catch (e) {} return; }
        if (hasPendingRequest(myKey, targetKey)) { try { socket.emit('friendRequestResult', { ok: false, reason: 'already-sent' }); } catch (e) {} return; }
        // Ulti taraf se request pehle se aayi hui ho to seedha friends ban jao.
        if (hasPendingRequest(targetKey, myKey)) {
            friendsData.requests = friendsData.requests.filter((r) => !(r && r.fromKey === targetKey && r.toKey === myKey));
            addFriendship(myKey, targetKey);
            saveFriendsData();
            sendFriendsUpdate(myKey);
            sendFriendsUpdate(targetKey);
            try { socket.emit('friendRequestResult', { ok: true, reason: 'accepted-mutual' }); } catch (e) {}
            const sid = findSocketIdByRegKey(targetKey);
            if (sid) { try { io.to(sid).emit('friendRequestAccepted', { by: publicFriendProfile(myKey) }); } catch (e) {} }
            return;
        }
        friendsData.requests.push({ fromKey: myKey, toKey: targetKey, at: Date.now() });
        saveFriendsData();
        try { socket.emit('friendRequestResult', { ok: true, reason: 'sent' }); } catch (e) {}
        // Target online ho to foran batao, offline ho to pending rehti hai (login par milegi).
        sendFriendsUpdate(targetKey);
        const sid = findSocketIdByRegKey(targetKey);
        if (sid) { try { io.to(sid).emit('friendRequestReceived', { from: publicFriendProfile(myKey) }); } catch (e) {} }
    });

    // 👥 FRIEND REQUEST ACCEPT / DECLINE — sirf jis ko request aayi wo jawab de sakta hai.
    socket.on('respondFriendRequest', (data) => {
        if (!players[socket.id]) return;
        const myKey = players[socket.id].regKey;
        if (!myKey || !data || typeof data !== 'object') return;
        const fromKey = String(data.fromKey || '').trim();
        const accept = !!data.accept;
        if (!fromKey || !registeredPlayers[fromKey]) return;
        const idx = friendsData.requests.findIndex((r) => r && r.fromKey === fromKey && r.toKey === myKey);
        if (idx === -1) return; // aisi koi request nahi hai.
        friendsData.requests.splice(idx, 1);
        if (accept) addFriendship(myKey, fromKey);
        saveFriendsData();
        sendFriendsUpdate(myKey);
        sendFriendsUpdate(fromKey);
        const sid = findSocketIdByRegKey(fromKey);
        if (sid) {
            try { io.to(sid).emit(accept ? 'friendRequestAccepted' : 'friendRequestDeclined', { by: publicFriendProfile(myKey) }); } catch (e) {}
        }
    });

    // ❌ REMOVE FRIEND — dono taraf se dosti hatao, dono ko friendsUpdate bhejo.
    socket.on('removeFriend', (data) => {
        if (!players[socket.id]) return;
        const myKey = players[socket.id].regKey;
        if (!myKey || !data || typeof data !== 'object') return;
        const targetKey = String(data.key || '').trim();
        if (!targetKey || !registeredPlayers[targetKey]) return;
        if (!areFriends(myKey, targetKey)) { try { socket.emit('removeFriendResult', { ok: false, reason: 'not-friends' }); } catch (e) {} return; }
        removeFriendship(myKey, targetKey);
        // Usi player ki doosri key (purana browser / purani app.js — regKey badal
        // gaya ho) se dosti bhi hatao, warna friend doosri key se wapas aa jata hai.
        const targetPid = (registeredPlayers[targetKey] || {}).playerId || '';
        if (targetPid) {
            Object.keys(registeredPlayers).forEach((k) => {
                if (k !== targetKey && registeredPlayers[k] && registeredPlayers[k].playerId === targetPid) removeFriendship(myKey, k);
            });
        }
        // Dono ke beech ki pending requests bhi saaf karo (warna Accept se dosti wapas aa jaye).
        friendsData.requests = friendsData.requests.filter((r) => !(r && ((r.fromKey === myKey && r.toKey === targetKey) || (r.fromKey === targetKey && r.toKey === myKey))));
        if (!saveFriendsData()) {
            // Save nahi hua — removal wapas lo, warna restart par friend wapas aa jayega.
            addFriendship(myKey, targetKey);
            try { socket.emit('removeFriendResult', { ok: false, reason: 'save-failed' }); } catch (e) {} return;
        }
        // 👥 Dost nahi rahe to shared lobby bhi khatam (dono taraf se).
        leaveLobbyGroup(myKey);
        leaveLobbyGroup(targetKey);
        console.log('❌ ' + (players[socket.id].name || myKey) + ' removed friend ' + (registeredPlayers[targetKey].name || targetKey));
        sendFriendsUpdate(myKey);
        sendFriendsUpdate(targetKey);
        try { socket.emit('removeFriendResult', { ok: true, removed: publicFriendProfile(targetKey) }); } catch (e) {}
        const sid = findSocketIdByRegKey(targetKey);
        if (sid) { try { io.to(sid).emit('friendRemoved', { by: publicFriendProfile(myKey) }); } catch (e) {} }
    });

    // 🎮 PLAYER STATE — game me ho ya lobby me (Friends list me Join ke liye).
    socket.on('playerState', (data) => {
        if (!players[socket.id]) return;
        const myKey = players[socket.id].regKey;
        if (!myKey || !data || typeof data !== 'object') return;
        players[socket.id].inGame = data.inGame === true;
        // Game me gaya — lobby group se nikal jao (host tha to lobby dissolve).
        if (players[socket.id].inGame) leaveLobbyGroup(myKey);
        // Mere friends ko mera naya status batao (Join button / Game me wali line ke liye).
        notifyFriendsOf(myKey);
    });

    // 👥 JOIN LOBBY — dost ki lobby me khade ho jao (uska character side pe,
    // apna beech me). Game start NAHI hota — sirf lobby share hoti hai.
    socket.on('joinLobby', (data) => {
        if (!players[socket.id]) return;
        const myKey = players[socket.id].regKey;
        if (!myKey || !data || typeof data !== 'object') return;
        const targetKey = String(data.key || '').trim();
        if (!targetKey || !registeredPlayers[targetKey]) { try { socket.emit('joinLobbyResult', { ok: false, reason: 'not-found' }); } catch (e) {} return; }
        if (targetKey === myKey) { try { socket.emit('joinLobbyResult', { ok: false, reason: 'self' }); } catch (e) {} return; }
        if (!isPlayerOnline(targetKey)) { try { socket.emit('joinLobbyResult', { ok: false, reason: 'offline' }); } catch (e) {} return; }
        if (isPlayerInGame(targetKey)) { try { socket.emit('joinLobbyResult', { ok: false, reason: 'in-game' }); } catch (e) {} return; }
        // Root host nikalo — agar target kisi aur ki lobby me hai to usi host ki lobby join hogi.
        const targetSid = findSocketIdByRegKey(targetKey);
        const targetLobbyWith = (targetSid && players[targetSid] && players[targetSid].lobbyWith) || null;
        const hostKey = targetLobbyWith || targetKey;
        if (hostKey === myKey) { try { socket.emit('joinLobbyResult', { ok: false, reason: 'already-there' }); } catch (e) {} return; }
        if (players[socket.id].lobbyWith === hostKey) { try { socket.emit('joinLobbyResult', { ok: false, reason: 'already-there' }); } catch (e) {} return; }
        players[socket.id].lobbyWith = hostKey;
        try { socket.emit('joinLobbyResult', { ok: true, hostKey, hostName: (registeredPlayers[hostKey] || {}).name || 'Player' }); } catch (e) {}
        sendLobbyUpdate(hostKey);
        // Host ko batao: koi uski lobby me aa gaya.
        const hostSid = findSocketIdByRegKey(hostKey);
        if (hostSid && hostSid !== socket.id) { try { io.to(hostSid).emit('lobbyJoined', { by: publicFriendProfile(myKey) }); } catch (e) {} }
    });

    // 🚪 LEAVE LOBBY — dost ki lobby se nikal kar apni khud ki lobby me wapas.
    socket.on('leaveLobby', () => {
        if (!players[socket.id]) return;
        const myKey = players[socket.id].regKey;
        if (!myKey) return;
        const hostKey = players[socket.id].lobbyWith;
        if (!hostKey) return;
        leaveLobbyGroup(myKey);
        sendEmptyLobbyUpdate(myKey);
        const hostSid = findSocketIdByRegKey(hostKey);
        if (hostSid) { try { io.to(hostSid).emit('lobbyLeft', { by: publicFriendProfile(myKey) }); } catch (e) {} }
    });

    // ✅ READY — lobby me PLAY dabane se pehle sab ko ready hona zaroori hai.
    socket.on('setReady', (data) => {
        if (!players[socket.id]) return;
        const myKey = players[socket.id].regKey;
        if (!myKey || !data || typeof data !== 'object') return;
        players[socket.id].ready = data.ready === true;
        // Apni group ko + friends ko naya ready status batao.
        const hostKey = players[socket.id].lobbyWith || myKey;
        sendLobbyUpdate(hostKey);
        notifyFriendsOf(myKey);
    });

    // 🎮 PARTY PLAY — PLAY dabao; sab ready hain to baaki members ko bhi game start ka signal.
    socket.on('partyPlay', () => {
        if (!players[socket.id]) return;
        const myKey = players[socket.id].regKey;
        if (!myKey) return;
        const hostKey = players[socket.id].lobbyWith || myKey;
        const keys = lobbyGroupKeys(hostKey);
        if (keys.length <= 1) { try { socket.emit('partyPlayResult', { ok: false, reason: 'solo' }); } catch (e) {} return; }
        const notReady = keys.filter((k) => !isPlayerReady(k)).map((k) => (registeredPlayers[k] || {}).name || 'Player');
        if (notReady.length) { try { socket.emit('partyPlayResult', { ok: false, reason: 'not-ready', notReady }); } catch (e) {} return; }
        keys.forEach((k) => {
            if (k === myKey) return;
            const sid = findSocketIdByRegKey(k);
            if (sid) { try { io.to(sid).emit('partyGameStart', { by: publicFriendProfile(myKey) }); } catch (e) {} }
        });
        try { socket.emit('partyPlayResult', { ok: true }); } catch (e) {}
    });

    // 🌟 Chat Message Handler - SIRF EK BAAR (doosra duplicate wala block DELETE karo)
    socket.on('sendChatMessage', (data) => {
        // Naya client object bhejta hai {id, message}, purana client sirf string
        const text = (typeof data === 'string' ? data : (data && data.message)) || '';
        const msgId = (data && data.id) ? data.id : (socket.id + '-' + Date.now());
        if (players[socket.id] && typeof text === 'string' && text.trim() !== '') {
            // broadcast, io.emit nahi. Sender apna message khud dikha deta hai.
            socket.broadcast.emit('chatMessage', {
                id: msgId,
                name: players[socket.id].name,
                message: text.trim()
            });
        }
    });

    socket.on('playerMovement', (movementData) => {
        if (players[socket.id] && !players[socket.id].isDead) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            players[socket.id].z = movementData.z;
            players[socket.id].yaw = movementData.yaw;
            players[socket.id].pitch = movementData.pitch;
            players[socket.id].isMoving = movementData.isMoving;
            players[socket.id].isCrouching = movementData.isCrouching;
            // 💪 Pushups — server terminal me dikhega (naye server ki pehchan).
            if (movementData.isDoingPushups && !players[socket.id].isDoingPushups) {
                console.log(`💪 ${players[socket.id].name} started pushups`);
            }
            if (!movementData.isDoingPushups && players[socket.id].isDoingPushups) {
                console.log(`💪 ${players[socket.id].name} stopped pushups`);
            }
            players[socket.id].isDoingPushups = !!movementData.isDoingPushups; // 💪 Pushups.
            // 🎒 Slot 1 gun (AR-9/VITA) — client se aata hai, baaki players ko dikhta hai.
            if (movementData.gun1 === 'vita' || movementData.gun1 === 'ar9') {
                players[socket.id].gun1 = movementData.gun1;
            }

            socket.broadcast.emit('playerMoved', { id: socket.id, player: players[socket.id] });
        }
    });

    // 🎨 Har player ki apni skin — client apni skin ka code bhejta hai
    // (join par aur jab bhi skin badle), server use save karke baaki
    // players ko bhejta hai, taake har player ko uski apni skin dikhe.
    socket.on('setPlayerSkin', (code) => {
        if (players[socket.id]) {
            players[socket.id].skin = (typeof code === 'string' ? code : '') || '';
            console.log(`Skin set for ${players[socket.id].name} (${socket.id}): ${players[socket.id].skin ? players[socket.id].skin.substring(0, 30) + '...' : '(no skin)'}`);
            socket.broadcast.emit('playerSkinChanged', { id: socket.id, skin: players[socket.id].skin });
        }
    });

    socket.on('playerHit', (data) => {
        const attackerId = socket.id;
        const target = players[data.targetId];

        if (target && !target.isDead) {
            target.health -= data.damage;
            io.emit('spawnBlood', { x: data.x, y: data.y, z: data.z });

            if (target.health <= 0) {
                target.health = 0;
                target.isDead = true;
                target.deaths++;
                target.matchDeaths++; // 🏁 Is match ki death (results panel).

                if (players[attackerId] && attackerId !== data.targetId) {
                    players[attackerId].kills++;
                    players[attackerId].matchKills++; // 🏁 Is match ka kill (results panel).
                }

                io.emit('playerStatsUpdate', { 
                    targetId: data.targetId, 
                    targetDeaths: target.deaths, 
                    attackerId: attackerId, 
                    attackerKills: players[attackerId] ? players[attackerId].kills : 0,
                    // 🎯 Headshot (100 damage) aur 🌙 Mid-air kill (target hawa me).
                    isHeadshot: (data.damage || 0) >= 100,
                    isMidAir: (target.y || 0) > 1.7
                });

                io.emit('playerDied', { id: data.targetId });

                setTimeout(() => {
                    if (players[data.targetId]) {
                        target.health = 100;
                        target.isDead = false;
                        target.x = (Math.random() - 0.5) * 20;
                        target.z = (Math.random() - 0.5) * 20;
                        target.y = 1.62;
                        io.emit('playerRespawned', { id: data.targetId, player: target });
                    }
                }, 3000);
            } else {
                io.emit('playerHealthUpdate', { id: data.targetId, health: target.health });
            }
        }
    });

    // 🔍 Matchmaking — client PLAY dabake match dhoondta hai; server
    // online players + match ka time bhejta hai (MATCH FOUND ke liye).
    socket.on('requestMatchInfo', () => {
        if (!players[socket.id]) return;
        try {
            socket.emit('matchInfo', {
                online: Object.keys(players).length,
                timeLeft: matchTimeLeft,
                ending: !!matchEnding
            });
        } catch (e) {}
    });

    // 🏁 Match end par client apne stats bhejta hai (shots/hits = accuracy,
    // coins = is match ke coins). Server leaderboard me mila deta hai.
    socket.on('matchStats', (stats) => {
        if (!players[socket.id] || !stats || typeof stats !== 'object') return;
        const s = Math.max(0, parseInt(stats.shots, 10) || 0);
        const h = Math.max(0, parseInt(stats.hits, 10) || 0);
        players[socket.id].matchShots = s;
        players[socket.id].matchHits = Math.min(h, s);
        players[socket.id].matchCoins = Math.max(0, parseInt(stats.coins, 10) || 0);
        players[socket.id].matchStatsReported = true;
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        const playerName = players[socket.id] ? players[socket.id].name : 'Player';
        const discRegKey = players[socket.id] ? players[socket.id].regKey : '';
        // 👥 Shared lobby se nikal jao (host tha to lobby dissolve).
        if (discRegKey) leaveLobbyGroup(discRegKey);
        delete players[socket.id];
        
        // 🌟 Screenshot ke mutabiq left notification (Red color text ke liye)
        io.emit('playerLeftNotif', playerName);
        io.emit('playerDisconnect', socket.id);
        // 🌍 W.W.P — PERMANENT: gaya hua player registry se NAHI hat-ta,
        // sirf offline ho jata hai (list broadcast se online dot update hota hai).
        broadcastPlayersList();
        // 👥 Friends — iske friends ko online status update bhejo.
        if (discRegKey) notifyFriendsOf(discRegKey);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});