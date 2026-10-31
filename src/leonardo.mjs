import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lerConfig } from "./config.mjs";

// Os textos e seletores da página ficam em leonardo.json: quando o site
// mudar, ajuste lá em vez de mexer no código.
const regex = (texto) => new RegExp(texto, "i");
const escapar = (texto) => String(texto).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class EtapaFalhou extends Error {
  constructor(etapa, causa) {
    super(`Etapa "${etapa}": ${causa?.message ?? causa}`);
    this.etapa = etapa;
  }
}

async function etapa(nome, log, acao) {
  log(`→ ${nome}`);
  try {
    return await acao();
  } catch (erro) {
    throw new EtapaFalhou(nome, erro);
  }
}

export async function verificarLogin(page) {
  const cfg = lerConfig();
  if (!page.url().includes("leonardo.ai")) {
    await page.goto(cfg.urlInicio, { waitUntil: "domcontentloaded" });
  }
  await page.waitForTimeout(cfg.tempos.esperaAposCarregarMs);
  const pedeLogin = await page
    .getByRole("button", { name: regex(cfg.textos.login) })
    .or(page.getByRole("link", { name: regex(cfg.textos.login) }))
    .first()
    .isVisible()
    .catch(() => false);
  return !pedeLogin && !/\/auth|login|signin/i.test(page.url());
}

// Fluxo do Leonardo para referências e Start frame:
//   ícone de imagem ao lado do prompt → painel "Reference" → cartão
//   ("Image Reference" ou "Start frame") → janela "Select Media" →
//   "Upload an image" → seleção ("N/9 selected") → "Confirm".

const esperarAte = async (page, condicao, ms, intervalo = 1000) => {
  const limite = Date.now() + ms;
  let valor = await condicao();
  while (!valor && Date.now() < limite) {
    await page.waitForTimeout(intervalo);
    valor = await condicao();
  }
  return valor;
};

async function abrirPainelReferencia(page, cfg) {
  const painel = page.getByText(regex(cfg.textos.tituloPainelReferencia)).first();
  if (await painel.isVisible().catch(() => false)) return;
  // O ícone não tem texto: tenta o seletor configurado e, se não achar, o
  // primeiro botão dentro da caixa do prompt.
  let botao = page.locator(cfg.seletores.botaoReferencias).first();
  if (!(await botao.isVisible().catch(() => false))) {
    const caixa = page.locator(cfg.seletores.prompt).first().locator("xpath=ancestor::*[.//button][1]");
    botao = caixa.locator("button").first();
  }
  await botao.click({ timeout: 15000 });
  await painel.waitFor({ state: "visible", timeout: 10000 });
}

const janelaMidia = (page, cfg) =>
  page.getByRole("dialog").filter({ hasText: regex(cfg.textos.tituloSelecaoMidia) }).first();

async function contarSelecionados(page, cfg) {
  const texto = await janelaMidia(page, cfg).getByText(regex(cfg.textos.selecionados)).first().textContent({ timeout: 3000 }).catch(() => null);
  const m = texto?.match(regex(cfg.textos.selecionados));
  return m ? { atual: Number(m[1]), maximo: Number(m[2]) } : null;
}

// Desmarca o que estiver selecionado na janela (referências de outro projeto).
async function limparSelecao(page, cfg, log) {
  const janela = janelaMidia(page, cfg);
  const inicial = (await contarSelecionados(page, cfg))?.atual ?? 0;
  if (inicial === 0) return;
  log(`  desmarcando ${inicial} referência(s) antiga(s)`);
  const marcados = janela.locator(cfg.seletores.itemSelecionado);
  for (let i = 0; i < inicial + 2 && (await marcados.count()) > 0; i++) {
    await marcados.first().click({ timeout: 5000 });
    await page.waitForTimeout(500);
  }
  const restante = (await contarSelecionados(page, cfg))?.atual ?? 0;
  if (restante > 0)
    throw new Error(`não consegui desmarcar ${restante} referência(s) antiga(s) — desmarque-as uma vez na janela "Select Media" do Leonardo e tente de novo`);
}

