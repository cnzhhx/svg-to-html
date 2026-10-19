import { getGatewayStore } from "../src/settings/gateway-store.js";
const mode = process.argv[2];
if (mode !== "setup" && mode !== "recovery") {
  console.error("Usage: pnpm admin:setup-token | pnpm admin:reset-password");
  process.exitCode = 1;
} else {
  try {
    const token = await getGatewayStore().issueToken(mode);
    console.log(`${mode === "setup" ? "初始化码" : "密码恢复码"}（15 分钟有效，仅限本机管理员查看）：\n${token}`);
    console.log(mode === "setup" ? "打开 /transformer/setup 创建管理员账号。" : "打开 /transformer/login，选择恢复密码。原账号名保持不变。");
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
