import React, { useEffect, useState } from "react";
import { useTranslations } from "@/i18n/compat/client";
import { FolderOpen, FolderCheck, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
    getFileHandle,
    getConfig,
    storeFileHandle,
    storeConfig,
} from "@/utils/fileSystem";

export default function SettingsPage() {
    const t = useTranslations();
    const [currentFolder, setCurrentFolder] = useState<string | null>(null);
    const [isSupported, setIsSupported] = useState(true);

    useEffect(() => {
        setIsSupported(
            typeof window !== "undefined" &&
                typeof window.showDirectoryPicker === "function"
        );

        const loadSavedConfig = async () => {
            try {
                const path = await getConfig("syncDirectoryPath");
                if (path) {
                    setCurrentFolder(path);
                }
            } catch (error) {
                console.error("Error loading saved config:", error);
            }
        };

        loadSavedConfig();
    }, []);

    const handleSelectFolder = async () => {
        if (typeof window === "undefined" || !window.showDirectoryPicker) {
            return;
        }
        try {
            const handle = await window.showDirectoryPicker({
                mode: "readwrite",
            });
            await storeFileHandle("syncDirectory", handle);
            // 记录可读的文件夹路径，便于界面展示
            const path = (handle as any).name ?? "";
            await storeConfig("syncDirectoryPath", path);
            setCurrentFolder(path);
        } catch (error: any) {
            // 用户取消选择会抛出 AbortError，无需提示
            if (error?.name === "AbortError") return;
            console.error("Error selecting sync directory:", error);
        }
    };

    return (
        <div className="p-8 max-w-2xl mx-auto space-y-6">
            <h1 className="text-2xl font-bold mb-2">{t("settings.title")}</h1>

            <section className="rounded-lg border p-6 space-y-4">
                <div>
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                        <FolderOpen className="w-5 h-5" />
                        {t("settings.syncDirectory.title")}
                    </h2>
                    <p className="text-sm text-muted-foreground mt-1">
                        {t("settings.syncDirectory.description")}
                    </p>
                </div>

                {!isSupported && (
                    <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>浏览器不支持</AlertTitle>
                        <AlertDescription>
                            当前浏览器不支持文件夹选择（File System Access
                            API）。请使用最新版 Chrome、Edge 等基于 Chromium
                            的浏览器以配置本地备份目录。
                        </AlertDescription>
                    </Alert>
                )}

                <div className="flex items-center justify-between rounded-md bg-muted/50 px-4 py-3">
                    <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">
                            {t("settings.syncDirectory.currentSyncFolder")}
                        </p>
                        {currentFolder ? (
                            <p className="flex items-center gap-1.5 text-sm font-medium truncate">
                                <FolderCheck className="w-4 h-4 text-green-600 shrink-0" />
                                {currentFolder}
                            </p>
                        ) : (
                            <p className="text-sm text-muted-foreground">
                                {t("settings.syncDirectory.noFolderConfigured")}
                            </p>
                        )}
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSelectFolder}
                        disabled={!isSupported}
                    >
                        <FolderOpen className="w-4 h-4 mr-2" />
                        {currentFolder
                            ? t("settings.syncDirectory.changeFolder")
                            : t("settings.syncDirectory.selectFolder")}
                    </Button>
                </div>

                <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>为什么需要配置？</AlertTitle>
                    <AlertDescription>
                        建议在设置中配置简历备份文件夹，防止您的数据在浏览器清除缓存后丢失。
                    </AlertDescription>
                </Alert>
            </section>
        </div>
    );
}
