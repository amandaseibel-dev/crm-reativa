// Situações de título que o borderô NUNCA reabre.
//
// 08/10/2026 — a lista foi ampliada por pedido da gestão ("impedir reativação de
// parcelas negociadas, pagas, quitadas, suspensas, canceladas, devolvidas ou
// encerradas"). Antes tinha só as três primeiras, e **NEGOCIADO ficava de fora**:
// o `upsert` do borderô grava `situacao: 'ABERTO'` fixo, então toda mensalidade
// negociada que voltasse no arquivo era reaberta — e nenhum dos três gatilhos de
// banco cobre NEGOCIADO (ver docs/SIMULACAO-REIMPORTACAO-PARCELAS-AUSENTES-2026-10-08.md §3).
//
//   PAGO            -- dívida concluída;
//   EM_CONFIRMACAO  -- aguardando a Conferência Prime (o banco também recusa);
//   CANCELADA       -- saída administrativa (saiu da base / encerramento pela
//                      Conferência Prime): terminal, não volta a ser cobrada;
//   NEGOCIADO       -- a dívida virou acordo. Reabrir desfaz a negociação e
//                      arrisca cobrar em dobro (o acordo já tem as parcelas);
//   QUITADO/QUITADA -- liquidada;
//   CANCELADO       -- grafia masculina presente na base;
//   DEVOLVIDA/DEVOLVIDO -- baixa devolvida: o desfecho é administrativo e
//                      pertence ao financeiro, não ao importador.
//
// "Suspensa" NÃO é situação de título: vive em `alunos.status_*`
// (SUSPENSAO_COBRANCA / JURIDICO / CANCELAMENTO_COBRANCA). A proteção desse caso
// é por aluno, na RPC `mensalidades_ausentes_inserir`, não aqui.
export const SITUACOES_QUE_NAO_REABREM = Object.freeze([
  "PAGO",
  "EM_CONFIRMACAO",
  "CANCELADA",
  "CANCELADO",
  "NEGOCIADO",
  "QUITADO",
  "QUITADA",
  "DEVOLVIDA",
  "DEVOLVIDO",
]);

export function naoReabreNoBordero(situacaoAtual) {
  return SITUACOES_QUE_NAO_REABREM.includes(String(situacaoAtual || "").toUpperCase());
}

// Status (coluna `status`, minúscula) que também são terminais. A situação e o
// status divergem na base — há título `VENCIDA`/`quitada` —, então conferir só
// `situacao` deixa passar linha já liquidada.
export const STATUS_QUE_NAO_REABREM = Object.freeze([
  "quitada",
  "cancelada",
  "devolvida",
]);

export function statusNaoReabreNoBordero(statusAtual) {
  return STATUS_QUE_NAO_REABREM.includes(String(statusAtual || "").toLowerCase());
}

// Decisão única usada pelo importador: este título existente pode ser tocado?
// Resposta sempre NÃO a partir de 08/10/2026 — o borderô passou a ser
// insert-only. Esta função existe para que o motivo do "ignorado" apareça na
// tela e no teste, não para liberar escrita.
export function motivoDeNaoTocar({ jaExiste, situacaoAtual, statusAtual }) {
  if (!jaExiste) return null;
  if (naoReabreNoBordero(situacaoAtual)) return `situação ${String(situacaoAtual).toUpperCase()}`;
  if (statusNaoReabreNoBordero(statusAtual)) return `status ${String(statusAtual).toLowerCase()}`;
  return "título já existe (a importação não atualiza existente)";
}

