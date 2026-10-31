import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RAIZ } from "./caminhos.mjs";

// Ordem de busca: variável de ambiente, cópia embutida no app instalado,
// cópia em vendor/ (desenvolvimento) e, por último, o PATH do sistema.
function caminhoFfmpeg() {
  const candidatos = [
    process.env.NOVELA_FFMPEG,
    process.resourcesPath && join(process.resourcesPath, "ffmpeg", "ffmpeg.exe"),
    join(RAIZ, "vendor", "ffmpeg", "ffmpeg.exe"),
  ];
  return candidatos.find((c) => c && existsSync(c)) ?? "ffmpeg";
}

function rodar(args) {
  return new Promise((resolve, reject) => {
    const processo = spawn(caminhoFfmpeg(), ["-hide_banner", ...args], { windowsHide: true });
    let stderr = "";
    processo.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    processo.on("error", (erro) =>
      reject(erro.code === "ENOENT" ? new Error("FFmpeg não encontrado.") : erro),
    );
    processo.on("close", (codigo) => resolve({ codigo, stderr }));
  });
}

const segundos = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

// Reprova vídeos corrompidos, sem imagem, com duração muito diferente da
// pedida ou quase todo preto. Falta de áudio vira só um aviso.
export async function verificarVideo(arquivo, { duracaoEsperada, toleranciaDuracaoS, maxProporcaoPreta, tamanhoMinimoKB }) {
  const avisos = [];
  const tamanhoKB = Math.round(statSync(arquivo).size / 1024);
  if (tamanhoKB < tamanhoMinimoKB) return { ok: false, motivo: `arquivo pequeno demais (${tamanhoKB} KB)`, avisos };

  const { codigo, stderr } = await rodar(["-i", arquivo, "-vf", "blackdetect=d=1:pix_th=0.10", "-f", "null", "-"]);
  if (codigo !== 0) return { ok: false, motivo: "o vídeo não pôde ser decodificado (arquivo corrompido?)", avisos };

  const d = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const duracao = d ? Math.round(segundos(d[1], d[2], d[3]) * 10) / 10 : null;
  if (!/Stream #.*Video:/.test(stderr)) return { ok: false, motivo: "o arquivo não tem imagem", avisos, duracao };
  if (!/Stream #.*Audio:/.test(stderr)) avisos.push("sem áudio");

  if (duracao === null) return { ok: false, motivo: "não foi possível ler a duração", avisos };
  if (duracaoEsperada && Math.abs(duracao - duracaoEsperada) > toleranciaDuracaoS)
    return { ok: false, motivo: `duração ${duracao}s, esperado ${duracaoEsperada}s`, avisos, duracao };

  const preto = [...stderr.matchAll(/black_duration:([\d.]+)/g)].reduce((t, m) => t + Number(m[1]), 0);
  if (preto >= duracao * maxProporcaoPreta)
    return { ok: false, motivo: `vídeo quase todo preto (${Math.round(preto)}s de ${duracao}s)`, avisos, duracao };
  if (preto >= 1) avisos.push(`${Math.round(preto)}s de tela preta`);

  return { ok: true, motivo: null, avisos, duracao };
}

// Junta os takes em ordem. Tenta primeiro sem recodificar (rápido e sem
// perda); se os arquivos não forem compatíveis, recodifica.
export async function juntarVideos(arquivos, saida) {
  const lista = `${saida}.lista.txt`;
  await writeFile(lista, arquivos.map((a) => `file '${a.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  try {
    const base = ["-y", "-f", "concat", "-safe", "0", "-i", lista];
    let r = await rodar([...base, "-c", "copy", "-movflags", "+faststart", saida]);
    if (r.codigo !== 0)
      r = await rodar([...base, "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", saida]);
    if (r.codigo !== 0) throw new Error(`FFmpeg falhou ao juntar: ${r.stderr.trim().split("\n").pop()}`);
  } finally {
    await rm(lista, { force: true });
  }
}
