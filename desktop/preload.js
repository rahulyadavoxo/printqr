// Gives the PrintQR website (only print.receipto.in) two small powers inside the Windows app:
// list the printers and print an order file straight to a printer (no browser print dialog).
const { contextBridge, ipcRenderer } = require('electron')

if (location.protocol === 'https:' && location.hostname === 'print.receipto.in') {
  contextBridge.exposeInMainWorld('PQDesktop', {
    version: 2,
    printers: () => ipcRenderer.invoke('pq:printers'),
    print: (job) => ipcRenderer.invoke('pq:print', job)
  })
}