// ---------------------------------------------------------------------------
// CHAVE NORMALIZADA DO DOCUMENTO (boleto)
// ---------------------------------------------------------------------------
//
// 27/10/2026. Espelha EXATAMENTE a `extracao_documento_norm()` do banco
// (`nullif(ltrim(documento,'0'),'')`, ver 20261001183516): só o zero à esquerda
// sai, nada mais. Duas implementações da mesma regra em linguagens diferentes é
// meio caminho para divergirem, então a regra é uma linha e o teste compara as
// duas contra os mesmos casos.
//
// POR QUE ISTO EXISTE. O banco tem `acordos_titulos_documento_key` UNIQUE sobre
// o `documento` **cru**: para ele, '04039712' e '4039712' são chaves
// diferentes. Os importadores, porém, casam por `ltrim`. Então a tela podia
// olhar o valor cru, não achar o título que existe, e inserir a variante —
// duplicando a dívida. Medido em 01/10/2026 a base estava limpa (47.949
// documentos, 0 colisão sob normalização), mas isso é uma foto, não uma
// garantia sobre o próximo arquivo.
//
// A partir daqui a tela compara, deduplica e decide SEMPRE por esta chave.
export function chaveDocumento(valor) {
  const texto = String(valor ?? "").trim();
  const semZeros = texto.replace(/^0+/, "");
  return semZeros === "" ? null : semZeros;
}

// Variantes a consultar no banco para um documento do arquivo.
//
// O problema que isto resolve: o `.in()` do PostgREST compara valor LITERAL, e
// não existe filtro por função. Se o arquivo traz '4039712' e a base guarda
// '04039712', a consulta pelo valor do arquivo **não acha** o título que
// existe, e o pré-filtro deixa passar uma duplicata. O contrário também vale.
//
// Não há como enumerar todas as variantes (zeros à esquerda são infinitos),
// então o limite é declarado e pequeno: a forma do arquivo, a forma sem zeros,
// e até MAX_ZEROS zeros à frente. A taxonomia medida em 01/10/2026 tem boletos
// de 6, 7, 12, 13 e 20 dígitos — três zeros cobrem a diferença entre todas as
// faixas vizinhas com folga.
//
// RESÍDUO ASSUMIDO, e por isso a colisão também é reportada: uma base com mais
// de três zeros à esquerda escaparia daqui. Nenhum caso assim existe hoje
// (0 colisão em 47.949), e o censo da migration 20261027120000 volta a medir
// isso a cada aplicação.
const MAX_ZEROS_DE_BUSCA = 3;

export function variantesDeDocumento(valor) {
  const texto = String(valor ?? "").trim();
  if (!texto) return [];
  const base = chaveDocumento(texto);
  if (!base) return [texto];
  const fora = new Set([texto, base]);
  for (let i = 1; i <= MAX_ZEROS_DE_BUSCA; i += 1) fora.add("0".repeat(i) + base);
  return [...fora];
}

// Indexa títulos existentes pela chave NORMALIZADA, não pelo valor cru.
// Primeiro a ganhar fica: se a base tiver duas grafias do mesmo boleto (hoje
// não tem), a tela trata as duas como "já existe" e não insere nenhuma — que é
// o lado seguro do erro.
export function indexarTitulosPorDocumento(titulos) {
  const mapa = {};
  for (const titulo of titulos || []) {
    const chave = chaveDocumento(titulo?.documento);
    if (!chave) continue;
    if (!mapa[chave]) mapa[chave] = titulo;
  }
  return mapa;
}

// Linhas do PRÓPRIO arquivo que colidem entre si sob a chave normalizada.
//
// É divergência de verdade: duas grafias do mesmo boleto na mesma remessa. A
// primeira entra, as outras são recusadas — e **aparecem**, com o motivo. A
// exigência da gestão em 27/10/2026 foi "sem introduzir duplicidades nem
// ocultar divergências": recusar sem dizer seria ocultar.
export function colisoesNormalizadasNoLote(linhas) {
  const porChave = new Map();
  for (const linha of linhas || []) {
    const chave = chaveDocumento(linha?.numTitulo);
    if (!chave) continue;
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(linha);
  }
  const colisoes = [];
  for (const [chave, grupo] of porChave) {
    const grafias = [...new Set(grupo.map((l) => String(l.numTitulo).trim()))];
    // Mesma grafia repetida é linha duplicada no arquivo; grafias diferentes
    // sob a mesma chave é a colisão que o banco cru não vê. Os dois casos
    // interessam, e o motivo distingue.
    if (grupo.length > 1) {
      colisoes.push({
        chave,
        grafias,
        linhas: grupo,
        motivo: grafias.length > 1
          ? `mesmo boleto com ${grafias.length} grafias no arquivo (${grafias.join(", ")})`
          : `linha repetida ${grupo.length}x no arquivo`,
      });
    }
  }
  return colisoes;
}

