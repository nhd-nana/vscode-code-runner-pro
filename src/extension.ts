"use strict";
import * as vscode from "vscode";
import { CodeManager } from "./codeManager";

const ORIGINAL_EXTENSION_ID = "formulahendry.code-runner";
const COEXIST_WARNED_KEY = "crun.coexistWarned";

export function activate(context: vscode.ExtensionContext) {

    const codeManager = new CodeManager(context);

    vscode.window.onDidCloseTerminal(() => {
        codeManager.onDidCloseTerminal();
    });

    const register = (id: string, handler: (...args: any[]) => any) => {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    };

    const runHandler = (fileUri: vscode.Uri) => codeManager.run(null, fileUri);
    const runCustomCommandHandler = () => codeManager.runCustomCommand();
    const runByLanguageHandler = () => codeManager.runByLanguage();
    const stopHandler = () => codeManager.stop();

    register("crun.run", runHandler);
    register("crun.runCustomCommand", runCustomCommandHandler);
    register("crun.runByLanguage", runByLanguageHandler);
    register("crun.stop", stopHandler);
    register("crun.explain", () => codeManager.explainActiveFile());
    register("crun.showLanguageMap", () => codeManager.showLanguageMap());

    // 与上游扩展的兼容策略：
    // 配置沿用 code-runner.*（两边互通），命令自己一套（crun.*，避免抢注）。
    const original = vscode.extensions.getExtension(ORIGINAL_EXTENSION_ID);
    if (!original) {
        // 原版未安装或已禁用 → 补上别名，用户自己绑的快捷键 / tasks / 脚本里的
        // code-runner.run 等引用继续可用
        register("code-runner.run", runHandler);
        register("code-runner.runCustomCommand", runCustomCommandHandler);
        register("code-runner.runByLanguage", runByLanguageHandler);
        register("code-runner.stop", stopHandler);
    } else if (!context.globalState.get<boolean>(COEXIST_WARNED_KEY)) {
        // 原版仍启用：小三角位置会出现两个运行按钮，提示一次
        vscode.window.showWarningMessage(
            "检测到原版 Code Runner 仍处于启用状态：编辑器右上角会出现两个运行按钮。建议禁用其一（Code Runner Pro 是它的超集，推荐保留 Pro）。",
            "查看原版扩展",
            "不再提示"
        ).then((action) => {
            if (action === "查看原版扩展") {
                vscode.commands.executeCommand("workbench.extensions.search", "@id:" + ORIGINAL_EXTENSION_ID);
            } else if (action === "不再提示") {
                context.globalState.update(COEXIST_WARNED_KEY, true);
            }
        });
    }

    context.subscriptions.push(codeManager);
}

export function deactivate() {
}
