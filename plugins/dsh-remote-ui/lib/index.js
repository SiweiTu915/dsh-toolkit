/**
 * dsh-remote-ui — 宿主侧(最小实现)
 *
 * 这个插件的主体是浏览器侧(lib/client.js):它在工作台里画出远程文件浏览器。
 * 数据来自本机 dsh-remote 面板的 HTTP API(127.0.0.1:4100,由 rw.mjs 同一套 SFTP 层提供)。
 * 宿主侧目前不需要注册服务,保留一个空插件以便 loader 有条目可挂。
 */
export const name = 'dsh-remote-ui'
export function apply() { /* 无宿主侧行为 */ }
export default { name, apply }