export async function enviarPelaSelecaoDeMidia(page, cfg, { cartao, caminhos, log }) {
  await abrirPainelReferencia(page, cfg);
  await page.getByText(regex(cartao)).first().click({ timeout: 10000 });
  const janela = janelaMidia(page, cfg);
  await janela.waitFor({ state: "visible", timeout: 15000 });
  const abaUploads = janela.getByRole("tab", { name: regex(cfg.textos.abaUploads) }).or(janela.getByText(regex(cfg.textos.abaUploads))).first();
  if (await abaUploads.isVisible().catch(() => false)) await abaUploads.click();
  await page.waitForTimeout(1500);

  const limite = (await contarSelecionados(page, cfg))?.maximo;
  if (limite && caminhos.length > limite) throw new Error(`o Leonardo aceita no máximo ${limite} imagem(ns) aqui (o projeto tem ${caminhos.length})`);
  await limparSelecao(page, cfg, log);

  const escolher = async () => {
    const [seletor] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 15000 }),
      janela.getByText(regex(cfg.textos.uploadImagem)).first().click({ timeout: 15000 }),
    ]);
    return seletor;
  };
  const primeiro = await escolher();
  if (primeiro.isMultiple()) await primeiro.setFiles(caminhos);
  else {
    await primeiro.setFiles(caminhos[0]);
    for (const caminho of caminhos.slice(1)) {
      await page.waitForTimeout(2500);
      await (await escolher()).setFiles(caminho);
    }
  }

  // Os envios novos aparecem selecionados (ou logo depois do botão de upload).
  const n = caminhos.length;
  let selecionados = await esperarAte(page, async () => ((await contarSelecionados(page, cfg))?.atual === n ? n : 0), 60000, 1500);
  if (!selecionados) {
    const atual = (await contarSelecionados(page, cfg))?.atual ?? 0;
    if (atual !== 0) throw new Error(`a janela mostra ${atual} selecionada(s), esperado ${n}`);
    log(`  selecionando as ${n} imagem(ns) enviadas`);
    const itens = janela.locator(cfg.seletores.itemMidia);
    for (let i = 0; i < n; i++) await itens.nth(i).click({ timeout: 5000 });
    selecionados = await esperarAte(page, async () => ((await contarSelecionados(page, cfg))?.atual === n ? n : 0), 10000);
    if (!selecionados) throw new Error(`não consegui selecionar as ${n} imagem(ns) enviadas`);
  }
  await janela.getByRole("button", { name: regex(cfg.textos.confirmar) }).click({ timeout: 10000 });
  await janela.waitFor({ state: "hidden", timeout: 15000 });
}

// Referências ativas: pelo parâmetro da URL (ex.: imageGuidance) que o
// Leonardo atualiza depois da seleção ou, sem ele, pelas miniaturas "Imag…"
// embaixo do prompt. Retorna null quando não dá para saber.
async function contarReferencias(page, cfg) {
  const valor = new URL(page.url()).searchParams.get(cfg.seletores.parametroReferenciasUrl);
  if (valor !== null) {
    const ids = decodeURIComponent(valor).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    return ids ? new Set(ids).size : 0;
  }
  const caixa = page.locator(cfg.seletores.prompt).first().locator("xpath=ancestor::*[.//button][1]");
  const miniaturas = await caixa.locator(cfg.seletores.miniaturaReferencia).count().catch(() => 0);
  return miniaturas > 0 ? miniaturas : null;
}

// Total "N/9" mostrado no cartão "Image Reference" do painel.
async function referenciasNoCartao(page, cfg) {
  await abrirPainelReferencia(page, cfg);
  const cartao = page.locator("div,button").filter({ hasText: regex(cfg.textos.cartaoReferenciaImagem) }).filter({ hasText: /\d+\s*\/\s*\d+/ }).last();
  const texto = await cartao.textContent({ timeout: 5000 }).catch(() => "");
  const m = texto.match(/(\d+)\s*\/\s*(\d+)/);
  await page.keyboard.press("Escape");
  return m ? Number(m[1]) : null;
}

export async function garantirReferencias(page, cfg, referencias, log) {
  if (referencias.length === 0) return;
  const n = referencias.length;
  if ((await contarReferencias(page, cfg)) === n) return log(`  referências já presentes (${n})`);

  await enviarPelaSelecaoDeMidia(page, cfg, { cartao: cfg.textos.cartaoReferenciaImagem, caminhos: referencias.map((r) => r.caminho), log });

  // O Leonardo pode mostrar as miniaturas antes de atualizar a URL.
  const naUrl = await esperarAte(page, async () => ((await contarReferencias(page, cfg)) === n ? n : 0), 20000);
  const confirmadas = naUrl || (await referenciasNoCartao(page, cfg));
  if (confirmadas !== n) throw new Error(`o Leonardo mostra ${confirmadas ?? "?"} referência(s) e o projeto exige ${n}`);
  log(`  ${n} referência(s) ativa(s): ${referencias.map((r) => r.rotulo).join(", ")}`);
}

// Barra deslizante (ex.: Duration): move com as setas até o valor pedido.
async function ajustarSlider(page, rotulo, alvo) {
  const slider = rotulo
    ? page.locator("div,section,label").filter({ hasText: regex(rotulo) }).getByRole("slider").first()
    : page.getByRole("slider").first();
  await slider.waitFor({ state: "visible", timeout: 15000 });
  const ler = async (atributo) => Number(await slider.getAttribute(atributo));
  const maximo = await ler("aria-valuemax");
  const minimo = await ler("aria-valuemin");
  if (Number.isFinite(maximo) && alvo > maximo) throw new Error(`o Leonardo permite no máximo ${maximo}s neste modelo (pedido: ${alvo}s)`);
  if (Number.isFinite(minimo) && alvo < minimo) throw new Error(`o Leonardo exige no mínimo ${minimo}s neste modelo (pedido: ${alvo}s)`);
  await slider.focus();
  for (let i = 0; i < 120; i++) {
    const atual = await ler("aria-valuenow");
    if (!Number.isFinite(atual)) throw new Error("não consegui ler o valor da barra");
    if (atual === alvo) return;
    await slider.press(atual < alvo ? "ArrowRight" : "ArrowLeft");
    await page.waitForTimeout(60);
  }
  throw new Error(`a barra não chegou em ${alvo} (valor atual: ${await ler("aria-valuenow")})`);
}

