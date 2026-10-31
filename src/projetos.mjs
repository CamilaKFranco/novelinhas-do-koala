import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { unzipSync } from "fflate";
import { PROJETOS } from "./caminhos.mjs";

const EXTENSOES_IMAGEM = [".png", ".jpg", ".jpeg", ".webp"];
export const FORMATOS = { "9:16": "9:16 vertical", "16:9": "16:9 horizontal", "1:1": "1:1 square" };
const CONFIG_VAZIA = { modelo: "", modo: "", resolucao: "", formatos: ["9:16"], duracao: "" };

const pastaProjeto = (id) => join(PROJETOS, id);
const arquivoProjeto = (id) => join(pastaProjeto(id), "projeto.json");

function validarId(id) {
  if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error("Projeto inválido.");
  return id;
}

function slug(nome) {
  const base = nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return `${base || "projeto"}-${randomUUID().slice(0, 6)}`;
}

// "9:16" → "9x16", usado nos nomes de arquivo.
export const sufixoFormato = (formato) => formato.replace(":", "x");

// Troca a menção de formato do prompt ("9:16 vertical") pelo formato da vez.
export function adaptarPrompt(prompt, formato) {
  return prompt.replace(/\b(9:16|16:9|1:1)(?:\s+(?:vertical|horizontal|square|widescreen))?/gi, FORMATOS[formato] ?? formato);
}

// "01_CARLOS.png_8c93d63d.jpg" → "01_CARLOS": o nome que os prompts usam.
export function rotuloReferencia(nomeArquivo) {
  const nome = basename(nomeArquivo);
  return (nome.match(/^(.+?)\.(png|jpe?g|webp)/i)?.[1] ?? nome.replace(/\.[^.]+$/, "")).trim();
}

// Lê blocos "--- TAKE 01 [15s] ---" seguidos do prompt do take.
export function lerPrompts(texto) {
  const partes = texto.replace(/^﻿/, "").replace(/\r/g, "").split(/^-{2,}\s*TAKE\s+(\d+)\s*(?:\[\s*(\d+)\s*s?\s*\])?\s*-{2,}\s*$/im);
  const takes = [];
  for (let i = 1; i < partes.length; i += 3) {
    const prompt = partes[i + 2].trim();
    if (prompt) takes.push({ numero: Number(partes[i]), duracao: partes[i + 1] ? Number(partes[i + 1]) : null, prompt });
  }
  return takes;
}

// "MiniMax H3, Accelerated, 480p, 9:16 vertical, exactly 15 seconds, …"
export function lerConfigDoPrompt(prompt) {
  const linha = prompt.split("\n")[0];
  const formato = linha.match(/\b(9:16|16:9|1:1)\b/)?.[1];
  return {
    modelo: linha.match(/^\s*([^,]+?)\s*,/)?.[1] ?? "",
    modo: linha.match(/\b(Accelerated|Standard|Turbo|Quality|Fast|Ultra)\b/i)?.[1] ?? "",
    resolucao: linha.match(/\b(\d{3,4}p|HD|2K|4K)\b/i)?.[1] ?? "",
    formatos: [formato ?? "9:16"],
    duracao: linha.match(/(\d+)\s*(?:s\b|sec|seconds?|segundos?)/i)?.[1] ?? "",
  };
}

const saidaVazia = () => ({ status: "pendente", tentativas: 0, erro: null, video: null, qualidade: null });

// Status do take considerando só os formatos escolhidos no projeto.
export function statusCena(cena, formatos) {
  const estados = formatos.map((f) => cena.saidas?.[f]?.status ?? "pendente");
  if (estados.every((s) => s === "concluida")) return "concluida";
  if (estados.includes("processando")) return "processando";
  if (estados.includes("falhou")) return "falhou";
  return "pendente";
}

// Garante o formato atual dos dados, convertendo projetos de versões antigas.
function normalizar(projeto) {
  const config = { ...CONFIG_VAZIA, ...(projeto.config ?? {}) };
  if (!Array.isArray(projeto.config?.formatos)) config.formatos = [projeto.config?.proporcao || "9:16"];
  // Um formato por vez (projetos antigos podiam ter os dois).
  if (config.formatos.length > 1) config.formatos = [config.formatos[0]];
  delete config.proporcao;
  projeto.config = config;
  projeto.referencias ??= [];
  projeto.videosFinais ??= {};
  if (projeto.videoFinal) projeto.videosFinais[config.formatos[0]] ??= projeto.videoFinal;
  delete projeto.videoFinal;
  for (const cena of projeto.cenas) {
    if (!cena.saidas) {
      cena.saidas = {
        [config.formatos[0]]: {
          status: cena.status === "processando" ? "pendente" : (cena.status ?? "pendente"),
          tentativas: cena.tentativas ?? 0,
          erro: cena.erro ?? null,
          video: cena.video ?? null,
          qualidade: cena.qualidade ?? null,
        },
      };
      for (const campo of ["tentativas", "erro", "video", "qualidade"]) delete cena[campo];
    }
    for (const formato of config.formatos) cena.saidas[formato] ??= saidaVazia();
    cena.status = statusCena(cena, config.formatos);
  }
  return projeto;
}