// ---------------------------------------------------------------------------
// CADASTRO ÚNICO POR CPF NO IMPORTADOR
// ---------------------------------------------------------------------------
//
// O defeito, medido em produção (borderô 723, 08/10/2026 19:18, 2.155 linhas):
// **14 CPFs ganharam de 2 a 5 fichas cada, 33 fichas no total.**
//
// A causa era uma linha só. `confirmarImportacao` montava os cadastros novos
// assim:
//
//     const linhasSemAluno = preview.linhas.filter((l) => !l.aluno);
//     inserirEmLotes("alunos", linhasSemAluno.map(...))
//
// O borderô tem **uma linha por título**, não por aluno. Quem devia 6
// mensalidades aparecia em 6 linhas; nenhuma batia com cadastro existente, e as
// 6 viravam 6 fichas. Os títulos depois caíam todos numa delas (o mapa
// `cpf -> aluno` guarda o último inserido), e as outras ficavam como cascas
// vazias na busca e nas listas. Assinatura exata na base: **nº de fichas = nº
// de títulos do aluno** (um caso 6/6, um 5/5, dois 3/3, onze 2/2).
//
// A segunda porta, menos visível: a busca do cadastro existente comparava o CPF
// já normalizado do arquivo (`padStart(11,'0')`) com a coluna `alunos.cpf`
// **crua**. Em 09/10/2026 havia 32 fichas com máscara e 10 com contagem de
// dígitos diferente de 11 — para essas, a busca não acha o cadastro que existe
// e o importador cria outro. É a mesma família do `sistema_fusao_cpf_sem_zero`
// citado em 20260909091338. Por isso a comparação aqui é sempre por `chaveCpf`
// dos DOIS lados.
//
// Regra 1 de docs/PADRAO_CADASTRO.md: a identidade é o CPF, nunca o nome. Estas
// funções não decidem nada por nome — o casamento por nome do preview continua
// onde estava e segue sendo só um palpite para evitar cadastro novo.

// CPF como chave de identidade: só dígitos, 11 posições, zeros à esquerda
// preservados. `null` quando não há dígito nenhum — sem CPF não há
// correspondência segura, e não se inventa uma.
export function chaveCpf(valor) {
  const digitos = String(valor ?? "").replace(/\D/g, "");
  if (!digitos) return null;
  return digitos.padStart(11, "0");
}

// ---------------------------------------------------------------------------
// CPF CONFIRMÁVEL — decisão da gestão de 27/10/2026, regra 2:
// "Não criar aluno ou título quando o CPF estiver ausente ou não puder ser
// confirmado."
//
// O CRITÉRIO, e por que não é "exatamente 11 dígitos": o Excel come o zero à
// esquerda. Um CPF que começa com 0 chega ao arquivo com 10 dígitos, e é
// exatamente para isso que `chaveCpf` faz `padStart(11,'0')` — comportamento
// estabelecido e medido neste projeto (42 fichas gravadas com máscara ou com
// contagem diferente de 11, em 09/10/2026). Exigir 11 crus rejeitaria aluno
// legítimo, o oposto do objetivo.
//
// Então: 9 a 11 dígitos é RECUPERÁVEL por padding e vale como confirmado.
// Rejeita o que não dá para confirmar de jeito nenhum:
//   · ausente, ou sem dígito nenhum;
//   · menos de 9 dígitos — não há padding que invente o que falta;
//   · mais de 11 — CNPJ ou lixo; não é CPF de aluno e não se chuta;
//   · todos os dígitos iguais (00000000000, 11111111111) — preenchimento
//     de formulário, não identidade.
//
// NÃO valida o dígito verificador de propósito: o borderô vem da ULBRA, e um
// CPF que o Prime aceitou não é nosso para recusar. O que se recusa aqui é o
// que não IDENTIFICA, não o que é inválido na regra do CPF.
export function cpfConfiavel(valor) {
  const digitos = String(valor ?? "").replace(/\D/g, "");
  if (digitos.length < 9 || digitos.length > 11) return false;
  if (/^(\d)\1+$/.test(digitos)) return false;
  return true;
}

