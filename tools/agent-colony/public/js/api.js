async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-colony': '1' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export const api = {
  state: () => request('GET', '/api/state'),
  task: (id) => request('GET', `/api/tasks/${id}`),
  startTask: (repo, prompt, opts) => request('POST', '/api/tasks', { repo, prompt, ...opts }),
  worktree: (id) => request('GET', `/api/threads/${id}/worktree`),
  stopTask: (id) => request('POST', `/api/tasks/${id}/stop`),
  open: (id, mode) => request('POST', `/api/threads/${id}/open`, { mode }),
  archive: (id) => request('POST', `/api/threads/${id}/archive`),
  viewed: (id) => request('POST', `/api/threads/${id}/viewed`),
  reply: (id, prompt, permissionMode) => request('POST', `/api/threads/${id}/reply`, { prompt, permissionMode }),
  addRepo: (path) => request('POST', '/api/repos/add', { path }),
  unpinRepo: (path) => request('POST', '/api/repos/unpin', { path }),
  allowTools: (repo, tools) => request('POST', '/api/repos/allow', { repo, tools }),
  reveal: (repo) => request('POST', '/api/repos/reveal', { repo }),
  clearArchive: () => request('POST', '/api/archive/clear'),
}