export async function salvarProjeto(projeto) {
  normalizar(projeto);
  const destino = arquivoProjeto(projeto.id);
  const temporario = `${destino}.tmp`;
  await writeFile(temporario, JSON.stringify(projeto, null, 2), "utf8");
  await rename(temporario, destino);
  return projeto;
}

export async function lerProjeto(id) {
  return normalizar(JSON.parse(await readFile(arquivoProjeto(validarId(id)), "utf8")));
}

const resumoStatus = (cenas) =>
  Object.fromEntries(["pendente", "processando", "concluida", "falhou"].map((s) => [s, cenas.filter((c) => c.status === s).length]));

// Conta os vídeos de takes (um por take e por formato) e os segundos já aprovados.
function resumoVideos(p) {
  let videos = 0;
  let segundos = 0;
  for (const cena of p.cenas) {
    for (const f of p.config.formatos) {
      const s = cena.saidas?.[f];
      if (s?.status !== "concluida") continue;
      videos++;
      segundos += Number(s.qualidade?.duracao) || Number(cena.duracao) || 0;
    }
  }
  return { videos, totalVideos: p.cenas.length * p.config.formatos.length, segundosConcluidos: Math.round(segundos) };
}

export async function listarProjetos() {
  if (!existsSync(PROJETOS)) return [];
  const projetos = [];
  for (const id of await readdir(PROJETOS)) {
    if (!existsSync(arquivoProjeto(id))) continue;
    const p = await lerProjeto(id);
    projetos.push({
      id: p.id,
      nome: p.nome,
      criadoEm: p.criadoEm,
      cenas: p.cenas.length,
      formatos: p.config.formatos,
      status: resumoStatus(p.cenas),
      videosFinais: p.videosFinais,
      capa: p.referencias[0]?.arquivo ?? null,
      ...resumoVideos(p),
    });
  }
  return projetos.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { numeric: true }));
}

async function novoProjeto(nome) {
  const nomeLimpo = String(nome ?? "").trim();
  if (!nomeLimpo) throw new Error("Dê um nome ao projeto.");
  const id = slug(nomeLimpo);
  for (const sub of ["entradas", "referencias", "videos"]) await mkdir(join(pastaProjeto(id), sub), { recursive: true });
  return { id, nome: nomeLimpo, criadoEm: new Date().toISOString(), config: { ...CONFIG_VAZIA }, referencias: [], cenas: [], videosFinais: {} };
}

export const criarProjeto = async (nome) => salvarProjeto(await novoProjeto(nome));

// Apaga o projeto inteiro (takes, referências e vídeos).
export async function excluirProjeto(id) {
  await lerProjeto(id);
  await rm(pastaProjeto(validarId(id)), { recursive: true, force: true });
  return { ok: true };
}

const novaCena = ({ numero, duracao, prompt, quadroInicial = null }) => ({
  id: randomUUID().slice(0, 8),
  numero,
  duracao,
  prompt,
  quadroInicial,
  saidas: {},
});

function extensaoImagem(nome) {
  const extensao = extname(basename(String(nome ?? ""))).toLowerCase();
  if (!EXTENSOES_IMAGEM.includes(extensao)) throw new Error("Use uma imagem PNG, JPG ou WEBP.");
  return extensao;
}

async function gravarReferencia(projeto, nomeOriginal, bytes) {
  const rotulo = rotuloReferencia(nomeOriginal).replace(/[^\w.-]+/g, "_");
  const arquivo = `${rotulo}${extensaoImagem(nomeOriginal)}`;
  await writeFile(join(pastaProjeto(projeto.id), "referencias", arquivo), bytes);
  projeto.referencias = [...projeto.referencias.filter((r) => r.arquivo !== arquivo), { arquivo, rotulo }]
    .sort((a, b) => a.rotulo.localeCompare(b.rotulo, "pt-BR", { numeric: true }));
}