// Por que a linha vai para ANÁLISE em vez de virar dívida. Um lugar só, para a
// tela e o teste dizerem a mesma coisa (regra 5 da gestão: "se houver
// duplicidade ou dúvida de vínculo, separar para análise, sem criar dívida").
export function motivoDeAnalise({ cpfOriginal, aluno, sugestaoPorNome }) {
  if (aluno) return null;                       // identidade comprovada por CPF
  const digitos = String(cpfOriginal ?? "").replace(/\D/g, "");
  if (!digitos) return "linha sem CPF";
  if (!cpfConfiavel(cpfOriginal)) {
    return `CPF não confirmável (${digitos.length} dígitos)`;
  }
  // CPF confiável e sem cadastro: NÃO é análise -- é aluno novo, e entra.
  // Este ramo só é alcançado se quem chamou já decidiu que não vai criar ficha.
  if (sugestaoPorNome) {
    return "CPF não casou, mas existe cadastro com o mesmo nome — conferir";
  }
  return null;
}

// Indexa cadastros existentes por `chaveCpf`, não pelo valor cru da coluna.
// É o que faz uma ficha gravada sem o zero à esquerda, ou com máscara, ser
// reaproveitada em vez de duplicada.
export function indexarAlunosPorCpf(alunos) {
  const mapa = {};
  for (const aluno of alunos || []) {
    const chave = chaveCpf(aluno?.cpf);
    if (!chave) continue;
    // Primeiro a ganhar fica. Com mais de uma ficha para o mesmo CPF (39 CPFs
    // na base em 09/10/2026), o importador não escolhe dona: reaproveita uma e
    // não cria mais nenhuma. Consolidar é outra frente, com autorização.
    if (!mapa[chave]) mapa[chave] = aluno;
  }
  return mapa;
}

// O coração da correção: UM cadastro por CPF, por mais linhas que o CPF tenha
// no arquivo.
//
// Devolve:
//   registros     -> o que inserir em `alunos` (um por CPF distinto, na ordem
//                    da primeira aparição)
//   linhasEmAnalise -> linhas cujo CPF está ausente ou NÃO é confirmável.
//                    **NÃO entram em `registros` e não geram título.** Regra 2
//                    da gestão (27/10/2026). Antes, linha sem CPF virava uma
//                    ficha POR LINHA e o título ia nela — criava dívida com
//                    identidade não comprovada.
//   cpfsNovos     -> as chaves que serão criadas, para conferência no teste
export function fichasParaCriar(linhas) {
  const registros = [];
  const linhasEmAnalise = [];
  const vistos = new Set();

  for (const linha of linhas || []) {
    if (linha?.aluno) continue; // já existe cadastro: reutiliza, não cria

    // Regra 2: sem CPF confirmável não se cria ficha nem título. O valor
    // conferido é o ORIGINAL do arquivo, não `cpfLimpo` -- este último já passou
    // por `padStart`, que esconde justamente a contagem de dígitos.
    if (!cpfConfiavel(linha?.cpfOriginal ?? linha?.cpfLimpo)) {
      linhasEmAnalise.push(linha);
      continue;
    }

    const chave = chaveCpf(linha?.cpfLimpo ?? linha?.cpfOriginal);
    if (!chave) {
      linhasEmAnalise.push(linha);
      continue;
    }
    if (vistos.has(chave)) continue; // outra linha do MESMO aluno

    vistos.add(chave);
    registros.push({
      nome: linha.nome,
      cpf: chave,
      email: linha.email,
      telefone: linha.telefone,
      curso: linha.curso,
      unidade: linha.unidade,
      status_jornada: "CONTATAR",
      status_atual: "CONTATAR",
    });
  }

  return { registros, linhasEmAnalise, cpfsNovos: [...vistos] };
}

