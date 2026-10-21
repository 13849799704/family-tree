; 家族谱自定义 NSIS 安装脚本片段（由 electron-builder 通过 nsis.include 注入）
;
; 编码要求（实测结论）：本文件必须是 UTF-8 且带 BOM。
;   electron-builder 传给 makensis 的主脚本是 UTF-8，include 的文件若带 UTF-8 BOM
;   NSIS 才按 UTF-8 解析；存成 GBK 或漏掉 BOM 会直接报
;   "Bad text encoding: installer.nsh:1" 导致构建失败。
;
; 为什么不固定安装目录（0.2.50 起）：
;   之前这里把默认安装目录写死成 "D:\族谱pc端项目\程序"（见 preInit 宏），
;   本意是让程序和数据都在 D 盘。但打包版是要**装到别人电脑上**用的 ——
;   别人机器上没有 D 盘、或 D 盘不可写时，NSIS 建不出这个目录，
;   结果就是「安装向导走完了、桌面快捷方式也有，双击却毫无反应」。
;   数据目录那边已经改成「有 D 盘用 D 盘、没有就放 C 盘用户目录」，
;   安装目录就没必要再绑 D 盘 —— 装在哪由用户在安装向导里自己挑
;   （allowToChangeInstallationDirectory = true，界面里可以改）。
;
; 现在默认装到：C:\Users\<用户名>\AppData\Local\Programs\家族谱
;   数据目录仍然独立在数据目录里，卸载 / 重装 / 删程序都不会丢族谱。

!macro preInit
!macroend
