import { createReadStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { basename, extname, join } from "node:path";
import { PERFIL_NAVEGADOR, PROJETOS, PUBLICO } from "./src/caminhos.mjs";
import {
  adicionarNaFila,
  estadoFila,
  iniciarFila,
  log,
  montarVideoFinal,
  moverNaFila,
  pararFila,
  removerDaFila,
  reordenarFila,
} from "./src/fila.mjs";
import { verificarLogin } from "./src/leonardo.mjs";
import { navegadorAberto, paginaPrincipal } from "./src/navegador.mjs";
import {
  adicionarCena,
  adicionarReferencia,
  atualizarConfig,
  caminhoEntrada,
  caminhoReferencia,
  criarProjeto,
  excluirProjeto,
  importarProjeto,
  lerProjeto,
  listarProjetos,
  pastaVideos,
  reabrirCena,
  removerCena,
  removerReferencia,
} from "./src/projetos.mjs";

const PORTA = 4321;
const LIMITE_CORPO = 300 * 1024 * 1024;
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };

await mkdir(PROJETOS, { recursive: true });
await mkdir(PERFIL_NAVEGADOR, { recursive: true });

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on("data", (p) => {
      tamanho += p.length;
      if (tamanho > LIMITE_CORPO) {
        reject(new Error("Arquivos grandes demais (máximo 300 MB por envio)."));
        req.destroy();
      } else partes.push(p);
    });
    req.on("end", () => {
      try {
        resolve(partes.length ? JSON.parse(Buffer.concat(partes).toString("utf8")) : {});
      } catch {
        reject(new Error("Corpo inválido."));
      }
    });
    req.on("error", reject);
  });
}

// Abre uma pasta no Explorador de Arquivos do Windows.
async function abrirPasta(caminho) {
  await mkdir(caminho, { recursive: true });
  spawn("explorer.exe", [caminho], { detached: true, stdio: "ignore" }).unref();
  return { ok: true };
}

function json(res, status, dados) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(dados));
}

