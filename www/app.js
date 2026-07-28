let csrfToken = null;

async function bootstrap() {
  try {
    const res = await fetch('/api/bootstrap');
    const data = await res.json();
    csrfToken = data.csrfToken;
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) meta.setAttribute('content', csrfToken);
  } catch (e) {
    document.getElementById('error').textContent = 'Failed to initialize. Refresh the page.';
  }
}

// VALIDATE[minor] F17: 4th-arg headers passed by btn-add-player below are silently ignored —
// Idempotency-Key never sent (PRD requires it on POST /api/invites). fix: accept + merge extra headers.
async function apiCall(method, path, body) {
  const opts = {
    method,
    headers: {
      'X-CSRF-Token': csrfToken,
      'X-Svpn-Api': '1',
    },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  return res.json();
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    const el = document.getElementById('success');
    el.textContent = 'Copied to clipboard';
    setTimeout(() => { el.textContent = ''; }, 2000);
  });
}

document.getElementById('btn-anchor').addEventListener('click', () => {
  document.getElementById('role-select').classList.add('hidden');
  document.getElementById('anchor-setup').classList.remove('hidden');
});

document.getElementById('btn-member').addEventListener('click', () => {
  document.getElementById('role-select').classList.add('hidden');
  document.getElementById('member-setup').classList.remove('hidden');
});

document.getElementById('btn-create-network').addEventListener('click', async () => {
  const name = document.getElementById('anchor-name').value;
  const port = document.getElementById('anchor-port').value;
  const result = await apiCall('POST', '/api/settings', { name, listenPort: parseInt(port) });
  if (result.code) {
    document.getElementById('error').textContent = result.message;
  } else {
    document.getElementById('success').textContent = 'Network created!';
    showDashboard();
  }
});

document.getElementById('btn-join').addEventListener('click', async () => {
  const code = document.getElementById('invite-code').value;
  const result = await apiCall('POST', '/api/invites/import', { invite: code });
  if (result.code) {
    document.getElementById('error').textContent = result.message;
  } else if (result.reply) {
    document.getElementById('member-setup').classList.add('hidden');
    document.getElementById('reply-display').classList.remove('hidden');
    document.getElementById('reply-code').value = result.reply;
    document.getElementById('success').textContent = 'Send your reply code to the host.';
  } else {
    document.getElementById('success').textContent = 'Joined network!';
    showDashboard();
  }
});

document.getElementById('btn-copy-reply').addEventListener('click', () => {
  copyToClipboard(document.getElementById('reply-code').value);
});

document.getElementById('btn-add-player').addEventListener('click', async () => {
  const name = document.getElementById('new-player-name').value;
  if (!name) return;
  const result = await apiCall('POST', '/api/invites', { playerName: name }, { 'Idempotency-Key': crypto.randomUUID() });
  if (result.code) {
    document.getElementById('error').textContent = result.message;
  } else {
    document.getElementById('invite-output').value = result.invite;
    document.getElementById('invite-display').classList.remove('hidden');
  }
});

document.getElementById('btn-copy-invite').addEventListener('click', () => {
  copyToClipboard(document.getElementById('invite-output').value);
});

document.getElementById('btn-import-reply').addEventListener('click', async () => {
  const reply = document.getElementById('reply-import').value;
  const result = await apiCall('POST', '/api/replies/import', { reply });
  if (result.code) {
    document.getElementById('error').textContent = result.message;
  } else {
    document.getElementById('success').textContent = 'Player added!';
    document.getElementById('reply-import').value = '';
    refreshStatus();
  }
});

document.getElementById('btn-toggle-listener').addEventListener('click', async () => {
  const btn = document.getElementById('btn-toggle-listener');
  const enable = btn.textContent === 'Enable';
  const result = await apiCall('POST', '/api/listener', { enable });
  if (result.code) {
    document.getElementById('error').textContent = result.message;
  } else {
    btn.textContent = enable ? 'Disable' : 'Enable';
    if (result.manualGuide) {
      document.getElementById('listener-guide').textContent = result.manualGuide;
      document.getElementById('listener-guide').classList.remove('hidden');
    }
  }
});

