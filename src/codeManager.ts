"use strict";
import * as fs from "fs";
import * as micromatch from "micromatch";
import * as os from "os";
import { basename, dirname, extname, join } from "path";
import * as vscode from "vscode";
import { AppInsightsClient } from "./appInsightsClient";
import { Constants } from "./constants";
import { Utility } from "./utility";

const TmpDir = os.tmpdir();

// ---------------------------------------------------------------------------
// fork 扩展：多命令 / 非文本文件 / 多段后缀 / 多选区原样拼接
// ---------------------------------------------------------------------------

export interface CodeAction {
    label: string;
    command: string;
    description?: string;
    detail?: string;
}

// fork: 匹配步骤全集。顺序 = 默认 matchOrder（具体优先：shebang → glob → 后缀 → 语言 → 兜底）
const MATCH_STEPS = ["shebang", "glob", "extension", "language", "default"];

export class CodeManager implements vscode.Disposable {
    private _outputChannel: vscode.OutputChannel;
    private _terminal: vscode.Terminal;
    private _isRunning: boolean;
    private _process;
    private _codeFile: string;
    private _isTmpFile: boolean;
    private _languageId: string;
    private _cwd: string;
    private _runFromExplorer: boolean;
    private _document: vscode.TextDocument;
    private _filePath: string;
    private _workspaceFolder: string;
    private _config: vscode.WorkspaceConfiguration;
    private _appInsightsClient: AppInsightsClient;
    private _TERMINAL_DEFAULT_SHELL_WINDOWS: string | null = null;

    constructor(private readonly _extContext?: vscode.ExtensionContext) {
        this._outputChannel = vscode.window.createOutputChannel("Code Runner Pro");
        this._terminal = null;
        this._appInsightsClient = new AppInsightsClient();
    }

    public onDidCloseTerminal(): void {
        this._terminal = null;
    }