function enviarArquivo(req, res, caminho) {
  if (!existsSync(caminho)) return json(res, 404, { erro: "Arquivo não encontrado." });
  res.writeHead(200, { "Content-Type": TIPOS[extname(caminho).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  createReadStream(caminho).pipe(res);
}

const P = "([a-z0-9-]+)";
const rotas = [
  ["GET", `^/api/estado$`, async () => ({ navegador: navegadorAberto(), fila: estadoFila() })],
  ["POST", `^/api/navegador/abrir$`, async () => {
    const logado = await verificarLogin(await paginaPrincipal());
    log(logado ? "Navegador aberto e logado no Leonardo." : "Navegador aberto. Faça o login na sua conta do Leonardo nessa janela.");
    return { logado };
  }],
  ["GET", `^/api/projetos$`, async () => listarProjetos()],
  ["POST", `^/api/projetos$`, async (_, c) => criarProjeto(c.nome)],
  ["POST", `^/api/importar$`, async (_, c) => {
    const projeto = await importarProjeto(c);
    log(`Projeto "${projeto.nome}" importado: ${projeto.cenas.length} takes, ${projeto.referencias.length} referência(s).`);
    return projeto;
  }],
  ["GET", `^/api/projetos/${P}$`, async ([id]) => lerProjeto(id)],
  ["DELETE", `^/api/projetos/${P}$`, async ([id]) => {
    const { nome } = await lerProjeto(id);
    if (estadoFila().projetos.includes(id)) await removerDaFila(id);
    await excluirProjeto(id);
    log(`Projeto "${nome}" apagado.`);
    return { ok: true };
  }],
  ["POST", `^/api/projetos/${P}/config$`, async ([id], c) => atualizarConfig(id, c)],
  ["POST", `^/api/projetos/${P}/referencias$`, async ([id], c) => adicionarReferencia(id, c)],
  ["DELETE", `^/api/projetos/${P}/referencias/([^/]+)$`, async ([id, arq]) => removerReferencia(id, decodeURIComponent(arq))],
  ["POST", `^/api/projetos/${P}/cenas$`, async ([id], c) => adicionarCena(id, c)],
  ["DELETE", `^/api/projetos/${P}/cenas/${P}$`, async ([id, cena]) => removerCena(id, cena)],
  // Ao refazer um take, o projeto volta para a fila: o take é gerado de novo e o vídeo final é remontado sozinho.
  ["POST", `^/api/projetos/${P}/cenas/${P}/reabrir$`, async ([id, cena], c) => {
    const projeto = await reabrirCena(id, cena, c.formato);
    await adicionarNaFila(id);
    return projeto;
  }],
  ["POST", `^/api/projetos/${P}/montar$`, async ([id], c) => montarVideoFinal(id, c.formato)],
  ["POST", `^/api/fila/adicionar/${P}$`, async ([id]) => (await adicionarNaFila(id), estadoFila())],
  ["POST", `^/api/fila/remover/${P}$`, async ([id]) => (await removerDaFila(id), estadoFila())],
  ["POST", `^/api/fila/(subir|descer)/${P}$`, async ([dir, id]) => (await moverNaFila(id, dir), estadoFila())],
  ["POST", `^/api/fila/ordem$`, async (_, c) => (await reordenarFila(c.ids), estadoFila())],
  ["POST", `^/api/projetos/${P}/abrir-pasta$`, async ([id]) => (await lerProjeto(id), abrirPasta(pastaVideos(id)))],
  ["POST", `^/api/abrir-pasta-projetos$`, async () => abrirPasta(PROJETOS)],
  ["POST", `^/api/fila/iniciar$`, async () => (iniciarFila(), estadoFila())],
  ["POST", `^/api/fila/parar$`, async () => (pararFila(), estadoFila())],
].map(([metodo, padrao, acao]) => [metodo, new RegExp(padrao), acao]);

const servidor = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    for (const [metodo, padrao, acao] of rotas) {
      const achou = req.method === metodo && pathname.match(padrao);
      if (achou) return json(res, 200, await acao(achou.slice(1), req.method === "POST" ? await lerCorpo(req) : {}));
    }
    let m;
    const nome = (s) => basename(decodeURIComponent(s));
    if ((m = pathname.match(/^\/videos\/([a-z0-9-]+)\/([^/]+)$/))) return enviarArquivo(req, res, join(pastaVideos(m[1]), nome(m[2])));
    if ((m = pathname.match(/^\/entradas\/([a-z0-9-]+)\/([^/]+)$/))) return enviarArquivo(req, res, caminhoEntrada(m[1], nome(m[2])));
    if ((m = pathname.match(/^\/referencias\/([a-z0-9-]+)\/([^/]+)$/))) return enviarArquivo(req, res, caminhoReferencia(m[1], nome(m[2])));
    if ((m = pathname.match(/^\/assets\/([\w.-]+)$/))) return enviarArquivo(req, res, join(PUBLICO, "assets", m[1]));
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) return enviarArquivo(req, res, join(PUBLICO, "index.html"));
    json(res, 404, { erro: "Não encontrado." });
  } catch (erro) {
    json(res, 400, { erro: erro.message });
  }
});

// O app de desktop aguarda esta promessa antes de abrir a janela.
// Se a porta 4321 estiver ocupada (outro programa ou uma cópia esquecida),
// tenta as próximas portas em vez de falhar.
export const pronto = new Promise((resolve, reject) => {
  let porta = PORTA;
  const tentar = () => servidor.listen(porta, "127.0.0.1");
  servidor.on("error", (erro) => {
    if (erro.code === "EADDRINUSE" && porta < PORTA + 20) {
      porta++;
      tentar();
    } else reject(erro);
  });
  servidor.on("listening", () => {
    const url = `http://localhost:${porta}`;
    console.log(`Novelinhas do Koala rodando em ${url}`);
    resolve(url);
  });
  tentar();
});
