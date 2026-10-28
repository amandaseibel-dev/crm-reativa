import { useState } from "react";
import {
  motivoDeNaoTocar,
  chaveCpf,
  indexarAlunosPorCpf,
  fichasParaCriar,
  alunoDaLinha,
  cpfConfiavel,
  motivoDeAnalise,
  chaveDocumento,
  variantesDeDocumento,
  indexarTitulosPorDocumento,
  colisoesNormalizadasNoLote,
  titulosNovosParaImportar,
  resumoPorGrupo,
} from "../utils/bordero";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";
import { hashArquivo, hashValido } from "../utils/hashArquivo";   // MESMA implementacao
import Dobra from "../ui/blocos";

// Fonte unica da chave de identidade: `chaveCpf` em utils/bordero.js, a mesma
// usada para indexar cadastro existente, para deduplicar o lote e para resolver
// o aluno de cada linha. Antes esta funcao era uma segunda implementacao local
// -- duas copias da regra de identidade e meio caminho para divergirem.
const limparCpf = chaveCpf;

function parseValor(valor) {
  if (typeof valor === "number") return valor;
  const texto = String(valor || "")
    .replace("R$", "")
    .trim()
    .replace(/\./g, "")
    .replace(",", ".");
  const numero = parseFloat(texto);
  return Number.isNaN(numero) ? null : numero;
}

function parseDataBr(valor) {
  if (!valor) return null;
  const texto = String(valor).trim();
  const partes = texto.split("/");
  if (partes.length !== 3) return null;
  const [dia, mes, ano] = partes;
  return `${ano}-${mes.padStart(2, "0")}-${dia.padStart(2, "0")}`;
}

function extrairNumeroBordero(nomeArquivo) {
  const match = String(nomeArquivo || "").match(/(\d+)/);
  return match ? match[1] : nomeArquivo;
}

// Borderôs grandes (2-3 mil linhas) geram listas de CPF/título enormes.
// Um único .in() com milhares de valores vira uma URL de dezenas de KB e
// o gateway do Supabase rejeita ou trunca a requisição -- nesse caso
// `alunosEncontrados`/`titulosExistentes` voltam vazios (ou incompletos)
// e QUASE TUDO aparece como "novo" na prévia, mesmo quem já está
// cadastrado. Por isso as buscas por CPF, nome e título são feitas em
// lotes menores e depois unidas.
const TAMANHO_LOTE_CONSULTA = 200;

function dividirEmLotes(lista, tamanho) {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamanho) {
    lotes.push(lista.slice(i, i + tamanho));
  }
  return lotes;
}

async function buscarEmLotes(tabela, coluna, valores, colunasSelect) {
  if (valores.length === 0) return [];
  const lotes = dividirEmLotes(valores, TAMANHO_LOTE_CONSULTA);
  const resultados = await Promise.all(
    lotes.map((lote) =>
      supabase.from(tabela).select(colunasSelect).in(coluna, lote)
    )
  );

  const registros = [];
  for (const { data, error } of resultados) {
    if (error) {
      // Não interrompe a prévia inteira por causa de um lote -- melhor
      // avisar e seguir só com o que deu certo do que travar a tela.
      console.error(`Erro ao consultar ${tabela}.${coluna} em lote:`, error);
      continue;
    }
    registros.push(...(data || []));
  }
  return registros;
}

// Gravação também vai em lote: além do corpo da requisição poder ficar
// grande demais com milhares de linhas de uma vez, o Supabase por padrão
// só devolve as primeiras 1000 linhas de um .select() após insert/upsert
// -- com um bordero de 5-10 mil linhas isso faria a metade "sumir" da
// resposta mesmo tendo sido gravada. Vai em série (não em paralelo) pra
// não sobrecarregar o banco com um monte de upserts simultâneos.
const TAMANHO_LOTE_GRAVACAO = 500;

async function inserirEmLotes(tabela, registros) {
  if (registros.length === 0) return { dados: [], erro: null };
  const lotes = dividirEmLotes(registros, TAMANHO_LOTE_GRAVACAO);
  const dados = [];
  for (const lote of lotes) {
    const { data, error } = await supabase.from(tabela).insert(lote).select();
    if (error) return { dados, erro: error };
    dados.push(...(data || []));
  }
  return { dados, erro: null };
}

// 08/10/2026: era `upsertEmLotes` e fazia ON CONFLICT DO UPDATE. Virou
// insert-only (`ignoreDuplicates: true` => ON CONFLICT DO NOTHING) porque o
// borderô passou a só INCLUIR documento ausente. O nome mudou junto de
// propósito: uma função chamada `upsert` que não faz upsert é uma armadilha.
//
// CONSEQUÊNCIA DESTA MUDANÇA, que a gestão precisa saber: reimportar um borderô
// deixa de corrigir valor/vencimento de título que já existe. Era o único efeito
// útil do upsert, e é também o que reabria NEGOCIADO. Correção de valor de
// título existente continua possível pela ficha (ajuste de valor, que tem
// trilha própria em `titulo_valor_ajuste_historico`), nunca por reimportação.
// 27/10/2026: passou a DEVOLVER quantas linhas o banco realmente gravou.
//
// Antes a tela reportava `inseridos = registrosTitulos.length` -- o tamanho da
// INTENÇÃO, não o do resultado. Isso já era frágil (`ignoreDuplicates` pula
// conflito de `documento`) e virou errado com a guarda `BEFORE INSERT` da
// migration 20261027120000 §1b, que pula duplicata normalizada: a tela
// anunciaria linhas que não entraram. O `.select()` depois do upsert devolve só
// o que foi inserido de fato -- é esse o número honesto.
async function inserirIgnorandoExistentesEmLotes(tabela, registros, onConflict) {
  if (registros.length === 0) return { gravados: 0, erro: null };
  const lotes = dividirEmLotes(registros, TAMANHO_LOTE_GRAVACAO);
  let gravados = 0;
  for (const lote of lotes) {
    const { data, error } = await supabase
      .from(tabela)
      .upsert(lote, { onConflict, ignoreDuplicates: true })
      .select("documento");
    if (error) return { gravados, erro: error };
    gravados += (data || []).length;
  }
  return { gravados, erro: null };
}

