# 🐨🎬 Novelinhas do Koala

Grandes histórias, um take de cada vez.

Aplicativo de Windows que organiza a produção de novelinhas em vídeo no
[Leonardo AI](https://app.leonardo.ai/). Ele usa o seu navegador, logado na
**sua própria conta** do Leonardo, para gerar os takes um por um, confere a
qualidade de cada vídeo e no final junta tudo num vídeo só.

## O que ele faz

- **Importa episódios em `.zip`** (até 10 de uma vez), com o `prompts.txt` e as
  fichas de personagens e cenário.
- **Fila de produção:** um episódio completo por vez, com progresso, tempo
  produzido e reordenação por arrastar.
- **Referências globais:** envia as fichas para o Leonardo (Image Reference) e
  confere antes de cada take.
- **Formato 9:16 (vertical) ou 16:9 (horizontal)**, com modelo, velocidade,
  resolução e duração configuráveis.
- **Verificação de qualidade** com FFmpeg (duração, imagem preta, áudio, arquivo
  corrompido) e nova tentativa automática quando um take é reprovado.
- **Vídeo final automático:** quando todos os takes ficam prontos, eles são
  juntados num único arquivo.

> Cada pessoa usa a própria conta do Leonardo e os próprios créditos. O app
> nunca guarda nem digita senhas: você faz o login na janela do navegador.

## Como instalar (para desenvolver ou gerar o seu instalador)

Você precisa do Windows 10/11 e do Google Chrome instalado.

1. Instale o [Node.js 24](https://nodejs.org/) e o [Git](https://git-scm.com/).
2. Baixe o projeto e instale as dependências:

```bash
git clone https://github.com/CamilaKFranco/novelinhas-do-koala.git
```

```bash
cd novelinhas-do-koala
```

```bash
npm install
```

3. Instale o FFmpeg (usado para conferir e juntar os vídeos):

```bash
winget install Gyan.FFmpeg
```

4. Rode o app:

```bash
npm run app
```

Ou, sem a janela do app, só no navegador: `npm start` e abra
http://localhost:4321.

## Gerar o instalador (.exe)

O instalador leva o FFmpeg junto. Antes de gerar, copie o `ffmpeg.exe`
(instalado no passo 3) para a pasta `vendor/ffmpeg/` do projeto. Depois rode:

```bash
npm run instalador
```

O instalador aparece na pasta `instalador/`.

## Como usar

1. Clique em **Abrir navegador e fazer login** e entre na sua conta do Leonardo.
2. Importe o `.zip` do episódio. Ele pode entrar direto na fila.
3. Abra o projeto, escolha o formato e as configurações e clique em
   **Salvar configurações**.
4. Na aba **Fila de produção**, clique em **Iniciar fila**.

Os projetos e vídeos ficam em `%APPDATA%\Novelinhas do Koala\dados`.

## Ajustes do site

O Leonardo muda a tela de vez em quando. Os textos e seletores que o robô
procura ficam em `config/leonardo.json`. Se uma etapa falhar, o **Registro** na
tela mostra qual foi, e é só ajustar ali.

## Estrutura

| Pasta | O que tem |
|---|---|
| `electron/` | Janela do app de desktop |
| `server.mjs` | Servidor local e API |
| `src/` | Fila, projetos, automação do navegador e FFmpeg |
| `public/` | Tela do app |
| `config/leonardo.json` | Endereços, textos e seletores do site |
