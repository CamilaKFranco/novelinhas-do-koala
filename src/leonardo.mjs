import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lerConfig } from "./config.mjs";

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

// === SISTEMA ANTI-ERRO (RETRY) ===
export async function tentarComReinicio(page, maxTentativas, log, acao, aoFalhar) {
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    try {
      return await acao();
    } catch (erro) {
      log(`  ⚠ Falha (tentativa ${tentativa}/${maxTentativas}): ${erro.message}`);

      if (tentativa === maxTentativas) {
        log(`  ❌ Abortando após ${maxTentativas} tentativas.`);
        throw erro;
      }

      if (aoFalhar) await aoFalhar();

      log(`  🔄 Atualizando a página (F5) para tentar de novo...`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(6000);
    }
  }
}
// ======================================

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

// === LIMPEZA SEGURA ===
// Só clica em fotos que estão MARCADAS e visíveis. Se não achar nenhuma
// (a grade só mostra parte das fotos), para e avisa, em vez de clicar na
// primeira foto da grade — era isso que fazia o vaivém marca/desmarca.
async function limparSelecao(page, cfg, log) {
  const janela = janelaMidia(page, cfg);
  let atual = (await contarSelecionados(page, cfg))?.atual ?? 0;
  if (atual === 0) return;

  log(`  desmarcando ${atual} referência(s) da novela anterior...`);

  for (let i = 0; i < 20; i++) {
    atual = (await contarSelecionados(page, cfg))?.atual ?? 0;
    if (atual === 0) break;

    const itensAtivos = janela.locator(cfg.seletores.itemSelecionado);
    if ((await itensAtivos.count()) === 0) break;
    await itensAtivos.first().click({ timeout: 5000 }).catch(() => {});
    // Espera o site atualizar antes do próximo clique (evita clicar 2x na mesma foto).
    await page.waitForTimeout(1500);
  }

  const restante = (await contarSelecionados(page, cfg))?.atual ?? 0;
  if (restante > 0)
    throw new Error(`não consegui desmarcar ${restante} referência(s) antiga(s) — desmarque-as uma vez na janela "Select Media" do Leonardo e tente de novo`);
}
// ========================================

export async function enviarPelaSelecaoDeMidia(page, cfg, { cartao, caminhos, log }) {
  await abrirPainelReferencia(page, cfg);
  const painel = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Reference", exact: true }) });
  await painel.getByRole("button", { name: regex(cartao) }).first().click({ timeout: 10000 });
  const janela = janelaMidia(page, cfg);
  await janela.waitFor({ state: "visible", timeout: 15000 });
  const abaUploads = janela.getByRole("tab", { name: regex(cfg.textos.abaUploads) }).or(janela.getByText(regex(cfg.textos.abaUploads))).first();
  if (await abaUploads.isVisible().catch(() => false)) await abaUploads.click();
  await page.waitForTimeout(1500);

  const limite = (await contarSelecionados(page, cfg))?.maximo;
  if (limite && caminhos.length > limite) throw new Error(`o Leonardo aceita no máximo ${limite} imagem(ns) aqui (o projeto tem ${caminhos.length})`);

  await limparSelecao(page, cfg, log);

  const campoArquivo = janela.locator("input[type=file]").first();
  await campoArquivo.waitFor({ state: "attached", timeout: 6000 }).catch(() => {});

  if ((await campoArquivo.count()) > 0) {
    log(`  enviando ${caminhos.length} imagem(ns) diretamente pelo site`);
    if (await campoArquivo.evaluate((i) => i.multiple)) {
      await campoArquivo.setInputFiles(caminhos);
    } else {
      for (const caminho of caminhos) {
        await campoArquivo.setInputFiles(caminho);
        await page.waitForTimeout(2500);
      }
    }
    await page.waitForTimeout(4000);
  } else {
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
  }

  // O Leonardo marca sozinho as fotos recém-enviadas. O robô só espera o
  // contador chegar em N/9 — não clica nas fotos pela posição na grade
  // (a grade é em colunas e a 1ª posição pode ser uma foto antiga).
  const n = caminhos.length;
  const selecionados = await esperarAte(page, async () => ((await contarSelecionados(page, cfg))?.atual === n ? n : 0), 60000, 1500);
  if (!selecionados) {
    const atual = (await contarSelecionados(page, cfg))?.atual ?? 0;
    throw new Error(`a janela mostra ${atual} selecionada(s), esperado ${n} — confira a janela "Select Media"`);
  }
  await janela.getByRole("button", { name: regex(cfg.textos.confirmar) }).click({ timeout: 10000 });
  await janela.waitFor({ state: "hidden", timeout: 15000 });
}

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

