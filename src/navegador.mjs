import { chromium } from "playwright-core";
import { PERFIL_NAVEGADOR } from "./caminhos.mjs";

let contexto = null;

// Abre o Chrome instalado com um perfil só deste app. Você faz o login no
// Leonardo nele uma vez; os cookies ficam no perfil e nada é lido da sua
// conta pessoal do Chrome.
export async function abrirNavegador() {
  if (contexto) return contexto;
  contexto = await chromium.launchPersistentContext(PERFIL_NAVEGADOR, {
    channel: "chrome",
    headless: false,
    viewport: null,
    acceptDownloads: true,
  });
  contexto.on("close", () => {
    contexto = null;
  });
  return contexto;
}

export const navegadorAberto = () => contexto !== null;

export async function paginaPrincipal() {
  const ctx = await abrirNavegador();
  return ctx.pages().find((p) => p.url().includes("leonardo.ai")) ?? ctx.pages()[0] ?? (await ctx.newPage());
}

export async function fecharNavegador() {
  await contexto?.close();
  contexto = null;
}
