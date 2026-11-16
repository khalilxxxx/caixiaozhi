# 财小智 · 通用单据卡片 Demo

本地 React + TypeScript 前端评审入口。所有数据、人物、流程和耗时均为虚构，查询由本地示例匹配，不连接模型或业务系统。

## 打开与运行

现有前端开发服务运行时，访问：

http://127.0.0.1:5173/document-query.html

也可在项目根目录单独启动这个 Demo：

```sh
node apps/web/node_modules/vite/bin/vite.js --config apps/web/vite.document-query.config.ts
```

独立服务地址：http://127.0.0.1:5186/document-query.html 。当前受限执行环境不能新绑定端口，因此本轮实际浏览器验收使用现有 5173 服务。原主应用入口保持独立。

满足项目声明的 Node 版本时也可使用 `pnpm demo:documents`。本次环境为 Node 22.16.0，直接运行 Vite、TypeScript、Vitest 验证通过；根项目的 npm devEngines 检查要求 Node 24.22.1，因此本环境不能使用 `npm run` 启动这些脚本。

## 卡片交互

默认卡片只展示三组信息，使用自适应高度，不用裁切固定高度强行压缩：

1. 标题与来源系统的具体状态。
2. 单据类型与最多两项核心摘要。
3. 来源、当前处理人与环节；有依据时附简短时间预估。

点击整张卡片打开详情抽屉，包含“办理进展”和“单据信息”两个页签。单号、完整流程、会签规则、退回原因、完整字段、更新时间和预估依据均在这里查看。支持 Esc 关闭、焦点恢复和键盘页签切换。

多单据默认显示三张，支持展开、来源筛选和状态筛选。底部“评审场景”可以切换空态与 OA 读取失败；读取失败不会当成零单据。点击卡片再关闭后，可追问“这张还要多久”。

## 跨系统设计

| 示例     | 卡片的两项摘要     | 说明                                 |
| -------- | ------------------ | ------------------------------------ |
| 差旅申请 | 行程、日期         | 预算放在详情，减少常显字段           |
| 费用报销 | 报销金额、费用期间 | 退回时突出当前需要本人补充的内容     |
| OA 请假  | 请假日期、时长     | 无金额，不显示空金额占位             |
| 采购付款 | 付款金额、收款方   | 审批通过后仍可处于执行阶段的“待付款” |
| 合同审批 | 相对方、合同金额   | 当前未处理人员与已通过人员分别表达   |
| 预算调拨 | 调拨金额、调拨方向 | 预算实际生效才显示完成               |

`DocumentCard` 不按单据类型写界面分支。`documentTypeRegistry` 控制摘要字段优先级；未知类型也可直接使用非空摘要字段。新增类型通常只需增加展示配置与模拟数据。

`source.id + typeId + id` 组成复合身份；相同单号存在于不同系统时不覆盖。`status` 是统一筛选分组，`sourceStatus` 保留原业务含义，`phase` 区分审批、执行和结束。金额和预估均为可选字段，审批预估不会沿用到付款阶段。

后续接真实系统时，各系统适配器负责提供同一展示结构；前端仅消费已授权的数据及可靠的流程、状态与预估。当前模型是评审用的展示契约，不作为完整生产接口规范。

## 文件

- `DocumentQueryDemo.tsx`：页面、卡片、详情和示例交互。
- `document-query.css`：独立样式与响应式布局。
- `document-model.ts`：通用展示结构与摘要规则。
- `fixtures.ts`：六种单据样例。
- `../../../document-query.html`：独立页面入口。

## 验证命令

从项目根目录执行：

```sh
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.document-query.json --noEmit
node node_modules/vitest/vitest.mjs run tests/unit/document-query-presentation.spec.ts
node apps/web/node_modules/vite/bin/vite.js build --config apps/web/vite.document-query.config.ts
```

构建产物为 `apps/web/dist-document-query/`，与原应用构建目录分开。

本轮浏览器验收覆盖：桌面与 390px 手机宽度、详情切换与 Esc 关闭、OA 无金额、审批后待付款、跨系统筛选、故障来源未知计数、正常来源空态、城市与业务类型不符时不返回错单。开发服务器控制台错误也纳入检查。

实际尺寸：1440px 桌面宽度下每张卡片 118px 高；390px 手机宽度下示例为 109–128px 高，长摘要自动换行。两种宽度均无横向溢出，控制台未发现错误。