async function referenciasNoCartao(page, cfg) {
  await abrirPainelReferencia(page, cfg);
  const cartao = page.locator("div,button").filter({ hasText: regex(cfg.textos.cartaoReferenciaImagem) }).filter({ hasText: /\d+\s*\/\s*\d+/ }).last();
  const texto = await cartao.textContent({ timeout: 5000 }).catch(() => "");
  const m = texto.match(/(\d+)\s*\/\s*(\d+)/);
  await page.keyboard.press("Escape");
  return m ? Number(m[1]) : null;
}

export async function garantirReferencias(page, cfg, referencias, log) {
  const n = referencias.length;
  const atuais = await contarReferencias(page, cfg);

  if (n === 0) {
    if (atuais === 0) return;

    log(`  limpando referência(s) da novela anterior...`);
    await abrirPainelReferencia(page, cfg);
    const painel = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Reference", exact: true }) });
    await painel.getByRole("button", { name: regex(cfg.textos.cartaoReferenciaImagem) }).first().click({ timeout: 10000 });
    const janela = janelaMidia(page, cfg);
    await janela.waitFor({ state: "visible", timeout: 15000 });

    const selecionados = (await contarSelecionados(page, cfg))?.atual ?? 0;
    if (selecionados > 0) {
      await limparSelecao(page, cfg, log);
      await janela.getByRole("button", { name: regex(cfg.textos.confirmar) }).click({ timeout: 10000 });
      await janela.waitFor({ state: "hidden", timeout: 15000 });
    } else {
      await page.keyboard.press("Escape");
    }
    return;
  }

  // Se as referências certas já estão ativas, não envia de novo
  // (evita fotos repetidas na galeria a cada take/tentativa).
  if (atuais === n) return log(`  referências já presentes (${n})`);

  log(`  preparando ${n} referência(s) da novela atual...`);
  await enviarPelaSelecaoDeMidia(page, cfg, { cartao: cfg.textos.cartaoReferenciaImagem, caminhos: referencias.map((r) => r.caminho), log });

  const naUrl = await esperarAte(page, async () => ((await contarReferencias(page, cfg)) === n ? n : 0), 20000);
  const confirmadas = naUrl || (await referenciasNoCartao(page, cfg));
  if (confirmadas !== n) throw new Error(`o Leonardo mostra ${confirmadas ?? "?"} referência(s) e o projeto exige ${n}`);
  log(`  ${n} referência(s) ativa(s): ${referencias.map((r) => r.rotulo).join(", ")}`);
}

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
  page.$$eval("video", (vs) => vs.map((v) => v.currentSrc || v.src || v.querySelector("source")?.src).filter((s) => s && !s.includes("/static/")));

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
    // Aviso vermelho do Leonardo quando já há gerações demais na fila da conta.
    const avisoLimite = page.getByText(/Pending generations limit exceeded/i).first();
    const ESPERA_MS = 60000; // espera 1 min antes de tentar de novo
    const MAX_TENTATIVAS = 20; // ~20 min no total

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      await botao.waitFor({ state: "visible", timeout: 15000 });
      if (await botao.isDisabled()) throw new Error("o botão de gerar está desabilitado (sem créditos ou campo faltando?)");
      await botao.click();

      // Dá 6 s para o aviso aparecer. Se não aparecer, a geração foi aceita.
      const recusado = await avisoLimite.waitFor({ state: "visible", timeout: 6000 }).then(() => true).catch(() => false);
      if (!recusado) return;

      if (tentativa === MAX_TENTATIVAS) throw new Error(`o Leonardo continuou recusando ("Pending generations limit exceeded") depois de ${MAX_TENTATIVAS} tentativas`);
      log(`  ⏳ fila do Leonardo cheia ("Pending generations limit exceeded") — tentando de novo em ${ESPERA_MS / 1000} s (${tentativa}/${MAX_TENTATIVAS})`);
      // Fecha o aviso e espera alguma geração pendente terminar.
      await page.getByRole("button", { name: /close|fechar/i }).filter({ has: page.locator("svg") }).first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(ESPERA_MS);
    }
  });

  const url = await etapa("aguardar o vídeo ficar pronto", log, async () => {
    const handle = await page.waitForFunction(
      (anteriores) => {
        for (const v of document.querySelectorAll("video")) {
          const src = v.currentSrc || v.src || v.querySelector("source")?.src;
          if (src && !src.startsWith("blob:") && !src.includes("/static/") && !anteriores.includes(src)) return src;
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
