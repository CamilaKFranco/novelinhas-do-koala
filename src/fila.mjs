import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DADOS } from "./caminhos.mjs";
import { lerConfig } from "./config.mjs";
import { juntarVideos, verificarVideo } from "./ffmpeg.mjs";
import { gerarCena, prepararEditor, verificarLogin, tentarComReinicio } from "./leonardo.mjs";
import { paginaPrincipal } from "./navegador.mjs";
import {
  adaptarPrompt,
  atualizarSaida,
  caminhoEntrada,
  caminhoReferencia,
  lerProjeto,
  pastaVideos,
  salvarProjeto,
  sufixoFormato,
} from "./projetos.mjs";

const ARQUIVO_FILA = join(DADOS, "fila.json");
const registros = [];
const estado = {
  rodando: false,
  projetos: existsSync(ARQUIVO_FILA) ? JSON.parse(readFileSync(ARQUIVO_FILA, "utf8")) : [],
  projetoAtual: null,
  cenaAtual: null,
  formatoAtual: null,
  pararPedido: false,
};

export function log(mensagem) {
  const linha = `[${new Date().toLocaleTimeString("pt-BR")}] ${mensagem}`;
  registros.push(linha);
  if (registros.length > 400) registros.shift();
  console.log(linha);
}

export const estadoFila = () => ({ ...estado, registros: registros.slice(-150) });

const salvarFila = () => writeFile(ARQUIVO_FILA, JSON.stringify(estado.projetos), "utf8");
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const entre = ([min, max]) => min + Math.floor(Math.random() * (max - min));

export async function adicionarNaFila(id) {
  await lerProjeto(id);
  if (!estado.projetos.includes(id)) estado.projetos.push(id);
  await salvarFila();
}

export async function removerDaFila(id) {
  if (estado.rodando && estado.projetoAtual === id) throw new Error("Este projeto está rodando agora. Pare a fila antes.");
  estado.projetos = estado.projetos.filter((p) => p !== id);
  await salvarFila();
}

export async function moverNaFila(id, direcao) {
  const i = estado.projetos.indexOf(id);
  const j = i + (direcao === "subir" ? -1 : 1);
  if (i < 0 || j < 0 || j >= estado.projetos.length) return;
  [estado.projetos[i], estado.projetos[j]] = [estado.projetos[j], estado.projetos[i]];
  await salvarFila();
}

// Recebe a fila inteira na nova ordem (arrastar e soltar na tela).
export async function reordenarFila(ids) {
  if (!Array.isArray(ids)) throw new Error("Ordem inválida.");
  const atual = new Set(estado.projetos);
  const nova = ids.filter((id, i) => atual.has(id) && ids.indexOf(id) === i);
  if (nova.length !== estado.projetos.length) throw new Error("A fila mudou. Tente de novo.");
  estado.projetos = nova;
  await salvarFila();
}

export function iniciarFila() {
  if (estado.rodando) throw new Error("A fila já está rodando.");
  if (estado.projetos.length === 0) throw new Error("A fila está vazia. Adicione projetos a ela primeiro.");
  Object.assign(estado, { rodando: true, projetoAtual: null, cenaAtual: null, formatoAtual: null, pararPedido: false });
  executar().finally(() => Object.assign(estado, { rodando: false, projetoAtual: null, cenaAtual: null, formatoAtual: null }));
}

export function pararFila() {
  if (estado.rodando) {
    estado.pararPedido = true;
    log("Parada pedida: a fila para depois do take atual.");
  }
}

// Junta os takes aprovados de um formato (ou de todos os formatos do projeto).
export async function montarVideoFinal(projetoId, formato) {
  let projeto = await lerProjeto(projetoId);
  const formatos = formato ? [formato] : projeto.config.formatos;
  const pasta = pastaVideos(projetoId);
  let montados = 0;
  for (const f of formatos) {
    const prontas = projeto.cenas.filter((c) => c.saidas[f]?.status === "concluida" && c.saidas[f].video).sort((a, b) => a.numero - b.numero);
    if (prontas.length === 0) {
      log(`Formato ${f}: nenhum take aprovado para juntar.`);
      continue;
    }
    const faltando = projeto.cenas.length - prontas.length;
    const arquivo = `${projeto.nome.replace(/[^\w.-]+/g, "_")}_${sufixoFormato(f)}_FINAL.mp4`;
    log(`Montando vídeo final ${f} de "${projeto.nome}" com ${prontas.length} take(s)${faltando ? ` (faltam ${faltando})` : ""}…`);
    await juntarVideos(prontas.map((c) => join(pasta, c.saidas[f].video)), join(pasta, arquivo));
    projeto = await lerProjeto(projetoId);
    projeto.videosFinais[f] = arquivo;
    await salvarProjeto(projeto);
    montados++;
    log(`🎬 Vídeo final ${f} pronto: ${arquivo}`);
  }
  if (montados === 0) throw new Error("Nenhum take aprovado para juntar.");
  return projeto;
}

