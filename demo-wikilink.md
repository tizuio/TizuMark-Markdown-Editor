# ![[ ]] 图片嵌入 人工验收样例

> 本文件放在项目根目录。用 TizuMark 打开它，逐条对照右侧预览。

## 1. 基础识别（相对路径按笔记目录解析，alt 取文件名）

![[assets/icon.png]]

## 2. 仅设宽（等比高）`|600`

![[assets/donate-alipay.png|600]]

## 3. 设宽×高 `|600x400`

![[assets/donate-wechat.png|600x400]]

## 4. 非数字后缀当 alt（带空格）

![[screenshots/01-main.png|主界面截图]]

## 5. 含冒号/连字符的时间戳文件名（转义与解析）

![[assets/image-2026-07-08T1632.png]]

## 6. 多图同篇

![[src/github-icon.png]]
![[src/gitee-icon.png]]
![[donate-alipay.png]]

## 7. 非图片扩展名——不转换，按原文本显示

![[demo.md]]

## 8. 无 `!` 的链接——不渲染成图片

[[icon.png]]

## 9. 行内代码内的 `![[ ]]`——不渲染，按代码显示

这是行内代码：`![[assets/icon.png]]`，不应变成图片。

## 10. 围栏代码块内的 `![[ ]]`——不渲染，按代码块显示

```
![[assets/icon.png|600x400]]
![[demo.md]]
```

---

## 关键验收点（最要紧）

输入下面这行 → 预览正常 → **Ctrl+S 保存 → 关闭重开本文件**：

![[assets/icon.png|600x400]]

编辑器里内容仍是 `![[assets/icon.png|600x400]]`（没被改成 `![](...)` 或绝对路径），且预览仍正常。
这表示笔记在 Obsidian 里继续可编辑。