document.getElementById('btn-accept-guard').addEventListener('click', async () => {
  // VALIDATE[minor] F17: guard consent posted to /api/listener — wrong resource; no guard endpoint exists (F5).
  // fix: dedicated guard-consent endpoint (or settings field) wired to GamePortGuard.apply.
  const result = await apiCall('POST', '/api/listener', { guardConsent: true });
  if (result.code) {
    document.getElementById('error').textContent = result.message;
  } else {
    document.getElementById('guard-consent').classList.add('hidden');
  }
});

document.getElementById('btn-probe').addEventListener('click', async () => {
  const result = await apiCall('POST', '/api/probe', {});
  const diag = document.getElementById('diagnostics');
  if (result.code) {
    diag.innerHTML = '<span class="status-dot err"></span>Diagnostics failed: ' + result.message;
  } else {
    let html = '';
    html += '<div><span class="status-dot ' + (result.tunnel ? 'ok' : 'err') + '"></span>Tunnel: ' + (result.tunnel ? 'Carries traffic' : 'No traffic') + '</div>';
    html += '<div><span class="status-dot ' + (result.tcp ? 'ok' : 'err') + '"></span>Game TCP: ' + (result.tcp ? 'Reachable' : 'Unreachable') + '</div>';
    html += '<div><span class="status-dot ' + (result.udp ? 'ok' : 'err') + '"></span>Overlay UDP: ' + (result.udp ? 'Verified' : 'Failed') + '</div>';
    diag.innerHTML = html;
  }
});

document.getElementById('btn-copy-server').addEventListener('click', () => {
  copyToClipboard(document.getElementById('server-address').textContent);
});

document.getElementById('btn-remove-peer').addEventListener('click', async () => {
  const pubkey = document.getElementById('remove-peer-key').value;
  if (!pubkey) return;
  const result = await apiCall('DELETE', '/api/peers/' + encodeURIComponent(pubkey));
  if (result.code) {
    document.getElementById('error').textContent = result.message;
  } else {
    document.getElementById('success').textContent = 'Peer removed';
    document.getElementById('remove-peer-key').value = '';
    refreshStatus();
  }
});

function showDashboard() {
  document.getElementById('anchor-setup').classList.add('hidden');
  document.getElementById('member-setup').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('peers').classList.remove('hidden');
  document.getElementById('settings').classList.remove('hidden');
  document.getElementById('server-address-card').classList.remove('hidden');
  document.getElementById('diagnostics-card').classList.remove('hidden');
  document.getElementById('anchor-tools').classList.remove('hidden');
  refreshStatus();
}

async function refreshStatus() {
  const status = await apiCall('GET', '/api/status');
  const info = document.getElementById('status-info');
  if (status.status === 'ok') {
    info.innerHTML = '<span class="status-dot ok"></span>Running (uptime: ' + Math.floor(status.uptime) + 's)';
  } else {
    info.innerHTML = '<span class="status-dot err"></span>Error';
  }

  if (status.serverAddress) {
    document.getElementById('server-address').textContent = status.serverAddress;
  }

  if (status.peers && Array.isArray(status.peers)) {
    const list = document.getElementById('peer-list');
    list.innerHTML = status.peers.map(p =>
      '<li><span>' + p.name + ' (' + p.overlayIP + ')</span>' +
      '<span><span class="status-dot ' + (p.state === 'active' ? 'ok' : p.state === 'stale' ? 'warn' : 'err') + '"></span>' +
      p.state + ' | HS: ' + Math.floor(p.lastHandshakeAge || 0) + 's | RX: ' + (p.rxBytes || 0) + ' TX: ' + (p.txBytes || 0) + '</span></li>'
    ).join('');
  }

  if (status.guard) {
    const guard = document.getElementById('guard-state');
    guard.innerHTML = '<span class="status-dot ' + (status.guard.applied ? 'ok' : 'warn') + '"></span>Game-port guard: ' + (status.guard.applied ? 'Active' : 'Inactive');
    if (status.guard.warnings && status.guard.warnings.length > 0) {
      guard.innerHTML += '<div class="error-msg">' + status.guard.warnings.join('; ') + '</div>';
    }
  }
}

bootstrap();
