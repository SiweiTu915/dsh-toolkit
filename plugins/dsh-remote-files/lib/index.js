/**
 * dsh-remote-files —— 宿主半边。
 *
 * 这个包是「双面插件」:功能全在浏览器侧的 `lib/client.js`(注册成右侧栏的一个标签页),
 * 宿主这半边只需要能被 Loader 当普通插件加载即可 —— 它不 provide 任何服务、不碰文件、
 * 也不需要注入任何东西。
 *
 * 数据通道:客户端直接调本机 dsh-remote 面板的 HTTP API(默认 127.0.0.1:4100),
 * 由面板经 ssh2/SFTP 就地读写远程文件 —— 和挂载型 provider 是**两条独立的路**,
 * 所以即使某个分区没挂远程文件系统,这个面板也能用。
 */
export const name = 'dsh-remote-files'

export function apply() {
  // 无宿主行为:全部逻辑在客户端半边。
}
