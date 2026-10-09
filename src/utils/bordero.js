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
//   linhasSemCpf  -> linhas sem dígito de CPF. NÃO entram em `registros`: sem
//                    CPF não há correspondência segura. Ficam aqui para a tela
//                    contar e avisar (ver o débito no fim deste bloco).
//   cpfsNovos     -> as chaves que serão criadas, para conferência no teste
export function fichasParaCriar(linhas) {
  const registros = [];
  const linhasSemCpf = [];
  const vistos = new Set();

  for (const linha of linhas || []) {
    if (linha?.aluno) continue; // já existe cadastro: reutiliza, não cria

    const chave = chaveCpf(linha?.cpfLimpo ?? linha?.cpfOriginal);
    if (!chave) {
      linhasSemCpf.push(linha);
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

  return { registros, linhasSemCpf, cpfsNovos: [...vistos] };
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