async function executar() {
  try {
    const page = await paginaPrincipal();
    if (!(await verificarLogin(page))) {
      log('Você não está logado no Leonardo. Clique em "Abrir navegador e fazer login", entre na sua conta e inicie a fila de novo.');
      return;
    }
    log(`Login no Leonardo confirmado. ${estado.projetos.length} projeto(s) na fila.`);

    while (!estado.pararPedido && estado.projetos.length > 0) {
      const id = estado.projetos[0];
      estado.projetoAtual = id;
      await processarProjeto(page, id);
      if (estado.pararPedido) break;
      estado.projetos.shift();
      await salvarFila();
    }
    if (!estado.pararPedido) log("Fila de projetos concluída.");
  } catch (erro) {
    log(`Erro na fila: ${erro.message}`);
  }
  if (estado.pararPedido) log("Fila parada. Os projetos restantes continuam na fila.");
}

// Gera todos os takes de um formato antes de passar ao próximo, para trocar
// as configurações do editor só uma vez por formato.
async function processarProjeto(page, projetoId) {
  const cfg = lerConfig();
  let projeto = await lerProjeto(projetoId);
  const { formatos } = projeto.config;
  log(`═══ Projeto "${projeto.nome}" — ${projeto.cenas.length} takes × ${formatos.length} formato(s) (${formatos.join(" e ")}) ═══`);
  const referencias = projeto.referencias.map((r) => ({ ...r, caminho: caminhoReferencia(projetoId, r.arquivo) }));

  for (const formato of formatos) {
    estado.formatoAtual = formato;
    let preparado = false;

    while (!estado.pararPedido) {
      projeto = await lerProjeto(projetoId);
      const cena = projeto.cenas.find((c) => ["pendente", "processando"].includes(c.saidas[formato]?.status));
      if (!cena) break;
      estado.cenaAtual = cena.id;
      const tentativa = cena.saidas[formato].tentativas + 1;
      log(`Take ${cena.numero} [${formato}] — tentativa ${tentativa} de ${cfg.tentativasPorCena}`);
      await atualizarSaida(projetoId, cena.id, formato, { status: "processando", tentativas: tentativa, erro: null });

      try {
        // === INÍCIO DA PROTEÇÃO ANTI-ERRO COM F5 ===
        // O robô vai tentar configurar e gerar o vídeo. Se falhar, dá F5 e tenta de novo, até ao limite configurado.
        const video = await tentarComReinicio(page, cfg.tentativasPorCena, log, async () => {
          
          if (!preparado) {
            await prepararEditor(page, { config: { ...projeto.config, proporcao: formato }, referencias, log });
            preparado = true;
          }
          
          return await gerarCena(page, {
            prompt: adaptarPrompt(cena.prompt, formato),
            arquivo: `take-${String(cena.numero).padStart(2, "0")}_${sufixoFormato(formato)}.mp4`,
            referencias,
            caminhoQuadroInicial: cena.quadroInicial ? caminhoEntrada(projetoId, cena.quadroInicial) : null,
            pastaSaida: pastaVideos(projetoId),
            log,
          });

        });
        // === FIM DA PROTEÇÃO ===

        log("→ verificar qualidade");
        const caminhoVideo = join(pastaVideos(projetoId), video);
        const qualidade = await verificarVideo(caminhoVideo, {
          duracaoEsperada: cena.duracao ?? (Number(projeto.config.duracao) || null),
          ...cfg.qualidade,
        });
        if (!qualidade.ok) {
          await rename(caminhoVideo, caminhoVideo.replace(/\.mp4$/, `.reprovado-${tentativa}.mp4`));
          throw new Error(`Qualidade reprovada: ${qualidade.motivo}`);
        }
        await atualizarSaida(projetoId, cena.id, formato, { status: "concluida", video, qualidade });
        log(`✔ Take ${cena.numero} [${formato}] aprovado (${qualidade.duracao}s${qualidade.avisos.length ? `; ${qualidade.avisos.join(", ")}` : ""})`);
      } catch (erro) {
        preparado = false;
        const esgotou = tentativa >= cfg.tentativasPorCena;
        await atualizarSaida(projetoId, cena.id, formato, { status: esgotou ? "falhou" : "pendente", erro: erro.message });
        log(`✖ Take ${cena.numero} [${formato}]: ${erro.message}${esgotou ? " — desisti deste take." : " — vou tentar de novo."}`);
      }

      if (estado.pararPedido) return;
      const pausa = entre(cfg.tempos.pausaEntreCenasMs);
      log(`Pausa de ${Math.round(pausa / 1000)} s.`);
      await esperar(pausa);
    }
    if (estado.pararPedido) return;

    projeto = await lerProjeto(projetoId);
    const falhas = projeto.cenas.filter((c) => c.saidas[formato]?.status === "falhou").length;
    if (falhas > 0) log(`Formato ${formato}: ${falhas} take(s) com falha. Clique em "Refazer" neles: o projeto volta para a fila e o vídeo final é montado no fim.`);
    else if (projeto.cenas.length > 0) {
      try {
        await montarVideoFinal(projetoId, formato);
      } catch (erro) {
        log(`Não foi possível montar o vídeo final ${formato}: ${erro.message}`);
      }
    }
  }
}