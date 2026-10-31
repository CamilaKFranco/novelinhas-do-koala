import { app, BrowserWindow, dialog, shell } from "electron";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NOME = "Novelinhas do Koala";
const ICONE = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.png");

// Até a versão 0.3 o app se chamava "Novela Studio": se os dados antigos
// existirem e os novos ainda não, eles são movidos para a pasta nova.
const pastaDados = join(app.getPath("appData"), NOME);
const pastaAntiga = join(app.getPath("appData"), "Novela Studio");
if (!existsSync(pastaDados) && existsSync(pastaAntiga)) {
  try {
    renameSync(pastaAntiga, pastaDados);
  } catch {
    // Pasta em uso: continua usando a antiga para não perder nada.
  }
}
app.setPath("userData", existsSync(pastaDados) || !existsSync(pastaAntiga) ? pastaDados : pastaAntiga);
app.setAppUserModelId("local.koala.novelastudio");

if (!app.requestSingleInstanceLock()) app.quit();

let janela = null;

async function iniciar() {
  // Dados, projetos, vídeos e o perfil do Chrome ficam em
  // %APPDATA%\Novelinhas do Koala\dados, fora da pasta de instalação.
  process.env.NOVELA_DADOS = join(app.getPath("userData"), "dados");

  let url;
  try {
    const { pronto } = await import("../server.mjs");
    url = await pronto;
  } catch (erro) {
    const ocupada = erro?.code === "EADDRINUSE";
    dialog.showErrorBox(
      NOME,
      ocupada
        ? `A porta 4321 já está em uso. Feche outra janela do ${NOME} (ou o iniciar.bat) e abra de novo.`
        : `Não foi possível iniciar: ${erro?.message ?? erro}`,
    );
    app.quit();
    return;
  }

  janela = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 500,
    title: NOME,
    icon: existsSync(ICONE) ? ICONE : undefined,
    backgroundColor: "#050912",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Links externos abrem no navegador padrão, não dentro do app.
  janela.webContents.setWindowOpenHandler(({ url: destino }) => {
    shell.openExternal(destino);
    return { action: "deny" };
  });
  janela.webContents.on("will-navigate", (evento, destino) => {
    if (!destino.startsWith(url)) evento.preventDefault();
  });
  await janela.loadURL(url);
}

app.on("second-instance", () => {
  if (janela) {
    if (janela.isMinimized()) janela.restore();
    janela.focus();
  }
});
app.on("window-all-closed", () => app.quit());
app.whenReady().then(iniciar);