export default function Borderos() {
  const [arquivo, setArquivo] = useState(null);
  const [processando, setProcessando] = useState(false);
  const [preview, setPreview] = useState(null);
  const [importando, setImportando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState("");
  // O hash passa a ser calculado ao ESCOLHER o arquivo, nao na hora da captura.
  // Antes era `await hashArquivo(await arquivo.arrayBuffer())` dentro do try da
  // trilha: se falhasse, a importacao financeira ja estava concluida e a captura
  // morria no catch. Calculando aqui, a falha aparece ANTES de qualquer gravacao.
  const [arquivoHash, setArquivoHash] = useState("");

  async function selecionarArquivo(e) {
    const arquivoSelecionado = e.target.files?.[0];
    if (!arquivoSelecionado) return;

    setArquivo(arquivoSelecionado);
    setResultado(null);
    setErro("");
    setProcessando(true);

    setArquivoHash("");

    try {
      const buffer = await arquivoSelecionado.arrayBuffer();
      // identidade do arquivo, pre-requisito da importacao (ver trava em
      // confirmarImportacao). Falha aqui nao interrompe a previa: quem recusa e
      // a trava, com mensagem propria.
      try { setArquivoHash(await hashArquivo(buffer)); } catch { setArquivoHash(""); }
      const workbook = XLSX.read(buffer, { type: "array" });
      const primeiraAba = workbook.SheetNames[0];
      const linhasBrutas = XLSX.utils.sheet_to_json(workbook.Sheets[primeiraAba], {
        raw: false,
      });

      if (linhasBrutas.length === 0) {
        setErro("Não encontrei linhas nessa planilha.");
        setProcessando(false);
        return;
      }

      const linhas = linhasBrutas
        .map((linha) => ({
          cpfOriginal: linha.cpfcnpj,
          cpfLimpo: limparCpf(linha.cpfcnpj),
          nome: linha.nome,
          numTitulo: String(linha.num_titulo || "").trim(),
          numParcela: linha.num_parcela,
          vencimento: parseDataBr(linha.datavencimento),
          valor: parseValor(linha.valorparcela),
          curso: linha.NomeTipoTitulo || null,
          unidade: linha.estabNome || null,
          email: String(linha.email || "").split(";")[0].trim() || null,
          telefone: linha.dddRes && linha.foneRes
            ? `(${linha.dddRes}) ${linha.foneRes}`
            : linha.foneRes || null,
        }))
        .filter((linha) => linha.numTitulo);

      const cpfs = [...new Set(linhas.map((l) => l.cpfLimpo).filter(Boolean))];
      const titulos = [...new Set(linhas.map((l) => l.numTitulo))];

      const alunosEncontrados = await buscarEmLotes(
        "alunos",
        "cpf",
        cpfs,
        "id, nome, cpf, email, telefone, curso, unidade, status_atual, status_jornada, status_acionamento"
      );

      // 27/10/2026: a consulta passou a mandar as VARIANTES de zero à esquerda
      // de cada documento, não só a grafia do arquivo.
      //
      // Por quê: `acordos_titulos_documento_key` é UNIQUE sobre o `documento`
      // CRU, então a base pode guardar '04039712' enquanto o arquivo traz
      // '4039712'. Consultando só a grafia do arquivo, o título que existe não
      // era encontrado, `jaExiste` saía `false` e a tela inseria a variante --
      // duplicando a dívida. O `.in()` do PostgREST compara valor literal e não
      // aceita filtro por função, então a largura é dada aqui, com limite
      // declarado em `variantesDeDocumento`.
      const titulosParaConsultar = [
        ...new Set(titulos.flatMap((d) => variantesDeDocumento(d))),
      ];

      const titulosExistentes = await buscarEmLotes(
        "acordos_titulos",
        "documento",
        titulosParaConsultar,
        // 08/10/2026: `status` entrou junto. Conferir só `situacao` deixava
        // passar linha já liquidada -- a base tem título `VENCIDA`/`quitada`.
        "documento, situacao, status"
      );

      // Indexa por `chaveCpf` dos DOIS lados. Comparar o CPF normalizado do
      // arquivo com a coluna `alunos.cpf` crua deixava de achar ficha gravada
      // com mascara ou sem zero a esquerda (42 fichas assim em 09/10/2026) --
      // e o importador criava outra para quem ja existia.
      const mapaAlunosPorCpf = indexarAlunosPorCpf(alunosEncontrados);

      // Indexado pela chave NORMALIZADA (mesma regra de
      // `extracao_documento_norm` no banco), não pelo valor cru da coluna. É
      // isto que faz um título gravado com zero à esquerda ser reconhecido
      // como existente em vez de duplicado.
      const mapaTitulos = indexarTitulosPorDocumento(titulosExistentes);

      // Tabulação atual do caso de cada aluno casado por CPF. Só lê, para a
      // prévia separar os grupos A/B/C/E; a gravação não consulta isto.
      const idsAlunosCasados = [...new Set(alunosEncontrados.map((a) => a.id))];
      const casosDosAlunos = await buscarEmLotes(
        "casos",
        "aluno_id",
        idsAlunosCasados,
        "aluno_id, status_acionamento"
      );
      const mapaCasoPorAluno = Object.fromEntries(
        casosDosAlunos.map((c) => [c.aluno_id, c])
      );

      // Pra quem não bateu por CPF, tenta achar pelo nome antes de decidir
      // criar um cadastro novo.
      const nomesParaTentar = [
        ...new Set(
          linhas
            .filter((l) => !(chaveCpf(l.cpfLimpo) && mapaAlunosPorCpf[chaveCpf(l.cpfLimpo)]))
            .map((l) => String(l.nome || "").trim())
            .filter(Boolean)
        ),
      ];

      const mapaAlunosPorNome = {};
      if (nomesParaTentar.length > 0) {
        const porNome = await buscarEmLotes(
          "alunos",
          "nome",
          nomesParaTentar,
          "id, nome, cpf, email, telefone, curso, unidade"
        );

        for (const aluno of porNome) {
          mapaAlunosPorNome[aluno.nome.trim().toLowerCase()] = aluno;
        }
      }

      const linhasComStatus = linhas.map((linha) => {
        const porCpf = chaveCpf(linha.cpfLimpo)
          ? mapaAlunosPorCpf[chaveCpf(linha.cpfLimpo)]
          : null;
        // ===== REGRA 1 da gestão (27/10/2026) =========================
        // "Não vincular aluno somente pelo nome."
        //
        // O nome deixou de RESOLVER o aluno e passou a ser SUGESTÃO. Antes,
        // CPF que não casava caía no nome e o título ia para o homônimo. O
        // borderô traz CPF em 100% das linhas, então este caminho era risco
        // sem benefício -- e o projeto já pagou por casar por nome (10 baixas
        // erradas em 08/09).
        //
        // A consulta por nome CONTINUA, só que para informar: "o CPF não
        // casou, mas existe cadastro com este nome -- confira". É a diferença
        // entre separar para análise com contexto e separar no escuro.
        // ==============================================================
        const sugestaoPorNome = !porCpf
          ? mapaAlunosPorNome[String(linha.nome || "").trim().toLowerCase()] || null
          : null;
        const aluno = porCpf || null;

        return {
          ...linha,
          aluno,
          sugestaoPorNome,
          // "novo" = CPF confirmável sem cadastro: entra e cria ficha.
          // "analise" = sem CPF confirmável: NÃO entra (regra 2).
          origemMatch: porCpf
            ? "cpf"
            : cpfConfiavel(linha.cpfOriginal)
              ? "novo"
              : "analise",
          jaExiste: Boolean(mapaTitulos[chaveDocumento(linha.numTitulo)]),
          situacaoAtual: mapaTitulos[chaveDocumento(linha.numTitulo)]?.situacao || null,
          statusAtual: mapaTitulos[chaveDocumento(linha.numTitulo)]?.status || null,
          statusCaso: porCpf ? mapaCasoPorAluno[porCpf.id]?.status_acionamento || null : null,
          statusAluno: porCpf?.status_acionamento || null,
          statusAtualAluno: porCpf?.status_atual || null,
          statusJornadaAluno: porCpf?.status_jornada || null,
        };
      });

      // Colisões DENTRO do arquivo, sob a chave normalizada: duas grafias do
      // mesmo boleto, ou a mesma linha repetida. O banco cru não as vê, e sem
      // isto a segunda grafia entraria como título novo.
      const colisoesNoArquivo = colisoesNormalizadasNoLote(linhasComStatus);

      const encontradosCpf = linhasComStatus.filter((l) => l.origemMatch === "cpf").length;
      const comSugestaoNome = linhasComStatus.filter((l) => l.sugestaoPorNome).length;
      const novosAlunos = linhasComStatus.filter((l) => l.origemMatch === "novo").length;
      const emAnalise = linhasComStatus.filter((l) => l.origemMatch === "analise").length;
      const existentes = linhasComStatus.filter((l) => l.jaExiste).length;

      // O que a confirmação vai GRAVAR, contado pelo mesmo predicado do laço
      // de `registrosTitulos`. Antes a gestão tinha que subtrair de cabeça, e
      // o valor em dinheiro não aparecia em lugar nenhum da prévia.
      const novosParaImportar = titulosNovosParaImportar(linhasComStatus);
      // Grupos da prévia (A/B/C/E novos, D já existentes, X em análise). Só
      // separa para leitura; não muda o que entra.
      const grupos = resumoPorGrupo(linhasComStatus);

      const numeroBordero = extrairNumeroBordero(arquivoSelecionado.name);

      // Avisa se esse mesmo bordero (mesmo numero) ja foi importado antes,
      // pra evitar reenvio sem perceber. Nao bloqueia (pode ser reforço de
      // dados de propósito), so deixa bem visivel antes de confirmar.
      const { data: importacoesAnteriores } = await supabase
        .from("importacoes")
        .select("id, created_at, usuario, qtd_registros")
        .eq("tipo", "BORDERO")
        .eq("referencia", numeroBordero)
        .eq("status", "CONCLUIDO")
        .order("created_at", { ascending: false })
        .limit(1);

      setPreview({
        linhas: linhasComStatus,
        totais: {
          total: linhasComStatus.length,
          encontradosCpf,
          comSugestaoNome,
          novosAlunos,
          emAnalise,
          existentes,
          novosParaImportarQtd: novosParaImportar.quantidade,
          novosParaImportarValor: novosParaImportar.valor,
          grupos,
        },
        numeroBordero,
        jaImportadoAntes: importacoesAnteriores?.[0] || null,
        colisoesNoArquivo,
      });
    } catch (err) {
      console.error(err);
      setErro("Não consegui ler essa planilha. Confira se é um .xls/.xlsx válido.");
    } finally {
      setProcessando(false);
    }
  }

  async function confirmarImportacao() {
    if (!preview) return;

    // ===== HASH OBRIGATORIO, ANTES DE QUALQUER GRAVACAO =====================
    // Mesmo contrato da ImportacaoAcordos: sem identidade do arquivo, a
    // importacao nao comeca. Vem antes do `setImportando` e antes do insert em
    // `importacoes`, entao nada financeiro e gravado.
    //
    // ATENCAO: isto e mais restritivo do que o bordero era. Antes, um bordero
    // cujo hash nao pudesse ser calculado importava normalmente e so perdia a
    // trilha. Agora ele e recusado. A troca e deliberada -- um bordero que nao
    // da para identificar nao da para auditar -- mas e um bloqueio novo num
    // fluxo que nunca bloqueava.
    if (!hashValido(arquivoHash)) {
      setErro("Não foi possível calcular a identidade do arquivo (SHA-256). " +
        "A importação NÃO foi iniciada: nada foi gravado. " +
        "Selecione o arquivo de novo; se persistir, confira se a página está em HTTPS.");
      return;
    }
    // ========================================================================

    setImportando(true);
    setErro("");

    try {
      const { data: userData } = await supabase.auth.getUser();
      const email = userData?.user?.email || "desconhecido";

      const { data: importacao, error: erroImportacao } = await supabase
        .from("importacoes")
        .insert({
          tipo: "BORDERO",
          referencia: preview.numeroBordero,
          arquivo_nome: arquivo?.name || null,
          usuario: email,
          qtd_registros: preview.linhas.length,
          status: "PROCESSANDO",
        })
        .select()
        .single();

      if (erroImportacao) {
        setErro("Erro ao registrar a importação: " + erroImportacao.message);
        setImportando(false);
        return;
      }

      let ignorados = 0;
      // Preenchido quando o recálculo de saldo não roda ou roda com falha. Vai
      // para o resultado na tela: fail-soft não pode ser invisível.
      let avisoSaldo = "";
      // Linhas que a tela mandou gravar e o banco não gravou. Hoje a causa
      // conhecida é a guarda de duplicata normalizada (20261027120000 §1b),
      // que pula a linha e registra TITULO_DUPLICADO_NORMALIZADO_RECUSADO.
      let recusadosPeloBanco = 0;
      const nomesNaoEncontrados = [];
      const nomesCriados = [];

      // ---------------------------------------------------------------------
      // ===== CONTRATO (nao mover) ==========================================
      // A captura de presenca deve permanecer ANTES de qualquer filtro
      // operacional do importador -- aqui, especificamente, antes de
      // `motivoDeNaoTocar`. Nao ha teste automatizado que proteja esta
      // ordem: a garantia e a posicao no codigo. Mover e silencioso.
      // =====================================================================

      // 1) Cria os alunos que não bateram nem por CPF nem por nome --
      // ===== UM CADASTRO POR CPF, nunca um por linha ======================
      // O borderô tem uma linha por TÍTULO. Antes isto era
      // `preview.linhas.filter((l) => !l.aluno).map(...)`, e quem devia 6
      // mensalidades ganhava 6 fichas: 14 CPFs e 33 fichas no borderô 723 de
      // 08/10/2026. `fichasParaCriar` colapsa o lote por `chaveCpf`.
      // ===================================================================
      // ===== REGRA 2 da gestão (27/10/2026) ==========================
      // "Não criar aluno ou título quando o CPF estiver ausente ou não puder
      // ser confirmado."
      //
      // `linhasEmAnalise` são essas. Antes elas viravam uma ficha POR LINHA e o
      // título ia nela -- dívida com identidade não comprovada, o oposto da
      // regra 5. Agora não criam nada: são contadas, listadas com o motivo, e
      // ficam para análise humana.
      // ===============================================================
      const { registros: fichasPorCpf, linhasEmAnalise } = fichasParaCriar(preview.linhas);

      const fichasNovas = fichasPorCpf;
      let alunosNovosPorCpf = {};
      let alunosCriados = 0;

      if (fichasNovas.length > 0) {
        const { dados: novosAlunos, erro: erroNovos } = await inserirEmLotes(
          "alunos",
          fichasNovas
        );
        if (erroNovos) {
          nomesNaoEncontrados.push(...fichasNovas.map((f) => f.nome));
          ignorados += fichasNovas.length;
        } else {
          alunosNovosPorCpf = indexarAlunosPorCpf(novosAlunos);
          alunosCriados = novosAlunos.length;
          nomesCriados.push(...novosAlunos.map((a) => a.nome));
        }
      }

      // as linhas em análise entram no relatório com o motivo de cada uma
      for (const l of linhasEmAnalise) {
        divergencias.push({
          documento: String(l.numTitulo || "").trim(),
          chave: chaveDocumento(l.numTitulo),
          motivo: motivoDeAnalise(l) || "identidade não comprovada",
        });
      }
      const emAnaliseCount = linhasEmAnalise.length;

      // 2) Completa telefone/email/curso/unidade só de quem já existia e
      // estava com algum desses campos vazio — em paralelo, não em fila.
      const completar = preview.linhas.filter((l) => l.aluno).map((l) => {
        const aluno = l.aluno;
        const camposParaCompletar = {};
        if (!aluno.email && l.email) camposParaCompletar.email = l.email;
        if (!aluno.telefone && l.telefone) camposParaCompletar.telefone = l.telefone;
        if (!aluno.curso && l.curso) camposParaCompletar.curso = l.curso;
        if (!aluno.unidade && l.unidade) camposParaCompletar.unidade = l.unidade;

        if (Object.keys(camposParaCompletar).length === 0) return null;
        return supabase.from("alunos").update(camposParaCompletar).eq("id", aluno.id);
      }).filter(Boolean);

      await Promise.all(completar);

      // 3) Grava todos os títulos em uma única chamada (upsert por
      // "documento"), em vez de um insert/update por linha.
      const registrosTitulos = [];
      // Chaves normalizadas já enfileiradas neste lote. Sem isto, duas grafias
      // do mesmo boleto no mesmo arquivo ('04039712' e '4039712') passariam as
      // duas: o `ON CONFLICT (documento)` compara valor CRU e não as vê como
      // conflito. A primeira entra, a segunda é recusada e REPORTADA.
      const chavesNoLote = new Set();
      const divergencias = [];

      for (const linha of preview.linhas) {
        // ===== 08/10/2026: TITULO QUE JA EXISTE NUNCA E TOCADO ==============
        // Pedido da gestao: "inserir apenas documentos ausentes, sem atualizar
        // existentes". Antes, so PAGO / EM_CONFIRMACAO / CANCELADA eram
        // pulados, e o `upsert` reabria todo o resto -- inclusive NEGOCIADO,
        // que nenhum gatilho de banco protege.
        //
        // `motivoDeNaoTocar` devolve o porque (situacao terminal, status
        // terminal, ou simplesmente "ja existe") para a tela poder dizer.
        // ===================================================================
        const motivoIgnorar = motivoDeNaoTocar(linha);
        if (motivoIgnorar) {
          ignorados += 1;
          continue;
        }

        const aluno =
          alunoDaLinha(linha, alunosNovosPorCpf) || null;
        if (!aluno) {
          ignorados += 1;
          continue;
        }

        // Dedupe pela chave NORMALIZADA, dentro do lote.
        const chave = chaveDocumento(linha.numTitulo);
        if (chave && chavesNoLote.has(chave)) {
          divergencias.push({
            documento: String(linha.numTitulo).trim(),
            chave,
            motivo: "mesma chave normalizada já presente neste lote",
          });
          ignorados += 1;
          continue;
        }
        if (chave) chavesNoLote.add(chave);

        registrosTitulos.push({
          aluno_id: aluno.id,
          cpf: linha.cpfLimpo,
          documento: linha.numTitulo,
          vencimento: linha.vencimento,
          valor_original: linha.valor,
          saldo_corrigido: linha.valor,
          situacao: "ABERTO",
          tipo_boleto: linha.curso,
          importacao_id: importacao.id,
        });
      }

      let inseridos = 0;
      let atualizados = 0;

      if (registrosTitulos.length > 0) {
        const { gravados, erro: erroTitulos } = await inserirIgnorandoExistentesEmLotes(
          "acordos_titulos",
          registrosTitulos,
          "documento"
        );

        if (erroTitulos) {
          // 23505 = unique_violation. O `ignoreDuplicates` só absorve conflito
          // no índice declarado em `onConflict` ('documento', cru): a violação
          // de QUALQUER outro índice único vem como erro e derruba o lote de
          // 500. O índice normalizado É único (20261027120000 §1, exigência da
          // gestão), e quem impede a tentativa de chegar nele é a guarda
          // BEFORE INSERT da §1b -- ela pula a linha e registra em auditoria em
          // vez de deixar o lote cair. Esta mensagem é a terceira camada: se um
          // 23505 escapar mesmo assim, a causa fica legível em vez de virar
          // "erro ao gravar" genérico.
          const ehDuplicata = erroTitulos.code === "23505";
          setErro(
            ehDuplicata
              ? "A gravação parou numa duplicidade de boleto (23505): " +
                erroTitulos.message +
                " — nada deste lote de 500 foi gravado. Isso indica duas grafias do mesmo " +
                "boleto (zero à esquerda). Confira o arquivo antes de reenviar."
              : "Erro ao gravar os títulos: " + erroTitulos.message
          );
        } else {
          // `registrosTitulos` já não contém nenhum título existente (todos
          // caíram no `motivoDeNaoTocar` acima), então tudo que foi gravado é
          // inserção. `atualizados` fica 0 por construção, e continua exposto
          // na tela para deixar explícito que a importação não atualiza.
          // Número do BANCO, não da intenção. A diferença entre o que se
          // tentou gravar e o que entrou é exatamente a duplicata normalizada
          // que a guarda BEFORE INSERT pulou -- e ela aparece na tela, abaixo,
          // em vez de virar linha anunciada que não existe.
          inseridos = gravados;
          recusadosPeloBanco = registrosTitulos.length - gravados;
          atualizados = 0;

          // ===== SALDO DO ALUNO, DEPOIS DE GRAVAR O TÍTULO ==============
          // Medido em 09/10/2026: 485 alunos tinham título cobrável em aberto
          // e `alunos.saldo_total` NULO -- R$ 692.047,04 de dívida que existia
          // em `acordos_titulos` e não aparecia no campo que a carteira, as
          // filas e os indicadores leem. A causa: `acordos_titulos` não tinha
          // gatilho de recálculo (todas as outras tabelas financeiras têm) e a
          // virada diária varre `from casos` -- quem não tem caso nunca era
          // alcançado.
          //
          // O gatilho de instrução da migration 20261009210000 enfileira os
          // alunos em `recalculo_saldo_pendente`; aqui a fila é drenada no
          // mesmo ato da importação, para o saldo já estar certo quando a
          // operadora abrir a tela. A fila é durável: se isto falhar, o
          // pendente continua registrado e a próxima chamada processa.
          //
          // FAIL-SOFT de propósito: recalcular saldo é campo derivado. Se
          // quebrar, a importação -- que é o ato financeiro -- não cai por
          // causa disso.
          // ===== DECISÃO DA GESTÃO, 27/10/2026 ==========================
          // "Recálculo de saldos: processamento controlado em lotes, fora da
          // requisição do navegador."
          //
          // O dreno SAIU daqui. Antes, esta tela chamava
          // `recalculo_saldo_pendente_processar` em até 10 voltas de 500 --
          // ou seja, até 5.000 recálculos dentro de uma requisição do
          // navegador, cada um com várias consultas. Era a assinatura dos
          // incidentes de saturação, e piorava com a fila de todo o sistema:
          // os gatilhos de instrução enfileiram em QUALQUER escrita de título
          // (motor de baixa, vinculador, crons), não só na importação -- então
          // quem importasse um borderô pagava o backlog de todos.
          //
          // O que acontece agora: o gatilho de instrução enfileira (uma linha
          // por lote, barata) e o processamento é lote controlado, fora daqui.
          // A dívida já está gravada; o saldo é campo derivado.
          //
          // POR ISSO O AVISO ABAIXO NÃO É OPCIONAL: sem ele a operadora abriria
          // a carteira esperando o saldo já certo. Dizer "entra no próximo
          // lote" é diferente de deixar em silêncio.
          avisoSaldo =
            "Os títulos foram gravados. O saldo dos alunos é recalculado em " +
            "lote controlado, fora desta tela — pode levar alguns minutos para " +
            "aparecer na carteira. A dívida já está registrada.";

          // ===== 08/10/2026: SEPARADO EM DOIS ===========================
          // Este bloco fazia TRÊS coisas de uma vez, e só a primeira é fila:
          //
          //   1. tirava o aluno de QUITADO/QUITADO_MANUAL e devolvia para
          //      CONTATAR  -> MANTIDO. É promessa explícita do produto, dita
          //      ao operador em dois lugares ("Só volta se subir um título
          //      novo dele em algum borderô"), e agora ela fica ainda mais
          //      exata: com o importador insert-only, só dispara quando
          //      entra título REALMENTE novo.
          //
          //   2. restaurava o saldo de títulos `quitada` com motivo "quitado
          //      manualmente"                              -> DESLIGADO
          //   3. devolvia parcela PAGO sem data para A_VENCER e REATIVAVA o
          //      acordo QUITADO                            -> DESLIGADO
          //
          // 2 e 3 são exatamente o que a gestão proibiu em 08/10/2026: "não
          // reative parcelas negociadas, pagas, quitadas, suspensas,
          // canceladas, devolvidas ou encerradas, incluindo acordos e
          // vínculos financeiros". Ficam no código atrás de um interruptor
          // desligado, não apagados: religar é decisão de negócio.
          //
          // Dívida nova de aluno quitado continua entrando como título e
          // continua trazendo a ficha para a fila. O que não acontece mais é
          // o CRM desfazer sozinho uma quitação e reabrir o acordo.
          // ==============================================================
          const RESTAURAR_QUITACAO_NO_BORDERO = false;
          const idsAlunosComTitulo = [
            ...new Set(registrosTitulos.map((r) => r.aluno_id)),
          ];
          if (idsAlunosComTitulo.length > 0) {
            // Descobre quais desses alunos estavam quitados -- só esses são
            // reativados/restaurados (não mexe em atendimento em andamento
            // nem em casos travados tipo jurídico).
            const { data: quitados } = await supabase
              .from("alunos")
              .select("id")
              .in("id", idsAlunosComTitulo)
              .in("status_jornada", ["QUITADO", "QUITADO_MANUAL"]);

            const idsQuitados = (quitados || []).map((a) => String(a.id));

            if (idsQuitados.length > 0) {
              const agora = new Date().toISOString();

              // 1) Volta pra fila ativa.
              await supabase
                .from("alunos")
                .update({
                  status_jornada: "CONTATAR",
                  status_atual: "CONTATAR",
                  status_acionamento: "CONTATAR",
                  proxima_acao: "CONTATAR",
                })
                .in("id", idsQuitados);

              // 2) e 3) DESLIGADAS em 08/10/2026 (ver o bloco acima). Desfazer
              // uma quitação e reabrir acordo é reativação de registro
              // financeiro, não movimento de fila — e a trava do banco
              // (migration 20261027120000) recusaria a 2) de qualquer jeito.
              if (RESTAURAR_QUITACAO_NO_BORDERO) {
              // 2) Restaura o saldo dos títulos que a quitação manual zerou
              // (reconhecidos pelo motivo_ajuste). Não toca em títulos pagos
              // de verdade nem em vinculados a acordo ativo.
              const { data: titsZerados } = await supabase
                .from("acordos_titulos")
                .select("id, valor_original")
                .in("aluno_id", idsQuitados)
                .eq("status", "quitada")
                .ilike("motivo_ajuste", "%quitado manualmente%");

              for (const t of titsZerados || []) {
                await supabase
                  .from("acordos_titulos")
                  .update({
                    situacao: "ABERTO",
                    status: "em_aberto",
                    saldo_corrigido: t.valor_original,
                    valor_em_aberto: t.valor_original,
                    motivo_ajuste: "Saldo restaurado por nova importação",
                    atualizado_em: agora,
                  })
                  .eq("id", t.id);
              }

              // 3) Reabre as parcelas que a quitação manual "pagou" sem data
              // (PAGO + pago_em nulo é a assinatura da quitação manual;
              // pagamento de verdade sempre tem data) e reativa esses acordos,
              // recalculando o saldo pela soma das parcelas em aberto.
              const { data: acordosQuit } = await supabase
                .from("acordos")
                .select("id")
                .in("aluno_id", idsQuitados)
                .eq("status", "QUITADO");

              const idsAcordos = (acordosQuit || []).map((a) => a.id);

              if (idsAcordos.length > 0) {
                await supabase
                  .from("parcelas")
                  .update({ status: "A_VENCER", atualizado_em: agora })
                  .in("acordo_id", idsAcordos)
                  .eq("status", "PAGO")
                  .is("pago_em", null);

                // Recalcula o saldo de cada acordo e só reativa os que
                // voltaram a ter parcela em aberto.
                const { data: parcelasAcordos } = await supabase
                  .from("parcelas")
                  .select("acordo_id, valor, status")
                  .in("acordo_id", idsAcordos);

                const saldoPorAcordo = {};
                (parcelasAcordos || []).forEach((p) => {
                  if (p.status !== "PAGO" && p.status !== "CANCELADA") {
                    saldoPorAcordo[p.acordo_id] =
                      (saldoPorAcordo[p.acordo_id] || 0) + Number(p.valor || 0);
                  }
                });

                for (const acordoId of idsAcordos) {
                  const saldo = saldoPorAcordo[acordoId] || 0;
                  if (saldo > 0) {
                    await supabase
                      .from("acordos")
                      .update({ status: "ATIVO", saldo, atualizado_em: agora })
                      .eq("id", acordoId);
                  }
                }
              }
              }   // fim do if (RESTAURAR_QUITACAO_NO_BORDERO)
            }
          }
        }
      }

      await supabase
        .from("importacoes")
        .update({ status: "CONCLUIDO" })
        .eq("id", importacao.id);

      // =====================================================================
      // J3/I2 — PRESENCA DO ARQUIVO BRUTO.
      //
      // ORDEM (corrigida em 01/10): a captura vem DEPOIS de a importacao
      // financeira CONCLUIR. Antes ela rodava no inicio de
      // `confirmarImportacao`, e o motivo documentado era outro -- garantir que
      // as linhas puladas pelo laco entrassem no registro. Esse motivo nao
      // exige rodar antes: `preview.linhas` e o arquivo inteiro e continua
      // disponivel aqui. Capturando antes, uma importacao que estourasse no
      // meio deixava a trilha afirmando que uma extracao foi recebida enquanto
      // a `importacoes` ficava em PROCESSANDO -- uma extracao registrada sem
      // importacao concluida.
      //
      // O QUE A CAPTURA PRECISA MANTER, e mantem: TODAS as linhas do arquivo,
      // inclusive as que o laco acima pula via `motivoDeNaoTocar(linha)` --
      // que a partir de 08/10/2026 e TODO titulo ja existente, nao so os
      // terminais -- e as sem aluno resolvido. Se a trilha repetisse o filtro
      // do importador, a ausencia medida seria artefato nosso, nao do arquivo.
      // =====================================================================
      try {
        await supabase.rpc("registrar_presenca_extracao", {
          p_importacao_id: importacao.id,
          p_source_type: "BORDERO",
          // o bordero E o escopo: comparar bordero 545 com 617 nao faz sentido,
          // sao populacoes diferentes por construcao.
          p_scope_key: "BORDERO=" + String(preview.numeroBordero || "DESCONHECIDO"),
          // CONTRATO DO BORDERO (aprovado em 01/10):
          //   · serve para AUDITORIA DE PRESENCA;
          //   · normalmente NAO tera snapshot comparavel seguinte (cada bordero
          //     e importado ~1 vez: 93 referencias em 97 importacoes);
          //   · portanto NAO gera inferencia de ausencia;
          //   · NAO participa da sequencia TOTAL do portador 195;
          //   · NAO e comparado com BORDERO=TODOS -- scope_key diferente, e o
          //     CHECK ck_extracao_scope_key_coerente garante a separacao.
          // TOTAL aqui significa "o lote inteiro DESTA remessa", nao a carteira.
          p_completude: "TOTAL",
          // instante do upload, nao da geracao do bordero: o arquivo nao traz
          // data de geracao. Inofensivo aqui porque cada bordero tem scope_key
          // propria -- existe no maximo UMA extracao por escopo, logo nao ha
          // ordem a inverter. No relatorio, onde todas as extracoes dividem a
          // mesma scope_key, a data E declarada pela gestao.
          p_snapshot_at: new Date().toISOString(),
          p_arquivo_nome: arquivo?.name || null,
          // hash ja calculado no `selecionarArquivo` e conferido pela trava
          p_arquivo_hash: arquivoHash,
          p_linhas_arquivo: preview.linhas.length,
          p_linhas: preview.linhas.map((l) => ({
            documento: l.numTitulo,
            cpf: l.cpfLimpo,
            tipo_boleto: l.curso,
            // CORRIGIDO em 01/10: antes ia `l.situacaoAtual || "ABERTO"`.
            // `situacaoAtual` e a situacao QUE O CRM TEM para o titulo
            // (`mapaTitulos[numTitulo].situacao`), nao algo que o arquivo diga
            // -- o bordero nao tem coluna de situacao. Gravar aquilo era
            // guardar estado nosso como se fosse conteudo do arquivo, e o
            // fallback literal "ABERTO" inventava uma situacao para todo
            // titulo que o CRM ainda nao conhecia. A trilha representa O
            // ARQUIVO RECEBIDO: sem coluna no arquivo, sem valor aqui.
            situacao: null,
            valor: l.valor,
            venc: l.vencimento,
          })),
        });
      } catch { /* presenca e auditoria paralela; nao derruba a importacao */ }

      setResultado({
        inseridos, atualizados, ignorados, alunosCriados, nomesCriados,
        nomesNaoEncontrados,
        emAnalise: emAnaliseCount,
        avisoSaldo,
        divergencias,
        recusadosPeloBanco,
        colisoesNoArquivo: preview.colisoesNoArquivo || [],
      });
      setPreview(null);
      setArquivo(null);
    } catch (err) {
      console.error(err);
      setErro("Erro ao importar. Tente novamente.");
    } finally {
      setImportando(false);
    }
  }

  return (
    <div className="main">
      <h1>Borderôs</h1>
      <p style={{ opacity: 0.75, marginBottom: 20 }}>
        Sobe a planilha de mensalidades/parcelas em aberto. Casa por CPF e não duplica
        títulos já importados e <strong>não toca</strong> nenhum título que já
        exista. Nada é gravado até você confirmar.
      </p>

      <div style={estilos.caixaUpload}>
        <input type="file" accept=".xls,.xlsx" onChange={selecionarArquivo} />
        {processando && <p style={{ marginTop: 10 }}>Lendo planilha...</p>}
      </div>

      {erro && <p style={{ color: "#f87171", marginTop: 12 }}>{erro}</p>}

      {/* 27/10/2026: colisao de chave normalizada DENTRO do arquivo, avisada
          ANTES de confirmar -- e o unico momento em que dá para conferir o
          arquivo. Duas grafias do mesmo boleto ('04039712' e '4039712') o
          UNIQUE cru do banco não vê; só a primeira entra. */}
      {preview?.colisoesNoArquivo?.length > 0 && (
        <div style={estilos.avisoDuplicado}>
          <strong>
            ⚠️ {preview.colisoesNoArquivo.length} boleto(s) repetidos neste arquivo
          </strong>
          <ul style={{ margin: "4px 0 0", fontSize: 13 }}>
            {preview.colisoesNoArquivo.slice(0, 20).map((c, i) => (
              <li key={i}><code>{c.chave}</code> — {c.motivo}</li>
            ))}
          </ul>
          <p style={{ margin: "4px 0 0", fontSize: 13 }}>
            Só a primeira linha de cada um entra; as outras são recusadas e
            listadas no resultado. Confira o arquivo se não era isso que você
            esperava.
          </p>
        </div>
      )}

      {resultado && (
        <div style={estilos.caixaSucesso}>
          <strong>Importação concluída.</strong>
          <p style={{ margin: "6px 0 0" }}>
            {resultado.inseridos} títulos novos, {resultado.atualizados} atualizados,{" "}
            {resultado.alunosCriados} alunos novos cadastrados, {resultado.ignorados}{" "}
            ignorados (já existentes nesta base).
          </p>

          {/* 27/10/2026: o fail-soft do recálculo de saldo deixou de ser mudo.
              A dívida é gravada de todo modo, mas se o saldo não foi
              recalculado quem lê a carteira precisa saber. */}
          {resultado.avisoSaldo && (
            <p style={{ ...estilos.avisoLinha, color: "#fcd34d" }}>
              <strong>Saldo:</strong> {resultado.avisoSaldo}
            </p>
          )}

          {/* Linhas que o BANCO recusou. Hoje a causa conhecida é a guarda de
              duplicata normalizada: duas grafias do mesmo boleto (zero à
              esquerda). Pular sem dizer seria ocultar divergência. */}
          {resultado.recusadosPeloBanco > 0 && (
            <p style={{ ...estilos.avisoLinha, color: "#fcd34d" }}>
              <strong>{resultado.recusadosPeloBanco}</strong> linha(s) foram
              recusadas pelo banco por já existir o mesmo boleto com outra grafia
              (zero à esquerda). A dívida não foi duplicada — e cada recusa está
              registrada na auditoria como{" "}
              <code>TITULO_DUPLICADO_NORMALIZADO_RECUSADO</code>.
            </p>
          )}

          {resultado.divergencias?.length > 0 && (
            <Dobra
              tema="escuro"
              titulo="Divergências do lote"
              contador={resultado.divergencias.length}
              estiloSumario={{ color: "#fcd34d" }}
              style={{ marginTop: 10 }}
            >
              <ul style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
                {resultado.divergencias.map((d, indice) => (
                  <li key={indice}>
                    <code>{d.documento}</code> — {d.motivo}
                  </li>
                ))}
              </ul>
            </Dobra>
          )}

          {resultado.colisoesNoArquivo?.length > 0 && (
            <Dobra
              tema="escuro"
              titulo="Boletos repetidos no próprio arquivo"
              contador={resultado.colisoesNoArquivo.length}
              estiloSumario={{ color: "#fcd34d" }}
              style={{ marginTop: 10 }}
            >
              <ul style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
                {resultado.colisoesNoArquivo.map((c, indice) => (
                  <li key={indice}>
                    <code>{c.chave}</code> — {c.motivo}
                  </li>
                ))}
              </ul>
            </Dobra>
          )}

          {resultado.emAnalise > 0 && (
            <p style={{ margin: "6px 0 0" }}>
              <strong>{resultado.emAnalise}</strong> linha(s) ficaram em{" "}
              <strong>ANÁLISE</strong> e <strong>não</strong> geraram cadastro nem
              título: o CPF está ausente ou não pode ser confirmado. Sem identidade
              comprovada não se cria dívida — cada uma está listada abaixo com o
              motivo, para conferência manual.
            </p>
          )}

          {resultado.nomesCriados?.length > 0 && (
            <Dobra
              tema="escuro"
              titulo="Alunos criados agora"
              contador={resultado.nomesCriados.length}
              style={{ marginTop: 10 }}
            >
              <ul style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
                {resultado.nomesCriados.map((nome, indice) => (
                  <li key={indice}>{nome}</li>
                ))}
              </ul>
            </Dobra>
          )}

          {resultado.nomesNaoEncontrados?.length > 0 && (
            <Dobra
              tema="escuro"
              titulo="Não importados"
              contador={resultado.nomesNaoEncontrados.length}
              estiloSumario={{ color: "#fcd34d" }}
              style={{ marginTop: 10 }}
            >
              <ul style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
                {resultado.nomesNaoEncontrados.map((nome, indice) => (
                  <li key={indice}>{nome}</li>
                ))}
              </ul>
            </Dobra>
          )}
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 20 }}>
          {preview.jaImportadoAntes && (
            <div style={estilos.avisoDuplicado}>
              <strong>⚠️ Este borderô (nº {preview.numeroBordero}) já foi importado antes</strong>
              <p style={{ margin: "4px 0 0", fontSize: 13 }}>
                Em {new Date(preview.jaImportadoAntes.created_at).toLocaleString("pt-BR")}, por{" "}
                {preview.jaImportadoAntes.usuario} ({preview.jaImportadoAntes.qtd_registros}{" "}
                registros). Confirmar de novo não duplica nem atualiza nada: título
                que já existe é ignorado —
                mas confira se é isso mesmo que você quer antes de continuar.
              </p>
            </div>
          )}

          <div style={estilos.grade}>
            <div style={estilos.cartao}>
              <div style={estilos.numero}>{preview.totais.total}</div>
              <div style={estilos.label}>Total no arquivo</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(34,197,94,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#93c5fd" }}>
                {preview.totais.encontradosCpf}
              </div>
              <div style={estilos.label}>Encontrados por CPF</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(56,189,248,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#7dd3fc" }}>
                {preview.totais.emAnalise}
              </div>
              <div style={estilos.label}>Em análise (sem CPF confirmável)</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(251,191,36,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#fcd34d" }}>
                {preview.totais.novosAlunos}
              </div>
              <div style={estilos.label}>Alunos novos (serão criados)</div>
            </div>
            <div style={estilos.cartao}>
              <div style={estilos.numero}>{preview.totais.existentes}</div>
              <div style={estilos.label}>Títulos já existentes</div>
            </div>
            {/* O que a confirmação vai gravar, em quantidade e em dinheiro.
                Mesmo predicado do laço de gravação (titulosNovosParaImportar). */}
            <div style={{ ...estilos.cartao, background: "rgba(167,139,250,0.12)" }}>
              <div style={{ ...estilos.numero, color: "#c4b5fd" }}>
                {preview.totais.novosParaImportarQtd}
              </div>
              <div style={estilos.label}>
                Títulos novos para importar
                <br />
                <strong style={{ color: "#c4b5fd" }}>
                  {preview.totais.novosParaImportarValor.toLocaleString("pt-BR", {
                    style: "currency",
                    currency: "BRL",
                  })}
                </strong>
              </div>
            </div>
          </div>

          {/* Os títulos novos separados por grupo, só para leitura. Não muda o
              que entra: a gravação continua sendo a de registrosTitulos. */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "12px 0 0" }}>
            {[
              ["A", "Sem restrição", preview.totais.grupos.A],
              ["B", "Em tratamento (acordo, termo, alegação)", preview.totais.grupos.B],
              ["C", "Suspensão, jurídico ou cancelamento", preview.totais.grupos.C],
              ["E", "Parcela devolvida", preview.totais.grupos.E],
            ].map(([codigo, rotulo, grupo]) => (
              <div key={codigo} style={{ ...estilos.cartao, minWidth: 180 }}>
                <div style={{ ...estilos.numero, fontSize: 20 }}>{grupo.quantidade}</div>
                <div style={estilos.label}>
                  Grupo {codigo}: {rotulo}
                  <br />
                  <strong>
                    {grupo.valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
                  </strong>
                </div>
              </div>
            ))}
          </div>

          <p style={{ fontSize: 13, opacity: 0.75, margin: "16px 0 8px" }}>
            Prévia das primeiras linhas
          </p>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(148,163,184,0.3)" }}>
                  <th style={{ padding: "8px 10px" }}>Aluno</th>
                  <th style={{ padding: "8px 10px" }}>Título</th>
                  <th style={{ padding: "8px 10px" }}>Vencimento</th>
                  <th style={{ padding: "8px 10px" }}>Valor</th>
                  <th style={{ padding: "8px 10px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.linhas.slice(0, 20).map((linha, indice) => (
                  <tr key={indice} style={{ borderBottom: "1px solid rgba(148,163,184,0.12)" }}>
                    <td style={{ padding: "8px 10px" }}>{linha.nome}</td>
                    <td style={{ padding: "8px 10px", opacity: 0.7 }}>{linha.numTitulo}</td>
                    <td style={{ padding: "8px 10px" }}>
                      {linha.vencimento
                        ? new Date(linha.vencimento + "T00:00:00").toLocaleDateString("pt-BR")
                        : "-"}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {linha.valor != null
                        ? linha.valor.toLocaleString("pt-BR", {
                            style: "currency",
                            currency: "BRL",
                          })
                        : "-"}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {linha.jaExiste ? (
                        <span style={estilos.tagNeutra}>Já existe (não é tocado)</span>
                      ) : linha.origemMatch === "analise" ? (
                        <span style={estilos.tagAmarela}>
                          Em análise — {motivoDeAnalise(linha) || "identidade não comprovada"}
                        </span>
                      ) : linha.origemMatch === "novo" ? (
                        <span style={estilos.tagAzul}>Aluno novo (será criado)</span>
                      ) : (
                        <span style={estilos.tagVerde}>Encontrado por CPF</span>
                      )}
                      {linha.sugestaoPorNome && (
                        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
                          existe cadastro com o mesmo nome — não foi vinculado
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={confirmarImportacao}
            disabled={importando}
            style={estilos.botaoConfirmar}
          >
            {importando ? "Importando..." : "Confirmar importação"}
          </button>
        </div>
      )}
    </div>
  );
}

const estilos = {
  caixaUpload: {
    padding: 20,
    borderRadius: 10,
    border: "1px dashed rgba(148,163,184,0.4)",
    background: "rgba(148,163,184,0.05)",
  },
  // margem padrao dos avisos do bloco de resultado (saldo, recusa pelo banco)
  avisoLinha: { margin: "6px 0 0", fontSize: 13 },
  avisoDuplicado: {
    padding: "12px 16px",
    marginBottom: 16,
    borderRadius: 10,
    background: "rgba(251,191,36,0.1)",
    border: "1px solid rgba(251,191,36,0.4)",
  },
  caixaSucesso: {
    marginTop: 16,
    padding: "12px 16px",
    borderRadius: 10,
    background: "rgba(34,197,94,0.1)",
    border: "1px solid rgba(34,197,94,0.3)",
  },
  grade: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 12,
  },
  cartao: {
    padding: 16,
    borderRadius: 10,
    background: "rgba(148,163,184,0.08)",
  },
  numero: {
    fontSize: 24,
    fontWeight: 800,
  },
  label: {
    fontSize: 12,
    opacity: 0.75,
    marginTop: 4,
  },
  tagVerde: {
    background: "rgba(34,197,94,0.16)",
    color: "#93c5fd",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  tagAmarela: {
    background: "rgba(251,191,36,0.16)",
    color: "#fcd34d",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  tagNeutra: {
    background: "rgba(148,163,184,0.15)",
    color: "#cbd5e1",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  tagAzul: {
    background: "rgba(56,189,248,0.16)",
    color: "#7dd3fc",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  botaoConfirmar: {
    marginTop: 16,
    padding: "10px 20px",
    borderRadius: 8,
    border: "1px solid rgba(34,197,94,0.6)",
    background: "rgba(34,197,94,0.16)",
    color: "#93c5fd",
    fontWeight: 600,
    cursor: "pointer",
  },
};
