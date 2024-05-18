import "dotenv/config"
import { app, BrowserWindow, Menu } from "electron"
import path from "path"
import { electronApp, optimizer } from "@electron-toolkit/utils"
import { createWindow } from "./window"
import { registerIpcMain } from "@egoist/tipc/main"
import { router } from "./tipc"

registerIpcMain(router)

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("follow", process.execPath, [
      path.resolve(process.argv[1]),
    ])
  }
} else {
  app.setAsDefaultProtocolClient("follow")
}

app.dock.setIcon(path.join(__dirname, "../../resources/icon.png"))

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId("re.follow")

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.

Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            console.log("Oh, hi there!")
            createWindow({
              extraPath: "/settings",
              width: 800,
              height: 600,
            })
          },
        },
        { type: "separator" },
        { role: "hide" },
        { role: "quit" },
      ],
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]),
)
