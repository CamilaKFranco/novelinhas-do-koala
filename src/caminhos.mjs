import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
// No app instalado, o Electron aponta NOVELA_DADOS para a pasta de dados do
// usuário (a pasta de instalação é substituída a cada atualização).
export const DADOS = process.env.NOVELA_DADOS ?? join(RAIZ, "dados");
export const PROJETOS = join(DADOS, "projetos");
// Perfil próprio do Chrome: o login que você fizer no Leonardo fica salvo aqui.
export const PERFIL_NAVEGADOR = join(DADOS, "perfil-chrome");
export const PUBLICO = join(RAIZ, "public");

// A configuração editável fica junto dos dados; na primeira execução ela é
// criada a partir do padrão que vem com o app.
const CONFIG_PADRAO = join(RAIZ, "config", "leonardo.json");
export const CONFIG_LEONARDO = process.env.NOVELA_DADOS ? join(DADOS, "leonardo.json") : CONFIG_PADRAO;
if (!existsSync(CONFIG_LEONARDO)) {
  mkdirSync(DADOS, { recursive: true });
  copyFileSync(CONFIG_PADRAO, CONFIG_LEONARDO);
}
