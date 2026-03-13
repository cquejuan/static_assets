/*
   JavaScript overview:
   - Manages Turnstile verification (onTurnstileSuccess, onTurnstileExpire, tryResetTurnstile).
   - Renders the board from FEN and handles square clicks (renderBoard, onSquareClick).
   - Manages WebSocket join and message flow (open, init, state, players, notifications).
   - Renders move history and appends moves (renderMoves, appendMove).
   - UI helpers: generateRoomName, makeInviteLink, renderPlayers, escapeHtml.
   - Auto-join from URL and copy-invite functionality.
 */
(function () {
    const TURNSTILE_SITEKEY = '__TURNSTILE_SITEKEY__';
    const SKIP_TURNSTILE = __SKIP_TURNSTILE__;
    const TURNSTILE_TTL_MS = 2 * 60 * 1000; // client-side expiry fallback (2 minutes)
    let turnstileWidget = null;
    let tokenExpiryTimer = null;
    window.__turnstileToken = null;

    // Called by Turnstile when token is issued
    window.onTurnstileSuccess = function (token) {
        window.__turnstileToken = token;
        try { setStatus('Verification OK'); } catch (e) { }
        try { if (joinBtn) joinBtn.disabled = false; if (generateBtn) generateBtn.disabled = false; setJoinStatus('Verification OK', 'success'); } catch (e) { }
        if (tokenExpiryTimer) { clearTimeout(tokenExpiryTimer); tokenExpiryTimer = null; }
        tokenExpiryTimer = setTimeout(function () {
            window.__turnstileToken = null;
            tokenExpiryTimer = null;
            try { setStatus('Verification token expired'); } catch (e) { }
            try { setJoinStatus('Verification token expired', 'error'); } catch (e) { }
            tryResetTurnstile();
        }, TURNSTILE_TTL_MS);
    };

    // Called by Turnstile when the token expires server-side
    window.onTurnstileExpire = function () {
        window.__turnstileToken = null;
        if (tokenExpiryTimer) { clearTimeout(tokenExpiryTimer); tokenExpiryTimer = null; }
        try { setStatus('Verification token expired'); } catch (e) { }
        try { if (!SKIP_TURNSTILE) { if (joinBtn) joinBtn.disabled = true; if (generateBtn) generateBtn.disabled = true; setJoinStatus('Verification token expired', 'error'); } else { if (joinBtn) joinBtn.disabled = false; if (generateBtn) generateBtn.disabled = false; setJoinStatus(''); } } catch (e) { }
    };

    function tryResetTurnstile() {
        try {
            if (window.turnstile && typeof window.turnstile.reset === 'function') {
                if (turnstileWidget != null) window.turnstile.reset(turnstileWidget);
                else {
                    const el = document.getElementById('cf-turnstile');
                    if (el && typeof window.turnstile.render === 'function') {
                        turnstileWidget = window.turnstile.render(el, { sitekey: TURNSTILE_SITEKEY, callback: 'onTurnstileSuccess', 'expired-callback': 'onTurnstileExpire' });
                    }
                }
            } else {
                const container = document.getElementById('turnstile-container');
                if (container) {
                    container.innerHTML = '<div id="cf-turnstile" class="cf-turnstile" data-sitekey="' + TURNSTILE_SITEKEY + '" data-callback="onTurnstileSuccess" data-expired-callback="onTurnstileExpire"></div>';
                    if (window.turnstile && typeof window.turnstile.render === 'function') {
                        const el = document.getElementById('cf-turnstile');
                        turnstileWidget = window.turnstile.render(el, { sitekey: TURNSTILE_SITEKEY, callback: 'onTurnstileSuccess', 'expired-callback': 'onTurnstileExpire' });
                    }
                }
            }
        } catch (e) { }
    }
    const joinForm = document.getElementById('join-form');
    const roomInput = document.getElementById('room');
    const nameInput = document.getElementById('name');
    const gameEl = document.getElementById('game');
    const boardEl = document.getElementById('board');
    const statusEl = document.getElementById('status');
    const playersEl = document.getElementById('players');
    const generateBtn = document.getElementById('generate');
    const inviteActions = document.getElementById('invite-actions');
    const inviteLinkInput = document.getElementById('invite-link');
    const copyInviteBtn = document.getElementById('copy-invite');
    const joinBtn = document.getElementById('join-btn');
    const joinStatusEl = document.getElementById('join-status');
    const joinSpinner = document.getElementById('join-spinner');
    const movesListEl = document.getElementById('moves-list');
    let socket = null; let myColor = null; let sel = null;
    let movesHistory = [];

    // Piece glyph helper — map piece character to unicode chess glyph
    function pieceToUnicode(ch) {
        var map = { 'p': '♟', 'r': '♜', 'n': '♞', 'b': '♝', 'q': '♛', 'k': '♚', 'P': '♙', 'R': '♖', 'N': '♘', 'B': '♗', 'Q': '♕', 'K': '♔' };
        return map[ch] || '';
    }

    // Render board from FEN: build DOM squares, attach click handlers, and add file/rank labels
    function renderBoard(fen) {
        var board = [];
        var rows = fen.split(' ')[0].split('/');
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r]; var arr = [];
            for (var i = 0; i < row.length; i++) {
                var ch = row[i];
                if (ch >= '1' && ch <= '8') {
                    for (var k = 0; k < parseInt(ch, 10); k++) arr.push(null);
                } else arr.push(ch);
            }
            board.push(arr);
        }
        boardEl.innerHTML = '';
        for (var r = 0; r < 8; r++) {
            var rankNum = 8 - r;
            var rowWrapper = document.createElement('div');
            rowWrapper.className = 'rank-row';
            var rankLabel = document.createElement('div');
            rankLabel.className = 'rank-label';
            rankLabel.textContent = rankNum;
            var rowDiv = document.createElement('div');
            rowDiv.className = 'rank';
            for (var c = 0; c < 8; c++) {
                var file = String.fromCharCode('a'.charCodeAt(0) + c);
                var square = file + rankNum;
                var sq = document.createElement('div');
                sq.className = 'square ' + (((r + c) % 2 === 0) ? 'light' : 'dark');
                sq.dataset.square = square;
                var piece = board[r] && board[r][c];
                if (piece) { var pc = document.createElement('div'); pc.className = 'piece'; pc.textContent = pieceToUnicode(piece); sq.appendChild(pc); }
                sq.addEventListener('click', onSquareClick);
                rowDiv.appendChild(sq);
            }
            rowWrapper.appendChild(rankLabel);
            rowWrapper.appendChild(rowDiv);
            boardEl.appendChild(rowWrapper);
        }
        // file labels (A..H)
        var fileLabels = document.createElement('div');
        fileLabels.className = 'file-labels';
        var spacer = document.createElement('div');
        spacer.className = 'file-label-spacer';
        fileLabels.appendChild(spacer);
        for (var f = 0; f < 8; f++) {
            var fl = document.createElement('div');
            fl.className = 'file-label';
            fl.textContent = String.fromCharCode('A'.charCodeAt(0) + f);
            fileLabels.appendChild(fl);
        }
        boardEl.appendChild(fileLabels);
    }

    // Square click handler — select or send a move over WebSocket
    function onSquareClick(e) {
        var square = e.currentTarget.dataset.square;
        if (!sel) { sel = square; e.currentTarget.classList.add('selected'); }
        else { var from = sel; var to = square; sel = null; var s = boardEl.querySelectorAll('.selected'); for (var i = 0; i < s.length; i++) s[i].classList.remove('selected'); if (!socket || socket.readyState !== WebSocket.OPEN) return; socket.send(JSON.stringify({ type: 'move', from: from, to: to })); }
    }

    // UI status setter
    function setStatus(text) { statusEl.textContent = text; }

    // Join/status helper — sets join notification text and styling
    function setJoinStatus(text, type) { if (!joinStatusEl) return; joinStatusEl.textContent = text || ''; joinStatusEl.className = 'join-status' + (type ? (' ' + type) : ''); }

    // Spinner helpers — show/hide the small inline spinner
    function showSpinner() { try { if (joinSpinner) joinSpinner.style.display = 'inline-block'; } catch (e) { } }
    function hideSpinner() { try { if (joinSpinner) joinSpinner.style.display = 'none'; } catch (e) { } }

    // initialize join/generate button state depending on whether Turnstile is configured
    try {
        if (!SKIP_TURNSTILE && TURNSTILE_SITEKEY && TURNSTILE_SITEKEY.length > 8) { if (joinBtn) joinBtn.disabled = true; if (generateBtn) generateBtn.disabled = true; setJoinStatus('Complete the verification to create/join a room'); }
        else { if (joinBtn) joinBtn.disabled = false; if (generateBtn) generateBtn.disabled = false; setJoinStatus(''); }
    } catch (e) { }

    function generateRoomName(len) {
        len = len || 6;
        const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
        const rnd = new Uint8Array(len);
        window.crypto.getRandomValues(rnd);
        let out = '';
        for (let i = 0; i < len; i++) out += chars[rnd[i] % chars.length];
        return out;
    }

    function makeInviteLink(room) {
        try { return location.origin + '/r/' + encodeURIComponent(room); }
        catch (err) { return location.origin + location.pathname + '?room=' + encodeURIComponent(room); }
    }

    // Auto-generate a room name on load unless a room/invite is provided in the URL
    try {
        const params = new URLSearchParams(location.search);
        if (!params.get('room') && !params.get('invite')) {
            roomInput.value = generateRoomName(6);
        }
    } catch (e) { }

    // Helpers for rendering move history
    function escapeHtml(str) {
        if (str === undefined || str === null) return '';
        return String(str).replace(/[&<>"']/g, function (m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            if (m === '"') return '&quot;';
            return '&#039;';
        });
    }

    function _inferFromSan(san, idx) {
        const s = String(san || '');
        if (s.startsWith('O-O')) return { piece: 'k', color: (idx % 2 === 0) ? 'w' : 'b' };
        const first = s.charAt(0);
        if (/^[NBRQK]/.test(first)) return { piece: first.toLowerCase(), color: (idx % 2 === 0) ? 'w' : 'b' };
        return { piece: 'p', color: (idx % 2 === 0) ? 'w' : 'b' };
    }

    function moveToDisplay(m, idx) {
        if (!m) return { san: '', icon: '' };
        if (typeof m === 'string') {
            const san = m;
            const inf = _inferFromSan(san, idx);
            const ch = (inf.color === 'w') ? (inf.piece || 'p').toUpperCase() : (inf.piece || 'p');
            return { san: san, icon: pieceToUnicode(ch) };
        }
        // object with fields { san, piece, color }
        const san = m.san || '';
        const piece = (m.piece || 'p');
        const color = (m.color || ((idx % 2 === 0) ? 'w' : 'b'));
        const ch = (color === 'w') ? piece.toUpperCase() : piece;
        return { san: san, icon: pieceToUnicode(ch) };
    }

    function renderMoves(moves) {
        if (!movesListEl) return;
        movesListEl.innerHTML = '';
        moves = moves || [];
        for (var i = 0; i < moves.length; i += 2) {
            var num = Math.floor(i / 2) + 1;
            var white = moveToDisplay(moves[i], i);
            var black = moveToDisplay(moves[i + 1], i + 1);
            var li = document.createElement('li');
            li.innerHTML = '<span style="font-weight:600;display:inline-block;width:36px">' + num + '.</span>' +
                '<span style="display:inline-flex;gap:8px;align-items:center">' + (white.icon ? ('<span style="font-size:18px">' + escapeHtml(white.icon) + '</span>') : '') + '<span>' + escapeHtml(white.san) + '</span></span>' +
                '<span style="float:right;color:#66788a;display:inline-flex;gap:8px;align-items:center">' + (black.icon ? ('<span style="font-size:18px">' + escapeHtml(black.icon) + '</span>') : '') + '<span>' + escapeHtml(black.san) + '</span></span>';
            movesListEl.appendChild(li);
        }
        movesListEl.scrollTop = movesListEl.scrollHeight;
    }

    function appendMove(moveOrSan) {
        if (!moveOrSan) return;
        // accept either a SAN string or a move object
        if (typeof moveOrSan === 'string') movesHistory.push(moveOrSan);
        else if (typeof moveOrSan === 'object') movesHistory.push({ san: moveOrSan.san || (moveOrSan.from + moveOrSan.to), piece: moveOrSan.piece || null, color: moveOrSan.color || null, from: moveOrSan.from || null, to: moveOrSan.to || null });
        renderMoves(movesHistory);
    }

    joinForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var room = roomInput.value.trim();
        var name = nameInput.value.trim() || 'Guest';
        if (!room) return alert('Room required');
        // if Turnstile is configured and not skipped, require token
        if (!SKIP_TURNSTILE && TURNSTILE_SITEKEY && TURNSTILE_SITEKEY.length > 8) {
            if (!window.__turnstileToken) return alert('Please complete the human verification');
        }

        // show spinner while connecting/verifying
        showSpinner();
        setJoinStatus('Connecting...', '');
        if (joinBtn) joinBtn.disabled = true; if (generateBtn) generateBtn.disabled = true;

        var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        var wsUrl = protocol + '//' + location.host + '/ws/' + encodeURIComponent(room);
        socket = new WebSocket(wsUrl);

        socket.addEventListener('open', function () {
            try { setJoinStatus('Verifying...'); } catch (e) { }
            socket.send(JSON.stringify({ type: 'join', name: name, token: window.__turnstileToken }));
            // reset token/widget after sending join to avoid reuse
            tryResetTurnstile();
        });

        socket.addEventListener('message', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                if (data.type === 'error') {
                    hideSpinner();
                    setJoinStatus(data.text || 'Verification failed', 'error');
                    // reset widget and require a fresh verification
                    tryResetTurnstile();
                    if (!SKIP_TURNSTILE && TURNSTILE_SITEKEY && TURNSTILE_SITEKEY.length > 8) { if (joinBtn) joinBtn.disabled = true; if (generateBtn) generateBtn.disabled = true; }
                    else { if (joinBtn) joinBtn.disabled = false; if (generateBtn) generateBtn.disabled = false; }
                    return;
                }

                if (data.type === 'init') {
                    hideSpinner();
                    // joined successfully
                    try { joinForm.style.display = 'none'; gameEl.style.display = 'block'; } catch (e) { }
                    try { inviteLinkInput.value = makeInviteLink(room); inviteActions.style.display = 'block'; } catch (e) { }
                    try { renderBoard(data.fen); } catch (e) { }
                    try {
                        // update the URL so it reflects the joined room (e.g. ?room=XXXX)
                        const u = new URL(location.href);
                        u.searchParams.set('room', room);
                        history.replaceState(null, '', u.toString());
                    } catch (e) { }
                    try { if (data.history && Array.isArray(data.history)) { movesHistory = data.history.slice(); renderMoves(movesHistory); } } catch (e) { }
                    if (data.color) myColor = data.color;
                    renderPlayers(data.players);
                    if (data.turn) setStatus('Turn: ' + data.turn + (myColor ? (' — you: ' + myColor) : ''));
                    else setStatus('Game ready');
                    setJoinStatus('', '');
                    return;
                }

                if (data.type === 'state') {
                    try { renderBoard(data.fen); } catch (e) { }
                    try { if (data.move) { appendMove({ san: data.move.san || data.move.lan || (data.move.from + data.move.to), piece: data.move.piece || null, color: data.move.color || null, from: data.move.from, to: data.move.to }); } } catch (e) { }
                    if (data.turn) setStatus('Turn: ' + data.turn + (myColor ? (' — you: ' + myColor) : ''));
                    return;
                }

                if (data.type === 'players') {
                    renderPlayers(data.players);
                    return;
                }

                if (data.type === 'notification') {
                    setStatus(data.text || '');
                    return;
                }
            } catch (err) { console.error(err); }
        });

        socket.addEventListener('close', function () {
            hideSpinner();
            setStatus('Disconnected');
            if (!SKIP_TURNSTILE && TURNSTILE_SITEKEY && TURNSTILE_SITEKEY.length > 8) { if (joinBtn) joinBtn.disabled = true; if (generateBtn) generateBtn.disabled = true; setJoinStatus('Disconnected — please verify to reconnect', 'error'); }
            else { if (joinBtn) joinBtn.disabled = false; if (generateBtn) generateBtn.disabled = false; }
        });
    });

    // generate room name button
    if (generateBtn) {
        generateBtn.addEventListener('click', function () { roomInput.value = generateRoomName(6); roomInput.focus(); });
    }

    // copy invite link
    if (copyInviteBtn) {
        copyInviteBtn.addEventListener('click', function () {
            const url = inviteLinkInput.value || makeInviteLink(roomInput.value || '');
            if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(function () { setStatus('Invite copied to clipboard'); }, function () { setStatus('Failed to copy invite'); }); }
            else { prompt('Copy this invite link:', url); }
        });
    }

    // auto-join if ?room=CODE or ?invite=CODE is present
    try {
        const params = new URLSearchParams(location.search);
        const inviteRoom = params.get('room') || params.get('invite');
        const nameParam = params.get('name');
        if (inviteRoom) {
            roomInput.value = inviteRoom;
            if (nameParam) nameInput.value = nameParam;
            setTimeout(function () { joinForm.dispatchEvent(new Event('submit', { cancelable: true })); }, 50);
        }
    } catch (err) { }

    function renderPlayers(list) { playersEl.innerHTML = ''; if (!list) return; for (var i = 0; i < list.length; i++) { var p = list[i]; var el = document.createElement('div'); el.textContent = p.name + (p.color ? (' (' + p.color + ')') : ''); playersEl.appendChild(el); } }
})();