// Aceita um .zip do projeto, ou os arquivos soltos (prompts.txt + imagens).
export async function importarProjeto({ nome, arquivos }) {
  if (!Array.isArray(arquivos) || arquivos.length === 0) throw new Error("Escolha o .zip do projeto ou os arquivos.");
  const soltos = [];
  let nomeSugerido = nome?.trim();
  for (const { nome: nomeArquivo, base64 } of arquivos) {
    const bytes = Buffer.from(base64, "base64");
    if (extname(nomeArquivo).toLowerCase() === ".zip") {
      nomeSugerido ||= basename(nomeArquivo, extname(nomeArquivo));
      for (const [caminho, conteudo] of Object.entries(unzipSync(new Uint8Array(bytes)))) {
        if (caminho.endsWith("/") || caminho.includes("__MACOSX") || basename(caminho).startsWith(".")) continue;
        soltos.push({ nome: basename(caminho), bytes: Buffer.from(conteudo) });
      }
    } else soltos.push({ nome: basename(nomeArquivo), bytes });
  }

  const textos = soltos.filter((a) => extname(a.nome).toLowerCase() === ".txt");
  const txt = textos.find((a) => /prompt/i.test(a.nome)) ?? textos[0];
  if (!txt) throw new Error("Não encontrei o arquivo de prompts (.txt) no projeto.");
  const takes = lerPrompts(txt.bytes.toString("utf8"));
  if (takes.length === 0) throw new Error(`Não encontrei takes no formato "--- TAKE 01 [15s] ---" em ${txt.nome}.`);

  const projeto = await novoProjeto(nomeSugerido || "Projeto importado");
  projeto.config = lerConfigDoPrompt(takes[0].prompt);
  for (const imagem of soltos.filter((a) => EXTENSOES_IMAGEM.includes(extname(a.nome).toLowerCase())))
    await gravarReferencia(projeto, imagem.nome, imagem.bytes);
  projeto.cenas = takes.sort((a, b) => a.numero - b.numero).map(novaCena);
  return salvarProjeto(projeto);
}

export async function atualizarConfig(id, config) {
  const projeto = await lerProjeto(id);
  for (const chave of ["modelo", "modo", "resolucao", "duracao"])
    if (chave in (config ?? {})) projeto.config[chave] = String(config[chave] ?? "").trim();
  if ("formatos" in (config ?? {})) {
    const formato = (config.formatos ?? []).find((f) => f in FORMATOS);
    if (!formato) throw new Error("Escolha um formato.");
    projeto.config.formatos = [formato];
  }
  return salvarProjeto(projeto);
}

export async function adicionarReferencia(id, imagem) {
  const projeto = await lerProjeto(id);
  if (!imagem?.base64) throw new Error("Escolha uma imagem.");
  await gravarReferencia(projeto, imagem.nome, Buffer.from(imagem.base64, "base64"));
  return salvarProjeto(projeto);
}

export async function removerReferencia(id, arquivo) {
  const projeto = await lerProjeto(id);
  projeto.referencias = projeto.referencias.filter((r) => r.arquivo !== arquivo);
  await rm(join(pastaProjeto(id), "referencias", basename(arquivo)), { force: true });
  return salvarProjeto(projeto);
}

export async function adicionarCena(id, { prompt, quadroInicial }) {
  const projeto = await lerProjeto(id);
  const texto = String(prompt ?? "").trim();
  if (!texto) throw new Error("Escreva o prompt da cena.");
  let arquivo = null;
  if (quadroInicial?.base64) {
    arquivo = `${randomUUID().slice(0, 8)}${extensaoImagem(quadroInicial.nome)}`;
    await writeFile(join(pastaProjeto(id), "entradas", arquivo), Buffer.from(quadroInicial.base64, "base64"));
  }
  const numero = Math.max(0, ...projeto.cenas.map((c) => c.numero ?? 0)) + 1;
  projeto.cenas.push(novaCena({ numero, duracao: Number(projeto.config.duracao) || null, prompt: texto, quadroInicial: arquivo }));
  return salvarProjeto(projeto);
}

export async function removerCena(id, cenaId) {
  const projeto = await lerProjeto(id);
  projeto.cenas = projeto.cenas.filter((c) => c.id !== cenaId);
  return salvarProjeto(projeto);
}

// Volta o take para a fila: num formato só, ou em todos os do projeto.
export async function reabrirCena(id, cenaId, formato) {
  const projeto = await lerProjeto(id);
  const cena = projeto.cenas.find((c) => c.id === cenaId);
  if (cena) for (const f of formato ? [formato] : projeto.config.formatos) cena.saidas[f] = saidaVazia();
  return salvarProjeto(projeto);
}

export async function atualizarSaida(id, cenaId, formato, mudancas) {
  const projeto = await lerProjeto(id);
  const cena = projeto.cenas.find((c) => c.id === cenaId);
  if (cena) Object.assign((cena.saidas[formato] ??= saidaVazia()), mudancas);
  return salvarProjeto(projeto);
}

export const caminhoEntrada = (id, arquivo) => join(pastaProjeto(validarId(id)), "entradas", basename(arquivo));
export const caminhoReferencia = (id, arquivo) => join(pastaProjeto(validarId(id)), "referencias", basename(arquivo));
export const pastaVideos = (id) => join(pastaProjeto(validarId(id)), "videos");
