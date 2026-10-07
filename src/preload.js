'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('nexus', {
  /* app state */
  getState: () => ipcRenderer.invoke('state:get'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  /* settings */
  updateSettings: patch => ipcRenderer.invoke('settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  /* updates */
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateOpenRelease: () => ipcRenderer.invoke('update:release'),
  onUpdateProgress: cb => subscribe('update:progress', cb),

  /* skills & plugins (prompt-level) */
  skillsState: () => ipcRenderer.invoke('skills:state'),
  setSkills: patch => ipcRenderer.invoke('skills:set', patch),

  /* providers */
  saveProvider: (id, cfg) => ipcRenderer.invoke('providers:save', { id, cfg }),
  testProvider: id => ipcRenderer.invoke('providers:test', { id }),
  fetchModels: id => ipcRenderer.invoke('providers:models', { id }),

  /* chat */
  send: payload => ipcRenderer.invoke('chat:send', payload),
  stop: () => ipcRenderer.invoke('chat:stop'),
  onChatBegin: cb => subscribe('chat:begin', cb),
  onChatDelta: cb => subscribe('chat:delta', cb),
  onChatDone: cb => subscribe('chat:done', cb),
  onChatError: cb => subscribe('chat:error', cb),

  /* conversations */
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  createConversation: title => ipcRenderer.invoke('conversations:create', { title }),
  getConversation: id => ipcRenderer.invoke('conversations:get', { id }),
  renameConversation: (id, title) => ipcRenderer.invoke('conversations:rename', { id, title }),
  deleteConversation: id => ipcRenderer.invoke('conversations:delete', { id }),

  /* bots (local scheduled task runners) */
  listBots: () => ipcRenderer.invoke('bots:list'),
  createBot: data => ipcRenderer.invoke('bots:create', data),
  updateBot: (id, patch) => ipcRenderer.invoke('bots:update', { id, patch }),
  setBotStatus: (id, status) => ipcRenderer.invoke('bots:setStatus', { id, status }),
  removeBot: id => ipcRenderer.invoke('bots:remove', { id }),
  runBot: id => ipcRenderer.invoke('bots:run', { id }),
  botRuns: (id, limit) => ipcRenderer.invoke('bots:runs', { id, limit }),
  botChat: id => ipcRenderer.invoke('bots:chat', { id }),
  botSend: (id, text) => ipcRenderer.invoke('bots:send', { id, text }),
  onBotChanged: cb => subscribe('bot:changed', cb),

  /* agent: tools on this machine (permissions asked for, never auto-accepted) */
  agentInfo: () => ipcRenderer.invoke('agent:info'),
  setAgentWorkspace: () => ipcRenderer.invoke('agent:setWorkspace'),
  clearAgentGrants: () => ipcRenderer.invoke('agent:clearGrants'),
  answerTool: (id, decision, reason) => ipcRenderer.invoke('agent:allow', { id, decision, reason }),
  onToolAsk: cb => subscribe('tool:ask', cb),
  onToolPlan: cb => subscribe('tool:plan', cb),
  onToolResult: cb => subscribe('tool:result', cb),

  /* ssh (system OpenSSH against hosts saved in Settings) */
  sshRun: (hostId, command) => ipcRenderer.invoke('ssh:run', { hostId, command }),
  sshList: (hostId, path) => ipcRenderer.invoke('ssh:list', { hostId, path }),
  sshRead: (hostId, path) => ipcRenderer.invoke('ssh:read', { hostId, path }),
  sshSave: (hostId, path, name) => ipcRenderer.invoke('ssh:save', { hostId, path, name }),
  sshTest: hostId => ipcRenderer.invoke('ssh:test', { hostId }),
  sshForgetKey: hostId => ipcRenderer.invoke('ssh:forgetKey', { hostId }),

  /* data */
  openDataFolder: () => ipcRenderer.invoke('app:dataFolder'),
  exportData: () => ipcRenderer.invoke('app:export'),
  importData: () => ipcRenderer.invoke('app:import')
});
