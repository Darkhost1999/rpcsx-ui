import { app, net, session, BrowserWindow, ipcMain } from 'electron';
import * as fs from '$fs';
import * as core from '$core';
import { PathLike } from 'fs';
import nodePath from 'path';
import * as path from '$core/path';
import { fileURLToPath } from 'url';
import { Future } from '$core/Future.js';
import * as explorer from '$explorer';
import { Window } from '$core/Window';

function toWindow(browserWindow: BrowserWindow): Window {
    return {
        pushView: (name, props) => { browserWindow.webContents.send("view/push", name, props); },
        setView: (name, props) => { browserWindow.webContents.send("view/set", name, props); },
        popView: () => { browserWindow.webContents.send("view/pop"); },
    };
}

let MainWindow: BrowserWindow;

async function activateMainWindow() {
    console.log('window creation');
    const win = new BrowserWindow({
        title: "RPCSX",
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        fullscreen: false,
        webPreferences: {
            preload: fileURLToPath(path.join(await fs.fsGetBuiltinResourcesLocation(undefined), "build", "preload.js")),
            webSecurity: false
        }
    });

    MainWindow = win;

    if (process.argv.includes("--dev")) {
        await win.loadURL("http://localhost:8081/");
    } else {
        await win.loadURL("app://-");
    }

}

export async function initialize() {
    ipcMain.on('window/create', async (_event, options) => {
        const win = new BrowserWindow({
            webPreferences: {
                preload: fileURLToPath(path.join(await fs.fsGetBuiltinResourcesLocation(undefined), "build", "preload.js")),
            },
            ...options,
        });

        win.loadURL(`app://-/${options.url}`);
    });

    const createWindow = async () => {
        await activateMainWindow();

        const uiInitializedFuture = new Future<void>();
        ipcMain.once('frame/initialized', () => {
            console.log('frame/initialized');
            uiInitializedFuture.resolve();
        });

        if (!uiInitializedFuture.hasValue()) {
            console.log('waiting for ui initialization completion');
            await uiInitializedFuture.value;
        }

        uiInitializedFuture.dispose();

        console.log('initialization complete');
        return explorer.pushExplorerView(toWindow(MainWindow), {
            filter: {
                type: 'game'
            }
        });
    };

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });

    app.on('window-all-closed', async () => {
        try {
            await core.shutdown(undefined);
        } catch (e) {
            console.error("shutdown throws exception", e);
        }

        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    await app.whenReady();

    const uiUri = path.join(await fs.fsGetBuiltinResourcesLocation(undefined), "build", "ui");

    const fixPath = async (loc: PathLike) => {
        loc = loc.toString();
        if (loc.length === 0) {
            return "index.html";
        }

        try {
            const stat = await fs.fsStat(loc);
            if (stat.type == FsDirEntryType.File) {
                return loc;
            }

            if (stat.type == FsDirEntryType.Directory) {
                return fixPath(path.join(loc, "index.html"));
            }
        } catch {
            const ext = nodePath.extname(loc);
            if (ext === ".html") {
                return undefined;
            }

            try {
                if ((await fs.fsStat(loc + ".html")).type == FsDirEntryType.File) {
                    return loc + ".html";
                }
            } catch { }
        }

        return undefined;
    };

    session.defaultSession.protocol.handle('app', async (request) => {
        const requestUrl = new URL(request.url);
        let pathname = requestUrl.pathname;
        if (pathname == "/Explorer") {
            pathname = "/";
        }

        const filePath = path.join(uiUri, decodeURIComponent(pathname));
        console.log(`open ${filePath}, request ${pathname}`);

        const relativePath = nodePath.relative(fileURLToPath(uiUri), filePath);
        const isSafe = !relativePath.startsWith('..') && !nodePath.isAbsolute(relativePath);

        if (!isSafe) {
            return new Response('bad request', {
                status: 400,
                headers: { 'content-type': 'text/html' }
            });
        }

        try {
            const absolutePath = await fixPath(path.join(uiUri, relativePath));

            if (absolutePath) {
                return net.fetch(absolutePath);
            }
        } catch { }

        return new Response('Not Found', {
            status: 404,
            headers: { 'content-type': 'text/html' }
        });
    });

    return createWindow();
}
