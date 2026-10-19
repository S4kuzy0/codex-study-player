# 测试与演示

所有回归运行在新建的本机临时端口、独立浏览器上下文和 `work/` 下的临时状态目录。服务测试将 CLI 指向一个不存在的测试路径；浏览器测试拦截模型接口并返回明确的合成回答。它们不使用已有播放器地址、用户浏览器资料或真实模型账号。

## 不安装测试依赖的服务检查

需要 Node.js 24：

```sh
npm test
```

覆盖静态资源完整性、项目与运行文件不可通过静态地址读取、Host/Origin 校验、API token 与输入校验，以及缺少 CLI 时的错误回传。

## 浏览器回归

安装开发依赖和 Playwright Chromium 后执行：

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

已安装 Chrome/Chromium 时可省去浏览器下载，设置 `PLAYWRIGHT_EXECUTABLE_PATH` 为其可执行文件完整路径。测试使用临时资料目录，不连接该浏览器的个人会话。

脚本读取仓库自制的两秒静音 WebM（来源与再生成方式见 `tests/fixtures/README.md`），实际导入 IndexedDB，核对页面重载持久化、两段对话隔离、归档、恢复和确认删除后的重载状态。过程中更新 `docs/images/player-demo.png`；图片中的课程和回答都是示例。

这些检查不证明真实 Codex 模型可用、所有视频编码均受浏览器支持，或完整覆盖历史测试中的所有交互。真实问答与个人安装应分别核验。