// Resolve o aluno de uma linha: o que o preview achou, ou o que acabou de ser
// criado para aquele CPF. Todas as linhas do mesmo CPF caem na MESMA ficha.
export function alunoDaLinha(linha, mapaNovosPorCpf) {
  if (linha?.aluno) return linha.aluno;
  const chave = chaveCpf(linha?.cpfLimpo ?? linha?.cpfOriginal);
  if (!chave) return null;
  return (mapaNovosPorCpf || {})[chave] || null;
}

// DÉBITO CONHECIDO, NÃO TRATADO AQUI: linha sem CPF.
//
// Regra 4 de docs/PADRAO_CADASTRO.md manda a linha sem CPF ir para quarentena,
// e a quarentena não existe ainda. Recusar a linha agora derrubaria no chão o
// título que hoje é gravado, então o importador segue criando uma ficha por
// linha sem CPF — e a tela passa a DIZER quantas foram (43 fichas sem CPF na
// base em 09/10/2026). Duas linhas sem CPF da mesma pessoa continuam virando
// duas fichas: juntá-las exigiria decidir identidade por nome, que a regra 1
// proíbe. O que mudou para elas é só não misturar mais os títulos de pessoas
// diferentes numa ficha só (ver o comentário do lote em Borderos.jsx).

// ---------------------------------------------------------------------------
// TÍTULOS NOVOS PARA IMPORTAR — o indicador da prévia
// ---------------------------------------------------------------------------
//
// 27/10/2026, pedido da gestão: a prévia dizia "1.338 já existentes" e deixava
// a gestão fazer a subtração de cabeça para saber o que a confirmação ia
// gravar, e não dizia o valor em dinheiro nenhum lugar.
//
// NÃO é uma regra nova: é o MESMO predicado do laço que monta
// `registrosTitulos` em Borderos.jsx -- `motivoDeNaoTocar` descarta, aluno
// irresolvível descarta, chave normalizada repetida no lote descarta. Nada
// aqui decide o que entra; isto só CONTA o que o importador já decidiu.
//
// POR QUE O PREDICADO ESTÁ AQUI e não inline na tela: duas cópias do mesmo
// critério divergem (foi exatamente o que aconteceu hoje com um campo
// renomeado em três suítes). O teste `o indicador conta o mesmo que o laço de
// gravação` prende os dois contra as mesmas linhas.
//
// `origemMatch !== "analise"` é o proxy de "o aluno vai existir na hora de
// gravar": `cpf` já tem ficha, `novo` terá a ficha criada no mesmo ato, e
// `analise` é justamente a linha que não vira dívida (regra 2 da gestão).
export function titulosNovosParaImportar(linhas) {
  const chavesNoLote = new Set();
  let quantidade = 0;
  let valor = 0;

  for (const linha of Array.isArray(linhas) ? linhas : []) {
    if (motivoDeNaoTocar(linha)) continue;
    if (linha?.origemMatch === "analise") continue;

    const chave = chaveDocumento(linha?.numTitulo);
    if (chave) {
      if (chavesNoLote.has(chave)) continue;
      chavesNoLote.add(chave);
    }

    quantidade += 1;
    // valor ausente ou ilegível entra como 0 e NÃO derruba a contagem: a linha
    // existe e vai ser gravada de qualquer forma (o importador grava
    // `valor_original: linha.valor`). Somar `null` como 0 é o que a soma do
    // arquivo já fazia.
    valor += Number(linha?.valor) || 0;
  }

  return { quantidade, valor };
}