// Cada controle do painel tem um tipo (veja "configuracao" em leonardo.json):
// "menu" (abre e escolhe), "botao" (clica direto) ou "slider" (barra).
export async function aplicarConfiguracao(page, cfg, config, log) {
  for (const { campo, tipo, abrir, opcao, rotulo } of cfg.configuracao) {
    const valor = config[campo];
    if (!valor) continue;
    const alvo = opcao ? regex(opcao.replace("{valor}", escapar(valor))) : null;

    if (tipo === "slider") await ajustarSlider(page, rotulo, Number(valor));
    else if (tipo === "botao") await page.getByRole("button", { name: alvo }).or(page.getByRole("radio", { name: alvo })).or(page.getByText(alvo)).first().click({ timeout: 15000 });
    else if (tipo === "menu") {
      if (await page.getByText(alvo).first().isVisible().catch(() => false)) {
        log(`  ${campo}: ${valor} (já selecionado)`);
        continue;
      }
      await page.getByText(regex(abrir)).first().click({ timeout: 15000 });
      await page.getByText(alvo).first().click({ timeout: 15000 });
    } else {
      log(`  ⚠ "${campo}" sem tipo definido em leonardo.json — mantendo o que está no site (desejado: ${valor})`);
      continue;
    }
    await page.waitForTimeout(500);
    log(`  ${campo}: ${valor}`);
  }
}

// Abre o editor uma vez por projeto, aplica as configurações e envia as
// referências globais. Os takes seguintes reaproveitam esse estado.
export async function prepararEditor(page, { config, referencias, log }) {
  const cfg = lerConfig();
  await etapa("abrir editor de vídeo", log, async () => {
    await page.goto(cfg.urlEditorVideo, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(cfg.tempos.esperaAposCarregarMs);
  });
  await etapa("selecionar a aba Video", log, async () => {
    const aba = page.getByRole("button", { name: regex(cfg.textos.abaVideo) }).or(page.getByRole("tab", { name: regex(cfg.textos.abaVideo) })).first();
    await aba.click({ timeout: 15000 });
    await page.waitForTimeout(800);
  });
  await etapa("aplicar configurações do projeto", log, () => aplicarConfiguracao(page, cfg, config, log));
  await etapa("enviar referências globais", log, () => garantirReferencias(page, cfg, referencias, log));
}

const videosNaPagina = (page) =>
  page.$$eval("video", (vs) => vs.map((v) => v.currentSrc || v.src || v.querySelector("source")?.src).filter(Boolean));

export async function gerarCena(page, { prompt, arquivo, referencias, caminhoQuadroInicial, pastaSaida, log }) {
  const cfg = lerConfig();

  await etapa("conferir editor e referências", log, async () => {
    if (!(await page.locator(cfg.seletores.prompt).first().isVisible().catch(() => false)))
      throw new Error("o editor de vídeo não está aberto");
    const atuais = await contarReferencias(page, cfg);
    if (atuais !== null && atuais !== referencias.length)
      throw new Error(`referências mudaram (${atuais} de ${referencias.length}); não gerar até preparar de novo`);
  });

  if (caminhoQuadroInicial) {
    await etapa("enviar quadro inicial", log, () =>
      enviarPelaSelecaoDeMidia(page, cfg, { cartao: cfg.textos.cartaoStartFrame, caminhos: [caminhoQuadroInicial], log }),
    );
    await page.waitForTimeout(3000);
  }

  await etapa("escrever prompt", log, async () => {
    const campo = page.locator(cfg.seletores.prompt).first();
    await campo.click({ timeout: 15000 });
    await campo.fill(prompt);
  });

  const antes = await videosNaPagina(page);

  await etapa("clicar em gerar", log, async () => {
    const botao = page.getByRole("button", { name: regex(cfg.textos.gerar) }).first();
    await botao.waitFor({ state: "visible", timeout: 15000 });
    if (await botao.isDisabled()) throw new Error("o botão de gerar está desabilitado (sem créditos ou campo faltando?)");
    await botao.click();
  });

  const url = await etapa("aguardar o vídeo ficar pronto", log, async () => {
    const handle = await page.waitForFunction(
      (anteriores) => {
        for (const v of document.querySelectorAll("video")) {
          const src = v.currentSrc || v.src || v.querySelector("source")?.src;
          if (src && !src.startsWith("blob:") && !anteriores.includes(src)) return src;
        }
        return null;
      },
      antes,
      { timeout: cfg.tempos.maximoGeracaoMs, polling: 5000 },
    );
    return handle.jsonValue();
  });

  return etapa("baixar o vídeo", log, async () => {
    const resposta = await page.request.get(url);
    if (!resposta.ok()) throw new Error(`download respondeu ${resposta.status()}`);
    await writeFile(join(pastaSaida, arquivo), await resposta.body());
    return arquivo;
  });
}
