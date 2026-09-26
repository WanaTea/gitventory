import appGenericIcon from '../assets/icons/app-generic.svg'
import finderIcon from '../assets/icons/finder.png'
import vscodeIcon from '../assets/icons/vscode.svg'
import codebuddyIcon from '../assets/icons/codebuddy.png'
import traeIcon from '../assets/icons/trae.png'
import warpIcon from '../assets/icons/warp.png'

/**
 * 打开目标 → 图标。
 *
 * 目标清单是**运行期数据**（服务端按 config/open-targets.json + 内置默认下发），
 * 所以这里不再用 Record<OpenTarget, string> 做穷尽校验，而是「已知 id 的映射 + 兜底图标」：
 * 使用者加一个自己的 IDE，也能渲染出一个可点的按钮，而不是因为缺图标被静默丢掉。
 */
const ICONS: Readonly<Record<string, string>> = {
  finder: finderIcon,
  vscode: vscodeIcon,
  codebuddy: codebuddyIcon,
  trae: traeIcon,
  warp: warpIcon,
}

export function iconOf(id: string): string {
  return ICONS[id] ?? appGenericIcon
}
