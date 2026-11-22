# WF Flashforge 5M Pro AutoLoop

AutoLoop is a local print queue for the **Flashforge Adventurer 5M Pro**. Add sliced G-code, enter a copy count, and run the queue from a Windows PC on the same network as the printer. The dashboard shows printer status, temperatures, and the build-plate camera. A queue can send a separate clearing G-code job between prints.

Built by [Wisconsin Filaments](https://wisconsinfilaments.com/).

## What you need

- A Windows PC with [Node.js 22 or newer](https://nodejs.org/en/download/).
- A Flashforge Adventurer 5M Pro on the same local network as the PC.
- A text `.gcode` file sliced for the **5M Pro** and the nozzle installed on your printer. Flash Studio and Orca-Flashforge exports are supported when they include the printer and nozzle metadata.

AutoLoop runs on your PC at [http://127.0.0.1:5174/](http://127.0.0.1:5174/). The server listens only on the local computer. Printer communication stays on the LAN. It uses the printer's existing firmware and does not require a cloud account or subscription.

## Install and start on Windows

1. On GitHub, choose **Code → Download ZIP**. Right-click the ZIP and choose **Extract All**.
2. Install Node.js if needed. Open a fresh PowerShell window and run `node --version` to check it.
3. In the extracted folder, double-click **`Start-AutoLoop.cmd`**.
4. Open [http://127.0.0.1:5174/](http://127.0.0.1:5174/) in your browser. Keep the launcher window open while using the app.

The Windows launcher is the entry point. No separate installer or npm package installation is required. To start from PowerShell, open it in the extracted folder and run:

```powershell
.\Start-AutoLoop.cmd
```

### Try the simulator

Double-click **`Start-Simulator.cmd`**, open the same address, and click **Connect printer** and **Connect and verify**. Add a sliced 5M Pro file and run a queue. The simulator does not connect to the real printer or supply a camera feed. Close its launcher window before starting the live app since both use port 5174.

## Connect your printer

1. On the printer, enable **LAN Only** and find the printer's **LAN IP**, **serial number**, and **LAN check code**.
2. In AutoLoop, click **Connect printer**, enter those three values, and click **Connect and verify**.
3. Confirm the dashboard shows **Printer verified**. Compare the model, nozzle size, and temperatures with the touchscreen.
4. Enable **Camera** and **Filament detect** on the printer. Use **Refresh camera** if the feed needs reconnecting.

The **Device name** is the nickname you gave the printer. **Verified model** is the hardware model AutoLoop checks. Keep the LAN check code private.

## Run a print queue

1. Choose **+ New queue** or use the existing production queue.
2. Select your sliced `.gcode`, enter **Copies**, and click **Add job**. Use **Edit** or the arrows to adjust queued jobs before starting.
3. If you want to remove parts by hand, open **Between-print settings**, turn on **Clear plate manually**, and click **Save settings**. Otherwise, pick the clearing file for this queue.
4. Check that the plate is empty, then click **Start this queue**. If you selected a clearing file, start only after you have tested it under supervision with the intended part, build plate, and exit path.
5. After each copy, check the build plate, including any purge line or loose debris. Click **Confirm plate clear** in AutoLoop when the plate is empty. AutoLoop acknowledges the printer's completion prompt and checks for **Ready** before the next copy.

### Clearing files

| Option | How it works |
| --- | --- |
| **Fast clear** | Default. The bundled file makes forward passes at Z4 and 60 mm/s. |
| **Slow clear** | The bundled first-layer-height file makes forward passes at Z0.2 and 15 mm/s. Test it on a clean, empty, leveled plate before using it with a part. |
| **Custom upload** | Choose **Replace G-code → Use file** to load your own clearing file. Its 5M Pro metadata and nozzle size must match the printer. The file must use supported commands and contain no forward extrusion. |
| **Clear plate manually** | Skips the clearing job for that queue. Remove the part and click **Confirm plate clear**. |

AutoLoop sends the print file as supplied. If a clearing file is selected, it waits for the configured cooldown and sends clearing as a **separate job** with auto-leveling off. A successful clearing job confirms that the file ran. On a real printer, **Confirm plate clear** is still required because the app cannot verify that the part came off by itself. Use supervised operation.

### Between-print settings

- **Auto-level before each print** defaults to off. It sets the printer's leveling flag for normal prints. Any leveling commands in the supplied file still run.
- **Keep warm between prints** defaults to off. If enabled, it holds the configured standby temperatures for a limited time while the queue waits for plate confirmation. A setting of 0 keeps the corresponding heater off.
- **Pause after copy** pauses at the plate-clear checkpoint so you can resume the rest of the queue later.

## Stop, cancel, and upgrade

- **Stop queue** prevents further uploads. The printer can continue a job it already received.
- **Cancel print on printer** asks the printer to stop the active job. If the touchscreen shows an active job or AutoLoop cannot confirm the stop, cancel directly from the touchscreen.
- To shut down AutoLoop, use **Stop queue** if needed, then close the launcher window or press **Ctrl+C** in it.
- Queues and uploaded files are saved in `local-data` inside the AutoLoop folder. To upgrade, close the old launcher, extract the new version elsewhere, and copy `local-data` into the new folder before starting it. AutoLoop asks you to reconnect to the printer after a restart. Review interrupted jobs before re-adding them.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| Windows says Node.js is missing | Install Node.js 22 or newer, then reopen the launcher. |
| The dashboard does not open | Keep the launcher running, use `http://127.0.0.1:5174/`, and close any old AutoLoop or simulator window using the same port. |
| Printer verification fails | Check LAN Only, the IP, serial number and check code. Make sure the PC and printer can reach each other locally. If the printer console is busy, close other printer-control software and retry. |
| The camera is blank | Enable the camera on the printer and click **Refresh camera**. Some printers may supply snapshots instead of a continuous feed. |
| A print upload is rejected | Export text `.gcode` for the 5M Pro and the installed nozzle. Print files must be under 48 MiB. |
| A clearing upload is rejected | Verify the printer and nozzle metadata, check the command reported by AutoLoop, and keep the file under 256 KiB. |
| The queue stalls during cooldown | Check that both heater targets are off on the touchscreen. AutoLoop waits for the nozzle and bed to cool before sending a clearing job. |
| The touchscreen still asks for OK | After removing material, try **Confirm plate clear** in AutoLoop. If the printer still shows the prompt, acknowledge it on the touchscreen and review the queue status. |

[Flashforge Adventurer 5M Pro manual](https://wiki.flashforge.com/resource/adventurer_series_manual/adventurer_5m_pro_manual.pdf)