    public async run(languageId: string = null, fileUri: vscode.Uri = null) {
        if (this._isRunning) {
            vscode.window.showInformationMessage("Code is already running!");
            return;
        }

        try {
            this._runFromExplorer = this.checkIsRunFromExplorer(fileUri);
            if (this._runFromExplorer) {
                await this.resolveTarget(fileUri);
            } else {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    this._document = editor.document;
                    this._filePath = editor.document.fileName;
                } else {
                    // fork: 自定义编辑器（Office Viewer 等）/ 二进制视图没有 activeTextEditor，回退到活动标签
                    const uri = this.getActiveTabUri();
                    if (!uri) {
                        vscode.window.showInformationMessage("No code found or selected.");
                        return;
                    }
                    await this.resolveTarget(uri);
                }
            }

            this.initialize();

            const fileExtension = this.getFileExtension();
            const resolved = this.resolveActions(languageId, fileExtension);
            if (!resolved || resolved.actions.length === 0) {
                this.diagnose(fileExtension);
                vscode.window.showInformationMessage("Code language not supported or defined.");
                return;
            }

            const action = await this.pickAction(resolved);
            if (!action) {
                return;
            }

            this.getCodeFileAndExecute(fileExtension, action.command);
        } catch (error) {
            vscode.window.showErrorMessage("Code Runner: " + (error && error.message ? error.message : error));
        }
    }

    public runCustomCommand(): void {
        if (this._isRunning) {
            vscode.window.showInformationMessage("Code is already running!");
            return;
        }

        this._runFromExplorer = false;
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this._document = editor.document;
        }

        this.initialize();

        const executor = this._config.get<string>("customCommand");

        if (this._document) {
            const fileExtension = extname(this._document.fileName);
            this.getCodeFileAndExecute(fileExtension, executor, false);
        } else {
            this.executeCommand(executor, false);
        }
    }

    public runByLanguage(): void {
        this._appInsightsClient.sendEvent("runByLanguage");
        const config = this.getConfiguration("code-runner");
        const executorMap = config.get<any>("executorMap");
        vscode.window.showQuickPick(Object.keys(executorMap), { placeHolder: "Type or select language to run" }).then((languageId) => {
            if (languageId !== undefined) {
                this.run(languageId);
            }
        });
    }

    public stop(): void {
        this._appInsightsClient.sendEvent("stop");
        this.stopRunning();
    }

    public dispose() {
        this.stopRunning();
    }

    private checkIsRunFromExplorer(fileUri: vscode.Uri): boolean {
        const editor = vscode.window.activeTextEditor;
        if (!fileUri || !fileUri.fsPath) {
            return false;
        }
        if (!editor) {
            return true;
        }
        if (fileUri.fsPath === editor.document.uri.fsPath) {
            return false;
        }
        return true;
    }

    /**
     * fork: 把目标解析成「路径 + 可选文档」。非文本文件（docx/exe/pdf...）打开文档会失败，
     * 此时只保留路径，后续仍可执行命令（原版在这里直接中断，导致二进制文件无法运行）。
     */
    private async resolveTarget(uri: vscode.Uri): Promise<void> {
        this._filePath = uri.fsPath;
        this._document = undefined;
        try {
            this._document = await vscode.workspace.openTextDocument(uri);
        } catch {
            this._document = undefined;
        }
    }

    private getActiveTabUri(): vscode.Uri {
        const tabGroup = vscode.window.tabGroups.activeTabGroup;
        const input: any = tabGroup && tabGroup.activeTab && tabGroup.activeTab.input;
        if (!input) {
            return undefined;
        }
        if (input instanceof vscode.TabInputText) {
            return input.uri;
        }
        if (input instanceof vscode.TabInputCustom) {
            return input.uri;
        }
        if (input instanceof vscode.TabInputTextDiff) {
            return input.modified || input.original;
        }
        if (input.uri instanceof vscode.Uri) {
            return input.uri;
        }
        return undefined;
    }

    private getFileExtension(): string {
        const ext = extname(this._filePath);
        return ext ? ext.toLowerCase() : ext;
    }

    /** fork: 未匹配到命令时，把关键信息打到输出面板，便于排查配置问题 */
    private diagnose(fileExtension: string): void {
        const executorMap = this._config.get<any>("executorMap") || {};
        const byExtension = this._config.get<any>("executorMapByFileExtension") || {};
        const byGlob = this._config.get<any>("executorMapByGlob") || {};
        this._outputChannel.appendLine("[Debug] 未匹配到可执行命令");
        this._outputChannel.appendLine("  filePath        = " + this._filePath);
        this._outputChannel.appendLine("  extension       = " + fileExtension);
        this._outputChannel.appendLine("  languageId      = " + this._languageId);
        this._outputChannel.appendLine("  可读取文件内容  = " + !!this._document);
        this._outputChannel.appendLine("  defaultLanguage = " + this._config.get<string>("defaultLanguage"));
        this._outputChannel.appendLine("  executorMap 键数 = " + Object.keys(executorMap).length + " : " + Object.keys(executorMap).slice(0, 12).join(", "));
        this._outputChannel.appendLine("  后缀表 键数      = " + Object.keys(byExtension).length + " : " + Object.keys(byExtension).slice(0, 12).join(", "));
        this._outputChannel.appendLine("  glob 表 键数     = " + Object.keys(byGlob).length);
        this._outputChannel.show(true);
    }

    private stopRunning() {
        if (this._isRunning) {
            this._isRunning = false;
            vscode.commands.executeCommand("setContext", "crun.codeRunning", false);
            const kill = require("tree-kill");
            kill(this._process.pid);
        }
    }

    private initialize(): void {
        this._config = this.getConfiguration("code-runner");
        this._cwd = this._config.get<string>("cwd");
        if (this._cwd) {
            return;
        }
        this._workspaceFolder = this.getWorkspaceFolder();
        // fork: 非文本文件没有 _document，用 _filePath 兜底
        if ((this._config.get<boolean>("fileDirectoryAsCwd") || !this._workspaceFolder)
            && this._filePath && !this.isUntitled()) {
            this._cwd = dirname(this._filePath);
        } else {
            this._cwd = this._workspaceFolder;
        }
        if (this._cwd) {
            return;
        }
        this._cwd = TmpDir;
    }

    private isUntitled(): boolean {
        return !!(this._document && this._document.isUntitled);
    }

    private getConfiguration(section?: string): vscode.WorkspaceConfiguration {
        return Utility.getConfiguration(section, this._document);
    }

    private getWorkspaceFolder(): string {
        if (vscode.workspace.workspaceFolders) {
            if (this._document) {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(this._document.uri);
                if (workspaceFolder) {
                    return workspaceFolder.uri.fsPath;
                }
            } else if (this._filePath) {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this._filePath));
                if (workspaceFolder) {
                    return workspaceFolder.uri.fsPath;
                }
            }
            return vscode.workspace.workspaceFolders[0].uri.fsPath;
        } else {
            return undefined;
        }
    }

    private getCodeFileAndExecute(fileExtension: string, executor: string, appendFile: boolean = true): any {
        let selections: readonly vscode.Selection[] = [];
        const activeTextEditor = vscode.window.activeTextEditor;
        // fork: 只有活动编辑器就是目标文档时才采用它的选区（目标可能是自定义编辑器里的文件）
        if (activeTextEditor && this._document && activeTextEditor.document === this._document) {
            selections = activeTextEditor.selections;
        }
        const ignoreSelection = this._config.get<boolean>("ignoreSelection");
        const namedSelections = selections.filter((item) => !item.isEmpty);
        const hasSelection = !ignoreSelection && namedSelections.length > 0;
        const useWholeFile = this._runFromExplorer || !hasSelection;
        const hasFile = !!this._filePath && !this.isUntitled();

        if (useWholeFile && hasFile) {
            this._isTmpFile = false;
            this._codeFile = this._filePath;

            if (this._config.get<boolean>("saveAllFilesBeforeRun")) {
                return vscode.workspace.saveAll().then(() => {
                    this.executeCommand(executor, appendFile);
                });
            }

            // fork: 非文本文件没有 document，跳过保存
            if (this._config.get<boolean>("saveFileBeforeRun") && this._document) {
                return this._document.save().then(() => {
                    this.executeCommand(executor, appendFile);
                });
            }
        } else {
            if (!this._document) {
                vscode.window.showInformationMessage("Code Runner: 无法读取该文件内容（非文本文件）。");
                return;
            }

            let text: string;
            if (useWholeFile) {
                text = this._document.getText();
            } else if (namedSelections.length > 1 && this.getMultiSelectionMode() === "concat") {
                // fork: 多选区（Alt 多选）→ 按文档顺序原样拼接
                const ordered = namedSelections.slice().sort((a, b) =>
                    a.start.line - b.start.line || a.start.character - b.start.character);
                text = ordered.map((item) => this._document.getText(item)).join("\n");
            } else {
                text = this._document.getText(namedSelections[0]);
            }

            if (this._languageId === "php") {
                text = text.trim();
                if (!text.startsWith("<?php")) {
                    text = "<?php\r\n" + text;
                }
            }

            this._isTmpFile = true;
            const folder = (this._document.isUntitled) ? this._cwd : dirname(this._filePath);
            this.createRandomFile(text, folder, fileExtension);
        }

        this.executeCommand(executor, appendFile);
    }

    private getMultiSelectionMode(): string {
        return this._config.get<string>("multiSelectionMode") || "concat";
    }

    private rndName(): string {
        return Math.random().toString(36).replace(/[^a-z]+/g, "").substr(0, 10);
    }

    /**
     * 生成运行选中片段用的临时文件：后缀**完全沿用原文件**（无后缀的文件就生成无后缀的临时文件）。
     * 一致性原则：临时文件与原文件走同一套「后缀 + 命令」，因此原文件跑不了时临时文件也跑不了——
     * 那属于配置问题（files.associations / executorMap），应当直接修配置，而不是靠推断后缀掩盖。
     */
    private createRandomFile(content: string, folder: string, fileExtension: string) {
        const fileType = fileExtension || "";
        const temporaryFileName = this._config.get<string>("temporaryFileName");
        const tmpFileNameWithoutExt = temporaryFileName ? temporaryFileName : "temp" + this.rndName();
        const tmpFileName = tmpFileNameWithoutExt + fileType;
        this._codeFile = join(folder, tmpFileName);
        fs.writeFileSync(this._codeFile, content);

        // fork: 便于核对拼接结果
        if (this._config.get<boolean>("showTempCode")) {
            this._outputChannel.show(true);
            this._outputChannel.appendLine("[Temp File] " + this._codeFile);
            this._outputChannel.appendLine("--------------------");
            this._outputChannel.appendLine(content);
            this._outputChannel.appendLine("--------------------");
        }
    }

    /**
     * fork: 解析候选动作列表（取代原版「一条命令」）。
     * 步骤顺序由 code-runner.matchOrder 决定，默认（具体优先）：
     *   shebang → glob → extension → language → default
     * 三张表的值都支持：字符串 / 字符串数组 / { label, command, description, detail } 对象数组。
     */
    private resolveActions(languageId: string, fileExtension: string, trace?: string[])
        : { actions: CodeAction[]; key: string; step: string } {
        const explicit = languageId !== null;
        this._languageId = explicit ? languageId : (this._document ? this._document.languageId : undefined);
        const log = (line: string) => { if (trace) { trace.push(line); } };

        for (const step of this.getMatchOrder()) {
            const matched = this.matchStep(step, explicit, fileExtension, log);
            if (matched) {
                log("=> 命中 [" + step + "] " + matched.key);
                return { actions: matched.actions, key: matched.key, step };
            }
        }
        return undefined;
    }

    /**
     * fork: 匹配步骤顺序。
     * 配置是**一个字符串**（逗号 / 分号 / 空白分隔），好处是可以整体编辑、粘贴、清空：
     *   - 留空 = 使用默认顺序（无需“恢复默认”按钮）
     *   - 整体重写 = 不会遇到“只能加在末尾”“不能改成已存在的项”这些数组 UI 的限制
     * 兼容早期版本的数组写法；非法项与重复项会被忽略，未列出的步骤按默认顺序补在末尾。
     */
    private getMatchOrder(): string[] {
        const raw = this._config.get<any>("matchOrder");
        let parts: any[] = [];
        if (Array.isArray(raw)) {
            parts = raw;
        } else if (typeof raw === "string") {
            parts = raw.split(/[,;\s]+/);
        }
        const configured: string[] = [];
        for (const part of parts) {
            const step = String(part).trim().toLowerCase();
            if (MATCH_STEPS.indexOf(step) >= 0 && configured.indexOf(step) < 0) {
                configured.push(step);
            }
        }
        const rest = MATCH_STEPS.filter((step) => configured.indexOf(step) < 0);
        return configured.concat(rest);
    }

    private matchStep(step: string, explicit: boolean, fileExtension: string, log: (line: string) => void)
        : { actions: CodeAction[]; key: string } {
        const executorMap = this._config.get<any>("executorMap") || {};

        switch (step) {
            case "shebang": {
                if (explicit || !this._document || !this._config.get<boolean>("respectShebang")) {
                    log("shebang   : 跳过（" + (explicit ? "命令面板显式指定语言" : this._document ? "respectShebang=false" : "非文本文件") + "）");
                    return undefined;
                }
                const firstLineInFile = this._document.lineAt(0).text;
                if (/^#!(?!\[)/.test(firstLineInFile)) { // #![...] are used in rust https://doc.rust-lang.org/reference/attributes.html
                    log("shebang   : ✅ " + firstLineInFile.trim());
                    return { actions: [{ label: "shebang", command: firstLineInFile.slice(2) }], key: "shebang" };
                }
                log("shebang   : 无 #!");
                return undefined;
            }
            case "glob": {
                const globMap = this._config.get<any>("executorMapByGlob") || {};
                const globKeys = Object.keys(globMap || {});
                if (!this._filePath || globKeys.length === 0) {
                    log("glob      : 未配置");
                    return undefined;
                }
                const fileBasename = basename(this._filePath);
                for (const glob of globKeys) {
                    if (micromatch.isMatch(fileBasename, glob)) {
                        log("glob      : ✅ " + glob);
                        return { actions: this.toActions(globMap[glob]), key: glob };
                    }
                }
                log("glob      : 未命中（已配置 " + globKeys.join(" / ") + "）");
                return undefined;
            }
            case "language": {
                if (!this._languageId) {
                    log("language  : 无 languageId");
                    return undefined;
                }
                const value = executorMap[this._languageId];
                if (value != null) {
                    log("language  : ✅ " + this._languageId);
                    return { actions: this.toActions(value), key: this._languageId };
                }
                log("language  : " + this._languageId + " 在 executorMap 里没配");
                return undefined;
            }
            case "extension": {
                const hit = this.matchByFileExtension(this._filePath, this._config.get<any>("executorMapByFileExtension"));
                if (hit) {
                    log("extension : ✅ " + hit.key);
                    this._languageId = hit.key;
                    return { actions: this.toActions(hit.value), key: hit.key };
                }
                log("extension : 未命中");
                return undefined;
            }
            case "default": {
                const defaultLanguage = this._config.get<string>("defaultLanguage");
                if (!defaultLanguage) {
                    log("default   : 未设置 defaultLanguage");
                    return undefined;
                }
                const value = executorMap[defaultLanguage];
                if (value != null) {
                    log("default   : ⚠️ 兜底命中 " + defaultLanguage);
                    this._languageId = defaultLanguage;
                    return { actions: this.toActions(value), key: defaultLanguage };
                }
                log("default   : " + defaultLanguage + " 也没配命令");
                return undefined;
            }
        }
        return undefined;
    }

    /**
     * fork: 解释「当前文件会怎样被匹配」，逐步列出每个步骤的结果。
     * 比反复点小三角快，也是调 matchOrder 时的首选工具。
     */
    public async explainActiveFile(): Promise<void> {
        try {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                this._document = editor.document;
                this._filePath = editor.document.fileName;
            } else {
                const uri = this.getActiveTabUri();
                if (!uri) {
                    vscode.window.showInformationMessage("Code Runner: 当前没有活动文件。");
                    return;
                }
                await this.resolveTarget(uri);
            }
            this.initialize();

            const fileExtension = this.getFileExtension();
            const trace: string[] = [];
            const resolved = this.resolveActions(null, fileExtension, trace);
            await this.showReport(this.buildExplainReport(fileExtension, trace, resolved), "code-runner-pro-explain.md");
        } catch (error) {
            vscode.window.showErrorMessage("Code Runner: " + (error && error.message ? error.message : error));
        }
    }

    private buildExplainReport(fileExtension: string, trace: string[], resolved: { actions: CodeAction[]; key: string; step: string }): string {
        const fileBasename = basename(this._filePath);
        const associations = vscode.workspace.getConfiguration("files").get<any>("associations") || {};
        const matchedAssociations = Object.keys(associations)
            .filter((glob) => micromatch.isMatch(fileBasename, glob))
            .map((glob) => "`" + glob + "` → `" + associations[glob] + "`");

        const lines: string[] = [];
        lines.push("# Code Runner Pro · 当前文件匹配解释");
        lines.push("");
        lines.push("| 项 | 值 |");
        lines.push("|---|---|");
        lines.push("| 文件 | `" + this._filePath + "` |");
        lines.push("| 可读取内容 | " + (this._document ? "是（文本文件）" : "否（当路径处理）") + " |");
        lines.push("| 文件后缀 | `" + fileExtension + "` |");
        lines.push("| languageId | `" + (this._languageId || "(无)") + "` |");
        lines.push("| `files.associations` 命中 | " + (matchedAssociations.length ? matchedAssociations.join("、") : "（无）") + " |");
        lines.push("");
        lines.push("## 匹配顺序");
        lines.push("");
        lines.push("`" + this.getMatchOrder().join(" → ") + "`");
        lines.push("");
        lines.push("## 逐步结果");
        lines.push("");
        trace.forEach((line) => lines.push("- " + line));
        lines.push("");
        lines.push("## 结论");
        lines.push("");
        if (resolved) {
            lines.push("✅ 第 **" + resolved.step + "** 步命中：`" + resolved.key + "`");
            lines.push("");
            resolved.actions.forEach((action, index) => {
                lines.push((index + 1) + ". **" + action.label + "**" + (action.description ? "（" + action.description + "）" : ""));
                lines.push("   ```");
                lines.push("   " + action.command);
                lines.push("   ```");
            });
        } else {
            lines.push("❌ 没有任何步骤命中 → 点小三角会弹 `Code language not supported or defined.`");
            lines.push("");
            lines.push("可以给 `executorMapByFileExtension` 加一条 `" + fileExtension + "`，或调整 `matchOrder`。");
        }

        // 环境信息：反馈问题时连同本报告一起贴出去，省得来回问
        lines.push("");
        lines.push("## 环境");
        lines.push("");
        lines.push("| 项 | 值 |");
        lines.push("|---|---|");
        lines.push("| 扩展版本 | " + this.getExtensionVersion() + " |");
        lines.push("| VS Code | " + vscode.version + " |");
        lines.push("| 系统 | " + os.platform() + " " + os.arch() + " |");
        lines.push("| 默认终端 | " + (vscode.workspace.getConfiguration("terminal").get<string>("integrated.defaultProfile.windows") || "(未设置)") + " |");
        lines.push("| shell | " + (vscode.env.shell || "(未知)") + " |");
        lines.push("| matchOrder | " + this.getMatchOrder().join(" → ") + " |");
        lines.push("| defaultLanguage | " + (this._config.get<string>("defaultLanguage") || "(未设置)") + " |");
        lines.push("| runInTerminal | " + this._config.get<boolean>("runInTerminal") + " |");
        lines.push("| 选中片段策略 | " + (this._config.get<string>("multiSelectionMode") || "concat") + " |");
        lines.push("");
        lines.push("> 反馈问题时可直接附上本文件内容；**发送前请自行检查是否包含不想公开的路径**。");
        return lines.join("\n");
    }

    private getExtensionVersion(): string {
        const extension = this._extContext && this._extContext.extension;
        return extension && extension.packageJSON ? String(extension.packageJSON.version) : "unknown";
    }

    /**
     * fork: 「扩展名 → 语言 id」只读对照表。
     * VS Code 没有这样的 API，这里遍历所有扩展的 contributes.languages + 用户的 files.associations 自己拼。
     */
    public async showLanguageMap(): Promise<void> {
        const byExtension = new Map<string, string[]>();
        const byFilename = new Map<string, string[]>();
        const add = (map: Map<string, string[]>, key: string, languageId: string) => {
            const list = map.get(key) || [];
            if (list.indexOf(languageId) < 0) {
                list.push(languageId);
            }
            map.set(key, list);
        };

        for (const extension of vscode.extensions.all) {
            const contributes = extension.packageJSON && extension.packageJSON.contributes;
            const languages = contributes && contributes.languages;
            if (!languages) {
                continue;
            }
            for (const language of languages) {
                (language.extensions || []).forEach((item: string) => add(byExtension, item, language.id));
                (language.filenames || []).forEach((item: string) => add(byFilename, item, language.id));
            }
        }

        const associations = vscode.workspace.getConfiguration("files").get<any>("associations") || {};

        const lines: string[] = [];
        lines.push("# 扩展名 → 语言 id 对照表（只读）");
        lines.push("");
        lines.push("来源：所有已安装扩展的 `contributes.languages` + 你的 `files.associations`。");
        lines.push("");
        lines.push("> ⚠️ 一个扩展名可能被多个扩展声明，VS Code 内部的取舍规则不公开；**实际归属以当前文件的 `languageId` 为准**，用 `Explain Current File` 查最准。");
        lines.push("");
        lines.push("## 用户的 files.associations（优先级最高，共 " + Object.keys(associations).length + " 条）");
        lines.push("");
        lines.push("| 模式 | 语言 id |");
        lines.push("|---|---|");
        Object.keys(associations).forEach((glob) => lines.push("| `" + glob + "` | `" + associations[glob] + "` |"));
        lines.push("");
        lines.push("## 扩展贡献的扩展名（共 " + byExtension.size + " 个）");
        lines.push("");
        lines.push("| 扩展名 | 声明它的语言 id |");
        lines.push("|---|---|");
        Array.from(byExtension.keys()).sort().forEach((ext) => {
            lines.push("| `" + ext + "` | " + byExtension.get(ext).map((id) => "`" + id + "`").join("、") + " |");
        });
        lines.push("");
        lines.push("## 扩展贡献的完整文件名（共 " + byFilename.size + " 个）");
        lines.push("");
        lines.push("| 文件名 | 声明它的语言 id |");
        lines.push("|---|---|");
        Array.from(byFilename.keys()).sort().forEach((name) => {
            lines.push("| `" + name + "` | " + byFilename.get(name).map((id) => "`" + id + "`").join("、") + " |");
        });

        await this.showReport(lines.join("\n"), "code-runner-pro-language-map.md");
    }

    /** 把报告写成真实的 .md 文件（untitled 文档没有 .md 后缀，无法预览） */
    private async showReport(content: string, fileName: string): Promise<void> {
        const filePath = join(os.tmpdir(), fileName);
        fs.writeFileSync(filePath, content, "utf8");
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(document, { preview: false });
    }

    private toActions(value: any): CodeAction[] {
        if (value == null) {
            return [];
        }
        const list = Array.isArray(value) ? value : [value];
        return list.map((item: any, index: number) => {
            if (typeof item === "string") {
                return { label: "命令 " + (index + 1), command: item, detail: item };
            }
            return {
                label: item.label || item.name || ("命令 " + (index + 1)),
                command: item.command || item.executor,
                description: item.description,
                detail: item.detail || item.command || item.executor,
            } as CodeAction;
        }).filter((action: CodeAction) => !!action.command);
    }

    /**
     * fork: 按「文件名末尾」匹配后缀表，支持多段后缀（.x64.s / .mips.s），最长者优先。
     * 兼容原版：单段后缀（.asm）同样命中。
     */
    private matchByFileExtension(filePath: string, map: any): { key: string; value: any } {
        if (!filePath || !map) {
            return undefined;
        }
        const fileBasename = basename(filePath).toLowerCase();
        let bestKey: string = null;
        for (const key of Object.keys(map)) {
            if (!key.startsWith(".")) {
                continue;
            }
            if (fileBasename.endsWith(key.toLowerCase()) && (bestKey === null || key.length > bestKey.length)) {
                bestKey = key;
            }
        }
        return bestKey === null ? undefined : { key: bestKey, value: map[bestKey] };
    }

    private getMultiActionBehavior(): string {
        return this._config.get<string>("multiActionBehavior") || "pick";
    }

    private async pickAction(resolved: { actions: CodeAction[]; key: string }): Promise<CodeAction> {
        const actions = resolved.actions;
        if (actions.length === 1) {
            return actions[0];
        }

        const stateKey = "codeRunner.lastAction." + resolved.key;
        const lastCommand = this._extContext ? this._extContext.globalState.get<string>(stateKey) : undefined;
        const lastAction = lastCommand ? actions.filter((action) => action.command === lastCommand)[0] : undefined;

        const behavior = this.getMultiActionBehavior();
        if (behavior === "first") {
            return actions[0];
        }
        if (behavior === "last" && lastAction) {
            return lastAction;
        }

        const items: vscode.QuickPickItem[] = actions.map((action) => ({
            label: action === lastAction ? "$(history) " + action.label : action.label,
            description: action.description,
            detail: action.detail || action.command,
            action,
        } as any));
        // 上次执行过的置顶
        if (lastAction) {
            const index = items.findIndex((item: any) => item.action === lastAction);
            items.unshift(items.splice(index, 1)[0]);
        }

        const picked: any = await vscode.window.showQuickPick(items, {
            placeHolder: "选择要执行的命令（" + resolved.key + "）",
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: true,
        });
        if (!picked) {
            return undefined;
        }
        if (this._extContext) {
            await this._extContext.globalState.update(stateKey, picked.action.command);
        }
        return picked.action;
    }

    private executeCommand(executor: string, appendFile: boolean = true) {
        if (this._config.get<boolean>("runInTerminal")) {
            this.executeCommandInTerminal(executor, appendFile);
        } else {
            this.executeCommandInOutputChannel(executor, appendFile);
        }
    }

    private getWorkspaceRoot(codeFileDir: string): string {
        return this._workspaceFolder ? this._workspaceFolder : codeFileDir;
    }

    /**
     * Gets the base name of the code file, that is without its directory.
     */
    private getCodeBaseFile(): string {
        const regexMatch = this._codeFile.match(/.*[\/\\](.*)/);
        return regexMatch ? regexMatch[1] : this._codeFile;
    }

    /**
     * Gets the code file name without its directory and extension.
     */
    private getCodeFileWithoutDirAndExt(): string {
        const regexMatch = this._codeFile.match(/.*[\/\\](.*(?=\..*))/);
        return regexMatch ? regexMatch[1] : this._codeFile;
    }

    /**
     * Gets the directory of the code file.
     */
    private getCodeFileDir(): string {
        const regexMatch = this._codeFile.match(/(.*[\/\\]).*/);
        return regexMatch ? regexMatch[1] : this._codeFile;
    }

    /**
     * Gets the drive letter of the code file.
     */
    private getDriveLetter(): string {
        const regexMatch = this._codeFile.match(/^([A-Za-z]:).*/);
        return regexMatch ? regexMatch[1] : "$driveLetter";
    }

    /**
     * Gets the directory of the code file without a trailing slash.
     */
    private getCodeFileDirWithoutTrailingSlash(): string {
        return this.getCodeFileDir().replace(/[\/\\]$/, "");
    }

    /**
     * Includes double quotes around a given file name.
     */
    private quoteFileName(fileName: string): string {
        return '\"' + fileName + '\"';
    }

    /**
     * Gets the executor to run a source code file
     * and generates the complete command that allow that file to be run.
     * This executor command may include a variable $1 to indicate the place where
     * the source code file name have to be included.
     * If no such a variable is present in the executor command,
     * the file name is appended to the end of the executor command.
     *
     * @param executor The command used to run a source code file
     * @return the complete command to run the file, that includes the file name
     */
    private async getFinalCommandToRunCodeFile(executor: string, appendFile: boolean = true): Promise<string> {
        let cmd = executor;

        if (this._codeFile) {
            const codeFileDir = this.getCodeFileDir();
            const pythonPath = cmd.includes("$pythonPath") ? await Utility.getPythonPath(this._document) : Constants.python;
            const placeholders: Array<{ regex: RegExp, replaceValue: string }> = [
                // A placeholder that has to be replaced by the path of the folder opened in VS Code
                // If no folder is opened, replace with the directory of the code file
                { regex: /\$workspaceRoot/g, replaceValue: this.getWorkspaceRoot(codeFileDir) },
                // A placeholder that has to be replaced by the code file name without its extension
                { regex: /\$fileNameWithoutExt/g, replaceValue: this.getCodeFileWithoutDirAndExt() },
                // A placeholder that has to be replaced by the full code file name
                { regex: /\$fullFileName/g, replaceValue: this.quoteFileName(this._codeFile) },
                // A placeholder that has to be replaced by the code file name without the directory
                { regex: /\$fileName/g, replaceValue: this.getCodeBaseFile() },
                // A placeholder that has to be replaced by the drive letter of the code file (Windows only)
                { regex: /\$driveLetter/g, replaceValue: this.getDriveLetter() },
                // A placeholder that has to be replaced by the directory of the code file without a trailing slash
                { regex: /\$dirWithoutTrailingSlash/g, replaceValue: this.quoteFileName(this.getCodeFileDirWithoutTrailingSlash()) },
                // A placeholder that has to be replaced by the directory of the code file
                { regex: /\$dir/g, replaceValue: this.quoteFileName(codeFileDir) },
                // A placeholder that has to be replaced by the path of Python interpreter
                { regex: /\$pythonPath/g, replaceValue: pythonPath },
            ];

            placeholders.forEach((placeholder) => {
                cmd = cmd.replace(placeholder.regex, placeholder.replaceValue);
            });
        }

        return (cmd !== executor ? cmd : executor + (appendFile ? " " + this.quoteFileName(this._codeFile) : ""));
    }

    private changeExecutorFromCmdToPs(executor: string): string {
        if (executor.includes(" && ") && this.isPowershellOnWindows()) {
            let replacement = "; if ($?) {";
            executor = executor.replace("&&", replacement);
            replacement = "} " + replacement;
            executor = executor.replace(/&&/g, replacement);
            executor = executor.replace(/\$dir\$fileNameWithoutExt/g, ".\\$fileNameWithoutExt");
            return executor + " }";
        }
        return executor;
    }

    private isPowershellOnWindows(): boolean {
        if (os.platform() === "win32") {
            const defaultProfile = vscode.workspace.getConfiguration("terminal").get<string>("integrated.defaultProfile.windows");
            if (defaultProfile) {
                if (defaultProfile.toLowerCase().includes("powershell")) {
                    return true;
                } else if (defaultProfile === "Command Prompt") {
                    return false;
                }
            }
            const windowsShell = vscode.env.shell;
            return (windowsShell && windowsShell.toLowerCase().includes("powershell"));
        }
        return false;
    }

    private changeFilePathForBashOnWindows(command: string): string {
        if (os.platform() === "win32") {
            const windowsShell = vscode.env.shell;
            const terminalRoot = this._config.get<string>("terminalRoot");
            if (windowsShell && terminalRoot) {
                command = command
                    .replace(/([A-Za-z]):\\/g, (match, p1) => `${terminalRoot}${p1.toLowerCase()}/`)
                    .replace(/\\/g, "/");
            } else if (windowsShell && windowsShell.toLowerCase().indexOf("bash") > -1 && windowsShell.toLowerCase().indexOf("windows") > -1) {
                command = command.replace(/([A-Za-z]):\\/g, this.replacer).replace(/\\/g, "/");
            }
        }
        return command;
    }

    private replacer(match: string, p1: string): string {
        return `/mnt/${p1.toLowerCase()}/`;
    }

    private async executeCommandInTerminal(executor: string, appendFile: boolean = true) {
        let isNewTerminal = false;
        if (this._terminal === null) {
            this._terminal = vscode.window.createTerminal("Code");
            isNewTerminal = true;
        }
        this._terminal.show(this._config.get<boolean>("preserveFocus"));
        this.sendRunEvent(executor, true);
        executor = this.changeExecutorFromCmdToPs(executor);
        let command = await this.getFinalCommandToRunCodeFile(executor, appendFile);
        command = this.changeFilePathForBashOnWindows(command);
        if (this._config.get<boolean>("clearPreviousOutput") && !isNewTerminal) {
            await vscode.commands.executeCommand("workbench.action.terminal.clear");
        }
        if (this._config.get<boolean>("fileDirectoryAsCwd")) {
            const cwd = this.changeFilePathForBashOnWindows(this._cwd);
            this._terminal.sendText(`cd "${cwd}"`);
        }
        this._terminal.sendText(command);
        this.maybeSendTempFileCleanup();
    }

    /**
     * fork: 终端模式无法得知命令何时结束，改为紧接着把删除命令送进同一个 shell
     * （shell 会等上一条命令跑完再执行），从而在运行后清掉临时文件。
     */
    private maybeSendTempFileCleanup(): void {
        if (!this._isTmpFile || !this._terminal || !this._config.get<boolean>("deleteTempFileAfterRun", true)) {
            return;
        }
        this._terminal.sendText(this.getDeleteFileCommand(this._codeFile));
    }

    private getDeleteFileCommand(filePath: string): string {
        const quoted = this.quoteFileName(filePath);
        if (this.isPowershellOnWindows()) {
            return "Remove-Item -LiteralPath " + quoted + " -ErrorAction SilentlyContinue";
        }
        if (os.platform() === "win32") {
            return "del /f /q " + quoted;
        }
        return "rm -f " + quoted;
    }

    private async executeCommandInOutputChannel(executor: string, appendFile: boolean = true) {
        this._isRunning = true;
        vscode.commands.executeCommand("setContext", "crun.codeRunning", true);
        const clearPreviousOutput = this._config.get<boolean>("clearPreviousOutput");
        if (clearPreviousOutput) {
            this._outputChannel.clear();
        }
        const showExecutionMessage = this._config.get<boolean>("showExecutionMessage");
        this._outputChannel.show(this._config.get<boolean>("preserveFocus"));
        const spawn = require("child_process").spawn;
        const command = await this.getFinalCommandToRunCodeFile(executor, appendFile);
        if (showExecutionMessage) {
            this._outputChannel.appendLine("[Running] " + command);
        }
        this.sendRunEvent(executor, false);
        const startTime = new Date();
        this._process = spawn(command, [], { cwd: this._cwd, shell: true });

        this._process.stdout.on("data", (data) => {
            this._outputChannel.append(data.toString());
        });

        this._process.stderr.on("data", (data) => {
            this._outputChannel.append(data.toString());
        });

        this._process.on("close", (code) => {
            this._isRunning = false;
            vscode.commands.executeCommand("setContext", "crun.codeRunning", false);
            const endTime = new Date();
            const elapsedTime = (endTime.getTime() - startTime.getTime()) / 1000;
            this._outputChannel.appendLine("");
            if (showExecutionMessage) {
                this._outputChannel.appendLine("[Done] exited with code=" + code + " in " + elapsedTime + " seconds");
                this._outputChannel.appendLine("");
            }
            if (this._isTmpFile && this._config.get<boolean>("deleteTempFileAfterRun", true)) {
                try {
                    fs.unlinkSync(this._codeFile);
                } catch {
                    // 已被外部清理，忽略
                }
            }
        });
    }

    private sendRunEvent(executor: string, runFromTerminal: boolean) {
        const properties = {
            runFromTerminal: runFromTerminal.toString(),
            runFromExplorer: this._runFromExplorer.toString(),
            isTmpFile: this._isTmpFile.toString(),
        };
        this._appInsightsClient.sendEvent(executor, properties);
    }
}
